/**
 * MABUS HIVE-MIND Protocol
 * 
 * Multi-Agent Cognitive Architecture for Intelligent Quotation
 * 
 * Agents:
 * 1. PERITO (Extractor) - Identifies Kill-Specs from tender description
 * 2. DETETIVE (Scout) - Investigates open web to find manufacturers
 * 3. AUDITOR (Validator) - Validates specs on manufacturer sites
 * 4. SNIPER (Buyer) - Surgical marketplace search
 * 5. JUIZ (Cross-Referencer) - Resolves poor seller descriptions
 */

const { initBrowser, setCEP, searchAndScrape, getProductDetails } = require('./scraper');
const { executePerito } = require('./agents/perito');
const { executeDetetive } = require('./agents/detetive');
const { executeAuditor } = require('./agents/auditor');
const { executeSniper } = require('./agents/sniper');
const { executeJuiz } = require('./agents/juiz');
const { getCachedEntity, cacheEntity } = require('./services/entityCache');
const { DebugLogger } = require('./services/debug_logger');

// State Machine States
const STATES = {
    INIT: 'INIT',
    PERITO: 'PERITO',           // Extract Kill-Specs
    DETETIVE: 'DETETIVE',       // Web Investigation
    AUDITOR: 'AUDITOR',         // Manufacturer Validation
    SNIPER: 'SNIPER',           // Marketplace Search
    AVALIACAO: 'AVALIACAO',     // LEI 2: Strategic Sufficiency Assessment
    JUIZ: 'JUIZ',               // Cross-Reference
    COMPLETE: 'COMPLETE',
    FAILED: 'FAILED'
};

// Maximum retry loops
const MAX_RELAXATION_RETRIES = 3;
const MAX_VALIDATION_RETRIES = 2;
const MAX_ELASTIC_RETRIES = 3;  // LEI 2: Maximum search re-attempts

/**
 * Main execution function for HIVE-MIND module
 * Implements a state machine with recursive feedback loops
 */
async function execute(job, config) {
    const { id, description, maxPrice, quantity, browser, cep, logger } = job;
    
    // Initialize state
    let state = {
        current: STATES.INIT,
        item: { id, description, maxPrice, quantity },
        complexity: null,              // LOW or HIGH
        marketplaceSearchTerm: null,   // Clean query for marketplace
        searchAnchor: null,            // NEW: Anchor for fallback searches (ANCHOR & LOCK)
        maxPriceEstimate: null,        // NEW: Price estimate from PERITO
        killSpecs: null,
        googleQueries: null,
        discoveredEntities: [],
        goldEntity: null,
        kitComponents: [],
        candidates: [],
        winner: null,
        relaxationLevel: 0,
        validationRetries: 0,
        elasticRetryCount: 0,          // LEI 2: Elastic loop counter
        previousQueries: [],           // LEI 2: Track used queries to avoid repetition
        logs: []
    };
    
    // Page context for browser operations
    let page = null;
    
    try {
        page = await browser.newPage();
        
        // Initialize Debug Logger for comprehensive tracing
        const taskId = job.taskId || 'unknown';
        const debugLogger = new DebugLogger(taskId, id);
        
        // Store debugLogger in state for passing to agents
        state.debugLogger = debugLogger;
        
        // Log start
        logger.log(`🧠 [Item ${id}] HIVE-MIND Ativado`);
        logState(state, 'Iniciando investigação cognitiva', logger, id);
        
        // Check cache first
        const cached = await getCachedEntity(description);
        if (cached) {
            logger.log(`💾 [Item ${id}] Entidade em cache: ${cached.entity_name}`);
            state.goldEntity = {
                name: cached.entity_name,
                manufacturer: cached.manufacturer,
                searchQueries: JSON.parse(cached.search_queries || '[]'),
                cachedSpecs: JSON.parse(cached.specs_json || '{}')
            };
            state.current = STATES.SNIPER; // Skip to Sniper
        } else {
            state.current = STATES.PERITO;
        }
        
        // State Machine Loop
        while (state.current !== STATES.COMPLETE && state.current !== STATES.FAILED) {
            switch (state.current) {
                case STATES.PERITO:
                    state = await runPerito(state, config, logger, id);
                    break;
                    
                case STATES.DETETIVE:
                    state = await runDetetive(state, config, logger, id);
                    break;
                    
                case STATES.AUDITOR:
                    state = await runAuditor(state, page, config, logger, id);
                    break;
                    
                case STATES.SNIPER:
                    state = await runSniper(state, page, cep, config, logger, id);
                    break;
                
                // LEI 2: Strategic Sufficiency Assessment
                case STATES.AVALIACAO:
                    state = await runAvaliacao(state, page, cep, config, logger, id);
                    break;
                    
                case STATES.JUIZ:
                    state = await runJuiz(state, config, logger, id);
                    break;
                    
                default:
                    state.current = STATES.FAILED;
            }
        }
        
        // Prepare final result
        if (state.current === STATES.COMPLETE && state.candidates.length > 0) {
            logger.log(`🎉 [Item ${id}] HIVE-MIND Completo. ${state.candidates.length} candidatos encontrados.`);
            
            return {
                id,
                description,
                valor_venda: maxPrice,
                quantidade: quantity,
                offers: state.candidates,
                winnerIndex: state.winner !== null ? state.winner : 0,
                goldEntity: state.goldEntity,
                defenseReport: state.defenseReport
            };
        } else {
            logger.log(`⚠️ [Item ${id}] HIVE-MIND não encontrou resultados válidos.`);
            return {
                id,
                description,
                valor_venda: maxPrice,
                quantidade: quantity,
                offers: [],
                winnerIndex: -1
            };
        }
        
    } catch (err) {
        logger.log(`💥 [Item ${id}] HIVE-MIND Error: ${err.message}`);
        throw err;
    } finally {
        if (page) await page.close();
    }
}

