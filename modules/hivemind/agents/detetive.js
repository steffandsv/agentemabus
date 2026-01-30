/**
 * DETETIVE Agent (The Scout) - v10.4
 * 
 * Mission: Leave the marketplace and investigate the open web.
 * Find the actual MANUFACTURER/MODEL that matches the Kill-Specs.
 * v10.4: Uses cascaded fallback system (Configured → Gemini → DeepSeek)
 * 
 * Tools:
 * - Google Custom Search API (primary)
 * - DuckDuckGo Search (fallback - no API key required)
 * - Jina Reader (convert any URL to markdown)
 * 
 * Output:
 * - entities: Array of discovered manufacturers/models
 * - OR retry signal with relaxed specs
 */

const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { search: duckDuckGoSearch } = require('duckduckgo-search');
// v10.4: Use cascaded fallback system
const { generateTextWithCascadeFallback, PROVIDERS, getApiKeyFromEnv } = require('../../../src/services/ai_manager');
const { getSetting } = require('../../../src/database');
const { googleSearch: customSearch } = require('../../../src/google_services');

// Jina Reader endpoint (free, no API key needed)
const JINA_READER_URL = 'https://r.jina.ai/';

/**
 * Execute DETETIVE agent
 * @param {string[]} killSpecs - Unique specs to find
 * @param {string[]} queries - Google Hacking queries from PERITO
 * @param {number} relaxationLevel - How much to relax the search (0-3)
 * @param {object} config - AI configuration
 */
async function executeDetetive(killSpecs, queries, relaxationLevel, config) {
    console.log(`[DETETIVE] Starting investigation. Relaxation level: ${relaxationLevel}`);
    
    // 1. Execute Google Searches
    const searchResults = await executeSearches(queries, relaxationLevel);
    
    if (searchResults.length === 0) {
        console.log('[DETETIVE] No search results found');
        return {
            retry: true,
            relaxedSpecs: relaxKillSpecs(killSpecs, relaxationLevel + 1),
            relaxedQueries: relaxQueries(queries, relaxationLevel + 1)
        };
    }
    
    console.log(`[DETETIVE] Found ${searchResults.length} search results`);
    
    // 2. Filter for manufacturer/datasheet sites
    const relevantSites = filterRelevantSites(searchResults);
    console.log(`[DETETIVE] ${relevantSites.length} relevant sites after filtering`);
    
    if (relevantSites.length === 0) {
        return {
            retry: relaxationLevel < 2,
            relaxedSpecs: relaxKillSpecs(killSpecs, relaxationLevel + 1),
            relaxedQueries: relaxQueries(queries, relaxationLevel + 1),
            entities: []
        };
    }
    
    // 3. Scrape and extract entities from top sites
    const entities = [];
    const sitesToScrape = relevantSites.slice(0, 5); // Limit to 5 sites
    
    for (const site of sitesToScrape) {
        try {
            const content = await scrapeWithJina(site.link);
            if (!content || content.length < 100) continue;
            
            const entity = await extractEntityFromContent(content, killSpecs, site, config);
            if (entity && entity.confidence > 0.5) {
                entities.push(entity);
                console.log(`[DETETIVE] Found entity: ${entity.name} (confidence: ${entity.confidence})`);
            }
        } catch (err) {
            console.warn(`[DETETIVE] Error scraping ${site.link}: ${err.message}`);
        }
    }
    
    // 4. Return results or retry signal
    if (entities.length === 0 && relaxationLevel < 2) {
        return {
            retry: true,
            relaxedSpecs: relaxKillSpecs(killSpecs, relaxationLevel + 1),
            relaxedQueries: relaxQueries(queries, relaxationLevel + 1)
        };
    }
    
    // Sort by confidence
    entities.sort((a, b) => b.confidence - a.confidence);
    
    // Return with best detected model for SNIPER's dual search logic
    const bestEntity = entities[0];
    return { 
        entities, 
        detectedModel: bestEntity ? bestEntity.name : null, // NEW: Best model for SNIPER
        retry: false 
    };
}

/**
 * Execute Google searches using available API
 */
