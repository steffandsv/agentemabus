const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');
const { readInput } = require('./input');
// writeOutput is no longer used directly for file generation in worker,
// but we might need the logic? No, we save to DB.
// const { writeOutput } = require('./output');
const {
    updateTaskStatus,
    getTaskById,
    getNextPendingTask,
    createTaskItems,
    getTaskItem,
    saveCandidates,
    logTaskMessage
} = require('./database');

// --- CONFIGURATION ---
const POLL_INTERVAL = 5000;
const CONCURRENT_ITEMS_LIMIT = 12;
let isProcessing = false;

console.log('[Worker] System Initialized. Waiting for tasks...');

// --- LOGGER ---
function Logger(taskId, logPath) {
    this.taskId = taskId;

    this.log = (msg) => {
        const timestamp = new Date().toLocaleTimeString('pt-BR');
        const line = `[${timestamp}] ${msg}`;
        console.log(`[Worker] ${line}`);

        // Log to File (Legacy/Backup)
        try {
            if (logPath) fs.appendFileSync(logPath, line + '\n');
        } catch (e) {
            console.error('Error writing to log file:', e);
        }

        // Log to DB (New)
        if (this.taskId) {
            logTaskMessage(this.taskId, msg, 'info');
        }
    };
    
    this.thought = (itemId, stage, content) => {
        if (!content) return;
        const payload = {
            itemId: itemId,
            stage: stage,
            content: content,
            timestamp: new Date().toLocaleTimeString('pt-BR')
        };
        const line = `[PENSAMENTO]${JSON.stringify(payload)}`;

        // File
        try {
            if (logPath) fs.appendFileSync(logPath, line + '\n');
        } catch (e) {}

        // DB (As a debug log?)
        if (this.taskId) {
            logTaskMessage(this.taskId, `[THOUGHT] Item ${itemId} (${stage})`, 'debug');
        }
    }
}

// --- MODULE LOADER ---
const modulesPath = path.join(__dirname, '../modules');
const loadedModules = {};

function loadModule(moduleName) {
    console.log(`[Debug] Loading module: ${moduleName}`);
    if (loadedModules[moduleName]) return loadedModules[moduleName];
    try {
        const modPath = path.join(modulesPath, moduleName, 'index.js');
        if (fs.existsSync(modPath)) {
            const mod = require(modPath);
            loadedModules[moduleName] = mod;
            console.log(`[Debug] Module ${moduleName} loaded successfully.`);
            return mod;
        } else {
            console.error(`[Debug] Module file not found: ${modPath}`);
        }
    } catch (e) {
        console.error(`Failed to load module ${moduleName}:`, e);
    }
    return null;
}

// --- MAIN LOOP ---
function startWorker() {
    console.log('[Worker] Starting polling loop...');
    setInterval(async () => {
        if (isProcessing) return;

        try {
            const nextTask = await getNextPendingTask();

            if (nextTask) {
                console.log(`[Worker] Found task: ${nextTask.name} (ID: ${nextTask.id})`);
                isProcessing = true;

                try {
                    await processTask(nextTask);
                } catch (e) {
                    console.error(`[Worker] Error processing task ${nextTask.id}:`, e);
                    await updateTaskStatus(nextTask.id, 'failed');
                    logTaskMessage(nextTask.id, `Task Failed: ${e.message}`, 'error');
                } finally {
                    isProcessing = false;
                    console.log(`[Worker] Finished processing task ${nextTask.id}. Ready for next.`);
                }
            }
        } catch (e) {
            console.error('[Worker] Error in polling loop:', e);
            isProcessing = false;
        }
    }, POLL_INTERVAL);
}

