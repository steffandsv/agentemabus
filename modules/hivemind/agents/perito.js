/**
 * PERITO Agent (The Extractor) - HIVE-MIND v10.3 "FLEXÍVEL & IMPLACÁVEL"
 * 
 * Mission: Read tender descriptions and extract structured information for marketplace search.
 * Philosophy: FLEXIBLE search (find many candidates), IMPLACABLE judgment (JUIZ validates)
 * 
 * Output:
 * - marketplaceSearchTerm: Natural search term for Mercado Livre
 * - searchAnchor: Most distinctive spec for filtering
 * - criticalSpecs: Specs with weights for adherence scoring
 * - searchVariations: Alternative search terms
 */

const path = require('path');
const fs = require('fs');
// LEI 1: Use generateTextWithFallback for DeepSeek safety net
// CRITICAL FIX: Use getApiKeyFromEnv to get keys from .env (source of truth), NOT from database
const { generateTextWithFallback, PROVIDERS, getApiKeyFromEnv } = require('../../../src/services/ai_manager');
const { getSetting } = require('../../../src/database');

// Load prompt template
const promptPath = path.join(__dirname, '../prompts/extract_killspecs.txt');

/**
 * Execute PERITO agent
 * @param {string} description - The tender item description
 * @param {object} config - AI configuration
 * @returns {object} { killSpecs, queries, negativeTerms }
 */
async function executePerito(description, config, debugLogger = null) {
    const promptTemplate = fs.existsSync(promptPath)
        ? fs.readFileSync(promptPath, 'utf-8')
        : getDefaultPrompt();

    const prompt = promptTemplate.replace('{{DESCRIPTION}}', description);

    // Get AI configuration - Provider/Model from DB, but KEYS ONLY FROM .env
    let provider = config.provider || await getSetting('perito_provider') || PROVIDERS.DEEPSEEK;
    let model = config.model || await getSetting('perito_model') || 'deepseek-chat';

    // CRITICAL FIX: API keys MUST come from .env file (source of truth)
    // The database has corrupted/mixed-up keys. NEVER trust the database for credentials.
    let apiKey = getApiKeyFromEnv(provider);

    // FALLBACK: If the configured provider's key doesn't exist in .env, fall back to DeepSeek
    if (!apiKey) {
        console.warn(`[PERITO] ⚠️ No API key in .env for "${provider}". Falling back to DeepSeek.`);
        provider = PROVIDERS.DEEPSEEK;
        model = 'deepseek-chat';
        apiKey = getApiKeyFromEnv(PROVIDERS.DEEPSEEK);

        if (!apiKey) {
            throw new Error(`PERITO FATAL: No DEEPSEEK_API_KEY found in .env. This is required as the fallback provider.`);
        }
    }

    console.log(`[PERITO] Using API key from .env for ${provider} (ending: ...${apiKey.slice(-4)})`);

    const messages = [
        { role: 'user', content: prompt }
    ];

    // DEBUG: Log prompt sent to AI with PROVIDER/MODEL/ENDPOINT info
    const providerEndpoints = {
        'deepseek': 'https://api.deepseek.com/v1/chat/completions',
        'gemini': 'https://generativelanguage.googleapis.com/v1beta',
        'qwen': 'https://dashscope.aliyuncs.com/api/v1',
        'perplexity': 'https://api.perplexity.ai/chat/completions'
    };
    const endpoint = providerEndpoints[provider] || 'unknown';

    console.log(`[PERITO] 🤖 AI Provider: ${provider}`);
    console.log(`[PERITO] 📦 Model: ${model || 'default'}`);
    console.log(`[PERITO] 🔗 Endpoint: ${endpoint}`);

    if (debugLogger) {
        debugLogger.agentInput('PERITO', description);
        debugLogger.aiPrompt('PERITO', prompt);
        debugLogger.log('PERITO', `AI Config: provider=${provider}, model=${model}, endpoint=${endpoint}`);
    }

    try {
        // LEI 1: Use safety net function that falls back to DeepSeek on 401
        const response = await generateTextWithFallback({ provider, model, apiKey, messages });

        // DEBUG: Log raw AI response
        if (debugLogger) {
            debugLogger.aiResponse('PERITO', response);
        }
        console.log(`[PERITO] AI Response received (${response.length} chars)`);

        const parsed = parseResponse(response, description, debugLogger);

        // DEBUG: Log parsed output
        if (debugLogger) {
            debugLogger.agentOutput('PERITO', parsed);
        }

        return parsed;
    } catch (err) {
        // LEI 1: FAIL-FAST - No regex fallback, explode error to orchestrator
        console.error('[PERITO] ⛔ AI FATAL ERROR:', err.message);
        if (debugLogger) {
            debugLogger.error('PERITO', 'FATAL - No fallback, aborting task', err.message);
        }
        throw err; // Let orchestrator handle this (task goes to 'failed')
    }
}