async function executeSearches(queries, relaxationLevel) {
    const allResults = [];
    
    // If relaxation level is high, use broader queries
    const effectiveQueries = relaxationLevel > 1 
        ? queries.map(q => q.replace(/site:\S+/g, '').replace(/filetype:\S+/g, '').trim())
        : queries;
    
    for (const query of effectiveQueries.slice(0, 3)) { // Limit to 3 queries
        try {
            // Check if Google Search is enabled
            const searchEnabled = process.env.ENABLE_GOOGLE_SEARCH === 'true';
            
            let results = [];
            
            if (searchEnabled && process.env.GOOGLE_SEARCH_API_KEY && process.env.GOOGLE_SEARCH_CX) {
                // Primary: Google Custom Search
                console.log(`[DETETIVE] Using Google Custom Search for: "${query.substring(0, 50)}..."`);
                results = await customSearch(query) || [];
            } else {
                // Fallback: DuckDuckGo (free, no API key)
                console.log(`[DETETIVE] Google Search not configured. Using DuckDuckGo fallback.`);
                results = await searchWithDuckDuckGo(query);
            }
            
            allResults.push(...results);
        } catch (err) {
            console.warn(`[DETETIVE] Search error for "${query}": ${err.message}`);
            
            // Try DuckDuckGo as last resort if Google failed
            if (err.message !== 'DUCKDUCKGO_FAILED') {
                try {
                    console.log(`[DETETIVE] Google failed, trying DuckDuckGo...`);
                    const ddgResults = await searchWithDuckDuckGo(query);
                    allResults.push(...ddgResults);
                } catch (ddgErr) {
                    console.error(`[DETETIVE] All search engines failed: ${ddgErr.message}`);
                }
            }
        }
    }
    
    // Deduplicate by URL
    const seen = new Set();
    return allResults.filter(r => {
        if (seen.has(r.link)) return false;
        seen.add(r.link);
        return true;
    });
}

/**
 * Search using DuckDuckGo (free, no API key required)
 */
