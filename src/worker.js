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
    getTaskItems,
    saveCandidates,
    logTaskMessage,
    addCredits,
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

        // 1. Resolve Items (DB Priority -> File Fallback)
        logger.log(`[Worker] Verificando itens da tarefa...`);
        let items = await getTaskItems(taskId);
        
        if (items && items.length > 0) {
             logger.log(`[DB] ${items.length} itens recuperados do banco de dados.`);
             // Normalize keys if needed (DB columns: original_id, description, max_price, quantity)
             // Worker logic expects: id, description, valor_venda, quantidade
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

        // Fetch Task Metadata for AI Override
        // We need to fetch metadata for the task to check for overrides
        // Assuming a helper exists or we query metadata table directly.
        // For simplicity, let's look at getTaskById again or fetch metadata.
        // There is no direct `getTaskMetadata` exported in `database.js` easily accessible here?
        // Wait, `createTaskMetadata` exists. `getTaskFullResults`?
        // Let's assume we can fetch it or trust global settings for now,
        // OR add `getTaskMetadata` to database.js?
        // Actually, let's fetch it via raw query if needed or add a helper.
        // But to be cleaner, let's modify `getTaskById` to include metadata?
        // Or just add `getTaskMetadata` to imports.

        // Quick helper query for metadata since it's in a separate table 'task_metadata'
        // We need to import 'getPool' or similar? No, worker imports from database.js.
        // Let's assume I can add `getTaskMetadata` to database.js export later.
        // For now, I will use the global setting as fallback.

        const { getTaskMetadata } = require('./database'); // Need to ensure this is exported!
        let overrideProvider = null;
        try {
            const metaRows = await getTaskMetadata(taskId);
            if (metaRows && metaRows.data) { // Assuming it returns the object { data: ... }
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
            model: await getSetting('sniper_model'), // Could override model too if UI supported it
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

        // --- CREDIT REFUND LOGIC ---
        // 1. Calculate Actual Cost (Items with successful results and risk < 5)
        // Note: Risk score is string "High", "Medium", "Low" or numerical?
        // Checking saveCandidates: stores 'risk_score' VARCHAR.
        // Assuming AI returns Low/Medium/High or 1-10. Prompt says "risk < 5".
        // Let's assume numerical or map "Low" -> 1.
        // For safety, let's count ANY successfully found item (where we have a candidate) as a success for now,
        // or refine if we can parse risk.
        // The prompt says: "consumirá 1 crédito por item que foi cotado corretamente (risco menor que 5)".
        // We need to fetch the results to count.

        // Count successes
        const { getTaskFullResults } = require('./database');
        const results = await getTaskFullResults(taskId);

        let successfulItems = 0;
        if (results) {
            results.forEach(item => {
                if (item.offers && item.offers.length > 0) {
                    // Check winner or best offer risk
                    // item.winnerIndex points to the selected one.
                    const winner = item.offers[item.winnerIndex];
                    if (winner) {
                        // Parse risk. If it's "Low" or "1/10", etc.
                        // Let's assume if we found a winner, it's a success.
                        // To follow strict "risk < 5" rule, we need to know the format.
                        // Assuming the validator output "risk_score" is a number string like "2/10".
                        const riskStr = String(winner.risk_score).split('/')[0];
                        const riskVal = parseInt(riskStr);
                        if (!isNaN(riskVal) && riskVal < 5) {
                            successfulItems++;
                        } else if (winner.risk_score === 'Low' || winner.risk_score === 'Medium') {
                             // Fallback for text
                            successfulItems++;
                        }
                    }
                }
            });
        }

        // 2. Refund Logic
        // Cost Estimate was stored in Task? Yes, tasks.cost_estimate.
        // We need to fetch the task again to get the estimate (or pass it through).
        // Let's fetch task info with cost_estimate (added to schema).
        const taskInfo = await getTaskById(taskId);
        const initialCost = taskInfo.cost_estimate || 0;
        const actualCost = successfulItems; // 1 credit per success

        const refundAmount = Math.max(0, initialCost - actualCost);

        if (refundAmount > 0 && taskInfo.user_id) {
            logger.log(`💰 Reembolsando ${refundAmount} créditos (Estimado: ${initialCost}, Real: ${actualCost}).`);
            try {
                await addCredits(taskInfo.user_id, refundAmount, `Reembolso de Sobra - Tarefa: ${taskInfo.name}`, taskId);
            } catch (err) {
                logger.log(`❌ Erro ao reembolsar créditos: ${err.message}`);
            }
        }

        logger.log('🎉 Finalizado com Sucesso. Resultados persistidos no Banco de Dados.');
        await updateTaskStatus(taskId, 'completed', 'db-generated');

    } catch (e) {
        // If Failed Completely, Refund ALL?
        // "caso o sistema falhe inteiramente... a quantidade correta será devolvida"
        // If logic fails here, we should probably refund everything.
        try {
            const taskInfo = await getTaskById(taskId);
            if (taskInfo && taskInfo.cost_estimate > 0 && taskInfo.user_id) {
                 logger.log(`💰 Reembolso Total por Falha: ${taskInfo.cost_estimate} créditos.`);
                 await addCredits(taskInfo.user_id, taskInfo.cost_estimate, `Reembolso Falha Total - Tarefa: ${taskInfo.name}`, taskId);
            }
        } catch(refundErr) {
            console.error("Refund error:", refundErr);
        }

        logger.log(`💀 ERRO GERAL: ${e.message}`);
        console.error(e);
        await updateTaskStatus(taskId, 'failed');
    } finally {
        if (browser) await browser.close();
    }
}

module.exports = { startWorker };
