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
const { generateText, PROVIDERS, getApiKeyFromEnv } = require('../../../src/services/ai_manager');
const { getSetting } = require('../../../src/database');

// Price anomaly threshold (items below this % of median are suspicious)
const PRICE_ANOMALY_THRESHOLD = 0.30;

// CRITICAL: Maximum query length to prevent "query dumping"
const MAX_QUERY_LENGTH = 60;

// Smart Candidate Selection: Delay between searches (ms)
const SEARCH_DELAY_MS = 1500;

/**
 * Execute SNIPER agent
 * @param {object} entity - Gold Entity validated by AUDITOR
 * @param {object[]} kitComponents - Additional items for kit composition
 * @param {number} maxPrice - Maximum acceptable price
 * @param {number} quantity - Quantity required
 * @param {object} page - Puppeteer page
 * @param {string} cep - CEP for shipping calculation
 * @param {object} config - AI configuration
 * @param {string} searchAnchor - Search anchor for fallback searches (ANCHOR & LOCK doctrine)
 */
async function executeSniper(entity, kitComponents, maxPrice, quantity, page, cep, config, searchAnchor = null) {
    console.log(`[SNIPER] Targeting: ${entity.name}`);
    if (searchAnchor) {
        console.log(`[SNIPER] Search Anchor disponível: ${searchAnchor}`);
    }

    // 1. Search for main entity (using ANCHOR & LOCK doctrine)
    const mainCandidates = await searchForEntity(entity, page, cep, searchAnchor);

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

    // 3. Get detailed info for top candidates (with ProductDNA for SKEPTICAL JUDGE)
    const detailedCandidates = [];
    for (const candidate of filteredCandidates.slice(0, 10)) {
        try {
            const details = await getProductDetails(page, candidate.link, cep);

            // CRITICAL FIX: Propagate ProductDNA from scraper to candidate
            // This enables the JUIZ to perform accurate spec matching
            const productDNA = details.productDNA || {
                title: candidate.title || '',
                specsText: '',
                descriptionText: details.description || '',
                fullText: `${candidate.title || ''} ${details.description || ''}`.toLowerCase(),
                fullTextRaw: `${candidate.title || ''} ${details.description || ''}`
            };

            console.log(`[SNIPER] ProductDNA extracted for "${candidate.title?.substring(0, 40)}..." (${productDNA.fullText?.length || 0} chars)`);

            detailedCandidates.push({
                ...candidate,
                productDNA,  // CRITICAL: Now propagating ProductDNA!
                shippingCost: details.shippingCost || 0,
                attributes: details.attributes || [],
                description: details.description || '',
                totalPrice: candidate.price + (details.shippingCost || 0),
                seller: details.seller || {},
                gtin: details.gtin || null,
                mpn: details.mpn || null,
                brand: details.brand || null,
                model: details.model || null,
                isGoldEntity: !entity.isGeneric
            });
        } catch (err) {
            console.warn(`[SNIPER] Error getting details for ${candidate.link}: ${err.message}`);
            // Fallback: Create minimal ProductDNA from title
            detailedCandidates.push({
                ...candidate,
                productDNA: {
                    title: candidate.title || '',
                    specsText: '',
                    descriptionText: '',
                    fullText: (candidate.title || '').toLowerCase(),
                    fullTextRaw: candidate.title || ''
                },
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
 * Search for a specific entity (ANCHOR & LOCK doctrine)
 * Implements dual search logic:
 * 1. If detected model exists, search by exact model name
 * 2. If fallback (generic), use marketplace term + search anchor
 */
async function searchForEntity(entity, page, cep, searchAnchor = null) {
    const allResults = [];

    // CASO 1: Modelo específico detectado pelo DETETIVE
    if (entity.detectedModel && !entity.isGeneric) {
        console.log(`[SNIPER] 🎯 Modo MODELO DETECTADO: "${entity.detectedModel}"`);
        const sanitized = sanitizeQuery(entity.detectedModel, entity);
        try {
            const results = await searchAndScrape(page, sanitized);
            allResults.push(...results);
        } catch (err) {
            if (err.message === 'BLOCKED_BY_PORTAL') throw err;
            console.warn(`[SNIPER] Search error for detected model: ${err.message}`);
        }
    }
    // CASO 2: Fallback com Âncora (A MÁGICA DO ANCHOR & LOCK)
    else if (searchAnchor) {
        // Combina termo comercial + âncora técnica
        // Ex: "Sirene Escolar Digital" + "72 músicas" = 'Sirene Escolar Digital "72 músicas"'
        const anchoredQuery = `${entity.name} ${searchAnchor}`;
        const sanitized = sanitizeQuery(anchoredQuery, entity);
        console.log(`[SNIPER] ⚓ Modo ÂNCORA: "${sanitized}"`);
        try {
            const results = await searchAndScrape(page, sanitized);
            allResults.push(...results);

            // Se não encontrou resultados com âncora, tenta sem (mas loga aviso)
            if (results.length === 0) {
                console.log(`[SNIPER] ⚠️ Âncora não retornou resultados, tentando busca simples...`);
                const simpleQuery = sanitizeQuery(entity.name, entity);
                const fallbackResults = await searchAndScrape(page, simpleQuery);
                allResults.push(...fallbackResults);
            }
        } catch (err) {
            if (err.message === 'BLOCKED_BY_PORTAL') throw err;
            console.warn(`[SNIPER] Search error for anchored query: ${err.message}`);
        }
    }
    // CASO 3: Busca genérica (último recurso - sem proteção)
    else {
        console.log(`[SNIPER] ⚠️ Modo GENÉRICO (sem âncora): "${entity.name}"`);
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

// ============================================
// SMART CANDIDATE SELECTION - Phase 6A
// ============================================

/**
 * Collect ALL titles from ALL search strategies
 * Returns deduplicated list of products with metadata
 */
async function collectAllTitles(strategies, page, cep) {
    const allTitles = [];
    const seenTitles = new Set();

    console.log(`[SNIPER] 📋 Coletando títulos de ${strategies.length} estratégias...`);

    for (const strategy of strategies) {
        console.log(`[SNIPER] 🔍 Estratégia "${strategy.type}": "${strategy.query}"`);

        try {
            const sanitized = sanitizeQuery(strategy.query);
            const results = await searchAndScrape(page, sanitized);

            let addedCount = 0;
            for (const r of results) {
                const titleKey = r.title.toLowerCase().trim();
                if (!seenTitles.has(titleKey) && r.price > 0) {
                    seenTitles.add(titleKey);
                    allTitles.push({
                        title: r.title,
                        price: r.price,
                        link: r.link,
                        sourceStrategy: strategy.type,
                        sourceQuery: strategy.query
                    });
                    addedCount++;
                }
            }

            console.log(`[SNIPER]   → ${results.length} resultados, ${addedCount} novos únicos`);

        } catch (err) {
            if (err.message === 'BLOCKED_BY_PORTAL') throw err;
            console.warn(`[SNIPER]   ⚠️ Erro na busca: ${err.message}`);
        }

        // CRITICAL: Delay between searches to avoid rate limiting
        await new Promise(r => setTimeout(r, SEARCH_DELAY_MS));
    }

    console.log(`[SNIPER] 📦 Total: ${allTitles.length} títulos únicos coletados`);
    return allTitles;
}

/**
 * AI pre-filter: Ask AI which products are worth investigating
 * Returns array of indices of selected products
 */
async function aiSelectCandidates(titles, originalDescription, config) {
    if (titles.length === 0) {
        return [];
    }

    // Build titles list (limit to 50 to avoid token overflow)
    const maxTitles = Math.min(titles.length, 50);
    const titlesForAI = titles.slice(0, maxTitles);

    const titlesList = titlesForAI
        .map((t, i) => `${i + 1}. ${t.title} - R$ ${t.price.toFixed(2)}`)
        .join('\n');

    const prompt = `Uma prefeitura quer comprar:

"${originalDescription}"

Abaixo estão ${titlesForAI.length} produtos encontrados no Mercado Livre:

${titlesList}

Quais destes produtos VALEM A PENA ser investigados mais de perto?
Considere: título compatível, preço razoável, parece atender ao edital.

Responda APENAS com os números dos itens relevantes, separados por vírgula.
Exemplo: 1, 3, 7, 12

Se nenhum parecer relevante, responda "NENHUM".
Limite: máximo 15 itens.`;

    console.log(`[SNIPER] 🤖 Perguntando à IA quais ${titlesForAI.length} produtos investigar...`);

    try {
        // Get AI configuration
        let provider = config.provider || await getSetting('sniper_provider') || PROVIDERS.DEEPSEEK;
        let model = config.model || await getSetting('sniper_model') || 'deepseek-chat';
        let apiKey = getApiKeyFromEnv(provider);

        if (!apiKey) {
            console.warn(`[SNIPER] ⚠️ No API key for "${provider}", using DeepSeek`);
            provider = PROVIDERS.DEEPSEEK;
            model = 'deepseek-chat';
            apiKey = getApiKeyFromEnv(PROVIDERS.DEEPSEEK);
        }

        const response = await generateText({
            provider,
            model,
            apiKey,
            messages: [{ role: 'user', content: prompt }]
        });

        console.log(`[SNIPER] 🤖 IA respondeu: "${response.substring(0, 100)}..."`);

        // Parse response
        if (response.toUpperCase().includes('NENHUM')) {
            console.log(`[SNIPER] ⚠️ IA não encontrou candidatos relevantes`);
            return [];
        }

        // Extract numbers from response
        const numbers = response.match(/\d+/g);
        if (!numbers) {
            console.warn(`[SNIPER] ⚠️ Resposta da IA sem números, usando fallback`);
            // Fallback: return first 10
            return titlesForAI.slice(0, 10).map((_, i) => i);
        }

        const indices = numbers
            .map(n => parseInt(n, 10) - 1)  // Convert to 0-indexed
            .filter(i => i >= 0 && i < titlesForAI.length)
            .slice(0, 15);  // Max 15

        console.log(`[SNIPER] 🎯 IA selecionou ${indices.length} candidatos para investigação`);
        return indices;

    } catch (err) {
        console.error(`[SNIPER] ❌ Erro na seleção por IA: ${err.message}`);
        // Fallback: return first 10
        return titles.slice(0, 10).map((_, i) => i);
    }
}

/**
 * Get detailed info for selected candidates (sequential, with delays)
 */
async function getDetailsForSelected(selectedIndices, allTitles, page, cep) {
    const detailedCandidates = [];

    console.log(`[SNIPER] 📝 Buscando detalhes de ${selectedIndices.length} candidatos...`);

    for (let i = 0; i < selectedIndices.length; i++) {
        const idx = selectedIndices[i];
        const title = allTitles[idx];

        console.log(`[SNIPER]   [${i + 1}/${selectedIndices.length}] "${title.title.substring(0, 40)}..."`);

        try {
            const details = await getProductDetails(page, title.link, cep);

            // Build ProductDNA
            const productDNA = details.productDNA || {
                title: title.title || '',
                specsText: '',
                descriptionText: details.description || '',
                fullText: `${title.title || ''} ${details.description || ''}`.toLowerCase(),
                fullTextRaw: `${title.title || ''} ${details.description || ''}`
            };

            detailedCandidates.push({
                ...title,
                productDNA,
                shippingCost: details.shippingCost || 0,
                attributes: details.attributes || [],
                description: details.description || '',
                totalPrice: title.price + (details.shippingCost || 0),
                seller: details.seller || {},
                gtin: details.gtin || null,
                mpn: details.mpn || null,
                brand: details.brand || null,
                model: details.model || null
            });

            // Delay between detail fetches
            await new Promise(r => setTimeout(r, 500));

        } catch (err) {
            console.warn(`[SNIPER]   ⚠️ Erro ao buscar detalhes: ${err.message}`);
            // Add with minimal data
            detailedCandidates.push({
                ...title,
                productDNA: {
                    title: title.title || '',
                    specsText: '',
                    descriptionText: '',
                    fullText: (title.title || '').toLowerCase(),
                    fullTextRaw: title.title || ''
                },
                shippingCost: 0,
                totalPrice: title.price
            });
        }
    }

    return detailedCandidates;
}

module.exports = { executeSniper, collectAllTitles, aiSelectCandidates, getDetailsForSelected };