/**
 * CODEX OMNI v10.0: Validate anchor to prevent hallucination
 * Rejects abbreviated anchors like "72 m" (should be "72 músicas")
 */
function validateAnchor(anchor) {
    if (!anchor) return { valid: false, reason: 'Anchor is null' };

    // Remove quotes for validation
    const clean = anchor.replace(/"/g, '').trim();

    // Reject if too short (< 5 characters)
    if (clean.length < 5) {
        return { valid: false, reason: `Anchor too short: "${clean}" (< 5 chars)` };
    }

    // ANTI-HALLUCINATION: Reject pattern "number + 1-2 letters" (e.g., "72 m", "1 a", "500 g")
    if (/^\d+\s*[a-záéíóú]{1,2}$/i.test(clean)) {
        return { valid: false, reason: `HALLUCINATION DETECTED: "${clean}" looks abbreviated` };
    }

    return { valid: true, clean };
}

/**
 * CODEX OMNI v10.0: Validate a kill-spec is not abbreviated
 * Returns { valid, reason, corrected }
 */
function validateKillSpec(spec, originalDescription) {
    if (!spec || typeof spec !== 'string') {
        return { valid: false, reason: 'Empty or invalid spec' };
    }

    const clean = spec.trim();

    // Check for abbreviated patterns like "72 m", "1 a", "500 g"
    if (/^\d+\s*[a-záéíóú]{1,2}$/i.test(clean)) {
        // Try to find the full version in the original description
        const numberMatch = clean.match(/(\d+)/);
        if (numberMatch) {
            const number = numberMatch[1];
            // Look for this number followed by a full word in the description
            const fullPattern = new RegExp(`${number}\\s*([a-záéíóúàâãêô]{3,})`, 'gi');
            const fullMatch = fullPattern.exec(originalDescription);

            if (fullMatch) {
                const corrected = `${number} ${fullMatch[1].toLowerCase()}`;
                return {
                    valid: false,
                    reason: `Abbreviated spec detected: "${clean}"`,
                    corrected
                };
            }
        }

        return { valid: false, reason: `Abbreviated spec: "${clean}" (too short)` };
    }

    // Check minimum length
    if (clean.length < 3) {
        return { valid: false, reason: `Spec too short: "${clean}"` };
    }

    return { valid: true };
}

/**
 * Parse AI response into structured output
 */
function parseResponse(response, originalDescription, debugLogger = null) {
    try {
        // Try to extract JSON from response
        const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) ||
            response.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
            const json = JSON.parse(jsonMatch[1] || jsonMatch[0]);

            // Extract marketplace search term (critical for query sanitization)
            let marketplaceSearchTerm = json.marketplace_search_term || json.marketplaceSearchTerm || '';

            // Enforce max 7 words for marketplace term
            if (marketplaceSearchTerm) {
                const words = marketplaceSearchTerm.split(/\s+/).slice(0, 7);
                marketplaceSearchTerm = words.join(' ');
            } else {
                // Generate fallback from description
                marketplaceSearchTerm = generateMarketplaceTerm(originalDescription);
            }

            // Extract and VALIDATE search anchor (CODEX OMNI v10.0)
            let rawAnchor = json.search_anchor || json.searchAnchor || null;
            let searchAnchorRaw = null;  // Without quotes
            let searchAnchorQuoted = null;  // With quotes for exact search

            if (rawAnchor) {
                const validation = validateAnchor(rawAnchor);

                if (validation.valid) {
                    searchAnchorRaw = validation.clean;
                    searchAnchorQuoted = `"${validation.clean}"`;
                    console.log(`[PERITO] ✓ Anchor validated: "${searchAnchorRaw}"`);
                } else {
                    console.warn(`[PERITO] ⚠ ${validation.reason} - Attempting extraction from description`);
                    // Try to extract anchor from original description
                    const extracted = extractAnchorFromDescription(originalDescription);
                    if (extracted) {
                        searchAnchorRaw = extracted;
                        searchAnchorQuoted = `"${extracted}"`;
                        console.log(`[PERITO] ✓ Anchor extracted from description: "${searchAnchorRaw}"`);
                    }
                }
            }

            // Extract max price estimate
            const maxPriceEstimate = json.max_price_estimate || json.maxPriceEstimate || 0;

            // v10.3: Extract search_variations for alternative marketplace queries
            const searchVariations = json.search_variations || json.searchVariations || [];

            // NEW: Extract critical specs with weights
            let criticalSpecs = json.critical_specs || json.criticalSpecs || [];
            // Normalize if it's just an array of strings (backward compat)
            if (criticalSpecs.length > 0 && typeof criticalSpecs[0] === 'string') {
                criticalSpecs = criticalSpecs.map(spec => ({ spec, weight: 10 }));
            }

            // CODEX OMNI v10.0: VALIDATE AND CORRECT KILL-SPECS (ANTI-HALLUCINATION)
            let rawKillSpecs = json.kill_specs || json.killSpecs || [];
            const validatedKillSpecs = [];
            const validationLog = [];

            for (const spec of rawKillSpecs) {
                const specText = typeof spec === 'string' ? spec : spec.spec || '';
                const validation = validateKillSpec(specText, originalDescription);

                if (validation.valid) {
                    validatedKillSpecs.push(specText);
                    validationLog.push({ field: 'kill_spec', value: specText, valid: true });
                    console.log(`[PERITO] ✓ Kill-spec validated: "${specText}"`);
                } else if (validation.corrected) {
                    validatedKillSpecs.push(validation.corrected);
                    validationLog.push({ field: 'kill_spec', value: specText, valid: false, result: `Corrected to: "${validation.corrected}"`, reason: validation.reason });
                    console.warn(`[PERITO] ⚠ Kill-spec corrected: "${specText}" → "${validation.corrected}"`);
                } else {
                    validationLog.push({ field: 'kill_spec', value: specText, valid: false, reason: validation.reason });
                    console.warn(`[PERITO] ✗ Kill-spec rejected: "${specText}" - ${validation.reason}`);
                }
            }

            // Also validate critical specs
            const validatedCriticalSpecs = [];
            for (const specObj of criticalSpecs) {
                const specText = typeof specObj === 'string' ? specObj : specObj.spec || '';
                const weight = typeof specObj === 'object' ? (specObj.weight || 10) : 10;
                const validation = validateKillSpec(specText, originalDescription);

                if (validation.valid) {
                    validatedCriticalSpecs.push({ spec: specText, weight });
                } else if (validation.corrected) {
                    validatedCriticalSpecs.push({ spec: validation.corrected, weight });
                }
                // Skip invalid specs that can't be corrected
            }

            // DEBUG: Log validation results
            if (debugLogger && validationLog.length > 0) {
                debugLogger.validation('PERITO', validationLog);
            }

            // ============================================
            // GOLDEN PATH v11.0: Build Search Strategies Array
            // ============================================
            const searchStrategies = buildSearchStrategies({
                detectedModel: json.detected_model || json.detectedModel || null,
                marketplaceSearchTerm,
                searchAnchorRaw,
                searchVariations,
                killSpecs: validatedKillSpecs
            });

            console.log(`[PERITO] Generated ${searchStrategies.length} search strategies`);
            searchStrategies.forEach((s, i) => {
                console.log(`  [${i + 1}] ${s.type}: "${s.query}"`);
            });

            return {
                complexity: json.complexity || 'HIGH', // Default to HIGH for safety
                marketplaceSearchTerm,
                // CODEX OMNI v10.0: Separated anchor fields
                searchAnchor: searchAnchorQuoted,      // Legacy (with quotes)
                searchAnchorRaw,                        // NEW: Without quotes
                searchAnchorQuoted,                     // NEW: With quotes for ML search
                maxPriceEstimate,                       // Price estimate for floor calculation
                killSpecs: validatedKillSpecs,          // VALIDATED kill-specs (for display only)
                // v10.3 "FLEXÍVEL & IMPLACÁVEL": Removed negativeTerms, genericSpecs, negativeConstraints
                // Philosophy: FLEXIBLE search (find many), IMPLACABLE judgment (JUIZ validates)
                searchVariations,                       // Alternative marketplace search terms
                criticalSpecs: validatedCriticalSpecs,  // VALIDATED critical specs with weights
                // GOLDEN PATH v11.0: Ordered search strategies for fallback loop
                searchStrategies,                       // NEW: Array of { type, query, priority }
                reasoning: json.reasoning || '',
                // Store original description for JUIZ reference
                originalDescription
            };
        }
    } catch (e) {
        console.warn('[PERITO] JSON parse failed, using fallback extraction:', e.message);
    }

    return fallbackExtraction(originalDescription);
}

