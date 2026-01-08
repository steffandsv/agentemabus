const fs = require('fs');
const pdf = require('pdf-parse');
const { generateText, PROVIDERS } = require('./ai_manager');
const { getSetting } = require('../database');

/**
 * Estimates token count based on character length.
 * Rough approximation: 1 token ~ 4 characters.
 */
function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

/**
 * Repairs broken JSON strings common in LLM outputs.
 */
function repairJson(text) {
    // 1. Remove markdown code blocks
    let cleaned = text.replace(/```json/g, '').replace(/```/g, '').trim();

    // 2. Find the outer-most braces/brackets
    const firstBrace = cleaned.indexOf('{');
    const lastBrace = cleaned.lastIndexOf('}');

    if (firstBrace !== -1 && lastBrace !== -1) {
        cleaned = cleaned.substring(firstBrace, lastBrace + 1);
    } else {
        // Maybe it's a list?
        const firstBracket = cleaned.indexOf('[');
        const lastBracket = cleaned.lastIndexOf(']');
        if (firstBracket !== -1 && lastBracket !== -1) {
            cleaned = cleaned.substring(firstBracket, lastBracket + 1);
        }
    }

    try {
        return JSON.parse(cleaned);
    } catch (e) {
        // Attempt simple fixes
        // Fix trailing commas
        cleaned = cleaned.replace(/,\s*}/g, '}').replace(/,\s*]/g, ']');
        try {
            return JSON.parse(cleaned);
        } catch (e2) {
            throw new Error(`Failed to parse JSON: ${e2.message} (Raw: ${cleaned.substring(0, 50)}...)`);
        }
    }
}

/**
 * Selects the best AI Strategy based on input size and availability.
 */
async function selectStrategy(tokenCount) {
    // Models (Prioritize defined keys or defaults)
    const geminiKey = process.env.GEMINI_API_KEY || await getSetting('oracle_api_key');
    const deepseekKey = process.env.DEEPSEEK_API_KEY;

    const strategies = [];

    // TIER 1: FAST / SMALL (< 30k tokens)
    if (tokenCount < 30000) {
        // User requested strict Gemini usage (v2.0+)
        if (geminiKey) strategies.push({ provider: PROVIDERS.GEMINI, model: 'gemini-2.0-flash', apiKey: geminiKey });
    }
    // TIER 2: MEDIUM (30k - 100k tokens)
    else if (tokenCount < 100000) {
         if (geminiKey) strategies.push({ provider: PROVIDERS.GEMINI, model: 'gemini-2.0-flash', apiKey: geminiKey });
    }
    // TIER 3: LARGE (> 100k tokens)
    else {
        // Gemini 2.0 Flash is also high context (1M), so it works here too.
        if (geminiKey) strategies.push({ provider: PROVIDERS.GEMINI, model: 'gemini-2.0-flash', apiKey: geminiKey });
    }

    // Add Fallbacks (in case primary fails)
    // DeepSeek as a non-Google backup
    if (deepseekKey) strategies.push({ provider: PROVIDERS.DEEPSEEK, model: 'deepseek-chat', apiKey: deepseekKey });

    // Explicitly add 'gemini-2.0-flash-lite-preview-02-05' if 2.0-flash fails (maybe strict limits?)
    if (geminiKey && !strategies.find(s => s.model === 'gemini-2.0-flash-lite-preview-02-05')) {
         strategies.push({ provider: PROVIDERS.GEMINI, model: 'gemini-2.0-flash-lite-preview-02-05', apiKey: geminiKey });
    }

    // De-duplicate
    const uniqueStrategies = [];
    const seen = new Set();
    for (const s of strategies) {
        const key = `${s.provider}-${s.model}`;
        if (!seen.has(key)) {
            seen.add(key);
            uniqueStrategies.push(s);
        }
    }

    if (uniqueStrategies.length === 0) {
        throw new Error("Nenhuma API Key configurada para Gemini (ou backup DeepSeek).");
    }

    return uniqueStrategies;
}

