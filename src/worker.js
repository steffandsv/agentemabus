const Queue = require('bull');
const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');
const { readInput } = require('./input');
const { initBrowser, setCEP, searchAndScrape, getProductDetails } = require('./scraper');
const { writeOutput } = require('./output');
const { generateSearchQuery, filterTitles, validateProductWithAI, selectBestCandidate } = require('./ai_validator');
const { updateTaskStatus } = require('./database');

console.log('[Worker] Initializing Queue...');

const scrapeQueue = new Queue('scrape-queue', process.env.REDIS_URL || 'redis://localhost:6379');

// --- Observability & Debugging ---
scrapeQueue.on('ready', () => {
    console.log('[Worker] ✅ Connected to Redis! Ready to process jobs.');
});

let redisErrorLogged = false;
scrapeQueue.on('error', (err) => {
    if (!redisErrorLogged) {
        console.error('\n[Worker] ❌ Redis Connection Error:', err.message);
        console.error('---------------------------------------------------');
        console.error('FATAL: Redis is required for the queue system.');
        console.error('👉 If running locally, try: npm run redis:up');
        console.error('👉 If running in Docker, ensure redis service is healthy.');
        console.error('---------------------------------------------------\n');
        redisErrorLogged = true; // Avoid spamming
    }
});

scrapeQueue.on('stalled', (job) => {
    console.warn(`[Worker] ⚠️ Job ${job.id} stalled! Redis might be overloaded.`);
});

scrapeQueue.on('failed', (job, err) => {
    console.error(`[Worker] ❌ Job ${job.id} failed with error: ${err.message}`);
});

