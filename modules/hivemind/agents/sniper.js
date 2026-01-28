/**
 * SNIPER Agent (The Buyer)
 * 
 * Mission: Surgical marketplace search for validated entities.
 * Only searches for the GOLD ENTITY, not generic terms.
 * Supports kit composition (multiple items).
 * 
 * Output:
 * - candidates: Array of products found
 * - kitPricing: Aggregated kit pricing if applicable
 */

const { searchAndScrape, getProductDetails } = require('../scraper');
const { generateText, PROVIDERS } = require('../../../src/services/ai_manager');
const { getSetting } = require('../../../src/database');

// Price anomaly threshold (items below this % of median are suspicious)
const PRICE_ANOMALY_THRESHOLD = 0.30;

// CRITICAL: Maximum query length to prevent "query dumping"
const MAX_QUERY_LENGTH = 60;

/**
 * Execute SNIPER agent
 * @param {object} entity - Gold Entity validated by AUDITOR
 * @param {object[]} kitComponents - Additional items for kit composition
 * @param {number} maxPrice - Maximum acceptable price
 * @param {number} quantity - Quantity required
 * @param {object} page - Puppeteer page
 * @param {string} cep - CEP for shipping calculation
 * @param {object} config - AI configuration
 */
async function executeSniper(entity, kitComponents, maxPrice, quantity, page, cep, config) {
    console.log(`[SNIPER] Targeting: ${entity.name}`);
    
    // 1. Search for main entity
    const mainCandidates = await searchForEntity(entity, page, cep);
    
    if (mainCandidates.length === 0 && !entity.isGeneric) {
        // Try broader search with just the model name
        console.log('[SNIPER] No results for specific search, trying broader...');
        const broaderQuery = entity.name.split(' ').slice(0, 3).join(' ');
        const broaderResults = await searchWithQuery(broaderQuery, page, cep);
        mainCandidates.push(...broaderResults);
    }
    
    if (mainCandidates.length === 0) {
        return { candidates: [], kitPricing: null };
    }
    
    // 2. Filter price anomalies
    const filteredCandidates = filterPriceAnomalies(mainCandidates);
    console.log(`[SNIPER] ${filteredCandidates.length} candidates after price filter`);
    
    // 3. Get detailed info for top candidates
    const detailedCandidates = [];
    for (const candidate of filteredCandidates.slice(0, 10)) {
        try {
            const details = await getProductDetails(page, candidate.link, cep);
            detailedCandidates.push({
                ...candidate,
                shippingCost: details.shippingCost || 0,
                attributes: details.attributes || [],
                description: details.description || '',
                totalPrice: candidate.price + (details.shippingCost || 0),
                seller: details.seller || {},
                isGoldEntity: !entity.isGeneric
            });
        } catch (err) {
            console.warn(`[SNIPER] Error getting details for ${candidate.link}: ${err.message}`);
            detailedCandidates.push({
                ...candidate,
                shippingCost: 0,
                totalPrice: candidate.price,
                isGoldEntity: !entity.isGeneric
            });
        }
    }
    
    // 4. Handle kit composition
    let kitPricing = null;
    if (kitComponents && kitComponents.length > 0) {
        kitPricing = await buildKitPricing(kitComponents, page, cep);
        
        // Add kit pricing to each main candidate
        if (kitPricing && kitPricing.total > 0) {
            for (const candidate of detailedCandidates) {
                candidate.kitComponents = kitPricing.items;
                candidate.kitTotal = kitPricing.total;
                candidate.totalPriceWithKit = candidate.totalPrice + kitPricing.total;
            }
        }
    }
    
    // 5. Sort by total price (including kit if applicable)
    detailedCandidates.sort((a, b) => {
        const priceA = a.totalPriceWithKit || a.totalPrice;
        const priceB = b.totalPriceWithKit || b.totalPrice;
        return priceA - priceB;
    });
    
    return {
        candidates: detailedCandidates,
        kitPricing
    };
}

/**
 * Sanitize query to prevent "query dumping" (oversized queries)
 */