// --- STATE HANDLERS ---

async function runPerito(state, config, logger, itemId) {
    logger.log(`🔬 [Item ${itemId}] PERITO (CODEX OMNI v10.0): Extraindo especificações...`);
    
    try {
        // Pass debugLogger to PERITO for tracing
        const result = await executePerito(state.item.description, config, state.debugLogger);
        
        state.complexity = result.complexity || 'HIGH';
        state.marketplaceSearchTerm = result.marketplaceSearchTerm || state.item.description.substring(0, 50);
        
        // CODEX OMNI v10.0: Separated anchor fields (anti-hallucination)
        state.searchAnchor = result.searchAnchor || null;           // Legacy with quotes
        state.searchAnchorRaw = result.searchAnchorRaw || null;     // Without quotes
        state.searchAnchorQuoted = result.searchAnchorQuoted || null; // With quotes for ML search
        
        state.maxPriceEstimate = result.maxPriceEstimate || state.item.maxPrice;
        state.killSpecs = result.killSpecs;
        state.googleQueries = result.queries;
        state.negativeTerms = result.negativeTerms || [];
        
        // CODEX OMNI v10.0: Calculate min viable price (THE GUILLOTINE - 20% of budget)
        const budget = state.item.maxPrice || state.maxPriceEstimate || 0;
        state.minViablePrice = budget > 0 ? budget * 0.20 : 0;
        
        // SKEPTICAL JUDGE fields from PERITO
        state.negativeConstraints = result.negativeConstraints || []; // Kill-words
        state.criticalSpecs = result.criticalSpecs || [];             // Specs with weights
        
        // CRITICAL: Store original description for JUIZ ground-truth matching
        state.originalDescription = result.originalDescription || state.item.description;
        
        logger.log(`📊 [Item ${itemId}] Complexidade: ${state.complexity}`);
        logger.log(`🏷️ [Item ${itemId}] Termo de Busca: "${state.marketplaceSearchTerm}"`);
        if (state.searchAnchorRaw) {
            logger.log(`⚓ [Item ${itemId}] Âncora VALIDADA: "${state.searchAnchorRaw}"`);
        }
        if (state.minViablePrice > 0) {
            logger.log(`💰 [Item ${itemId}] Preço Mínimo Viável: R$ ${state.minViablePrice.toFixed(2)} (Guilhotina 20%)`);
        }
        if (state.negativeConstraints.length > 0) {
            logger.log(`⛔ [Item ${itemId}] Kill-Words: ${state.negativeConstraints.join(', ')}`);
        }
        logger.log(`📋 [Item ${itemId}] Kill-Specs: ${state.killSpecs.join(', ')}`);
        
        logState(state, `PERITO extraiu ${state.killSpecs.length} especificações (${state.complexity})`, logger, itemId);
        
        // COMPLEXITY ROUTING: LOW items skip DETETIVE/AUDITOR
        if (state.complexity === 'LOW') {
            logger.log(`⚡ [Item ${itemId}] ROTEAMENTO: Complexidade BAIXA - pulando investigação`);
            state.goldEntity = {
                name: state.marketplaceSearchTerm,
                manufacturer: null,
                searchQueries: [state.marketplaceSearchTerm],
                isGeneric: true,
                isLowComplexity: true
            };
            state.current = STATES.SNIPER; // Skip directly to marketplace search
        } else {
            logger.log(`🔍 [Item ${itemId}] ROTEAMENTO: Complexidade ALTA - iniciando investigação`);
            state.current = STATES.DETETIVE;
        }
        
    } catch (err) {
        logger.log(`❌ [Item ${itemId}] PERITO Error: ${err.message}`);
        // Fallback: use marketplace term, default to DETETIVE
        state.complexity = 'HIGH';
        state.marketplaceSearchTerm = state.item.description.substring(0, 50);
        state.killSpecs = [state.item.description];
        state.googleQueries = [state.item.description.substring(0, 60)];
        state.current = STATES.DETETIVE;
    }
    
    return state;
}