/**
 * Extract anchor from description when LLM fails (anti-hallucination fallback)
 */
function extractAnchorFromDescription(description) {
    // Look for patterns like "72 músicas", "500 litros", "16 polegadas"
    const patterns = [
        /(\d+\s*músicas)/i,
        /(\d+\s*litros?)/i,
        /(\d+\s*polegadas?)/i,
        /(\d+\s*lumens?)/i,
        /(\d+\s*gb)/i,
        /(\d+\s*mb)/i,
        /(\d+\s*watts?)/i,
        /(\d+\s*volts?)/i,
    ];

    for (const pattern of patterns) {
        const match = description.match(pattern);
        if (match && match[1].length >= 5) {
            return match[1].trim().toLowerCase();
        }
    }

    return null;
}

/**
 * Generate a marketplace search term from description
 */
function generateMarketplaceTerm(description) {
    // Remove common noise words and take first meaningful words
    const noiseWords = ['aquisição', 'de', 'para', 'com', 'em', 'ao', 'do', 'da', 'dos', 'das', 'o', 'a', 'os', 'as', 'um', 'uma', 'uns', 'umas', 'e', 'ou', 'que', 'tipo', 'modelo', 'marca', 'conforme', 'especificação', 'técnica', 'segundo', 'contendo', 'composto', 'aproximadamente'];

    const words = description
        .toLowerCase()
        .replace(/[^a-záàâãéèêíïóôõöúçñ0-9\s]/gi, ' ')
        .split(/\s+/)
        .filter(w => w.length > 2 && !noiseWords.includes(w));

    // Take first 5 meaningful words
    return words.slice(0, 5).join(' ') || description.substring(0, 50);
}

