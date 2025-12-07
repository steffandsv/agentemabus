const fs = require('fs');
const path = require('path');
const { askGemini, googleSearch } = require('./google_services');

// Helper: Simple template engine
function renderTemplate(template, data) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        return data[key] || `[${key} not found]`;
    });
}

// Helper: Extract JSON from markdown code block if present
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

// Generic DeepSeek Caller
async function callDeepSeek(messages, model = "deepseek-chat") {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        console.warn("DEEPSEEK_API_KEY missing. Falling back to Gemini for safety.");
        return null;
    }

    let apiEndpoint = 'https://api.deepseek.com/chat/completions';
    if (process.env.DEEPSEEK_API_URL) apiEndpoint = process.env.DEEPSEEK_API_URL;

    try {
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model === 'deepseek-v3.2' ? 'deepseek-reasoner' : model,
                messages: messages,
                stream: false
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API Error ${response.status}: ${errText}`);
        }

        const json = await response.json();
        return {
            content: json.choices[0].message.content,
            reasoning_content: json.choices[0].message.reasoning_content || null
        };
    } catch (error) {
        console.error(`DeepSeek API Error (${model}):`, error.message);
        return null; // Fallback
    }
}

// 1. Discover Models (GEMINI ONLY)
async function discoverModels(description) {
    const templatePath = path.join(__dirname, '../prompts/model_discovery.txt');
    let template;
    try {
        template = fs.readFileSync(templatePath, 'utf-8');
    } catch (e) {
        return [{ term: description.substring(0, 50), risk: 0, reasoning: "Template Error" }];
    }

    let webContext = "N/A";
    try {
        const googleQuery = `melhor custo beneficio ${description.substring(0, 60)} 2024 review`;
        const searchResults = await googleSearch(googleQuery);
        if (searchResults && searchResults.length > 0) {
            webContext = searchResults.map(r => `- ${r.title}: ${r.snippet}`).join('\n');
        }
    } catch (err) {
        console.warn("[AI] Google Search failed:", err.message);
    }

    const prompt = renderTemplate(template, {
        DESCRIPTION: description,
        WEB_CONTEXT: webContext
    });

    const resultText = await askGemini(prompt);

    try {
        const jsonStr = extractJson(resultText);
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed.search_terms)) {
            if (typeof parsed.search_terms[0] === 'string') {
                return parsed.search_terms.map(t => ({ term: t, risk: 0, reasoning: "Legacy format" }));
            }
            return parsed.search_terms;
        }
        return [{ term: description.substring(0, 50), risk: 0, reasoning: "Fallback" }];
    } catch (e) {
        console.error("Error parsing discoverModels:", e);
        return [{ term: description.substring(0, 50), risk: 0, reasoning: "Parse Error" }];
    }
}

// 2. Filter Titles (DEEPSEEK PREFERRED)
async function filterTitles(requiredSpecs, candidates) {
    const templatePath = path.join(__dirname, '../prompts/title_filtering.txt');
    let template;
    try {
        template = fs.readFileSync(templatePath, 'utf-8');
    } catch (e) {
        return { selected_indices: candidates.map((_, i) => i), reasoning: "Template Error" };
    }

    const candidatesList = candidates.map((c, i) => `[${i}] ${c.title} - R$ ${c.price}`).join('\n');
    const prompt = renderTemplate(template, {
        REQUIRED_SPECS: requiredSpecs,
        CANDIDATES_LIST: candidatesList
    });

    // Try DeepSeek first
    let result = await callDeepSeek([{ role: "user", content: prompt }], "deepseek-chat");

    // Fallback to Gemini if DeepSeek fails/missing
    if (!result) {
        const geminiRes = await askGemini(prompt);
        result = { content: geminiRes };
    }

    try {
        const jsonStr = extractJson(result.content);
        const parsed = JSON.parse(jsonStr);
        return {
            selected_indices: parsed.selected_indices || candidates.map((_, i) => i),
            reasoning: parsed.reasoning || result.reasoning_content || "AI Filtered"
        };
    } catch (e) {
        console.error("Error parsing filterTitles:", e);
        return { selected_indices: candidates.map((_, i) => i), reasoning: "Parse Error" };
    }
}

// 3. Batch Validation (DEEPSEEK PREFERRED)
async function validateBatchWithDeepSeek(requiredSpecs, candidates) {
    if (!candidates || candidates.length === 0) return [];

    const templatePath = path.join(__dirname, '../prompts/batch_validation.txt');
    let template;
    try {
        template = fs.readFileSync(templatePath, 'utf-8');
    } catch (e) {
        return candidates.map((_, i) => ({ index: i, status: "Erro", risk_score: 10 }));
    }

    // Prepare minimal JSON for token efficiency
    const candidatesMin = candidates.map((c, i) => ({
        index: i,
        title: c.title,
        attributes: c.attributes,
        description: (c.description || "").substring(0, 800) // Limit length
    }));

    const prompt = renderTemplate(template, {
        REQUIRED_SPECS: requiredSpecs,
        CANDIDATES_JSON: JSON.stringify(candidatesMin, null, 2)
    });

    let result = await callDeepSeek([{ role: "user", content: prompt }], "deepseek-chat");

    // Fallback to Gemini
    if (!result) {
        const geminiRes = await askGemini(prompt);
        result = { content: geminiRes };
    }

    try {
        const jsonStr = extractJson(result.content);
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) return parsed;
        return [];
    } catch (e) {
        console.error("Error parsing batch validation:", e);
        return [];
    }
}

// Legacy Single Validation (Wrapper)
async function validateProductWithAI(requiredSpecs, productDetails) {
    const batchResult = await validateBatchWithDeepSeek(requiredSpecs, [productDetails]);
    if (batchResult.length > 0) return batchResult[0];
    return { status: "Erro", risk_score: 10, reasoning: "Validation Failed" };
}

// 4. Select Best Candidate (DEEPSEEK PREFERRED)
async function selectBestCandidate(description, candidates, maxPrice = null, quantity = 1) {
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
        MAX_PRICE: maxPrice ? maxPrice.toFixed(2) : "Não informado",
        QUANTITY: quantity,
        CANDIDATES_JSON: JSON.stringify(candidatesSimple, null, 2)
    });

    let result = await callDeepSeek([{ role: "user", content: prompt }], "deepseek-reasoner");
    if (!result) {
        const geminiRes = await askGemini(prompt);
        result = { content: geminiRes };
    }

    try {
        const jsonStr = extractJson(result.content);
        const parsed = JSON.parse(jsonStr);
        return {
            winner_index: parsed.winner_index,
            reasoning: parsed.reasoning || result.reasoning_content
        };
    } catch (e) {
        console.error('Error parsing selection response:', e);
        const sorted = candidatesSimple.sort((a,b) => {
            if (a.ai_risk !== b.ai_risk) return a.ai_risk - b.ai_risk;
            return a.total_price - b.total_price;
        });
        return {
            winner_index: sorted[0].index,
            reasoning: "Fallback logic"
        };
    }
}

module.exports = { 
    discoverModels,
    filterTitles,
    validateProductWithAI,
    validateBatchWithDeepSeek,
    selectBestCandidate 
};
