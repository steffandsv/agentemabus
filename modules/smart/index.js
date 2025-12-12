const geminiMeli = require('../gemini_meli/index');
const perplexity = require('../perplexity/index');

async function execute(job) {
    const { logger, id } = job;

    // 1. Try Gemini + Mercado Livre
    logger.log(`🧠 [Item ${id}] Iniciando Estratégia SMART: Tentando Meli primeiro...`);
    try {
        const resultMeli = await geminiMeli.execute(job);
        
        // Analyze result
        if (resultMeli && resultMeli.winnerIndex !== -1 && resultMeli.offers && resultMeli.offers[resultMeli.winnerIndex]) {
            const winner = resultMeli.offers[resultMeli.winnerIndex];
            if (winner.risk_score < 7) { // Confidence threshold
                logger.log(`✅ [Item ${id}] Meli encontrou um bom candidato (Risco: ${winner.risk_score}). Finalizando.`);
                return resultMeli;
            } else {
                 logger.log(`⚠️ [Item ${id}] Meli encontrou vencedor, mas risco alto (${winner.risk_score}). Tentando Perplexity...`);
            }
        } else {
             logger.log(`⚠️ [Item ${id}] Meli não encontrou nada viável. Tentando Perplexity...`);
        }
    } catch (e) {
        logger.log(`⚠️ [Item ${id}] Erro no módulo Meli: ${e.message}. Tentando Perplexity...`);
    }

    // 2. Fallback to Perplexity
    logger.log(`🧠 [Item ${id}] Iniciando fallback para Perplexity...`);
    try {
        const resultPerplexity = await perplexity.execute(job);
        return resultPerplexity;
    } catch (e) {
        logger.log(`💥 [Item ${id}] Erro no módulo Perplexity: ${e.message}.`);
        // Return empty result
        return { 
            id: job.id, 
            description: job.description, 
            valor_venda: job.maxPrice, 
            quantidade: job.quantity, 
            offers: [], 
            winnerIndex: -1 
        };
    }
}

// Re-export helpers from gemini_meli as it's the primary browser controller
const { initBrowser, setCEP } = require('../gemini_meli/scraper');

module.exports = { execute, initBrowser, setCEP };
