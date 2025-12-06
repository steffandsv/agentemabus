const fs = require('fs');
const path = require('path');
const { askGemini, googleSearch } = require('./google_services');

// Helper: Simple template engine
function renderTemplate(template, data) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        return data[key] || `[${key} not found]`;
    });
}

// Helper: Clean JSON markdown
function extractJson(text) {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) {
        return jsonMatch[1];
    }
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) {
        return text.substring(start, end + 1);
    }
    return text;
}

// 1. Discover Models (Enhanced with Google Search)
async function discoverModels(description) {
    const templatePath = path.join(__dirname, '../prompts/model_discovery.txt');
    let template;
    try {
        template = fs.readFileSync(templatePath, 'utf-8');
    } catch (e) {
        console.error("Error reading model_discovery template:", e);
        return [description.substring(0, 50)];
    }

    // Context Retrieval: Search Google to get up-to-date suggestions
    let webContext = "N/A";
    try {
        // Query Google for "best budget [description] 2024" or similar
        const googleQuery = `melhor custo beneficio ${description.substring(0, 60)} 2024 review`;
        console.log(`[AI] Buscando contexto no Google: "${googleQuery}"...`);

        const searchResults = await googleSearch(googleQuery);
        if (searchResults && searchResults.length > 0) {
            webContext = searchResults.map(r => `- ${r.title}: ${r.snippet}`).join('\n');
        }
    } catch (err) {
        console.warn("[AI] Falha na busca Google (continuando sem contexto):", err.message);
    }

    const prompt = renderTemplate(template, {
        DESCRIPTION: description,
        WEB_CONTEXT: webContext
    });

    const resultText = await askGemini(prompt);

    try {
        const jsonStr = extractJson(resultText);
        const parsed = JSON.parse(jsonStr);
        // Ensure we always return an array of strings
        if (Array.isArray(parsed.search_terms)) {
            return parsed.search_terms;
        }
        return [description.substring(0, 50)];
    } catch (e) {
        console.error("Error parsing discoverModels response:", e);
        // Fallback: use the description itself if AI fails
        return [description.substring(0, 50)];
    }
}

// 2. Filter Titles (Simplified for Gemini - Optional now if we trust model search, but kept for safety)
// We might skip this step if we are searching specific models, but let's keep it available.
async function filterTitles(description, candidates) {
    // Basic heuristic filter is often faster/cheaper than AI for this step,
    // but if we use AI, let's just reuse the validation logic later or do a quick pass.
    // For now, let's assume we pass all search results to validation if we have bandwidth (12 threads),
    // OR implement a very lightweight check.

    // For this refactor, I'll bypass this explicit "filterTitles" AI step to save tokens/time,
    // relying on the specific search queries + keyword matching in logic.js + final validation.
    // So this just returns all indices.
    return {
        selected_indices: candidates.map((_, i) => i),
        reasoning_content: "Skipping explicit AI title filter to prioritize full validation."
    };
}

// 3. Final Validation
async function validateProductWithAI(requiredSpecs, productDetails) {
    const templatePath = path.join(__dirname, '../prompts/final_validation.txt');
    let template;
    try {
        template = fs.readFileSync(templatePath, 'utf-8');
    } catch (e) {
        return { status: "Erro", reasoning: "Template error", brand_model: "N/A", risk_score: 10 };
    }

    const data = {
        REQUIRED_SPECS: requiredSpecs,
        PRODUCT_TITLE: productDetails.title,
        PRODUCT_ATTRIBUTES: JSON.stringify(productDetails.attributes, null, 2),
        PRODUCT_DESCRIPTION: (productDetails.description || "").substring(0, 2000)
    };

    const prompt = renderTemplate(template, data);
    const resultText = await askGemini(prompt);

    try {
        const jsonStr = extractJson(resultText);
        const parsed = JSON.parse(jsonStr);
        return {
            status: parsed.status || "Incompatível", 
            reasoning: parsed.reasoning || "Sem explicação",
            brand_model: parsed.brand_model || "Não identificado",
            risk_score: typeof parsed.risk_score === 'number' ? parsed.risk_score : 10
        };
    } catch (e) {
        console.error('Error parsing validation response:', e);
        return {
            status: "Erro",
            reasoning: "AI Error: Invalid JSON response.",
            brand_model: "Erro",
            risk_score: 10
        };
    }
}

// 4. Select Best Candidate
async function selectBestCandidate(description, candidates) {
    const templatePath = path.join(__dirname, '../prompts/final_selection.txt');
    let template;
    try {
        template = fs.readFileSync(templatePath, 'utf-8');
    } catch (e) { return { winner_index: 0, reasoning: "Template error" }; }

    const candidatesSimple = candidates.map((c, i) => ({
        index: i,
        title: c.title,
        total_price: c.totalPrice,
        ai_status: c.aiMatch,
        ai_risk: c.risk_score,
        brand_model: c.brand_model
    }));

    const prompt = renderTemplate(template, {
        ITEM_DESCRIPTION: description,
        CANDIDATES_JSON: JSON.stringify(candidatesSimple, null, 2)
    });

    const resultText = await askGemini(prompt);

    try {
        const jsonStr = extractJson(resultText);
        const parsed = JSON.parse(jsonStr);
        return {
            winner_index: parsed.winner_index,
            reasoning: parsed.reasoning
        };
    } catch (e) {
        console.error('Error parsing selection response:', e);
        // Fallback: Pick the one with lowest risk and price
        const sorted = candidatesSimple.sort((a,b) => {
            if (a.ai_risk !== b.ai_risk) return a.ai_risk - b.ai_risk;
            return a.total_price - b.total_price;
        });
        return {
            winner_index: sorted[0].index,
            reasoning: "Fallback logic: Lowest risk & price."
        };
    }
}

module.exports = { 
    discoverModels,
    filterTitles,
    validateProductWithAI,
    selectBestCandidate 
};
