const { searchAndScrape, getProductDetails, initBrowser, setCEP } = require('./scraper');
const { analyzeItemStrategy } = require('./discovery'); // Use standardized name
const { filterTitles, validateBatchWithDeepSeek, selectBestCandidate } = require('./ai');
const { resolveAmbiguityWithPerplexity } = require('./verifier');

async function execute(job, config) {
    const { id, description, maxPrice, quantity, browser, cep, logger } = job;
    // config contains { provider, model, apiKey }

    // Page context
    let itemPage = null;
    try { itemPage = await browser.newPage(); } catch(e) { return null; }

    try {
        // PHASE 1: DISCOVERY
        logger.log(`🤖 [Item ${id}] Consultando IA (${config.provider || 'default'})...`);

        // Pass config to Discovery
        const strategyResult = await analyzeItemStrategy(description, config);

        // Strategy Result: { strategy, search_terms, negative_terms, ... }
        // Map to what this module expects: array of { term, risk, reasoning } or strings?
        // Existing code expects array of objects or strings.
        // Let's assume search_terms are strings.
        const searchQueries = strategyResult.search_terms || [description];

        logger.log(`🔍 [Item ${id}] ${searchQueries.length} termos sugeridos.`);

        // PHASE 2: SEARCH & DEDUPLICATION
        const uniqueUrls = new Set();
        let allCandidates = [];

        for (const queryTerm of searchQueries) {
            // Existing logic handled 'queryObj', but analyzeItemStrategy returns list of strings.
            // Simplified loop
            const query = queryTerm;

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
                if (err.message === 'BLOCKED_BY_PORTAL') throw err;
                logger.log(`⚠️ [Item ${id}] Erro na busca: ${err.message}`);
            }
        }

        if (allCandidates.length === 0) {
             logger.log(`⚠️ [Item ${id}] Nada encontrado.`);
             logger.thought(id, 'error', "Nenhum candidato encontrado.");
             return { id, description, valor_venda: maxPrice, quantidade: quantity, offers: [] };
        }

        allCandidates.sort((a, b) => a.price - b.price);

        // PHASE 2.5: AI FILTERING
        logger.log(`🧠 [Item ${id}] Filtrando ${allCandidates.length} títulos...`);
        // Pass config to AI
        const filterResult = await filterTitles(description, allCandidates, config);
        logger.thought(id, 'filter', filterResult);

        const selectedIndices = new Set(filterResult.selected_indices);
        const filteredCandidates = allCandidates.filter((_, i) => selectedIndices.has(i));
        logger.log(`📉 [Item ${id}] Restaram ${filteredCandidates.length} candidatos.`);

        // PHASE 3: BATCH VALIDATION
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

            // Pass config to Batch Validation
            const batchResults = await validateBatchWithDeepSeek(description, batch, config);

            for (let j = 0; j < batch.length; j++) {
                const candidate = batch[j];
                const res = batchResults.find(r => r.index === j) || { status: 'Erro', risk_score: 10 };

                candidate.aiMatch = res.status;
                candidate.aiReasoning = res.reasoning;
                // Capture new fields from AI
                candidate.is_brand_mismatch = res.is_brand_mismatch;
                candidate.is_dimension_mismatch = res.is_dimension_mismatch;
                candidate.data_gaps = res.data_gaps;

                // If the prompt returns technical_score instead of risk_score directly, map it.
                // The new prompt returns "technical_score" (0-10).
                // The rest of the system expects "risk_score" (often 0-10 or High/Low).
                // Map technical_score to risk_score:
                // Tech Score 10 -> Risk 0
                // Tech Score 0 -> Risk 10
                if (res.technical_score !== undefined) {
                    candidate.risk_score = 10 - res.technical_score;
                    candidate.technical_score = res.technical_score;
                } else {
                     candidate.risk_score = res.risk_score || 10;
                }

                logger.thought(id, 'validation', {
                    title: candidate.title,
                    risk: candidate.risk_score,
                    reasoning: candidate.aiReasoning
                });

                logger.log(`📝 [Item ${id}] Risk: ${candidate.risk_score}`);
                validatedCandidates.push(candidate);
            }
        }

        // PHASE 3.5: GAP VERIFICATION (PERPLEXITY)
        // Identify "Missing Info" candidates (Risk 5)
        const ambiguousCandidates = validatedCandidates.filter(c => c.risk_score === 5);
        if (ambiguousCandidates.length > 0) {
            logger.log(`🕵️ [Item ${id}] Verificando ${ambiguousCandidates.length} itens incertos com Perplexity...`);
            
            for (const cand of ambiguousCandidates) {
                logger.log(`🤖 [Item ${id}] Verificando detalhes: ${cand.title}`);
                const verification = await resolveAmbiguityWithPerplexity(description, cand, config);
                
                if (verification) {
                    logger.thought(id, 'verification', verification);
                    
                    // Update Risk based on Perplexity
                    if (verification.risk_score !== undefined) {
                         cand.risk_score = verification.risk_score;
                         cand.aiReasoning = `(Verified) ${verification.reasoning}`;
                         logger.log(`📝 [Item ${id}] Novo Risco: ${cand.risk_score}`);
                    }
                }
            }
        }

        // PHASE 4: SELECTION
        const viable = validatedCandidates.filter(c => c.risk_score < 10);
        let winnerIndex = -1;
        if (viable.length > 0) {
             logger.log(`👨‍⚖️ [Item ${id}] Escolhendo o vencedor...`);
             // Pass config to Selection
             const selectionResult = await selectBestCandidate(description, viable, maxPrice, quantity, config);
             logger.thought(id, 'selection', selectionResult);

             const winnerObj = viable[selectionResult.winner_index];
             if (winnerObj) {
                 winnerIndex = validatedCandidates.indexOf(winnerObj);
                 logger.log(`🏆 [Item ${id}] VENCEDOR: ${winnerObj.title} (R$ ${winnerObj.totalPrice})`);
             }
        } else {
             logger.log(`⚠️ [Item ${id}] Sem opção viável.`);
             logger.thought(id, 'selection', "Nenhuma opção viável.");
        }

        return { id, description, valor_venda: maxPrice, quantidade: quantity, offers: validatedCandidates, winnerIndex };

    } catch (err) {
        throw err;
    } finally {
        if (itemPage) await itemPage.close();
    }
}

module.exports = { execute, initBrowser, setCEP };