// --- TASK PROCESSOR ---
async function processTask(task) {
    const { id: taskId, cep, input_file: filePath, log_file: logPath, module_name } = task;
    const moduleName = module_name || 'gemini_meli';
    
    const logger = new Logger(taskId, logPath);
    logger.log(`🚀 Iniciando Missão #${taskId}`);
    logger.log(`🛠️ Módulo Definido: ${moduleName}`);
    logger.log(`📂 Arquivo de Entrada: ${filePath}`);

    await updateTaskStatus(taskId, 'running');

    let browser = null;

    try {
        const mod = loadModule(moduleName);
        if (!mod) throw new Error(`Module '${moduleName}' not found.`);

        if (!fs.existsSync(filePath)) throw new Error(`Input file not found: ${filePath}`);
        
        // 1. Read Input
        logger.log(`[Worker] Reading input file...`);
        const items = await readInput(filePath);
        logger.log(`📄 Itens para processar: ${items.length}`);

        if (items.length === 0) {
            const msg = "ERRO CRÍTICO: Nenhum item encontrado no CSV.";
            logger.log(msg);
            await updateTaskStatus(taskId, 'failed');
            return;
        }

        // 1.5 Save Items to DB (Persistence)
        logger.log(`[DB] Salvando itens no banco de dados...`);
        await createTaskItems(taskId, items);

        // 2. Init Browser
        if (mod.initBrowser) {
            logger.log('🌐 Abrindo navegador...');
            browser = await mod.initBrowser();
        }

        // 3. Set CEP
        if (mod.setCEP && browser) {
            const page = await browser.newPage();
            logger.log(`📍 Configurando CEP: ${cep}...`);
            try {
                await mod.setCEP(page, cep);
            } catch(e) {
                logger.log(`❌ Erro ao configurar CEP: ${e.message}`);
                if (moduleName === 'gemini_meli') throw e;
            }
            await page.close();
        }

        // 4. Execute Module Logic
        const concurrency = pLimit(CONCURRENT_ITEMS_LIMIT);
        logger.log(`⚡ Processamento Paralelo: ${CONCURRENT_ITEMS_LIMIT} threads.`);

        const promises = items.map((item, index) => concurrency(async () => {
            // Re-check task status
            const currentTask = await getTaskById(taskId);
            if (currentTask && (currentTask.status === 'aborted' || currentTask.status === 'failed')) return;

            const itemJob = {
                id: item.ID || item.id,
                description: item.Descricao || item.Description || item.description,
                maxPrice: item.valor_venda,
                quantity: item.quantidade,
                browser: browser,
                cep: cep,
                logger: logger
            };

            logger.log(`[Item ${itemJob.id}] Iniciando processamento...`);

            try {
                const result = await mod.execute(itemJob);

                // Result structure: { ..., offers: [...], winnerIndex: N }
                if (result && result.offers && result.offers.length > 0) {
                    // Save to DB
                    // Need to find the task_item_id.
                    const dbItem = await getTaskItem(taskId, itemJob.id);
                    if (dbItem) {
                        await saveCandidates(dbItem.id, result.offers, result.winnerIndex);
                        logger.log(`[Item ${itemJob.id}] ✅ Resultados salvos no banco.`);
                    } else {
                        logger.log(`[Item ${itemJob.id}] ⚠️ ERRO: Item não encontrado no DB.`);
                    }
                } else {
                     // Save empty result to mark as done?
                     const dbItem = await getTaskItem(taskId, itemJob.id);
                     if (dbItem) {
                         // Save nothing but mark done? Or save a "not found" candidate?
                         // For now, simple logic: if no result, just log.
                         // Maybe update status to 'error'?
                         logger.log(`[Item ${itemJob.id}] ⚠️ Nenhum resultado encontrado.`);
                     }
                }
            } catch (e) {
                logger.log(`💥 [Item ${itemJob.id}] Falha Crítica: ${e.message}`);
            }
        }));

        await Promise.all(promises);

        const finalTaskCheck = await getTaskById(taskId);
        if (finalTaskCheck && (finalTaskCheck.status === 'aborted' || finalTaskCheck.status === 'failed')) {
            logger.log('🛑 Tarefa abortada pelo usuário.');
            return;
        }

        // Generate Output File?
        // User said: "logs de download... ficam inacessíveis".
        // Solution: Do NOT generate file here. Generate on-the-fly when user clicks Download.
        // Just update status.
        
        logger.log('🎉 Finalizado com Sucesso. Resultados persistidos no Banco de Dados.');
        // output_file param is null because we don't have a static file anymore (or we create a dummy one)
        // Let's set it to 'db-generated' or similar to indicate dynamic generation.
        await updateTaskStatus(taskId, 'completed', 'db-generated');

    } catch (e) {
        logger.log(`💀 ERRO GERAL: ${e.message}`);
        console.error(e);
        await updateTaskStatus(taskId, 'failed');
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { startWorker };
