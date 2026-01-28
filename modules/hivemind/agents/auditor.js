/**
 * AUDITOR Agent (The Validator)
 * 
 * Mission: Validate discovered entities on manufacturer sites.
 * Confirm that the product meets ALL Kill-Specs.
 * Detect if kit composition is needed (missing accessories).
 * 
 * Output:
 * - validated: boolean
 * - specs: validated specifications
 * - kitNeeded: boolean
 * - missingItems: array of items to add to kit
 */

const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { generateText, PROVIDERS } = require('../../../src/services/ai_manager');
const { getSetting } = require('../../../src/database');

// Jina Reader endpoint
const JINA_READER_URL = 'https://r.jina.ai/';

/**
 * Execute AUDITOR agent
 * @param {object} entity - Entity discovered by DETETIVE
 * @param {string[]} killSpecs - Kill-Specs to validate against
 * @param {object} page - Puppeteer page for browser-based scraping (fallback)
 * @param {object} config - AI configuration
 */
async function executeAuditor(entity, killSpecs, page, config) {
    console.log(`[AUDITOR] Validating entity: ${entity.name}`);
    
    // 1. Try to get product page content
    let content = null;
    
    // First try Jina Reader on the source URL
    if (entity.sourceUrl) {
        content = await scrapeWithJina(entity.sourceUrl);
    }
    
    // If we have evidence from DETETIVE, use that
    if (!content && entity.evidence) {
        content = entity.evidence;
    }
    
    // If still no content, try to search for manufacturer product page
    if (!content || content.length < 200) {
        const productPageUrl = await findProductPage(entity, page);
        if (productPageUrl) {
            content = await scrapeWithJina(productPageUrl);
            entity.productPageUrl = productPageUrl;
        }
    }
    
    if (!content || content.length < 100) {
        console.log(`[AUDITOR] No content available for validation`);
        return {
            validated: false,
            reason: 'Não foi possível acessar informações do fabricante'
        };
    }
    
    // 2. Validate specs with AI
    const validation = await validateSpecs(entity, killSpecs, content, config);
    
    if (!validation.allMatch) {
        return {
            validated: false,
            reason: `Especificações não atendidas: ${validation.missingSpecs.join(', ')}`,
            matchedSpecs: validation.matchedSpecs,
            missingSpecs: validation.missingSpecs
        };
    }
    
    // 3. Check for kit composition needs
    const kitAnalysis = await analyzeKitNeeds(entity, killSpecs, content, config);
    
    return {
        validated: true,
        specs: validation.matchedSpecs,
        searchQueries: generateSearchQueries(entity),
        sourceUrl: entity.productPageUrl || entity.sourceUrl,
        kitNeeded: kitAnalysis.kitNeeded,
        missingItems: kitAnalysis.missingItems || []
    };
}

/**
 * Scrape URL with Jina Reader
 */
async function scrapeWithJina(url) {
    try {
        const jinaUrl = `${JINA_READER_URL}${encodeURIComponent(url)}`;
        const response = await fetch(jinaUrl, {
            headers: { 'Accept': 'text/plain' },
            timeout: 15000
        });
        
        if (!response.ok) return null;
        
        const text = await response.text();
        return text.substring(0, 15000);
    } catch (err) {
        console.warn(`[AUDITOR] Jina scrape failed: ${err.message}`);
        return null;
    }
}

/**
 * Find the official product page for an entity
 */
async function findProductPage(entity, page) {
    // Try constructing likely URLs
    const manufacturer = entity.manufacturer || '';
    const name = entity.name || '';
    
    // Common patterns for Brazilian manufacturer sites
    const patterns = [
        `${manufacturer.toLowerCase().replace(/\s/g, '')}.com.br`,
        `www.${manufacturer.toLowerCase().replace(/\s/g, '')}.com.br`
    ];
    
    // For now, return null - the DETETIVE should have found the source
    return null;
}

/**
 * Validate that all Kill-Specs are present in the content
 */
