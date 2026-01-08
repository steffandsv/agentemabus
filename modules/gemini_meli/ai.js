const path = require('path');
const fs = require('fs');
const { callDeepSeek } = require('../../src/services/deepseek');
const { askGemini } = require('../../src/services/gemini');

// Helper: Simple template engine
function renderTemplate(template, data) {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
        return data[key] || `[${key} not found]`;
    });
}

function extractJson(text) {
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) return jsonMatch[1];
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) return text.substring(start, end + 1);
    return text;
}

async function filterTitles(requiredSpecs, candidates) {
    const templatePath = path.join(__dirname, 'prompts/title_filtering.txt');
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

    let result = await callDeepSeek([{ role: "user", content: prompt }], "deepseek-chat");
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
        return { selected_indices: candidates.map((_, i) => i), reasoning: "Parse Error" };
    }
}

async function validateBatchWithDeepSeek(requiredSpecs, candidates) {
    if (!candidates || candidates.length === 0) return [];

    const templatePath = path.join(__dirname, 'prompts/batch_validation.txt');
    let template;
    try {
        template = fs.readFileSync(templatePath, 'utf-8');
    } catch (e) {
        return candidates.map((_, i) => ({ index: i, status: "Erro", risk_score: 10 }));
    }

    const candidatesMin = candidates.map((c, i) => ({
        index: i,
        title: c.title,
        attributes: c.attributes,
        description: (c.description || "").substring(0, 500)
    }));

    // The template uses {{INPUT_JSON}} based on our previous edit to `batch_validation.txt`.
    // The previous code here used {{CANDIDATES_JSON}} and {{REQUIRED_SPECS}}.
    // We must update the code to match the template placeholders.
    // The new template has:
    // ITEM DO EDITAL: {{INPUT_JSON}} ... wait, previous template was {{INPUT_JSON}}
    // But I changed it to:
    // DADOS DE ENTRADA: {{INPUT_JSON}}
    // And implicit assumption that input json has everything?
    // Let's check the prompt structure I wrote earlier.

    // The prompt `batch_validation.txt` expects {{INPUT_JSON}}.
    // And it says: "1. ITEM DO EDITAL... 2. LISTA DE CANDIDATOS".
    // I need to structure the input JSON to contain both, OR replace placeholders in prompt.
    // My previous `verifier.js` (which I replaced partially with `ai.js` logic here?)
    // Wait, `verifier.js` logic was merged into `ai.js` or `index.js` uses `ai.js`?
    // `index.js` calls `validateBatchWithDeepSeek` in `ai.js`.

    // So I need to adapt `validateBatchWithDeepSeek` to construct the prompt correctly.
    // The prompt file `batch_validation.txt` currently ends with:
    // DADOS DE ENTRADA:
    // {{INPUT_JSON}}

    // So I should construct an object that has the tender description and the candidates.

    const inputPayload = {
        item_edital: requiredSpecs,
        candidatos: candidatesMin
    };

    const prompt = template.replace('{{INPUT_JSON}}', JSON.stringify(inputPayload, null, 2));

    let result = await callDeepSeek([{ role: "user", content: prompt }], "deepseek-chat");
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
        return [];
    }
}

async function validateProductWithAI(requiredSpecs, productDetails) {
    const batchResult = await validateBatchWithDeepSeek(requiredSpecs, [productDetails]);
    if (batchResult.length > 0) return batchResult[0];
    return { status: "Erro", risk_score: 10, reasoning: "Validation Failed" };
}

async function selectBestCandidate(description, candidates, maxPrice = null, quantity = 1) {
    const templatePath = path.join(__dirname, 'prompts/final_selection.txt');
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
    filterTitles,
    validateBatchWithDeepSeek,
    selectBestCandidate,
    validateProductWithAI
};
