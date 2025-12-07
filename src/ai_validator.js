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
        return [{ term: description.substring(0, 50), risk: 0, reasoning: "Template Error" }];
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

        // Handle new Object structure
        if (Array.isArray(parsed.search_terms)) {
            // Check if it's an array of strings (legacy) or objects
            if (typeof parsed.search_terms[0] === 'string') {
                return parsed.search_terms.map(t => ({ term: t, risk: 0, reasoning: "Legacy format" }));
            }
            return parsed.search_terms;
        }
        return [{ term: description.substring(0, 50), risk: 0, reasoning: "Fallback" }];
    } catch (e) {
        console.error("Error parsing discoverModels response:", e);
        // Fallback: use the description itself if AI fails
        return [{ term: description.substring(0, 50), risk: 0, reasoning: "Parse Error" }];
    }
}

// 2. Filter Titles
async function filterTitles(requiredSpecs, candidates) {
    const templatePath = path.join(__dirname, '../prompts/title_filtering.txt');
    let template;
    try {
        template = fs.readFileSync(templatePath, 'utf-8');
    } catch (e) {
        console.error("Error reading title_filtering template:", e);
        return { selected_indices: candidates.map((_, i) => i), reasoning: "Template Error" };
    }

    // Format candidates list
    const candidatesList = candidates.map((c, i) => `[${i}] ${c.title} - R$ ${c.price}`).join('\n');

    const prompt = renderTemplate(template, {
        REQUIRED_SPECS: requiredSpecs,
        CANDIDATES_LIST: candidatesList
    });

    try {
        const resultText = await askGemini(prompt);
        const jsonStr = extractJson(resultText);
        const parsed = JSON.parse(jsonStr);

        return {
            selected_indices: parsed.selected_indices || candidates.map((_, i) => i), // Fallback to all if parse fails
            reasoning: parsed.reasoning || "Filtered by AI"
        };
    } catch (e) {
        console.error("Error in filterTitles:", e);
        return {
            selected_indices: candidates.map((_, i) => i),
            reasoning: "Error in AI filtering"
        };
    }
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