async function runDetetive(state, config, logger, itemId) {
    logger.log(`🕵️ [Item ${itemId}] DETETIVE: Investigando web aberta...`);
    
    try {
        const result = await executeDetetive(
            state.killSpecs,
            state.googleQueries,
            state.relaxationLevel,
            config
        );
        
        if (result.retry && state.relaxationLevel < MAX_RELAXATION_RETRIES) {
            // Feedback loop: Ask PERITO to relax specs
            logger.log(`🔄 [Item ${itemId}] DETETIVE: Sem resultados. Relaxando especificações...`);
            state.relaxationLevel++;
            state.killSpecs = result.relaxedSpecs || state.killSpecs;
            state.googleQueries = result.relaxedQueries || state.googleQueries;
            state.current = STATES.PERITO; // Loop back
            return state;
        }
        
        if (!result.entities || result.entities.length === 0) {
            logger.log(`⚠️ [Item ${itemId}] DETETIVE: Nenhuma entidade descoberta.`);
            // CODEX OMNI v10.0: Set investigation status for SNIPER Anchor-Lock
            state.investigationStatus = "FAILED"; // Enables paranoid mode in SNIPER
            // Fallback to direct marketplace search with clean query
            state.goldEntity = {
                name: state.marketplaceSearchTerm || state.item.description.substring(0, 50),
                manufacturer: null,
                searchQueries: [state.marketplaceSearchTerm || state.item.description.substring(0, 50)],
                isGeneric: true
            };
            state.current = STATES.SNIPER;
            return state;
        }
        
        state.discoveredEntities = result.entities;
        state.investigationStatus = "SUCCESS"; // CODEX OMNI v10.0: Enables model-based search
        logger.log(`🎯 [Item ${itemId}] DETETIVE: ${result.entities.length} entidades descobertas`);
        for (const entity of result.entities.slice(0, 3)) {
            logger.log(`   → ${entity.name} (${entity.manufacturer || 'desconhecido'})`);
        }
        
        logState(state, `DETETIVE descobriu ${result.entities.length} entidades potenciais`, logger, itemId);
        
        state.current = STATES.AUDITOR;
        
    } catch (err) {
        logger.log(`❌ [Item ${itemId}] DETETIVE Error: ${err.message}`);
        // Fallback with clean query
        state.goldEntity = {
            name: state.marketplaceSearchTerm || state.item.description.substring(0, 50),
            manufacturer: null,
            searchQueries: [state.marketplaceSearchTerm || state.item.description.substring(0, 50)],
            isGeneric: true
        };
        state.current = STATES.SNIPER;
    }
    
    return state;
}

