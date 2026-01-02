const { GoogleGenerativeAI } = require("@google/generative-ai"); // Legacy for now or replace?
const { getSetting } = require('../../src/database');
const { generateStream, PROVIDERS } = require('../../src/services/ai_manager');

/**
 * Discovery Phase: Understand the item and strategy.
 * Uses AI Config.
 */
async function analyzeItemStrategy(itemDescription) {
    // Load Settings
    const provider = await getSetting('sniper_provider') || PROVIDERS.GEMINI;
    const model = await getSetting('sniper_model') || 'gemini-2.0-flash-exp';
    const apiKey = await getSetting('sniper_api_key') || process.env.GEMINI_API_KEY;

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
        let resultText = "";

        // Use AI Manager (simulate non-stream via stream if needed, or just collect)
        await new Promise((resolve, reject) => {
            generateStream(
                { provider, model, apiKey, messages: [{ role: 'user', content: prompt }] },
                {
                    onChunk: (chunk) => { resultText += chunk; },
                    onDone: () => resolve(),
                    onError: (e) => reject(e)
                }
            );
        });

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