async function extractItemsFromPdf(files, userInstructions = "") {
    let fullText = "";

    // 1. Extract Text
    for (const file of files) {
        try {
            const dataBuffer = fs.readFileSync(file.path);
            const data = await pdf(dataBuffer);
            fullText += `\n--- FILE: ${file.originalname} ---\n${data.text}`;
        } catch (e) {
            console.error(`Error parsing PDF ${file.originalname}:`, e);
        }
    }

    if (!fullText.trim()) throw new Error("Não foi possível extrair texto dos arquivos.");

    const tokenCount = estimateTokens(fullText);
    console.log(`[PDF Parser] Total Tokens (Approx): ${tokenCount}`);

    // Select Strategy
    const strategyQueue = await selectStrategy(tokenCount);

    // Construct Prompt
    const systemPrompt = `Você é um especialista em licitações e extração de dados.
    Sua missão é converter editais brutos em JSON estruturado para importação.

    REGRAS CRÍTICAS:
    1. Retorne APENAS o JSON. Sem markdown, sem explicações, sem \`\`\`.
    2. A estrutura deve ser EXATAMENTE:
       {
         "metadata": { "name": "...", "cep": "..." },
         "items": [ { "id": "1", "description": "...", "quantidade": 1, "valor_venda": 0.00 } ]
       }
    3. Se houver instruções extras do usuário, siga-as com prioridade.
    `;

    const userPrompt = `
    ${userInstructions ? `INSTRUÇÕES DO USUÁRIO: ${userInstructions}\n` : ''}

    Extraia os itens deste texto.
    - "valor_venda" é o valor máximo/estimado unitário. Se não achar, use 0.
    - "id" deve ser o número do item no edital.
    - Procure o CEP de entrega no texto.

    TEXTO DO EDITAL:
    ${fullText.substring(0, 4000000)}
    `;
    // Truncate at 4M chars (~1M tokens) to be safe for Gemini 1.5 Pro,
    // though it handles more. For others, let's hope they handle context or fail to fallback.
    // Ideally we should truncate per model, but keeping it simple for now.

    let lastError = null;

    // Try strategies in order
    for (const strategy of strategyQueue) {
        console.log(`[PDF Parser] Attempting with ${strategy.provider} (${strategy.model})...`);

        try {
            const config = {
                provider: strategy.provider,
                model: strategy.model,
                apiKey: strategy.apiKey,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: userPrompt }
                ]
            };

            const responseText = await generateText(config);
            const result = repairJson(responseText);

            // Basic Validation
            if (!result.items || !Array.isArray(result.items)) {
                throw new Error("JSON retornado não contém array de 'items'.");
            }

            // Sanitize Items (Ensure numbers for frontend compatibility)
            result.items = result.items.map(item => {
                let val = item.valor_venda;
                let qtd = item.quantidade;

                // Parse Value
                if (typeof val === 'string') {
                    // Remove quotes, R$, spaces
                    val = val.replace(/["'R$\s]/g, '');
                    // PT-BR format check
                    if (val.includes(',')) {
                        val = val.replace(/\./g, '').replace(',', '.');
                    }
                    val = parseFloat(val);
                }
                if (!val || isNaN(val)) val = 0;

                // Parse Qty
                if (typeof qtd === 'string') {
                    if (qtd.includes(',')) qtd = qtd.replace(',', '.');
                    qtd = parseFloat(qtd);
                }
                if (!qtd || isNaN(qtd)) qtd = 1;

                return { ...item, valor_venda: val, quantidade: qtd };
            });

            console.log(`[PDF Parser] Success with ${strategy.model}. Extracted ${result.items.length} items.`);
            return result;

        } catch (e) {
            console.error(`[PDF Parser] Failed with ${strategy.model}: ${e.message}`);
            lastError = e;
            // Continue to next strategy
        }
    }

    throw new Error(`Falha em todas as tentativas de extração. Último erro: ${lastError ? lastError.message : 'Desconhecido'}`);
}

module.exports = { extractItemsFromPdf };
