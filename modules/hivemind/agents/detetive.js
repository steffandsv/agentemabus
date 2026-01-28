/**
 * DETETIVE Agent (The Scout)
 * 
 * Mission: Leave the marketplace and investigate the open web.
 * Find the actual MANUFACTURER/MODEL that matches the Kill-Specs.
 * 
 * Tools:
 * - Google Custom Search API (or SerpAPI)
 * - Jina Reader (convert any URL to markdown)
 * 
 * Output:
 * - entities: Array of discovered manufacturers/models
 * - OR retry signal with relaxed specs
 */

const path = require('path');
const fs = require('fs');
const fetch = require('node-fetch');
const { generateText, PROVIDERS } = require('../../../src/services/ai_manager');
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
    
    return { entities, retry: false };
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
                // Use existing Google Custom Search
                results = await customSearch(query) || [];
            } else {
                // Fallback: Mock/limited search
                console.log(`[DETETIVE] Google Search not configured. Using mock data.`);
                results = generateMockSearchResults(query);
            }
            
            allResults.push(...results);
        } catch (err) {
            console.warn(`[DETETIVE] Search error for "${query}": ${err.message}`);
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

/**
 * Generate mock search results for testing when API is not available
 */
function generateMockSearchResults(query) {
    // This is a fallback - real implementation would use the API
    console.log(`[DETETIVE] Mock search for: ${query}`);
    return [];
}

module.exports = { executeDetetive };