async function runAuditor(state, page, config, logger, itemId) {
    logger.log(`🔎 [Item ${itemId}] AUDITOR: Validando entidades descobertas...`);
    
    try {
        // Try each discovered entity until one validates
        for (const entity of state.discoveredEntities) {
            logger.log(`📝 [Item ${itemId}] AUDITOR: Verificando ${entity.name}...`);
            
            const result = await executeAuditor(entity, state.killSpecs, page, config);
            
            if (result.validated) {
                state.goldEntity = {
                    ...entity,
                    detectedModel: entity.name,  // NEW: Enable SNIPER's detected model search
                    validatedSpecs: result.specs,
                    searchQueries: result.searchQueries || [entity.name],
                    sourceUrl: result.sourceUrl
                };
                
                // Check for kit composition
                if (result.kitNeeded) {
                    state.kitComponents = result.missingItems || [];
                    logger.log(`🧩 [Item ${itemId}] AUDITOR: Kit detectado. ${state.kitComponents.length} itens adicionais.`);
                }
                
                logger.log(`✅ [Item ${itemId}] AUDITOR: "${entity.name}" VALIDADO`);
                
                // Cache the discovery
                await cacheEntity(state.item.description, state.goldEntity);
                
                logState(state, `AUDITOR validou "${entity.name}" como Gold Entity`, logger, itemId);
                
                state.current = STATES.SNIPER;
                return state;
            } else {
                logger.log(`❌ [Item ${itemId}] AUDITOR: "${entity.name}" não passou. Razão: ${result.reason}`);
            }
        }
        
        // None validated - retry loop
        if (state.validationRetries < MAX_VALIDATION_RETRIES) {
            state.validationRetries++;
            logger.log(`🔄 [Item ${itemId}] AUDITOR: Retry ${state.validationRetries}. Voltando ao DETETIVE...`);
            state.relaxationLevel++;
            state.current = STATES.DETETIVE;
            return state;
        }
        
        // All retries exhausted - fallback to generic search with clean query
        logger.log(`⚠️ [Item ${itemId}] AUDITOR: Todas as entidades falharam. Usando busca genérica.`);
        state.goldEntity = {
            name: state.marketplaceSearchTerm || state.item.description.substring(0, 50),
            manufacturer: null,
            searchQueries: [state.marketplaceSearchTerm || state.item.description.substring(0, 50)],
            isGeneric: true
        };
        state.current = STATES.SNIPER;
        
    } catch (err) {
        logger.log(`❌ [Item ${itemId}] AUDITOR Error: ${err.message}`);
        state.goldEntity = {
            name: state.marketplaceSearchTerm || state.item.description.substring(0, 50),
            manufacturer: null,
            searchQueries: [state.marketplaceSearchTerm || state.item.description.substring(0, 50)],
            isGeneric: true
        };
        state.current = STATES.SNIPER;
    }
    
    return state;
}

async function runSniper(state, page, cep, config, logger, itemId) {
    logger.log(`🎯 [Item ${itemId}] SNIPER: Busca cirúrgica no marketplace...`);
    
    try {
        const entity = state.goldEntity;
        logger.log(`🔍 [Item ${itemId}] SNIPER: Buscando "${entity.searchQueries[0]}"...`);
        
        const result = await executeSniper(
            entity,
            state.kitComponents,
            state.item.maxPrice,
            state.item.quantity,
            page,
            cep,
            config,
            state.searchAnchor  // NEW: Pass search anchor for ANCHOR & LOCK doctrine
        );
        
        if (!result.candidates || result.candidates.length === 0) {
            logger.log(`⚠️ [Item ${itemId}] SNIPER: Nenhum candidato encontrado.`);
            state.candidates = [];
            state.current = STATES.COMPLETE;
            return state;
        }
        
        state.candidates = result.candidates;
        state.kitPricing = result.kitPricing || null;
        
        logger.log(`📦 [Item ${itemId}] SNIPER: ${result.candidates.length} candidatos encontrados`);
        
        if (state.kitPricing) {
            logger.log(`🧩 [Item ${itemId}] SNIPER: Kit composto. Total: R$ ${state.kitPricing.total}`);
        }
        
        logState(state, `SNIPER encontrou ${result.candidates.length} candidatos no marketplace`, logger, itemId);
        
        // LEI 2: Go to AVALIACAO for strategic sufficiency check
        state.current = STATES.AVALIACAO;
        
    } catch (err) {
        logger.log(`❌ [Item ${itemId}] SNIPER Error: ${err.message}`);
        state.candidates = [];
        state.current = STATES.COMPLETE;
    }
    
    return state;
}