async function searchWithDuckDuckGo(query) {
    try {
        // Sanitize query - DuckDuckGo doesn't like special operators
        const cleanQuery = query
            .replace(/site:\S+/gi, '')
            .replace(/filetype:\S+/gi, '')
            .replace(/["']/g, '')
            .trim();
        
        console.log(`[DETETIVE] DuckDuckGo search: "${cleanQuery.substring(0, 50)}..."`);
        
        const searchResults = await duckDuckGoSearch(cleanQuery, { maxResults: 5 });
        
        if (!searchResults || searchResults.length === 0) {
            console.log('[DETETIVE] DuckDuckGo returned no results');
            return [];
        }
        
        // Normalize to match Google format
        return searchResults.map(r => ({
            title: r.title || '',
            link: r.href || r.url || '',
            snippet: r.body || r.description || ''
        })).filter(r => r.link);
        
    } catch (err) {
        console.error(`[DETETIVE] DuckDuckGo error: ${err.message}`);
        const error = new Error('DUCKDUCKGO_FAILED');
        error.cause = err;
        throw error;
    }
}

/**
 * Filter results for manufacturer/datasheet sites
 */
function filterRelevantSites(results) {
    const priorityPatterns = [
        /\.com\.br/i,           // Brazilian sites
        /fabricante/i,          // Manufacturer
        /manual/i,              // Manuals
        /ficha.*técnica/i,      // Tech specs
        /datasheet/i,           // Datasheets
        /especifica[çc]/i,      // Specifications
        /catalogo/i,            // Catalog
    ];
    
    const excludePatterns = [
        /mercadolivre/i,
        /amazon/i,
        /shopee/i,
        /aliexpress/i,
        /olx/i,
        /facebook/i,
        /instagram/i,
        /youtube/i
    ];
    
    return results
        .filter(r => !excludePatterns.some(p => p.test(r.link) || p.test(r.title)))
        .sort((a, b) => {
            const aScore = priorityPatterns.filter(p => 
                p.test(a.link) || p.test(a.title) || p.test(a.snippet || '')
            ).length;
            const bScore = priorityPatterns.filter(p => 
                p.test(b.link) || p.test(b.title) || p.test(b.snippet || '')
            ).length;
            return bScore - aScore;
        });
}

/**
 * Scrape a URL using Jina Reader
 */
async function scrapeWithJina(url) {
    try {
        const jinaUrl = `${JINA_READER_URL}${encodeURIComponent(url)}`;
        const response = await fetch(jinaUrl, {
            headers: {
                'Accept': 'text/plain'
            },
            timeout: 15000
        });
        
        if (!response.ok) {
            throw new Error(`Jina Reader error: ${response.status}`);
        }
        
        const text = await response.text();
        
        // Limit content size
        return text.substring(0, 10000);
    } catch (err) {
        console.warn(`[DETETIVE] Jina Reader failed for ${url}: ${err.message}`);
        return null;
    }
}

/**
 * Extract entity (manufacturer/model) from scraped content
 */
async function extractEntityFromContent(content, killSpecs, site, config) {
    const prompt = `Você é um especialista em identificar produtos e fabricantes.

CONTEÚDO DA PÁGINA:
${content.substring(0, 5000)}

ESPECIFICAÇÕES BUSCADAS:
${killSpecs.join(', ')}

TAREFA:
Identifique se esta página contém informações sobre um FABRICANTE ou MODELO de produto que atenda às especificações acima.

RESPONDA EM JSON:
\`\`\`json
{
    "found": true/false,
    "entity_name": "Nome do Modelo (ex: Tok Escola III)",
    "manufacturer": "Nome do Fabricante (ex: Tok Sirenes)",
    "matched_specs": ["spec1 encontrada", "spec2 encontrada"],
    "missing_specs": ["spec3 não encontrada"],
    "confidence": 0.0-1.0,
    "evidence": "Trecho do texto que comprova"
}
\`\`\``;

    // v10.4: Read DETETIVE config from database, use cascaded fallback
    let provider = config.provider || await getSetting('detetive_provider') || PROVIDERS.DEEPSEEK;
    let model = config.model || await getSetting('detetive_model') || 'deepseek-chat';
    
    try {
        const result = await generateTextWithCascadeFallback({
            provider,
            model,
            messages: [{ role: 'user', content: prompt }],
            agentName: 'detetive'
        });
        
        const response = result.text;
        console.log(`[DETETIVE] ✅ Entity extraction with ${result.usedProvider} (${result.tier})`);
        
        const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) || 
                          response.match(/\{[\s\S]*\}/);
        
        if (jsonMatch) {
            const json = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            
            if (json.found && json.entity_name) {
                return {
                    name: json.entity_name,
                    manufacturer: json.manufacturer,
                    matchedSpecs: json.matched_specs || [],
                    missingSpecs: json.missing_specs || [],
                    confidence: json.confidence || 0.5,
                    evidence: json.evidence,
                    sourceUrl: site.link,
                    sourceTitle: site.title
                };
            }
        }
    } catch (err) {
        console.warn(`[DETETIVE] Entity extraction failed: ${err.message}`);
    }
    
    return null;
}

/**
 * Relax kill specs for broader search
 */
function relaxKillSpecs(specs, level) {
    switch (level) {
        case 1:
            // Remove numeric precision
            return specs.map(s => s.replace(/\d+/g, '').trim()).filter(s => s.length > 2);
        case 2:
            // Keep only main keywords
            return specs
                .map(s => s.split(/\s+/).slice(0, 2).join(' '))
                .filter(s => s.length > 2);
        default:
            return specs;
    }
}

/**
 * Relax queries for broader search
 */
function relaxQueries(queries, level) {
    return queries.map(q => {
        let relaxed = q;
        
        if (level >= 1) {
            relaxed = relaxed.replace(/site:\S+/gi, '');
            relaxed = relaxed.replace(/filetype:\S+/gi, '');
        }
        
        if (level >= 2) {
            relaxed = relaxed.replace(/"/g, '');
        }
        
        return relaxed.trim();
    });
}


module.exports = { executeDetetive };
