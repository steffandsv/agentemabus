const { searchAndScrape, getProductDetails, initBrowser, setCEP } = require('./scraper');
const { discoverModels } = require('./discovery');
const { filterTitles, validateBatchWithDeepSeek, selectBestCandidate } = require('./ai');

async function execute(job, dependencies) {
    const { id, description, maxPrice, quantity, browser, cep, logger } = job;

    // Page context
    let itemPage = null;
    try { itemPage = await browser.newPage(); } catch(e) { return null; }

    try {
        // PHASE 1: DISCOVERY (Gemini)
        logger.log(`🤖 [Item ${id}] Consultando Gemini (Meli)...`);
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
        const filterResult = await filterTitles(description, allCandidates);
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

                logger.log(`📝 [Item ${id}] Risk: ${candidate.risk_score}`);
                validatedCandidates.push(candidate);
            }
        }

        // PHASE 4: SELECTION
        const viable = validatedCandidates.filter(c => c.risk_score < 10);
        let winnerIndex = -1;
        if (viable.length > 0) {
             logger.log(`👨‍⚖️ [Item ${id}] Escolhendo o vencedor...`);
             const selectionResult = await selectBestCandidate(description, viable, maxPrice, quantity);
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