async function runJuiz(state, config, logger, itemId) {
    logger.log(`⚖️ [Item ${itemId}] JUIZ (CODEX OMNI v10.0): Validação com Risco Decimal...`);
    
    try {
        // Build specs object for SKEPTICAL JUDGE (CODEX OMNI v10.0)
        const specs = {
            searchAnchor: state.searchAnchor || null,
            searchAnchorRaw: state.searchAnchorRaw || null, // Without quotes
            negativeConstraints: state.negativeConstraints || [],
            criticalSpecs: state.criticalSpecs || [],
            minViablePrice: state.minViablePrice || 0, // THE GUILLOTINE (20% of budget)
            originalDescription: state.originalDescription || state.item.description // CRITICAL: For ground-truth matching
        };
        
        const result = await executeJuiz(
            state.candidates,
            state.goldEntity,
            state.killSpecs,
            state.item,
            config,
            specs,                         // NEW: PERITO specs for scoring
            state.detectedModel || null,   // NEW: DETETIVE model for bonus
            state.debugLogger              // NEW: Debug logger for detailed tracing
        );
        
        // Update candidates with JUIZ validation
        state.candidates = result.validatedCandidates;
        state.winner = result.winnerIndex;
        state.defenseReport = result.defenseReport;
        
        if (state.winner !== null && state.winner >= 0) {
            const winner = state.candidates[state.winner];
            logger.log(`🏆 [Item ${itemId}] JUIZ: Vencedor: ${winner.title.substring(0, 60)}...`);
            logger.log(`📊 [Item ${itemId}] Risco: ${winner.risk_score} | Score: ${winner.adherenceScore || 'N/A'}`);
            logger.log(`💰 [Item ${itemId}] Preço Final: R$ ${winner.totalPrice || winner.price}`);
        } else {
            logger.log(`⚠️ [Item ${itemId}] JUIZ: Nenhum candidato com risco aceitável encontrado.`);
        }
        
        logState(state, `JUIZ concluiu validação com Risco Decimal`, logger, itemId);
        
        // Finalize debug log and report file path
        if (state.debugLogger) {
            const logFilePath = state.debugLogger.finalize();
            logger.log(`📝 [Item ${itemId}] Debug log salvo: ${logFilePath}`);
        }
        
        state.current = STATES.COMPLETE;
        
    } catch (err) {
        logger.log(`❌ [Item ${itemId}] JUIZ Error: ${err.message}`);
        if (state.debugLogger) {
            state.debugLogger.error('JUIZ', err.message, err.stack);
            state.debugLogger.finalize();
        }
        state.current = STATES.COMPLETE;
    }
    
    return state;
}

// ============================================
// LEI 2: STRATEGIC SUFFICIENCY ASSESSMENT
// ============================================

/**
 * Evaluate if the candidates are sufficient or if we need another search pass.
 * This implements ELASTIC COGNITION: the system doesn't give up easily.
 */