/**
 * Generate a search anchor from kill specs (ANCHOR & LOCK doctrine)
 * The anchor is the most restrictive numeric/technical spec wrapped in quotes
 */
function generateSearchAnchor(killSpecs) {
    if (!killSpecs || killSpecs.length === 0) return null;

    // Priority 1: Find specs with numbers (most filterable)
    const numericSpec = killSpecs.find(spec => /\d+/.test(spec));
    if (numericSpec) {
        // Extract the core numeric phrase (e.g., "72 músicas" from "capacidade de 72 músicas")
        const numericMatch = numericSpec.match(/(\d+\s*[a-záàâãéèêíïóôõöúçñ]+)/i);
        if (numericMatch) {
            return `"${numericMatch[1].trim()}"`;
        }
        return `"${numericSpec.trim()}"`;
    }

    // Priority 2: Find short technical terms (max 3 words)
    const shortSpec = killSpecs.find(spec => spec.split(/\s+/).length <= 3 && spec.length > 3);
    if (shortSpec) {
        return `"${shortSpec.trim()}"`;
    }

    // Priority 3: Use first spec
    return `"${killSpecs[0].trim()}"`;
}

/**
 * GOLDEN PATH v11.0: Build Search Strategies Array
 * Creates ordered search strategies for the fallback loop
 * 
 * @param {object} params - Search parameters from parsing
 * @returns {object[]} Array of { type, query, priority }
 */
function buildSearchStrategies(params) {
    const { detectedModel, marketplaceSearchTerm, searchAnchorRaw, searchVariations, killSpecs } = params;
    const strategies = [];
    let priority = 1;

    // Strategy 1: SURGICAL - Exact model name (if detected by DETETIVE)
    if (detectedModel && detectedModel.length > 3) {
        strategies.push({
            type: 'surgical',
            query: sanitizeQuery(detectedModel),
            priority: priority++,
            description: 'Modelo exato detectado pelo DETETIVE'
        });
    }

    // Strategy 2: FUNCTIONAL - Marketplace term + anchor (most common case)
    if (marketplaceSearchTerm && searchAnchorRaw) {
        const functionalQuery = `${marketplaceSearchTerm} "${searchAnchorRaw}"`;
        strategies.push({
            type: 'functional',
            query: sanitizeQuery(functionalQuery),
            priority: priority++,
            description: 'Termo comercial + âncora técnica'
        });
    }

    // Strategy 3: BROAD - Just the marketplace term
    if (marketplaceSearchTerm) {
        strategies.push({
            type: 'broad',
            query: sanitizeQuery(marketplaceSearchTerm),
            priority: priority++,
            description: 'Termo genérico de marketplace'
        });
    }

    // Strategy 4+: VARIATIONS - Alternative search terms
    if (searchVariations && searchVariations.length > 0) {
        for (const variation of searchVariations.slice(0, 3)) {
            if (variation && variation.trim().length > 3) {
                strategies.push({
                    type: 'variation',
                    query: sanitizeQuery(variation.trim()),
                    priority: priority++,
                    description: `Variação: ${variation.substring(0, 30)}`
                });
            }
        }
    }

    // Strategy LAST: KILL-SPEC based (emergency fallback)
    if (killSpecs && killSpecs.length > 0 && strategies.length < 2) {
        const specQuery = killSpecs.slice(0, 3).join(' ');
        strategies.push({
            type: 'spec-based',
            query: sanitizeQuery(specQuery),
            priority: priority++,
            description: 'Baseado em kill-specs (fallback)'
        });
    }

    return strategies;
}

