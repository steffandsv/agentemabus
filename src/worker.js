const Queue = require('bull');
const fs = require('fs');
const path = require('path');
const pLimit = require('p-limit');
const { readInput } = require('./input');
const { initBrowser, setCEP, searchAndScrape, getProductDetails } = require('./scraper');
const { writeOutput } = require('./output');
const { discoverModels, validateProductWithAI, selectBestCandidate } = require('./ai_validator');
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
    
    logger.log(`🚀 Iniciando Missão #${taskId} (Modo Genius + Gemini)`);
    await updateTaskStatus(taskId, 'running');

    let browser = null;

    try {
        // 1. Read Input
        if (!fs.existsSync(filePath)) throw new Error(`Input file not found: ${filePath}`);
        
        const items = await readInput(filePath);
        logger.log(`📄 Itens para processar: ${items.length}`);

        // 2. Init Browser
        logger.log('🌐 Abrindo navegador...');
        browser = await initBrowser();
        let page = await browser.newPage();
        
        // 3. Set CEP
        logger.log(`📍 Configurando CEP: ${cep}...`);
        await setCEP(page, cep);

        const finalResults = [];

        // 4. Process Items in Parallel
        // Bumped to 12 as requested
        const itemConcurrency = pLimit(12);

        logger.log(`⚡ Processamento Paralelo: 12 threads ativas.`);
        
        const processingPromises = items.map(item => itemConcurrency(async () => {
            const id = item.ID || item.id;
            const description = item.Descricao || item.Description || item.description;
            
            logger.log(`🔧 [Item ${id}] Analisando: "${description.substring(0, 30)}..."`);
            
            let itemPage = null;
            try {
                itemPage = await browser.newPage();
            } catch(e) {
                logger.log(`Error creating page: ${e.message}`);
                return;
            }

            try {
                // PHASE 1: DISCOVERY
                // Ask AI for best models
                logger.log(`🤖 [Item ${id}] Consultando Gemini sobre Marcas/Modelos...`);
                const searchQueries = await discoverModels(description);
                logger.log(`🔍 [Item ${id}] Termos sugeridos: ${JSON.stringify(searchQueries)}`);

                // PHASE 2: SEARCH & DEDUPLICATION
                const uniqueUrls = new Set();
                let allCandidates = [];

                for (const query of searchQueries) {
                    logger.log(`📡 [Item ${id}] Buscando: "${query}"...`);

                    // We search only top 10 per query to be fast, relying on specificity
                    const searchResults = await searchAndScrape(itemPage, query);

                    for (const res of searchResults) {
                        if (!res.price) continue;

                        // Simple deduplication by link
                        // Sometimes links differ by tracking params, so we might want to clean them,
                        // but usually ML links are clean enough or distinct enough.
                        // We can also dedup by ID if we extracted it, but URL is safe for now.
                        if (!uniqueUrls.has(res.link)) {
                            uniqueUrls.add(res.link);
                            allCandidates.push(res);
                        }
                    }
                }

                logger.log(`💰 [Item ${id}] Total de candidatos únicos encontrados: ${allCandidates.length}`);

                if (allCandidates.length === 0) {
                     logger.log(`⚠️ [Item ${id}] Nada encontrado.`);
                     finalResults.push({ id, description, offers: [] });
                     return;
                }

                // Sort by price (ascending) to prioritize checking cheap items first
                allCandidates.sort((a, b) => a.price - b.price);

                // Check top 15 candidates total (Global Limit)
                // We don't want to check infinite items.
                const candidatesToCheck = allCandidates.slice(0, 15);
                
                const validatedCandidates = [];
                
                // PHASE 3: VALIDATION
                for (const candidate of candidatesToCheck) {
                     logger.log(`🕵️ [Item ${id}] Inspecionando: ${candidate.title.substring(0, 25)}... (R$ ${candidate.price})`);
                     
                     const details = await getProductDetails(itemPage, candidate.link, cep);
                     candidate.shippingCost = details.shippingCost;
                     candidate.attributes = details.attributes;
                     candidate.description = details.description;
                     candidate.totalPrice = candidate.price + candidate.shippingCost;
                     
                     // AI Validate
                     const aiResult = await validateProductWithAI(description, candidate);
                     
                     candidate.aiMatch = aiResult.status;
                     candidate.aiReasoning = aiResult.reasoning;
                     candidate.brand_model = aiResult.brand_model;
                     candidate.risk_score = aiResult.risk_score;

                     logger.log(`📝 [Item ${id}] Risk Score: ${candidate.risk_score}/10 (${candidate.brand_model})`);
                     
                     validatedCandidates.push(candidate);
                }

                // PHASE 4: SELECTION
                // Filter viable
                const viable = validatedCandidates.filter(c => c.risk_score < 10);

                if (viable.length > 0) {
                     logger.log(`👨‍⚖️ [Item ${id}] Escolhendo o melhor entre ${viable.length} opções...`);
                     const selectionResult = await selectBestCandidate(description, viable);
                     
                     const winnerObj = viable[selectionResult.winner_index];
                     let winnerIndex = -1;
                     if (winnerObj) {
                         winnerIndex = validatedCandidates.indexOf(winnerObj);
                         logger.log(`🏆 [Item ${id}] VENCEDOR: ${winnerObj.title} (R$ ${winnerObj.totalPrice})`);
                     }

                     finalResults.push({ id, description, offers: validatedCandidates, winnerIndex });
                } else {
                     logger.log(`⚠️ [Item ${id}] Nenhuma opção viável após validação.`);
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

        // Sort final results by ID
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
