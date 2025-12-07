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
            stage: stage, // 'discovery', 'filter', 'validation', 'selection', 'error'
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
        if (!fs.existsSync(filePath)) throw new Error(`Input file not found: ${filePath}`);
        
        // 1. Read Input
        const items = await readInput(filePath);
        logger.log(`📄 Itens para processar: ${items.length}`);

        if (items.length === 0) {
            const msg = "ERRO CRÍTICO: Nenhum item encontrado no CSV. Verifique se o separador é ';' e se as colunas 'ID', 'Descricao' existem.";
            logger.log(msg);
            logger.thought('global', 'error', msg);
            await updateTaskStatus(taskId, 'failed');
            return;
        }

        logger.log('🌐 Abrindo navegador...');
        browser = await initBrowser();
        let page = await browser.newPage();
        
        logger.log(`📍 Configurando CEP: ${cep}...`);
        try {
            await setCEP(page, cep);
        } catch (e) {
            logger.log(`❌ ERRO FATAL AO CONFIGURAR CEP/COOKIES: ${e.message}`);
            logger.thought('global', 'error', `Falha crítica ao configurar acesso: ${e.message}`);
            await updateTaskStatus(taskId, 'failed');
            await browser.close();
            return; // ABORT MISSION
        }

        const finalResults = [];
        const itemConcurrency = pLimit(12);
        logger.log(`⚡ Processamento Paralelo: 12 threads ativas.`);
        
        const processingPromises = items.map(item => itemConcurrency(async () => {
            const id = item.ID || item.id;
            const description = item.Descricao || item.Description || item.description;
            const maxPrice = item.valor_venda || null;
            const quantity = item.quantidade || 1;
            
            logger.log(`🔧 [Item ${id}] Analisando: "${description.substring(0, 30)}..." (Max: R$${maxPrice}, Qtd: ${quantity})`);
            let itemPage = null;
            try { itemPage = await browser.newPage(); } catch(e) { return; }

            try {
                // PHASE 1: DISCOVERY (Gemini)
                logger.log(`🤖 [Item ${id}] Consultando Gemini...`);
                const searchQueries = await discoverModels(description);

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

                    try {
                        const searchResults = await searchAndScrape(itemPage, query);
                        for (const res of searchResults) {
                            if (!res.price) continue;
                            if (!uniqueUrls.has(res.link)) {
                                uniqueUrls.add(res.link);
                                allCandidates.push(res);
                            }
                        }
                    } catch (err) {
                        if (err.message === 'BLOCKED_BY_PORTAL') {
                            logger.log(`⛔ [Item ${id}] BLOQUEADO pelo Mercado Livre. Abortando item.`);
                            logger.thought(id, 'error', "Acesso bloqueado pelo portal durante a busca.");
                            throw err; // Escalate to stop worker or handle
                        }
                        logger.log(`⚠️ [Item ${id}] Erro na busca de "${query}": ${err.message}`);
                    }
                }

                if (allCandidates.length === 0) {
                     logger.log(`⚠️ [Item ${id}] Nada encontrado.`);
                     logger.thought(id, 'error', "Nenhum candidato encontrado nos marketplaces.");
                     finalResults.push({ id, description, valor_venda: maxPrice, quantidade: quantity, offers: [] });
                     return;
                }

                allCandidates.sort((a, b) => a.price - b.price);

                // PHASE 2.5: AI FILTERING (DeepSeek)
                logger.log(`🧠 [Item ${id}] Filtrando ${allCandidates.length} títulos...`);
                const filterResult = await filterTitles(description, allCandidates);

                logger.thought(id, 'filter', filterResult);

                const selectedIndices = new Set(filterResult.selected_indices);
                const filteredCandidates = allCandidates.filter((_, i) => selectedIndices.has(i));
                logger.log(`📉 [Item ${id}] Restaram ${filteredCandidates.length} candidatos.`);

                // PHASE 3: BATCH VALIDATION (DeepSeek)
                const candidatesToCheck = filteredCandidates.slice(0, 15);
                const validatedCandidates = [];
                
                const BATCH_SIZE = 5;
                for (let i = 0; i < candidatesToCheck.length; i += BATCH_SIZE) {
                    const batch = candidatesToCheck.slice(i, i + BATCH_SIZE);
                    logger.log(`🕵️ [Item ${id}] Validando lote ${i+1}-${i+batch.length}...`);

                    for (const candidate of batch) {
                         const details = await getProductDetails(itemPage, candidate.link, cep);
                         candidate.shippingCost = details.shippingCost;
                         candidate.attributes = details.attributes;
                         candidate.description = details.description;
                         candidate.totalPrice = candidate.price + candidate.shippingCost;
                    }

                    const batchResults = await validateBatchWithDeepSeek(description, batch);

                    for (let j = 0; j < batch.length; j++) {
                        const candidate = batch[j];
                        const res = batchResults.find(r => r.index === j) || { status: 'Erro', risk_score: 10 };

                        candidate.aiMatch = res.status;
                        candidate.aiReasoning = res.reasoning;
                        candidate.brand_model = res.brand_model;
                        candidate.risk_score = res.risk_score;

                        logger.thought(id, 'validation', {
                            title: candidate.title,
                            risk: candidate.risk_score,
                            reasoning: candidate.aiReasoning
                        });

                        logger.log(`📝 [Item ${id}] ${candidate.title.substring(0,15)}... Risk: ${candidate.risk_score}`);
                        validatedCandidates.push(candidate);
                    }
                }

                // PHASE 4: SELECTION (DeepSeek)
                const viable = validatedCandidates.filter(c => c.risk_score < 10);
                if (viable.length > 0) {
                     logger.log(`👨‍⚖️ [Item ${id}] Escolhendo o vencedor...`);
                     const selectionResult = await selectBestCandidate(description, viable, maxPrice, quantity);

                     logger.thought(id, 'selection', selectionResult);

                     const winnerObj = viable[selectionResult.winner_index];
                     let winnerIndex = -1;
                     if (winnerObj) {
                         winnerIndex = validatedCandidates.indexOf(winnerObj);
                         logger.log(`🏆 [Item ${id}] VENCEDOR: ${winnerObj.title} (R$ ${winnerObj.totalPrice})`);
                     }
                     finalResults.push({ id, description, valor_venda: maxPrice, quantidade: quantity, offers: validatedCandidates, winnerIndex });
                } else {
                     logger.log(`⚠️ [Item ${id}] Sem opção viável.`);
                     logger.thought(id, 'selection', "Nenhuma opção viável encontrada após validação.");
                     finalResults.push({ id, description, valor_venda: maxPrice, quantidade: quantity, offers: validatedCandidates });
                }

            } catch (err) {
                if (err.message === 'BLOCKED_BY_PORTAL') {
                    logger.log(`⛔ [Item ${id}] Processo interrompido por bloqueio.`);
                    // We might want to stop everything, but 'p-limit' continues others.
                    // To stop ALL, we'd need to reject and handle in Promise.all or set a global flag.
                    // For now, let's just log and fail this item.
                } else {
                    logger.log(`💥 [Item ${id}] Erro: ${err.message}`);
                    console.error(err);
                }
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
