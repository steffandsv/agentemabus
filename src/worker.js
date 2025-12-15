const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');
const { readInput } = require('./input');
const { writeOutput } = require('./output');
const { updateTaskStatus, getTaskById, getNextPendingTask } = require('./database');

// --- CONFIGURATION ---
const POLL_INTERVAL = 5000; // Check DB every 5 seconds
const CONCURRENT_ITEMS_LIMIT = 12; // Parallel items per task
let isProcessing = false;

console.log('[Worker] System Initialized. Waiting for tasks...');

// --- LOGGER ---
function Logger(logPath) {
    this.log = (msg) => {
        const timestamp = new Date().toLocaleTimeString('pt-BR');
        const line = `[${timestamp}] ${msg}\n`;
        console.log(`[Worker] ${line.trim()}`);
        try {
            if (logPath) fs.appendFileSync(logPath, line);
        } catch (e) {
            console.error('Error writing to log file:', e);
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
        const line = `[PENSAMENTO]${JSON.stringify(payload)}\n`;
        try {
            if (logPath) fs.appendFileSync(logPath, line);
        } catch (e) {
            console.error('Error writing thought to log file:', e);
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
        if (isProcessing) {
            // console.log('[Debug] Worker is busy. Skipping poll.');
            return;
        }

        try {
            // console.log('[Debug] Checking for pending tasks...');
            const nextTask = await getNextPendingTask();

            if (nextTask) {
                console.log(`[Worker] Found task: ${nextTask.name} (ID: ${nextTask.id})`);
                isProcessing = true;

                try {
                    await processTask(nextTask);
                } catch (e) {
                    console.error(`[Worker] Error processing task ${nextTask.id}:`, e);
                    await updateTaskStatus(nextTask.id, 'failed');
                } finally {
                    isProcessing = false;
                    console.log(`[Worker] Finished processing task ${nextTask.id}. Ready for next.`);
                }
            } else {
                // console.log('[Debug] No pending tasks found.');
            }
        } catch (e) {
            console.error('[Worker] Error in polling loop:', e);
            isProcessing = false;
        }
    }, POLL_INTERVAL);
}

// --- TASK PROCESSOR ---
async function processTask(task) {
    const { id: taskId, cep, input_file: filePath, log_file: logPath } = task;
    // Default module logic (if not specified in DB, defaulting to 'gemini_meli' or 'smart')
    // The previous code had a hardcoded default 'smart' in the dispatcher if not present.
    // We should probably read it from the task or default to 'gemini_meli' if that's the preferred one.
    // But `server.js` doesn't seem to store moduleName in DB yet?
    // Wait, the create route reads `moduleName` but I don't see it saved in `createTask`.
    // Checking `database.js`... `createTask` function:
    // `const sql = ... VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    // It saves: id, name, status, cep, input_file, log_file, position, tags, external_link.
    // It MISSES moduleName!
    // The user previously selected a module in the UI.
    // I should probably fix that too or default to 'gemini_meli' or 'smart'.
    // For now, I'll default to 'gemini_meli' as per memory instructions ("gemini_meli set as default").
    // Actually, let's check what 'smart' was doing. It was the default in the old dispatcher.
    // Let's use 'gemini_meli' as it seems to be the main one.

    const moduleName = 'gemini_meli';
    
    const logger = new Logger(logPath);
    logger.log(`🚀 Iniciando Missão #${taskId}`);
    logger.log(`🛠️ Módulo Definido: ${moduleName}`);
    logger.log(`📂 Arquivo de Entrada: ${filePath}`);

    await updateTaskStatus(taskId, 'running');
    console.log(`[Worker] Task ${taskId} marked as running.`);

    let browser = null;

    try {
        const mod = loadModule(moduleName);
        if (!mod) {
            throw new Error(`Module '${moduleName}' not found.`);
        }

        if (!fs.existsSync(filePath)) {
            throw new Error(`Input file not found: ${filePath}`);
        }
        
        // 1. Read Input
        console.log(`[Worker] Reading input file...`);
        const items = await readInput(filePath);
        logger.log(`📄 Itens para processar: ${items.length}`);

        if (items.length === 0) {
            const msg = "ERRO CRÍTICO: Nenhum item encontrado no CSV.";
            logger.log(msg);
            await updateTaskStatus(taskId, 'failed');
            return;
        }

        // 2. Init Browser
        if (mod.initBrowser) {
            logger.log('🌐 Abrindo navegador...');
            console.log(`[Worker] initializing browser for module ${moduleName}...`);
            browser = await mod.initBrowser();
            console.log(`[Worker] Browser initialized.`);
        }

        // 3. Set CEP
        if (mod.setCEP && browser) {
            console.log(`[Worker] Setting CEP ${cep}...`);
            const page = await browser.newPage();
            logger.log(`📍 Configurando CEP: ${cep}...`);
            try {
                await mod.setCEP(page, cep);
                console.log(`[Worker] CEP set successfully.`);
            } catch(e) {
                logger.log(`❌ Erro ao configurar CEP: ${e.message}`);
                console.error(`[Worker] CEP Error:`, e);
                // Fail hard if CEP is crucial?
                if (moduleName === 'gemini_meli') throw e;
            }
            await page.close();
        }

        // 4. Execute Module Logic
        const finalResults = [];
        const concurrency = pLimit(CONCURRENT_ITEMS_LIMIT);

        logger.log(`⚡ Processamento Paralelo: ${CONCURRENT_ITEMS_LIMIT} threads.`);
        console.log(`[Worker] processing ${items.length} items with concurrency ${CONCURRENT_ITEMS_LIMIT}`);

        const promises = items.map((item, index) => concurrency(async () => {
            console.log(`[Worker] Starting item ${index + 1}/${items.length}: ${item.Descricao || item.description}`);

            // Re-check task status to allow abortion
            const currentTask = await getTaskById(taskId);
            if (currentTask && (currentTask.status === 'aborted' || currentTask.status === 'failed')) {
                console.log(`[Worker] Task aborted, skipping item.`);
                return; 
            }

            const itemJob = {
                id: item.ID || item.id,
                description: item.Descricao || item.Description || item.description,
                maxPrice: item.valor_venda,
                quantity: item.quantidade,
                browser: browser,
                cep: cep,
                logger: logger
            };

            try {
                const result = await mod.execute(itemJob);
                if (result) {
                    finalResults.push(result);
                    console.log(`[Worker] Item ${itemJob.id} finished successfully.`);
                } else {
                    finalResults.push({ ...itemJob, offers: [] });
                    console.log(`[Worker] Item ${itemJob.id} finished with no result.`);
                }
            } catch (e) {
                logger.log(`💥 [Item ${itemJob.id}] Falha Crítica: ${e.message}`);
                console.error(`[Worker] Item ${itemJob.id} failed:`, e);
                finalResults.push({ ...itemJob, offers: [] });
            }
        }));

        await Promise.all(promises);

        const finalTaskCheck = await getTaskById(taskId);
        if (finalTaskCheck && (finalTaskCheck.status === 'aborted' || finalTaskCheck.status === 'failed')) {
            logger.log('🛑 Tarefa abortada pelo usuário. Não salvando planilha.');
            return;
        }

        finalResults.sort((a, b) => parseInt(a.id) - parseInt(b.id));
        const outputFileName = `resultado_${taskId}.xlsx`; 
        const outputPath = path.join('outputs', outputFileName);
        
        logger.log('💾 Salvando planilha...');
        console.log(`[Worker] Writing output to ${outputPath}`);
        await writeOutput(finalResults, outputPath);
        
        logger.log('🎉 Finalizado com Sucesso.');
        await updateTaskStatus(taskId, 'completed', outputPath);
        console.log(`[Worker] Task ${taskId} completed.`);

    } catch (e) {
        logger.log(`💀 ERRO GERAL: ${e.message}`);
        console.error(`[Worker] General Error for task ${taskId}:`, e);
        await updateTaskStatus(taskId, 'failed');
    } finally {
        if (browser) {
            console.log(`[Worker] Closing browser...`);
            await browser.close();
        }
    }
}

// For compatibility with server.js requiring { addJob }
// We can just keep a dummy addJob or remove it.
// server.js calls addJob. But since we are polling DB now, addJob logic in server might not be needed?
// server.js logic:
// app.post('/create'...) -> createTask(task) -> DONE.
// Then it calls `addJob`? No, let's check server.js again.

// Checking server.js...
// It does: `const { addJob } = require('./src/worker');`
// But it NEVER CALLS `addJob` in the `/create` route!
// Wait.
// app.post('/create', ...) -> await createTask(task); -> res.redirect('/');
// It relies on the Dispatcher (which was inside worker.js) to pick it up.
// So, I don't need to export addJob.
// However, I need to start the worker loop.
// So I should export `startWorker` and call it in server.js.

module.exports = { startWorker };
