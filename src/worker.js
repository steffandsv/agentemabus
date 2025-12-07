const Queue = require('bull');
const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');
const { readInput } = require('./input');
const { initBrowser, setCEP, searchAndScrape, getProductDetails } = require('./scraper');
const { writeOutput } = require('./output');
const { discoverModels, filterTitles, validateBatchWithDeepSeek, selectBestCandidate } = require('./ai_validator');
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
        redisErrorLogged = true;
    }
});

// Helper Logger
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
    
    // Updated thought logger for side panel structure
    this.thought = (itemId, stage, content) => {
        if (!content) return;
        const payload = {
            itemId: itemId,
            stage: stage, // 'discovery', 'filter', 'validation', 'selection'
            content: content, // Can be object or string
            timestamp: new Date().toLocaleTimeString('pt-BR')
        };
        // Use a special prefix for the UI/Parser to pick up
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
    
    logger.log(`🚀 Iniciando Missão #${taskId} (Modo Genius + Gemini)`);
    await updateTaskStatus(taskId, 'running');

    let browser = null;

    try {
        if (!fs.existsSync(filePath)) throw new Error(`Input file not found: ${filePath}`);
        
        const items = await readInput(filePath);
        logger.log(`📄 Itens para processar: ${items.length}`);

        logger.log('🌐 Abrindo navegador...');
        browser = await initBrowser();
        let page = await browser.newPage();
        
        logger.log(`📍 Configurando CEP: ${cep}...`);
        await setCEP(page, cep);

        const finalResults = [];
        const itemConcurrency = pLimit(12);
        logger.log(`⚡ Processamento Paralelo: 12 threads ativas.`);
        
        const processingPromises = items.map(item => itemConcurrency(async () => {
            const id = item.ID || item.id;
            const description = item.Descricao || item.Description || item.description;
            
            logger.log(`🔧 [Item ${id}] Analisando: "${description.substring(0, 30)}..."`);
            let itemPage = null;
            try { itemPage = await browser.newPage(); } catch(e) { return; }

            try {
                // PHASE 1: DISCOVERY (Gemini)
                logger.log(`🤖 [Item ${id}] Consultando Gemini...`);
                const searchQueries = await discoverModels(description);

                // Log separate thoughts for the UI side panel
                searchQueries.forEach(q => {
                    logger.thought(id, 'discovery', {
                        term: q.term || q,
                        risk: q.risk,
                        reasoning: q.reasoning
                    });
                });

                logger.log(`🔍 [Item ${id}] ${searchQueries.length} termos sugeridos.`);

                // PHASE 2: SEARCH & DEDUPLICATION
                const uniqueUrls = new Set();
                let allCandidates = [];

                for (const queryObj of searchQueries) {
                    const query = typeof queryObj === 'string' ? queryObj : queryObj.term;
                    const predictedRisk = typeof queryObj === 'string' ? null : queryObj.risk;

                    if (predictedRisk === 10) continue;

                    // Search (Paginated)
                    const searchResults = await searchAndScrape(itemPage, query);
                    for (const res of searchResults) {
                        if (!res.price) continue;
                        if (!uniqueUrls.has(res.link)) {
                            uniqueUrls.add(res.link);
                            allCandidates.push(res);
                        }
                    }
                }

                if (allCandidates.length === 0) {
                     logger.log(`⚠️ [Item ${id}] Nada encontrado.`);
                     finalResults.push({ id, description, offers: [] });
                     return;
                }

                allCandidates.sort((a, b) => a.price - b.price);

                // PHASE 2.5: AI FILTERING (DeepSeek)
                logger.log(`🧠 [Item ${id}] Filtrando ${allCandidates.length} títulos...`);
                const filterResult = await filterTitles(description, allCandidates);
                const selectedIndices = new Set(filterResult.selected_indices);
                const filteredCandidates = allCandidates.filter((_, i) => selectedIndices.has(i));
                logger.log(`📉 [Item ${id}] Restaram ${filteredCandidates.length} candidatos.`);

                // PHASE 3: BATCH VALIDATION (DeepSeek)
                // Limit to top 15 filtered
                const candidatesToCheck = filteredCandidates.slice(0, 15);
                const validatedCandidates = [];
                
                // Batch process: chunks of 5
                const BATCH_SIZE = 5;
                for (let i = 0; i < candidatesToCheck.length; i += BATCH_SIZE) {
                    const batch = candidatesToCheck.slice(i, i + BATCH_SIZE);
                    logger.log(`🕵️ [Item ${id}] Validando lote ${i+1}-${i+batch.length}...`);

                    // Enrich details first
                    for (const candidate of batch) {
                         const details = await getProductDetails(itemPage, candidate.link, cep);
                         candidate.shippingCost = details.shippingCost;
                         candidate.attributes = details.attributes;
                         candidate.description = details.description;
                         candidate.totalPrice = candidate.price + candidate.shippingCost;
                    }

                    // Send batch to AI
                    const batchResults = await validateBatchWithDeepSeek(description, batch);

                    // Merge results back
                    for (let j = 0; j < batch.length; j++) {
                        const candidate = batch[j];
                        // Match result by index or order
                        // Since batchResults is array of {index, ...} where index is relative to batch usually or absolute?
                        // My prompt asks for index. Let's assume index refers to the list passed (0 to batch.length-1)
                        const res = batchResults.find(r => r.index === j) || { status: 'Erro', risk_score: 10 };

                        candidate.aiMatch = res.status;
                        candidate.aiReasoning = res.reasoning;
                        candidate.brand_model = res.brand_model;
                        candidate.risk_score = res.risk_score;

                        logger.log(`📝 [Item ${id}] ${candidate.title.substring(0,15)}... Risk: ${candidate.risk_score}`);
                        validatedCandidates.push(candidate);
                    }
                }

                // PHASE 4: SELECTION (DeepSeek)
                const viable = validatedCandidates.filter(c => c.risk_score < 10);
                if (viable.length > 0) {
                     logger.log(`👨‍⚖️ [Item ${id}] Escolhendo o vencedor...`);
                     const selectionResult = await selectBestCandidate(description, viable);
                     const winnerObj = viable[selectionResult.winner_index];
                     let winnerIndex = -1;
                     if (winnerObj) {
                         winnerIndex = validatedCandidates.indexOf(winnerObj);
                         logger.log(`🏆 [Item ${id}] VENCEDOR: ${winnerObj.title} (R$ ${winnerObj.totalPrice})`);
                     }
                     finalResults.push({ id, description, offers: validatedCandidates, winnerIndex });
                } else {
                     logger.log(`⚠️ [Item ${id}] Sem opção viável.`);
                     finalResults.push({ id, description, offers: validatedCandidates });
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
