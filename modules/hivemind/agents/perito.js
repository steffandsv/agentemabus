/**
 * PERITO Agent (The Extractor)
 * 
 * Mission: Read tender descriptions and extract the "Kill-Specs" 
 * - unique specifications that differentiate the product from generic items.
 * 
 * Output:
 * - killSpecs: Array of unique requirements
 * - queries: Google Hacking queries for web investigation
 * - negativeTerms: Terms to ignore in searches
 */

const path = require('path');
const fs = require('fs');
const { generateText, PROVIDERS } = require('../../../src/services/ai_manager');
const { getSetting } = require('../../../src/database');

// Load prompt template
const promptPath = path.join(__dirname, '../prompts/extract_killspecs.txt');

/**
 * Execute PERITO agent
 * @param {string} description - The tender item description
 * @param {object} config - AI configuration
 * @returns {object} { killSpecs, queries, negativeTerms }
 */
async function executePerito(description, config) {
    const promptTemplate = fs.existsSync(promptPath) 
        ? fs.readFileSync(promptPath, 'utf-8')
        : getDefaultPrompt();
    
    const prompt = promptTemplate.replace('{{DESCRIPTION}}', description);
    
    // Get AI configuration
    const provider = config.provider || await getSetting('sniper_provider') || PROVIDERS.DEEPSEEK;
    const model = config.model || await getSetting('sniper_model');
    const apiKey = config.apiKey || await getSetting('sniper_api_key') || getApiKeyForProvider(provider);
    
    const messages = [
        { role: 'user', content: prompt }
    ];
    
    try {
        const response = await generateText({ provider, model, apiKey, messages });
        const parsed = parseResponse(response, description);
        return parsed;
    } catch (err) {
        console.error('[PERITO] AI Error:', err.message);
        return fallbackExtraction(description);
    }
}

/**
 * Parse AI response into structured output
 */
function parseResponse(response, originalDescription) {
    try {
        // Try to extract JSON from response
        const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                          response.match(/\{[\s\S]*\}/);
        
        if (jsonMatch) {
            const json = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            
            return {
                killSpecs: json.kill_specs || json.killSpecs || [],
                queries: json.google_queries || json.queries || [],
                negativeTerms: json.negative_terms || json.negativeTerms || [],
                genericSpecs: json.generic_specs || json.genericSpecs || [],
                reasoning: json.reasoning || ''
            };
        }
    } catch (e) {
        console.warn('[PERITO] JSON parse failed, using fallback extraction');
    }
    
    return fallbackExtraction(originalDescription);
}

/**
 * Fallback extraction when AI fails
 */
function fallbackExtraction(description) {
    // Generic terms to filter out
    const genericTerms = [
        'bivolt', '110v', '220v', 'plástico', 'metal', 'novo', 'original',
        'garantia', 'nf', 'nota fiscal', 'sem uso', 'lacrado'
    ];
    
    // Split description into potential specs
    const words = description.toLowerCase();
    const killSpecs = [];
    
    // Look for numbers with units (likely specific specs)
    const numberSpecs = description.match(/\d+\s*(gb|mb|tb|mah|w|watts|kg|g|ml|l|cm|mm|m|pol|"|v|a|hz)/gi);
    if (numberSpecs) {
        killSpecs.push(...numberSpecs.map(s => s.trim()));
    }
    
    // Look for quoted terms (specific requirements)
    const quotedTerms = description.match(/"([^"]+)"/g);
    if (quotedTerms) {
        killSpecs.push(...quotedTerms.map(s => s.replace(/"/g, '').trim()));
    }
    
    // Look for "com X" patterns (features)
    const comPatterns = description.match(/com\s+[\w\s]+(?:,|\.|\s+e\s+)/gi);
    if (comPatterns) {
        killSpecs.push(...comPatterns.map(s => s.replace(/com\s+/i, '').replace(/[,.\s]+e\s*$/i, '').trim()));
    }
    
    // Remove generic terms and deduplicate
    const filtered = [...new Set(killSpecs)]
        .filter(s => s.length > 2)
        .filter(s => !genericTerms.some(g => s.toLowerCase().includes(g)));
    
    // If nothing specific found, use whole description
    const finalSpecs = filtered.length > 0 ? filtered : [description.substring(0, 100)];
    
    // Generate basic queries
    const queries = finalSpecs.map(spec => 
        `"${spec}" site:com.br OR site:gov.br`
    );
    
    return {
        killSpecs: finalSpecs,
        queries,
        negativeTerms: genericTerms,
        genericSpecs: [],
        reasoning: 'Fallback extraction (AI unavailable)'
    };
}

/**
 * Get API key for provider from environment
 */
function getApiKeyForProvider(provider) {
    switch (provider) {
        case PROVIDERS.QWEN:
            return process.env.QWEN_KEY;
        case PROVIDERS.DEEPSEEK:
            return process.env.DEEPSEEK_API_KEY;
        case PROVIDERS.GEMINI:
            return process.env.GEMINI_API_KEY;
        case PROVIDERS.PERPLEXITY:
            return process.env.PERPLEXITY_API_KEY;
        default:
            return process.env.DEEPSEEK_API_KEY;
    }
}

/**
 * Default prompt if file doesn't exist
 */
function getDefaultPrompt() {
    return `Você é um especialista em análise de editais de licitação.
Sua missão: Extrair as especificações ÚNICAS (Kill-Specs) que diferenciam este produto.

DESCRIÇÃO DO ITEM:
{{DESCRIPTION}}

REGRAS:
1. IGNORE especificações genéricas: bivolt, 220V, plástico, metal, novo, original, garantia
2. FOQUE em números específicos, capacidades, funcionalidades raras
3. Identifique características que um fornecedor teria que descrever obrigatoriamente
4. Gere queries de "Google Hacking" para encontrar fabricantes

EXEMPLOS DE KILL-SPECS:
- "72 músicas pré-gravadas" (número específico)
- "entrada cartão SD" (funcionalidade diferenciada)
- "capacidade 10 litros" (medida exata)
- "bateria de contingência" (requisito técnico)

FORMATO DE RESPOSTA (JSON):
\`\`\`json
{
    "kill_specs": ["spec1", "spec2"],
    "generic_specs": ["bivolt", "plástico"],
    "google_queries": [
        "'sirene escolar \"72 músicas\" site:com.br'",
        "'central musical \"cartão SD\" manual filetype:pdf'"
    ],
    "negative_terms": ["timer", "despertador", "campainha"],
    "reasoning": "Explicação da estratégia"
}
\`\`\``;
}

module.exports = { executePerito };
