const path = require('path');
const fs = require('fs');
const { askGemini } = require('../../src/services/gemini');
const { googleSearch } = require('../../src/google_services'); // Legacy, or we create a new one? Keeping legacy for now if needed.

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

// 1. Discover Models (GEMINI ONLY)
async function discoverModels(description) {
    const templatePath = path.join(__dirname, 'prompts/model_discovery.txt');
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

module.exports = { discoverModels };