// Helper Logger
function Logger(logPath) {
    this.log = (msg) => {
        // Simple log
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

// Job Processor
scrapeQueue.process(async (job) => {
    const { taskId, cep, filePath, logPath } = job.data;
    const logger = new Logger(logPath);
    
    logger.log(`🚀 Iniciando Missão #${taskId}! Preparando os motores...`);
    await updateTaskStatus(taskId, 'running');

    let browser = null;

    try {
        // 1. Read Input
        if (!fs.existsSync(filePath)) throw new Error(`Input file not found: ${filePath}`);
        
        const items = await readInput(filePath);
        logger.log(`📄 Arquivo lido! Encontrei ${items.length} itens para processar.`);

        // 2. Init Browser
        logger.log('🌐 Abrindo o navegador ultra-rápido (Stealth Mode ON)...');
        browser = await initBrowser();
        let page = await browser.newPage();
        
        // 3. Set CEP
        logger.log(`📍 Configurando CEP de destino para: ${cep}...`);
        await setCEP(page, cep);
        logger.log(`✅ CEP definido! O cálculo de frete será preciso.`);

        const finalResults = [];

        // 4. Process Items in Parallel
        const itemConcurrency = pLimit(3); 

        logger.log(`⚡ Iniciando processamento paralelo (3 threads) com prioridade de preço baixo...`);
        
        let processedCount = 0;
        const ROTATE_EVERY = 5;

        // NOTE: We need to serialize item processing if we want to rotate the single browser instance reliably.
        // Or we use pLimit but share the browser.
        // To support rotation, we should process sequentially or accept complexity.
        // User asked for parallel processing.
        // Let's stick to parallel items but NO rotation for now to avoid race conditions on `browser.close()`.
        // If 403 happens, we can try to recover.

        const processingPromises = items.map(item => itemConcurrency(async () => {
            const id = item.ID || item.id;
            const description = item.Descricao || item.Description || item.description;
            
            logger.log(`🔧 [Item ${id}] Iniciando análise: "${description.substring(0, 30)}..."`);
            
            let itemPage = null;
            try {
                itemPage = await browser.newPage();
            } catch(e) {
                logger.log(`Error creating page: ${e.message}`);
                // Try restarting browser if crashed?
                // For now, fail item.
                return;
            }

            try {
                // AI Query
                logger.log(`🤖 [Item ${id}] I.A. gerando busca otimizada...`);
                const searchQuery = await generateSearchQuery(description);
                logger.log(`🔍 [Item ${id}] Busca Gerada: "${searchQuery}"`);
                
                // Scrape Search Results
                logger.log(`📡 [Item ${id}] Varrendo o Mercado Livre...`);
                let searchResults = await searchAndScrape(itemPage, searchQuery);
                
                if (searchResults.length > 0) {
                     // Price Sort
                     searchResults = searchResults.filter(r => r.price && !isNaN(r.price) && r.price > 0);
                     searchResults.sort((a, b) => a.price - b.price);
                     
                     logger.log(`💰 [Item ${id}] Encontrei ${searchResults.length} ofertas. Organizando por menor preço...`);

                     const candidatesToCheck = searchResults.slice(0, 40);
                     
                     // AI Title Filter
                     logger.log(`🧠 [Item ${id}] Filtrando os TOP ${candidatesToCheck.length} títulos mais baratos com I.A....`);
                     const filterResult = await filterTitles(description, candidatesToCheck);
                     
                     logger.thought(id, "Filtragem de Títulos", filterResult.reasoning_content);

                     let selectedCandidates = filterResult.selected_indices
                        .map(i => candidatesToCheck[i])
                        .filter(x => x !== undefined);
                     
                     logger.log(`🎯 [Item ${id}] I.A. pré-selecionou ${selectedCandidates.length} candidatos.`);

                     const validatedCandidates = [];
                     let validCount = 0;
                     
                     // Deep validation
                     for (const candidate of selectedCandidates) {
                         if (validCount >= 10) break;

                         logger.log(`🕵️ [Item ${id}] Inspecionando: ${candidate.title.substring(0, 25)}... (R$ ${candidate.price})`);
                         
                         // We reuse itemPage to save resources
                         const details = await getProductDetails(itemPage, candidate.link, cep);
                         candidate.shippingCost = details.shippingCost;
                         candidate.attributes = details.attributes;
                         candidate.description = details.description;
                         candidate.totalPrice = candidate.price + candidate.shippingCost;
                         
                         // AI Validate
                         logger.log(`⚖️ [Item ${id}] Validando especificações...`);
                         const aiResult = await validateProductWithAI(description, candidate);
                         
                         logger.thought(id, `Validação: ${candidate.title.substring(0, 15)}...`, aiResult.reasoning_content);

                         candidate.aiMatch = aiResult.status; 
                         candidate.aiReasoning = aiResult.reasoning;
                         candidate.brand_model = aiResult.brand_model;
                         candidate.risk_score = aiResult.risk_score;

                         logger.log(`📝 [Item ${id}] Score de Risco: ${candidate.risk_score}/10 (${candidate.aiMatch})`);
                         
                         validatedCandidates.push(candidate);

                         if (candidate.risk_score < 10) {
                             validCount++;
                         }
                     }

                     // Sort by Risk then Price
                     validatedCandidates.sort((a, b) => {
                         if (a.risk_score === b.risk_score) {
                             return a.totalPrice - b.totalPrice;
                         }
                         return a.risk_score - b.risk_score;
                     });

                     // Final Selection
                     const finalists = validatedCandidates.filter(c => c.risk_score < 10).slice(0, 5);
                     let winnerIndex = -1;
                     
                     if (finalists.length > 0) {
                         logger.log(`👨‍⚖️ [Item ${id}] I.A. Juiz deliberando vencedor...`);
                         const selectionResult = await selectBestCandidate(description, finalists);
                         logger.thought(id, "Seleção Final (Juiz)", selectionResult.reasoning_content);
                         
                         const winnerObj = finalists[selectionResult.winner_index];
                         if (winnerObj) {
                             winnerIndex = validatedCandidates.indexOf(winnerObj);
                             logger.log(`🏆 [Item ${id}] Vencedor: ${winnerObj.title.substring(0, 20)}...`);
                         }
                     } else {
                         logger.log(`⚠️ [Item ${id}] Nenhum candidato viável encontrado.`);
                     }

                     finalResults.push({ id, description, offers: validatedCandidates, winnerIndex });
                     logger.log(`🏁 [Item ${id}] Processamento concluído. ${validCount} opções válidas.`);
                } else {
                    logger.log(`⚠️ [Item ${id}] Nenhuma oferta encontrada.`);
                    finalResults.push({ id, description, offers: [] });
                }
            } catch (err) {
                logger.log(`💥 [Item ${id}] Erro: ${err.message}`);
                console.error(err);
                finalResults.push({ id, description, offers: [] });
            } finally {
                if (itemPage) await itemPage.close();
            }
        }));

        await Promise.all(processingPromises);

        // Sort final results by ID
        finalResults.sort((a, b) => parseInt(a.id) - parseInt(b.id));

        const outputFileName = `resultado_${taskId}.xlsx`; 
        const outputPath = path.join('outputs', outputFileName);
        
        logger.log('💾 Gerando planilha Excel final...');
        await writeOutput(finalResults, outputPath);
        
        logger.log('🎉 Missão Cumprida! O relatório está pronto para download.');
        await updateTaskStatus(taskId, 'completed', outputPath);

    } catch (e) {
        logger.log(`💀 ERRO FATAL: ${e.message}`);
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