async function runAvaliacao(state, page, cep, config, logger, itemId) {
    logger.log(`🔄 [Item ${itemId}] AVALIACAO: Verificando suficiência dos resultados...`);
    
    // Quick pre-assessment: calculate how many candidates look promising
    // A candidate is promising if it has ProductDNA and a reasonable price
    const budget = state.item.maxPrice || state.maxPriceEstimate || Infinity;
    const minViablePrice = budget * 0.10; // 10% floor
    const maxViablePrice = budget * 1.50; // 150% ceiling
    
    const promisingCandidates = state.candidates.filter(c => {
        const hasProductDNA = c.productDNA && c.productDNA.fullText && c.productDNA.fullText.length > 50;
        const hasReasonablePrice = c.price >= minViablePrice && c.price <= maxViablePrice;
        const notAnomaly = !c.priceAnomaly;
        return hasProductDNA && hasReasonablePrice && notAnomaly;
    });
    
    const promisingCount = promisingCandidates.length;
    const totalCount = state.candidates.length;
    
    logger.log(`📊 [Item ${itemId}] AVALIACAO: ${promisingCount}/${totalCount} candidatos promissores`);
    
    // Decision logic
    const MINIMUM_PROMISING = 2;
    const needsRetry = promisingCount < MINIMUM_PROMISING && state.elasticRetryCount < MAX_ELASTIC_RETRIES;
    
    if (needsRetry) {
        state.elasticRetryCount++;
        
        // Track what we already tried
        const currentQuery = state.goldEntity?.searchQueries?.[0] || state.marketplaceSearchTerm;
        if (currentQuery && !state.previousQueries.includes(currentQuery)) {
            state.previousQueries.push(currentQuery);
        }
        
        logger.log(`🔁 [Item ${itemId}] AVALIACAO: Retry ${state.elasticRetryCount}/${MAX_ELASTIC_RETRIES} - Gerando novas queries...`);
        
        // Generate alternative queries using different strategies
        const alternativeQueries = generateAlternativeQueries(state, logger, itemId);
        
        if (alternativeQueries.length > 0) {
            // Update entity with new queries
            state.goldEntity = {
                ...state.goldEntity,
                searchQueries: alternativeQueries,
                isElasticRetry: true
            };
            
            logger.log(`🔍 [Item ${itemId}] AVALIACAO: Novas queries: ${alternativeQueries.join(', ')}`);
            
            // Go back to SNIPER with new queries
            state.current = STATES.SNIPER;
        } else {
            // No more alternatives, proceed to JUIZ
            logger.log(`⚠️ [Item ${itemId}] AVALIACAO: Sem alternativas de busca. Procedendo com ${totalCount} candidatos.`);
            state.current = STATES.JUIZ;
        }
    } else {
        // We have enough candidates or exhausted retries
        if (state.elasticRetryCount >= MAX_ELASTIC_RETRIES) {
            logger.log(`⏹️ [Item ${itemId}] AVALIACAO: Limite de ${MAX_ELASTIC_RETRIES} retries atingido.`);
        } else {
            logger.log(`✅ [Item ${itemId}] AVALIACAO: ${promisingCount} candidatos suficientes. Enviando ao JUIZ.`);
        }
        
        state.current = STATES.JUIZ;
    }
    
    logState(state, `AVALIACAO: ${promisingCount} promissores, elasticRetry=${state.elasticRetryCount}`, logger, itemId);
    
    return state;
}

/**
 * Generate alternative search queries based on previous attempts.
 */
function generateAlternativeQueries(state, logger, itemId) {
    const alternatives = [];
    const tried = state.previousQueries || [];
    
    // Strategy 1: Use anchor if available and not tried
    if (state.searchAnchor && !tried.some(q => q.includes(state.searchAnchor))) {
        const anchorQuery = state.searchAnchor.replace(/"/g, '');
        if (anchorQuery.length > 3) {
            alternatives.push(anchorQuery);
        }
    }
    
    // Strategy 2: Use kill specs as queries (most specific first)
    if (state.killSpecs && state.killSpecs.length > 0) {
        for (const spec of state.killSpecs.slice(0, 2)) {
            const specQuery = spec.trim();
            if (specQuery.length > 5 && !tried.some(q => q.toLowerCase() === specQuery.toLowerCase())) {
                alternatives.push(specQuery);
            }
        }
    }
    
    // Strategy 3: Simplify marketplace term (remove modifiers)
    const simpleTerm = state.marketplaceSearchTerm?.split(' ').slice(0, 2).join(' ');
    if (simpleTerm && simpleTerm.length > 3 && !tried.includes(simpleTerm)) {
        alternatives.push(simpleTerm);
    }
    
    // Filter out already tried queries
    const newQueries = alternatives.filter(q => !tried.includes(q));
    
    logger.log(`💡 [Item ${itemId}] AVALIACAO: ${newQueries.length} queries alternativas geradas`);
    
    return newQueries.slice(0, 2); // Max 2 new queries per retry
}

// --- HELPERS ---

function logState(state, message, logger, itemId) {
    state.logs.push({
        timestamp: new Date().toISOString(),
        state: state.current,
        message
    });
    
    logger.thought(itemId, state.current, message);
}

module.exports = { execute, initBrowser, setCEP };
