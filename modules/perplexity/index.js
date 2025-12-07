const { askPerplexity } = require('./client');
const { scrapeGeneric } = require('./scraper');
const { callDeepSeek } = require('../../src/services/deepseek');
const { initBrowser } = require('../gemini_meli/scraper'); // Reuse browser init for now

// Re-use logic for selection/validation from gemini_meli or create new?
// "DeepSeek is cheap enough to process everything"
// We can import the generic validateBatchWithDeepSeek if we refactor it to shared.
// For now, I will duplicate or import from sibling (bad practice but fast).
// Better: Refactor `validateBatchWithDeepSeek` to `src/services/deepseek.js` helper?
// Actually, `src/services/deepseek.js` is just the client.
// I'll copy the validation logic or import it.
const { validateBatchWithDeepSeek, selectBestCandidate } = require('../gemini_meli/ai');

async function execute(job, dependencies) {
    const { id, description, maxPrice, quantity, browser, logger } = job;
    let page = null;

    try {
        // 1. Search with Perplexity
        logger.log(`🤖 [Item ${id}] Perplexity: Buscando preços...`);
        logger.thought(id, 'discovery', "Consultando Perplexity para encontrar links diretos.");

        const query = `Encontre o menor preço para: "${description}" no Brasil. Retorne APENAS um JSON array com objetos: { title, price, link }. Ignore marketplaces internacionais.`;
        const perplexityRaw = await askPerplexity(query);

        let candidates = [];
        try {
            // Extract JSON
            const jsonMatch = perplexityRaw.match(/\[.*\]/s);
            if (jsonMatch) {
                candidates = JSON.parse(jsonMatch[0]);
            }
        } catch (e) {
            logger.log(`⚠️ [Item ${id}] Falha ao ler resposta do Perplexity.`);
        }

        logger.log(`🔍 [Item ${id}] Encontrados ${candidates.length} links.`);

        if (candidates.length === 0) {
             return { id, description, valor_venda: maxPrice, quantidade: quantity, offers: [] };
        }

        // 2. Scrape & Validate
        const validCandidates = [];
        page = await browser.newPage();

        for (const cand of candidates) {
            logger.log(`📡 [Item ${id}] Acessando: ${cand.link}`);
            const scraped = await scrapeGeneric(page, cand.link);

            cand.description = scraped.text;
            cand.attributes = {}; // extracted from text?
            if (!cand.price && scraped.price) cand.price = scraped.price;
            cand.totalPrice = cand.price; // Assume shipping included or unknown

            // Validate
            const batchResult = await validateBatchWithDeepSeek(description, [cand]);
            const res = batchResult[0] || { status: 'Erro', risk_score: 10 };

            cand.risk_score = res.risk_score;
            cand.aiReasoning = res.reasoning;
            cand.brand_model = res.brand_model;

            logger.thought(id, 'validation', {
                title: cand.title,
                risk: cand.risk_score,
                reasoning: cand.aiReasoning
            });

            validCandidates.push(cand);
        }

        // 3. Select
        const viable = validCandidates.filter(c => c.risk_score < 10);
        let winnerIndex = -1;
        if (viable.length > 0) {
             const selectionResult = await selectBestCandidate(description, viable, maxPrice, quantity);
             logger.thought(id, 'selection', selectionResult);
             const winnerObj = viable[selectionResult.winner_index];
             if (winnerObj) {
                 winnerIndex = validCandidates.indexOf(winnerObj);
                 logger.log(`🏆 [Item ${id}] VENCEDOR: ${winnerObj.title}`);
             }
        }

        return { id, description, valor_venda: maxPrice, quantidade: quantity, offers: validCandidates, winnerIndex };

    } catch (e) {
        logger.log(`💥 [Item ${id}] Erro Perplexity: ${e.message}`);
        return { id, description, offers: [] };
    } finally {
        if (page) await page.close();
    }
}

// Reuse setCEP from scraper if needed, or dummy
async function setCEP(page, cep) {
    // Perplexity might not need CEP injection if it searches Google Shopping/etc.
    // But if we scrape ML links found by Perplexity, we might need it.
    // We can reuse the one from gemini_meli if we scrape ML.
    // For now, assume generic scraping doesn't set CEP.
    return;
}

module.exports = { execute, initBrowser, setCEP };
