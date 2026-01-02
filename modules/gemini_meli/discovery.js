const { getSetting } = require('../../src/database');
const { generateText, PROVIDERS } = require('../../src/services/ai_manager');

/**
 * Discovery Phase: Understand the item and strategy.
 * Uses AI Config.
 * @param {string} itemDescription
 * @param {object} config { provider, model, apiKey }
 */
async function analyzeItemStrategy(itemDescription, config = {}) {
    // Load Settings (Fallback to DB if config missing props)
    const provider = config.provider || await getSetting('sniper_provider') || PROVIDERS.GEMINI;
    const model = config.model || await getSetting('sniper_model') || 'gemini-2.0-flash-exp';
    const apiKey = config.apiKey || await getSetting('sniper_api_key') || process.env.GEMINI_API_KEY;

    // Prompt
    const prompt = `
    Você é um especialista em compras públicas e e-commerce.
    Analise o seguinte item de um edital de licitação: "${itemDescription}"

    Determine a melhor estratégia de busca:
    1. "SPECIFIC_BRAND": O item exige uma marca/modelo específico ou é muito técnico? (Ex: "Notebook Dell Latitude 5420", "Iphone 15").
    2. "GENERIC_OPTIMIZED": O item é genérico e aceita similares? (Ex: "Caneta azul", "Cadeira de escritório").

    Retorne APENAS um JSON:
    {
        "strategy": "SPECIFIC_BRAND" | "GENERIC_OPTIMIZED",
        "search_terms": ["termo 1", "termo 2"], // Termos otimizados para busca no Mercado Livre/Google
        "negative_terms": ["usado", "defeito"], // Termos para excluir
        "min_price_estimate": 100.00, // Estimativa conservadora de preço mínimo
        "required_specs": ["spec1", "spec2"] // Lista de specs obrigatórias
    }
    `;

    try {
        const messages = [{ role: 'user', content: prompt }];
        const resultText = await generateText({ provider, model, apiKey, messages });

        // JSON Extract
        const jsonMatch = resultText.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error("No JSON found");
        return JSON.parse(jsonMatch[0]);

    } catch (e) {
        console.error("Discovery AI Failed:", e);
        // Fallback
        return {
            strategy: "GENERIC_OPTIMIZED",
            search_terms: [itemDescription],
            negative_terms: [],
            min_price_estimate: 0,
            required_specs: []
        };
    }
}

module.exports = { analyzeItemStrategy };