async function validateSpecs(entity, killSpecs, content, config) {
    const prompt = `Você é um auditor técnico validando especificações de produto.

PRODUTO:
${entity.name} (${entity.manufacturer || 'Fabricante desconhecido'})

CONTEÚDO DA PÁGINA DO FABRICANTE:
${content.substring(0, 8000)}

ESPECIFICAÇÕES EXIGIDAS (Kill-Specs):
${killSpecs.map((s, i) => `${i + 1}. ${s}`).join('\n')}

TAREFA:
Para CADA especificação exigida, verifique se o produto ATENDE.

RESPONDA EM JSON:
\`\`\`json
{
    "all_match": true/false,
    "matched_specs": [
        {"spec": "72 músicas", "evidence": "Trecho do texto que comprova", "match": true}
    ],
    "missing_specs": ["especificação não encontrada"],
    "confidence": 0.0-1.0,
    "notes": "Observações adicionais"
}
\`\`\``;

    const provider = config.provider || PROVIDERS.DEEPSEEK;
    const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY;
    
    try {
        const response = await generateText({
            provider,
            model: config.model,
            apiKey,
            messages: [{ role: 'user', content: prompt }]
        });
        
        const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                          response.match(/\{[\s\S]*\}/);
        
        if (jsonMatch) {
            const json = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            
            return {
                allMatch: json.all_match,
                matchedSpecs: json.matched_specs || [],
                missingSpecs: json.missing_specs || [],
                confidence: json.confidence || 0.5
            };
        }
    } catch (err) {
        console.warn(`[AUDITOR] Spec validation failed: ${err.message}`);
    }
    
    // Fallback: simple text matching
    return fallbackValidation(killSpecs, content);
}

/**
 * Analyze if kit composition is needed (missing accessories)
 */
async function analyzeKitNeeds(entity, killSpecs, content, config) {
    const prompt = `Você é um especialista em identificar se um produto é vendido COMPLETO ou precisa de ACESSÓRIOS.

PRODUTO:
${entity.name}

CONTEÚDO DO FABRICANTE:
${content.substring(0, 5000)}

ESPECIFICAÇÕES DO EDITAL:
${killSpecs.join(', ')}

TAREFA:
Identifique se o produto vem COMPLETO ou se algum item precisa ser comprado separadamente.

EXEMPLOS DE KIT:
- "Central de música" que "não acompanha cornetas" → Kit: Central + Cornetas
- "Computador" que "não inclui monitor" → Kit: Computador + Monitor
- "Impressora" sem "cabo USB" → Kit: Impressora + Cabo

RESPONDA EM JSON:
\`\`\`json
{
    "kit_needed": true/false,
    "missing_items": [
        {
            "item": "Corneta 35W",
            "quantity": 2,
            "search_query": "corneta 35w aluminio"
        }
    ],
    "reasoning": "Explicação"
}
\`\`\``;

    const provider = config.provider || PROVIDERS.DEEPSEEK;
    const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY;
    
    try {
        const response = await generateText({
            provider,
            model: config.model,
            apiKey,
            messages: [{ role: 'user', content: prompt }]
        });
        
        const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                          response.match(/\{[\s\S]*\}/);
        
        if (jsonMatch) {
            const json = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            
            return {
                kitNeeded: json.kit_needed || false,
                missingItems: json.missing_items || [],
                reasoning: json.reasoning
            };
        }
    } catch (err) {
        console.warn(`[AUDITOR] Kit analysis failed: ${err.message}`);
    }
    
    return { kitNeeded: false, missingItems: [] };
}

/**
 * Fallback validation using simple text matching
 */
function fallbackValidation(killSpecs, content) {
    const contentLower = content.toLowerCase();
    const matched = [];
    const missing = [];
    
    for (const spec of killSpecs) {
        const specLower = spec.toLowerCase();
        const words = specLower.split(/\s+/).filter(w => w.length > 2);
        
        // Check if most words from the spec are in the content
        const matchedWords = words.filter(w => contentLower.includes(w));
        const matchRatio = matchedWords.length / words.length;
        
        if (matchRatio > 0.6) {
            matched.push({ spec, evidence: 'Encontrado no texto', match: true });
        } else {
            missing.push(spec);
        }
    }
    
    return {
        allMatch: missing.length === 0,
        matchedSpecs: matched,
        missingSpecs: missing,
        confidence: 0.5
    };
}

/**
 * Generate search queries for the validated entity
 */
function generateSearchQueries(entity) {
    const queries = [];
    
    // Primary: Full name
    queries.push(entity.name);
    
    // With manufacturer
    if (entity.manufacturer) {
        queries.push(`${entity.manufacturer} ${entity.name}`);
    }
    
    // Clean variations
    const cleanName = entity.name
        .replace(/\s+/g, ' ')
        .replace(/[^\w\s]/g, '')
        .trim();
    
    if (cleanName !== entity.name) {
        queries.push(cleanName);
    }
    
    return queries;
}

module.exports = { executeAuditor };
