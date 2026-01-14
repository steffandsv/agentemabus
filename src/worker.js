const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');
const { readInput } = require('./input');
const {
    updateTaskStatus,
    getTaskById,
    getNextPendingTask,
    createTaskItems,
    getTaskItem,
    getTaskItems,
    saveCandidates,
    logTaskMessage,
    getSetting
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

        // Log to DB
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

        // 1. Resolve Items (DB Priority -> File Fallback)
        logger.log(`[Worker] Verificando itens da tarefa...`);
        let items = await getTaskItems(taskId);
        
        if (items && items.length > 0) {
             logger.log(`[DB] ${items.length} itens recuperados do banco de dados.`);
             // Normalize keys
             items = items.map(i => ({
                 id: i.original_id,
                 description: i.description,
                 valor_venda: parseFloat(i.max_price),
                 quantidade: i.quantity
             }));
        } else {
             // Fallback to File
             if (!fs.existsSync(filePath)) throw new Error(`Input file not found: ${filePath} AND no DB items found.`);

             logger.log(`[Worker] Lendo arquivo de entrada: ${filePath}`);
             items = await readInput(filePath);
             logger.log(`📄 Itens lidos do arquivo: ${items.length}`);

             if (items.length > 0) {
                 logger.log(`[DB] Persistindo itens no banco...`);
                 await createTaskItems(taskId, items);
             }
        }

        if (items.length === 0) {
            const msg = "ERRO CRÍTICO: Nenhum item encontrado (DB ou Arquivo).";
            logger.log(msg);
            await updateTaskStatus(taskId, 'failed');
            return;
        }

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

        const { getTaskMetadata } = require('./database');
        let overrideProvider = null;
        try {
            const metaRows = await getTaskMetadata(taskId);
            if (metaRows && metaRows.data) {
                 const metaData = typeof metaRows.data === 'string' ? JSON.parse(metaRows.data) : metaRows.data;
                 if (metaData.ai_provider_override) {
                     overrideProvider = metaData.ai_provider_override;
                 }
            }
        } catch(e) { /* ignore */ }

        // Fetch AI Settings for Sniper
        const globalProvider = await getSetting('sniper_provider');

        const sniperConfig = {
            provider: overrideProvider || globalProvider,
            model: await getSetting('sniper_model'),
            apiKey: await getSetting('sniper_api_key')
        };

        logger.log(`🤖 Configuração de IA: ${sniperConfig.provider || 'Padrão'} ${overrideProvider ? '(Manual)' : '(Global)'}`);

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
                // Pass dependencies/config to execute if supported
                const result = await mod.execute(itemJob, sniperConfig);

                // Result structure: { ..., offers: [...], winnerIndex: N }
                if (result && result.offers && result.offers.length > 0) {
                    // Save to DB
                    const dbItem = await getTaskItem(taskId, itemJob.id);
                    if (dbItem) {
                        await saveCandidates(dbItem.id, result.offers, result.winnerIndex);
                        logger.log(`[Item ${itemJob.id}] ✅ Resultados salvos no banco.`);
                    } else {
                        logger.log(`[Item ${itemJob.id}] ⚠️ ERRO: Item não encontrado no DB.`);
                    }
                } else {
                     logger.log(`[Item ${itemJob.id}] ⚠️ Nenhum resultado encontrado.`);
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

        logger.log('🎉 Finalizado com Sucesso. Resultados persistidos no Banco de Dados.');
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
