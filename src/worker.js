const Queue = require('bull');
const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');
const { readInput } = require('./input');
const { writeOutput } = require('./output');
const { updateTaskStatus, getTaskById, getNextPendingTask } = require('./database');

console.log('[Worker] Initializing Queue...');

// Redis Configuration
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const scrapeQueue = new Queue('scrape-queue', redisUrl, {
    redis: {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        retryStrategy: function(times) {
            return Math.min(times * 50, 2000);
        }
    }
});

const DISPATCH_INTERVAL = 5000; // 5 seconds
const CONCURRENT_JOBS = 1;

scrapeQueue.on('ready', async () => {
    console.log('[Worker] ✅ Connected to Redis! Ready to process jobs.');

    // --- GHOST JOB CLEANUP ---
    // If the worker restarts, any "active" job is dead.
    try {
        const activeJobs = await scrapeQueue.getJobs(['active']);
        if (activeJobs.length > 0) {
            console.log(`[Worker] Found ${activeJobs.length} ghost jobs from previous session. Cleaning up...`);
            for (const job of activeJobs) {
                try {
                    // Update DB to failed so it doesn't stay 'running' forever
                    const taskId = job.data.taskId;
                    if (taskId) {
                        await updateTaskStatus(taskId, 'failed');
                        console.log(`[Worker] Marked ghost job task ${taskId} as failed in DB.`);
                    }
                    // Move to failed in Bull so it leaves the 'active' queue
                    await job.moveToFailed({ message: 'Worker restarted while processing' }, true);
                    console.log(`[Worker] Moved ghost job ${job.id} to failed queue.`);
                } catch (e) {
                    console.error(`[Worker] Failed to cleanup ghost job ${job.id}:`, e);
                }
            }
        }
    } catch (e) {
        console.error('[Worker] Error checking ghost jobs:', e);
    }

    startDispatcher();
});

let redisErrorLogged = false;
scrapeQueue.on('error', (err) => {
    if (!redisErrorLogged) {
        console.error('\n[Worker] ❌ Redis Connection Error:', err.message);
        redisErrorLogged = true;
    }
});

// --- DISPATCHER LOGIC ---
async function startDispatcher() {
    setInterval(async () => {
        try {
            const counts = await scrapeQueue.getJobCounts();
            
            // Check capacity: only dispatch if active < limit
            if (counts.active < CONCURRENT_JOBS) {
                // Fetch next task from DB (ordered by position)
                const nextTask = await getNextPendingTask();
                
                if (nextTask) {
                    console.log(`[Dispatcher] Found pending task: ${nextTask.name} (ID: ${nextTask.id})`);
                    
                    await updateTaskStatus(nextTask.id, 'queued'); // Transitional status

                    const jobData = {
                        taskId: nextTask.id,
                        cep: nextTask.cep,
                        filePath: nextTask.input_file,
                        logPath: nextTask.log_file,
                        moduleName: 'smart' // Default
                    };

                    await scrapeQueue.add(jobData);
                }
            }
        } catch (e) {
            console.error('[Dispatcher] Error:', e.message);
        }
    }, DISPATCH_INTERVAL);
}

function Logger(logPath) {
    this.log = (msg) => {
        const timestamp = new Date().toLocaleTimeString('pt-BR');
        const line = `[${timestamp}] ${msg}\n`;
        console.log(line.trim());
        try {
            fs.appendFileSync(logPath, line);
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
            fs.appendFileSync(logPath, line);
        } catch (e) {
            console.error('Error writing thought to log file:', e);
        }
    }
}

// Module Loader
const modulesPath = path.join(__dirname, '../modules');
const loadedModules = {};

function loadModule(moduleName) {
    if (loadedModules[moduleName]) return loadedModules[moduleName];
    try {
        const modPath = path.join(modulesPath, moduleName, 'index.js');
        if (fs.existsSync(modPath)) {
            const mod = require(modPath);
            loadedModules[moduleName] = mod;
            return mod;
        }
    } catch (e) {
        console.error(`Failed to load module ${moduleName}:`, e);
    }
    return null;
}

scrapeQueue.process(CONCURRENT_JOBS, async (job) => {
    const { taskId, cep, filePath, logPath, moduleName } = job.data;
    const logger = new Logger(logPath);
    
    logger.log(`🚀 Iniciando Missão #${taskId}`);
    logger.log(`🛠️ Módulo Selecionado: ${moduleName}`);

    await updateTaskStatus(taskId, 'running');

    let browser = null;

    try {
        // Load Module
        const mod = loadModule(moduleName);
        if (!mod) {
            throw new Error(`Module '${moduleName}' not found.`);
        }

        if (!fs.existsSync(filePath)) throw new Error(`Input file not found: ${filePath}`);
        
        // 1. Read Input
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
                // Allow continue even if CEP fails? 
                // For Gemeni/Meli it's critical-ish but maybe we can fallback.
                if (moduleName === 'gemini_meli' || moduleName === 'smart') {
                     throw e;
                }
            }
            await page.close();
        }

        // 4. Execute Module Logic
        const finalResults = [];
        const concurrency = pLimit(12);

        logger.log(`⚡ Processamento Paralelo: 12 threads.`);

        const promises = items.map(item => concurrency(async () => {
            const currentTask = await getTaskById(taskId);
            if (currentTask && (currentTask.status === 'aborted' || currentTask.status === 'failed')) {
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
                if (result) finalResults.push(result);
                else finalResults.push({ ...itemJob, offers: [] }); 
            } catch (e) {
                logger.log(`💥 [Item ${itemJob.id}] Falha Crítica: ${e.message}`);
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
        await writeOutput(finalResults, outputPath);
        
        logger.log('🎉 Finalizado com Sucesso.');
        await updateTaskStatus(taskId, 'completed', outputPath);

    } catch (e) {
        logger.log(`💀 ERRO GERAL: ${e.message}`);
        console.error(e);
        await updateTaskStatus(taskId, 'failed');
    } finally {
        if (browser) await browser.close();
    }
});

function addJob(data) {
    return scrapeQueue.add(data);
}

module.exports = { addJob };