/**
 * Sanitize query to prevent oversized queries
 */
function sanitizeQuery(query) {
    if (!query) return '';
    const MAX_QUERY_LENGTH = 60;

    let sanitized = query.trim();

    if (sanitized.length > MAX_QUERY_LENGTH) {
        const words = sanitized.split(/\s+/);
        sanitized = '';
        for (const word of words) {
            if ((sanitized + ' ' + word).trim().length <= MAX_QUERY_LENGTH) {
                sanitized = (sanitized + ' ' + word).trim();
            } else {
                break;
            }
        }
    }

    return sanitized || query.substring(0, MAX_QUERY_LENGTH);
}

/**
 * Classify complexity based on description keywords
 */
function classifyComplexity(description) {
    const lowComplexityKeywords = [
        'lápis', 'caneta', 'papel', 'borracha', 'grampo', 'clips', 'envelope',
        'água', 'café', 'açúcar', 'copo', 'guardanapo', 'sabão', 'detergente',
        'vassoura', 'pano', 'balde', 'escova', 'pasta', 'fichário', 'caderno'
    ];

    const highComplexityKeywords = [
        'digital', 'eletrônico', 'programável', 'automático', 'computador',
        'impressora', 'monitor', 'sirene', 'sensor', 'câmera', 'servidor',
        'músicas', 'memória', 'gb', 'tb', 'processador', 'bateria', 'bivolt',
        'instrumento', 'hospitalar', 'laborat', 'científico', 'médico'
    ];

    const desc = description.toLowerCase();

    // Check for high complexity first (takes precedence)
    if (highComplexityKeywords.some(kw => desc.includes(kw))) {
        return 'HIGH';
    }

    // Check for low complexity
    if (lowComplexityKeywords.some(kw => desc.includes(kw))) {
        return 'LOW';
    }

    // Default to HIGH for safety
    return 'HIGH';
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
    // FIXED: Word boundary \b prevents "72 músicas" → "72 m" hallucination
    // Added audio units: músicas, sons, toques, programações
    const numberSpecs = description.match(/\d+\s*(gb|mb|tb|mah|watts?|kg|gramas?|ml|litros?|cm|mm|metros?|polegadas?|pol|volts?|amperes?|hz|músicas?|sons?|toques?|programaç(?:ão|ões)|cornetas?|níveis?)\b/gi);
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

    // Classify complexity
    const complexity = classifyComplexity(description);

    // Generate marketplace term
    const marketplaceSearchTerm = generateMarketplaceTerm(description);

    // Generate search anchor (ANCHOR & LOCK doctrine)
    const searchAnchor = complexity === 'HIGH' ? generateSearchAnchor(finalSpecs) : null;

    // Generate basic queries (only if HIGH complexity)
    const queries = complexity === 'HIGH'
        ? finalSpecs.map(spec => `"${spec}" site:com.br OR site:gov.br`)
        : [];

    return {
        complexity,
        marketplaceSearchTerm,
        searchAnchor,         // NEW: Anchor for fallback searches
        searchAnchorRaw: searchAnchor ? searchAnchor.replace(/"/g, '') : null, // For strategy building
        maxPriceEstimate: 0,  // NEW: Unknown in fallback mode
        killSpecs: finalSpecs,
        queries,
        negativeTerms: genericTerms,
        genericSpecs: [],
        // NEW: SKEPTICAL JUDGE fields (fallback defaults)
        negativeConstraints: [], // No kill-words in fallback
        criticalSpecs: finalSpecs.map(spec => ({ spec, weight: 10 })), // Equal weight in fallback
        // GOLDEN PATH v11.0: Build strategies even in fallback mode
        searchStrategies: buildSearchStrategies({
            detectedModel: null,
            marketplaceSearchTerm,
            searchAnchorRaw: searchAnchor ? searchAnchor.replace(/"/g, '') : null,
            searchVariations: [],
            killSpecs: finalSpecs
        }),
        reasoning: `Fallback extraction (AI unavailable). Complexity: ${complexity}`
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
