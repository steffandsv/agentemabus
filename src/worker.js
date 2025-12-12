const Queue = require('bull');
const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');
const { readInput } = require('./input');
const { writeOutput } = require('./output');
const { updateTaskStatus, getTaskById } = require('./database');

console.log('[Worker] Initializing Queue...');

const scrapeQueue = new Queue('scrape-queue', process.env.REDIS_URL || 'redis://localhost:6379');

scrapeQueue.on('ready', () => {
    console.log('[Worker] ✅ Connected to Redis! Ready to process jobs.');
});

let redisErrorLogged = false;
scrapeQueue.on('error', (err) => {
    if (!redisErrorLogged) {
        console.error('\n[Worker] ❌ Redis Connection Error:', err.message);
        redisErrorLogged = true;
    }
});

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

scrapeQueue.process(async (job) => {
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

        // 2. Init Browser (if module needs it, or we do it globally)
        // Ideally module handles it, but let's provide a shared browser instance if exported
        // or let execute handle it.
        // Assuming module.execute takes { ...jobData, browser, logger }
        
        if (mod.initBrowser) {
            logger.log('🌐 Abrindo navegador...');
            browser = await mod.initBrowser();
        }

        // 3. Set CEP (if supported)
        if (mod.setCEP && browser) {
            const page = await browser.newPage();
            logger.log(`📍 Configurando CEP: ${cep}...`);
            try {
                await mod.setCEP(page, cep);
            } catch(e) {
                logger.log(`❌ Erro ao configurar CEP: ${e.message}`);
                // Abort if critical?
                // Depending on module.
                if (moduleName === 'gemini_meli') {
                     throw e;
                }
            }
            await page.close();
        }

        // 4. Execute Module Logic (Parallel Limit handled inside module or here?)
        // The previous worker handled p-limit.
        // It's better if `mod.execute` processes a SINGLE item, and we handle concurrency here.
        // BUT my refactor plan put the loop inside `index.js` of the module?
        // Wait, my previous plan said "Create modules/gemini_meli/index.js containing the current logic...".
        // If the module handles the whole loop, it's easier to migrate.
        // But `execute` usually implies one task.
        // Let's check `modules/gemini_meli/index.js` I wrote.
        // It exports `execute(job, dependencies)`. It processes ONE item? No, I copied the WHOLE loop logic into `execute`?
        // Let's check the code I wrote for `gemini_meli/index.js`.
        // I wrote: `async function execute(job, dependencies) { const { id... } = job; ... return { ... } }`
        // It processes ONE item.
        // So the loop stays in `worker.js`.

        const finalResults = [];
        const concurrency = pLimit(12);

        logger.log(`⚡ Processamento Paralelo: 12 threads.`);

        const promises = items.map(item => concurrency(async () => {
            // Check for task cancellation
            const currentTask = await getTaskById(taskId);
            if (currentTask && (currentTask.status === 'aborted' || currentTask.status === 'failed')) {
                // We cannot really stop the concurrency queue easily without clearing it, 
                // but we can skip execution of individual items
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
                else finalResults.push({ ...itemJob, offers: [] }); // Error handled inside
            } catch (e) {
                logger.log(`💥 [Item ${itemJob.id}] Falha Crítica: ${e.message}`);
                finalResults.push({ ...itemJob, offers: [] });
            }
        }));

        await Promise.all(promises);

        // Final check before saving
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
