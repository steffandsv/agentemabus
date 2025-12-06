const fs = require('fs');
const path = require('path');

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
    if (!apiKey) return null; 

    // Endpoint switching based on user request for "DeepSeek V3.2" special beta endpoint
    let apiEndpoint = 'https://api.deepseek.com/chat/completions'; // Default
    
    // User requested special endpoint for V3.2 agents reasoning
    if (model === 'deepseek-reasoner' || model === 'deepseek-v3.2') {
        // Assuming the user meant this specific URL for the 'reasoner' logic
        apiEndpoint = 'https://api.deepseek.com/v3.2_speciale_expires_on_20251215/chat/completions';
    }

    // Allow override via ENV
    if (process.env.DEEPSEEK_API_URL) {
        apiEndpoint = process.env.DEEPSEEK_API_URL;
    }

    try {
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model === 'deepseek-v3.2' ? 'deepseek-reasoner' : model, // Fallback if name differs
                messages: messages,
                stream: false
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API Error ${response.status}: ${errText}`);
        }

        const json = await response.json();
        // Return object with content and reasoning (if available)
        return {
            content: json.choices[0].message.content,
            reasoning_content: json.choices[0].message.reasoning_content || null
        };
    } catch (error) {
        console.error(`DeepSeek API Error (${model}) at ${apiEndpoint}:`, error.message);
        throw error;
    }
}

// 1. Generate Query
async function generateSearchQuery(description) {
    const templatePath = path.join(__dirname, '../prompts/query_generation.txt');
    let template;
    try {
        template = fs.readFileSync(templatePath, 'utf-8');
    } catch (e) {
        return description.split(' ').slice(0, 4).join(' '); 
    }

    const prompt = renderTemplate(template, { DESCRIPTION: description });
    const result = await callDeepSeek([{ role: "user", content: prompt }], "deepseek-chat");

    if (!result || !result.content) {
        console.log('Mocking Query Gen...');
        return description.split(';')[0].substring(0, 50).trim(); 
    }
    return result.content.trim().replace(/^"|"$/g, '');
}

// 2. Filter Titles
async function filterCandidatesByTitle(requiredSpecs, candidates) {
    const templatePath = path.join(__dirname, '../prompts/title_filtering.txt');
    let template;
    try {
        template = fs.readFileSync(templatePath, 'utf-8');
    } catch (e) { 
        return { selected_indices: candidates.map((_, i) => i), reasoning_content: "Erro ao ler template." }; 
    }

    const candidatesList = candidates.map((c, i) => `[${i}] ${c.title} - R$ ${c.price}`).join('\n');
    const prompt = renderTemplate(template, {
        REQUIRED_SPECS: requiredSpecs,
        CANDIDATES_LIST: candidatesList
    });

    const result = await callDeepSeek([{ role: "user", content: prompt }], "deepseek-reasoner");

    if (!result || !result.content) {
        return { 
            selected_indices: [0, 1, 2, 3, 4].filter(i => i < candidates.length),
            reasoning_content: "Mock AI: Filtragem simulada."
        };
    }

    try {
        const jsonStr = extractJson(result.content);
        const parsed = JSON.parse(jsonStr);
        return {
            selected_indices: parsed.selected_indices || [],
            reasoning_content: result.reasoning_content
        };
    } catch (e) {
        console.error('Error parsing title filter response:', e);
        return {
            selected_indices: [0, 1, 2, 3, 4].filter(i => i < candidates.length),
            reasoning_content: "Erro ao parsear JSON da IA."
        };
    }
}

// 3. Final Validation
async function validateProductWithAI(requiredSpecs, productDetails) {
    const templatePath = path.join(__dirname, '../prompts/final_validation.txt');
    let template;
    try {
        template = fs.readFileSync(templatePath, 'utf-8');
    } catch (e) { return { status: "Erro", reasoning: "Template error", brand_model: "N/A", risk_score: 10 }; }

    const data = {
        REQUIRED_SPECS: requiredSpecs,
        PRODUCT_TITLE: productDetails.title,
        PRODUCT_ATTRIBUTES: JSON.stringify(productDetails.attributes, null, 2),
        PRODUCT_DESCRIPTION: (productDetails.description || "").substring(0, 2000)
    };

    const prompt = renderTemplate(template, data);
    const result = await callDeepSeek([{ role: "user", content: prompt }], "deepseek-reasoner");

    if (!result || !result.content) {
        // Mock
        const rand = Math.random();
        let status = "Incompatível";
        let risk = 10;
        if (rand > 0.6) { status = "Perfeito"; risk = 0; }
        else if (rand > 0.3) { status = "Necessita Atenção"; risk = 3; }
        
        return {
            status: status,
            reasoning: `Mock AI (Reasoner): Simulação de status ${status}.`,
            brand_model: "Marca Mock / Modelo Mock",
            risk_score: risk,
            reasoning_content: "Este é um pensamento simulado. Na vida real, eu estaria analisando cada volt e byte deste produto com a precisão de um cirurgião digital."
        };
    }

    try {
        const jsonStr = extractJson(result.content);
        const parsed = JSON.parse(jsonStr);
        return {
            status: parsed.status || "Incompatível", 
            reasoning: parsed.reasoning,
            brand_model: parsed.brand_model || "Não identificado",
            risk_score: typeof parsed.risk_score === 'number' ? parsed.risk_score : 10,
            reasoning_content: result.reasoning_content 
        };
    } catch (e) {
        console.error('Error parsing validation response:', e);
        return { status: "Erro", reasoning: "AI Error: Invalid JSON response.", brand_model: "Erro", risk_score: 10, reasoning_content: null };
    }
}

// 4. Select Best Candidate (The "Judge")
async function selectBestCandidate(description, candidates) {
    const templatePath = path.join(__dirname, '../prompts/final_selection.txt');
    let template;
    try {
        template = fs.readFileSync(templatePath, 'utf-8');
    } catch (e) { return { winner_index: 0, reasoning_content: "Template error" }; }

    // Simplify candidates for prompt
    const candidatesSimple = candidates.map((c, i) => ({
        index: i,
        title: c.title,
        total_price: c.totalPrice,
        ai_status: c.aiMatch,
        ai_risk: c.risk_score, // New field
        ai_reasoning: c.aiReasoning
    }));

    const prompt = renderTemplate(template, {
        ITEM_DESCRIPTION: description,
        CANDIDATES_JSON: JSON.stringify(candidatesSimple, null, 2)
    });

    const result = await callDeepSeek([{ role: "user", content: prompt }], "deepseek-reasoner");

    if (!result || !result.content) {
        return { winner_index: 0, reasoning_content: "Mock AI: Seleção simulada." }; 
    }

    try {
        const jsonStr = extractJson(result.content);
        const parsed = JSON.parse(jsonStr);
        return {
            winner_index: parsed.winner_index,
            reasoning_content: result.reasoning_content
        };
    } catch (e) {
        console.error('Error parsing selection response:', e);
        return { winner_index: 0, reasoning_content: "Erro ao parsear seleção." };
    }
}

module.exports = { 
    generateSearchQuery, 
    filterTitles: filterCandidatesByTitle, 
    validateProductWithAI,
    selectBestCandidate 
};
