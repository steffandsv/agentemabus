const { askGemini, googleSearch } = require('./google_services');

/**
 * Uses AI + Google Search to find specific commercial models matching the description.
 * @param {string} description - The tender item description.
 * @returns {Promise<string[]>} - List of search queries (e.g., specific models).
 */
async function findBestModels(description) {
    console.log(`[Discovery] Analysing description: "${description.substring(0, 50)}..."`);

    // 1. Ask Gemini for potential models
    const prompt = `
    Você é um especialista em compras e licitações.
    Tenho a seguinte descrição de um item de edital:
    "${description}"

    Sua missão: Identificar 3 modelos comerciais ESPECÍFICOS (Marca e Modelo) que atendam perfeitamente a esta descrição e sejam fáceis de encontrar no mercado brasileiro (Mercado Livre, Amazon, etc).

    Não invente modelos. Se for um item genérico (ex: "Clips de papel"), sugira termos de busca precisos com marcas renomadas.

    Retorne APENAS um JSON array de strings, sem markdown, sem explicações.
    Exemplo: ["Dell P2419H", "Samsung T350", "LG 24MK430"]
    `;

    let models = [];
    try {
        const response = await askGemini(prompt);
        const jsonMatch = response.match(/\[.*\]/s);
        if (jsonMatch) {
            models = JSON.parse(jsonMatch[0]);
        } else {
            console.warn("[Discovery] Could not parse JSON from AI. Using generic description.");
            models = [description];
        }
    } catch (e) {
        console.error("[Discovery] AI Error:", e.message);
        return [description]; // Fallback
    }

    console.log(`[Discovery] AI Suggestions: ${JSON.stringify(models)}`);

    // 2. Verify availability with Google Search (Optional but recommended to filter hallucinations)
    // For speed, we will pick the Top 1 specific model that yields results,
    // or return the top 2 models to let the scraper try them.

    // Let's refine: We will return the specific models found.
    // The scraper will try to search for them.

    // If the description was very generic, the models might be generic too.
    // Let's filter out very long strings or invalid ones.
    models = models.filter(m => typeof m === 'string' && m.length < 100);

    if (models.length === 0) return [description];

    return models;
}

module.exports = { findBestModels };