function sanitizeQuery(query, entity = null) {
    if (!query) return '';
    
    const originalLength = query.length;
    let sanitized = query.trim();
    
    // If query is too long, truncate intelligently
    if (sanitized.length > MAX_QUERY_LENGTH) {
        // Try to use marketplace search term if available
        if (entity && entity.marketplaceSearchTerm && entity.marketplaceSearchTerm.length <= MAX_QUERY_LENGTH) {
            console.log(`[SNIPER] Query sanitized: ${originalLength} chars -> ${entity.marketplaceSearchTerm.length} chars (using marketplace term)`);
            return entity.marketplaceSearchTerm;
        }
        
        // Take first N words that fit within limit
        const words = sanitized.split(/\s+/);
        sanitized = '';
        for (const word of words) {
            if ((sanitized + ' ' + word).trim().length <= MAX_QUERY_LENGTH) {
                sanitized = (sanitized + ' ' + word).trim();
            } else {
                break;
            }
        }
        
        console.log(`[SNIPER] Query sanitized: ${originalLength} chars -> ${sanitized.length} chars`);
    }
    
    return sanitized || query.substring(0, MAX_QUERY_LENGTH);
}

/**
 * Search for a specific entity
 */
async function searchForEntity(entity, page, cep) {
    const allResults = [];
    
    // Get search queries, applying sanitization
    const rawQueries = entity.searchQueries || [entity.name];
    const sanitizedQueries = rawQueries.map(q => sanitizeQuery(q, entity));
    
    for (const query of sanitizedQueries.slice(0, 2)) {
        try {
            console.log(`[SNIPER] Searching marketplace: "${query}"`);
            const results = await searchAndScrape(page, query);
            allResults.push(...results);
        } catch (err) {
            if (err.message === 'BLOCKED_BY_PORTAL') throw err;
            console.warn(`[SNIPER] Search error for "${query}": ${err.message}`);
        }
    }
    
    // Deduplicate by URL
    const seen = new Set();
    return allResults.filter(r => {
        if (!r.price) return false;
        if (seen.has(r.link)) return false;
        seen.add(r.link);
        return true;
    });
}

/**
 * Search with a generic query (also sanitized)
 */
async function searchWithQuery(query, page, cep) {
    try {
        const sanitized = sanitizeQuery(query);
        console.log(`[SNIPER] Generic search: "${sanitized}"`);
        const results = await searchAndScrape(page, sanitized);
        return results.filter(r => r.price);
    } catch (err) {
        console.warn(`[SNIPER] Query search error: ${err.message}`);
        return [];
    }
}

/**
 * Filter out price anomalies (too cheap = suspicious)
 */
function filterPriceAnomalies(candidates) {
    if (candidates.length < 3) return candidates;
    
    // Calculate median price
    const prices = candidates.map(c => c.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    
    // Filter out items that are suspiciously cheap
    const threshold = median * PRICE_ANOMALY_THRESHOLD;
    
    return candidates.map(c => {
        if (c.price < threshold) {
            c.priceAnomaly = true;
            c.anomalyReason = `Preço ${Math.round((c.price / median) * 100)}% da mediana. Possível peça/sucata.`;
        }
        return c;
    });
}

/**
 * Build kit pricing for additional items
 */
async function buildKitPricing(components, page, cep) {
    const items = [];
    let total = 0;
    
    for (const component of components) {
        try {
            const results = await searchWithQuery(component.search_query || component.item, page, cep);
            
            if (results.length > 0) {
                // Get cheapest valid option
                const cheapest = results
                    .filter(r => r.price > 0)
                    .sort((a, b) => a.price - b.price)[0];
                
                if (cheapest) {
                    const qty = component.quantity || 1;
                    const itemTotal = cheapest.price * qty;
                    
                    items.push({
                        name: component.item,
                        quantity: qty,
                        unitPrice: cheapest.price,
                        totalPrice: itemTotal,
                        link: cheapest.link,
                        title: cheapest.title
                    });
                    
                    total += itemTotal;
                }
            }
        } catch (err) {
            console.warn(`[SNIPER] Kit item search failed for ${component.item}: ${err.message}`);
        }
    }
    
    return { items, total };
}

module.exports = { executeSniper };
