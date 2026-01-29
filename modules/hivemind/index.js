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
// Smart Candidate Selection: Import new functions
const { executeSniper, collectAllTitles, aiSelectCandidates, getDetailsForSelected } = require('./agents/sniper');
// Smart Candidate Selection: Import direct evaluation
const { executeJuiz, evaluateCandidateDirect } = require('./agents/juiz');
const { getCachedEntity, cacheEntity } = require('./services/entityCache');
const { DebugLogger } = require('./services/debug_logger');
const { askPerplexity } = require('../perplexity/client'); // GOLDEN PATH: Enrichment via Perplexity

// State Machine States
const STATES = {
    INIT: 'INIT',
    PERITO: 'PERITO',           // Extract Kill-Specs
    DETETIVE: 'DETETIVE',       // Web Investigation
    AUDITOR: 'AUDITOR',         // Manufacturer Validation
    SNIPER: 'SNIPER',           // Marketplace Search
    AVALIACAO: 'AVALIACAO',     // LEI 2: Strategic Sufficiency Assessment
    ENRICHMENT: 'ENRICHMENT',   // GOLDEN PATH: Data enrichment via external sources
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

                // GOLDEN PATH: Data enrichment via external sources
                case STATES.ENRICHMENT:
                    state = await runEnrichment(state, config, logger, id);
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
        // v10.3 FLEXÍVEL & IMPLACÁVEL: Removed googleQueries, negativeTerms, negativeConstraints
        state.searchVariations = result.searchVariations || []; // Alternative search terms

        // CODEX OMNI v10.0: Calculate min viable price (THE GUILLOTINE - 20% of budget)
        const budget = state.item.maxPrice || state.maxPriceEstimate || 0;
        state.minViablePrice = budget > 0 ? budget * 0.20 : 0;

        // SKEPTICAL JUDGE fields from PERITO (v10.3: negativeConstraints removed)
        state.criticalSpecs = result.criticalSpecs || [];             // Specs with weights

        // GOLDEN PATH v11.0: Store search strategies for fallback loop
        state.searchStrategies = result.searchStrategies || [];
        state.strategyIndex = 0; // Current strategy being tried

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
        // v10.3: Kill-words log removed (feature was removed)
        if (state.searchVariations.length > 0) {
            logger.log(`🔄 [Item ${itemId}] Variações de busca: ${state.searchVariations.slice(0, 2).join(' | ')}`);
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
    logger.log(`🎯 [Item ${itemId}] SNIPER: Smart Candidate Selection v2.0...`);

    // SMART CANDIDATE SELECTION: 3-Phase Approach
    const strategies = state.searchStrategies || [];

    if (strategies.length === 0) {
        // Fallback: Create basic strategies from available data
        const fallbackQuery = state.marketplaceSearchTerm || state.goldEntity?.name || state.item.description.substring(0, 50);
        strategies.push({
            type: 'fallback',
            query: fallbackQuery,
            priority: 1,
            description: 'Fallback query'
        });
    }

    logger.log(`📋 [Item ${itemId}] SNIPER: ${strategies.length} estratégias disponíveis`);

    if (state.debugLogger) {
        state.debugLogger.section('SMART CANDIDATE SELECTION');
        state.debugLogger._write(`Strategies: ${strategies.length}`);
        strategies.forEach((s, i) => {
            state.debugLogger._write(`  [${i + 1}] ${s.type}: "${s.query}"`);
        });
    }

    try {
        // =============================================
        // PHASE 1: Collect ALL titles from ALL strategies
        // =============================================
        logger.log(`🔍 [Item ${itemId}] FASE 1: Coletando títulos de todas as estratégias...`);
        const allTitles = await collectAllTitles(strategies, page, cep);

        if (allTitles.length === 0) {
            logger.log(`⚠️ [Item ${itemId}] SNIPER: Nenhum produto encontrado em ${strategies.length} estratégias.`);
            state.candidates = [];
            state.current = STATES.COMPLETE;
            return state;
        }

        logger.log(`📦 [Item ${itemId}] FASE 1 concluída: ${allTitles.length} títulos únicos`);

        // =============================================
        // PHASE 2: AI pre-filter - which are worth investigating?
        // =============================================
        logger.log(`🤖 [Item ${itemId}] FASE 2: IA pré-filtrando candidatos...`);
        const selectedIndices = await aiSelectCandidates(
            allTitles,
            state.originalDescription || state.item.description,
            config
        );

        if (selectedIndices.length === 0) {
            logger.log(`⚠️ [Item ${itemId}] SNIPER: IA não selecionou nenhum candidato relevante.`);
            // Fallback: take first 10 by price
            const fallbackSelection = allTitles
                .sort((a, b) => a.price - b.price)
                .slice(0, 10)
                .map((_, i) => i);
            selectedIndices.push(...fallbackSelection);
            logger.log(`🔙 [Item ${itemId}] SNIPER: Fallback - usando os 10 mais baratos`);
        }

        logger.log(`🎯 [Item ${itemId}] FASE 2 concluída: ${selectedIndices.length} candidatos selecionados para investigação`);

        // =============================================
        // PHASE 3: Get detailed info for selected candidates only
        // =============================================
        logger.log(`📝 [Item ${itemId}] FASE 3: Buscando detalhes dos candidatos selecionados...`);
        const detailedCandidates = await getDetailsForSelected(selectedIndices, allTitles, page, cep);

        // Apply price anomaly filter
        const filteredCandidates = filterPriceAnomaliesLocal(detailedCandidates);

        state.candidates = filteredCandidates;
        state.allTitlesCount = allTitles.length;
        state.selectedCount = selectedIndices.length;
        state.kitPricing = null;

        logger.log(`✅ [Item ${itemId}] SNIPER concluído: ${filteredCandidates.length} candidatos prontos para avaliação`);
        logger.log(`   → ${allTitles.length} títulos coletados → ${selectedIndices.length} selecionados pela IA → ${filteredCandidates.length} detalhados`);

        if (state.debugLogger) {
            state.debugLogger.section('SMART CANDIDATE SELECTION RESULTS');
            state.debugLogger._write(`Total titles collected: ${allTitles.length}`);
            state.debugLogger._write(`AI selected: ${selectedIndices.length}`);
            state.debugLogger._write(`Detailed candidates: ${filteredCandidates.length}`);

            // Log by strategy
            const byStrategy = {};
            detailedCandidates.forEach(c => {
                byStrategy[c.sourceStrategy || 'unknown'] = (byStrategy[c.sourceStrategy || 'unknown'] || 0) + 1;
            });
            Object.entries(byStrategy).forEach(([strat, count]) => {
                state.debugLogger._write(`  - ${strat}: ${count} candidates`);
            });
        }

        logState(state, `SNIPER Smart Selection: ${allTitles.length}→${selectedIndices.length}→${filteredCandidates.length}`, logger, itemId);

        state.current = STATES.AVALIACAO;

    } catch (err) {
        logger.log(`❌ [Item ${itemId}] SNIPER Error: ${err.message}`);
        console.error(err);
        state.candidates = [];
        state.current = STATES.COMPLETE;
    }

    return state;
}

/**
 * Local price anomaly filter (copy from sniper.js)
 */
function filterPriceAnomaliesLocal(candidates) {
    if (candidates.length < 3) return candidates;

    const prices = candidates.map(c => c.price).sort((a, b) => a - b);
    const median = prices[Math.floor(prices.length / 2)];
    const threshold = median * 0.30;

    return candidates.map(c => {
        if (c.price < threshold) {
            c.priceAnomaly = true;
            c.anomalyReason = `Preço ${Math.round((c.price / median) * 100)}% da mediana. Possível peça/sucata.`;
        }
        return c;
    });
}

async function runJuiz(state, config, logger, itemId) {
    logger.log(`⚖️ [Item ${itemId}] JUIZ v2.0: Avaliação Direta de Risco...`);

    try {
        const originalDescription = state.originalDescription || state.item.description;
        const candidates = state.candidates || [];

        if (candidates.length === 0) {
            logger.log(`⚠️ [Item ${itemId}] JUIZ: Nenhum candidato para avaliar.`);
            state.winner = -1;
            state.current = STATES.COMPLETE;
            return state;
        }

        logger.log(`📋 [Item ${itemId}] JUIZ: Avaliando ${candidates.length} candidatos...`);

        // Track candidates that need Perplexity validation
        const candidatesNeedingPerplexity = [];

        // PHASE 1: Initial AI evaluation
        for (let i = 0; i < candidates.length; i++) {
            const candidate = candidates[i];
            logger.log(`   [${i + 1}/${candidates.length}] "${candidate.title?.substring(0, 40)}..."`);

            // SEQUENTIAL: Wait for each AI evaluation
            const evaluation = await evaluateCandidateDirect(candidate, originalDescription, config);

            // Apply evaluation results to candidate
            candidate.risk_score = evaluation.risk_score;
            candidate.aiReasoning = evaluation.reasoning;
            candidate.aiMatch = evaluation.risk_score <= 5;
            candidate.validar_perplexity = evaluation.validar_perplexity;
            candidate.oq_perguntar = evaluation.oq_perguntar;

            logger.log(`      → Risco: ${evaluation.risk_score}/10`);

            // Check if AI wants Perplexity validation
            if (evaluation.validar_perplexity && evaluation.oq_perguntar) {
                logger.log(`      → 🔍 IA quer validar via Perplexity`);
                candidatesNeedingPerplexity.push({ index: i, candidate, questions: evaluation.oq_perguntar });
            }

            // Debug logging
            if (state.debugLogger) {
                state.debugLogger.section(`CANDIDATE ${i + 1} - DIRECT EVALUATION`);
                state.debugLogger._write(`Title: ${candidate.title?.substring(0, 60)}...`);
                state.debugLogger._write(`Price: R$ ${candidate.price}`);
                state.debugLogger._write(`Risk Score: ${evaluation.risk_score}/10`);
                state.debugLogger._write(`Validar Perplexity: ${evaluation.validar_perplexity ? 'SIM' : 'NAO'}`);
                if (evaluation.oq_perguntar) {
                    state.debugLogger._write(`Perguntas: ${evaluation.oq_perguntar.substring(0, 100)}...`);
                }
            }
        }

        // PHASE 2: Perplexity validation for candidates that need it
        if (candidatesNeedingPerplexity.length > 0) {
            logger.log(`🔬 [Item ${itemId}] JUIZ: ${candidatesNeedingPerplexity.length} candidatos precisam de validação Perplexity`);

            const MAX_PERPLEXITY_VALIDATIONS = 3; // Limit API calls
            const toValidate = candidatesNeedingPerplexity.slice(0, MAX_PERPLEXITY_VALIDATIONS);

            for (const { index, candidate, questions } of toValidate) {
                logger.log(`   📡 Validando: "${candidate.title?.substring(0, 40)}..."`);
                logger.log(`   ❓ Perguntas: ${questions.substring(0, 80)}...`);

                try {
                    // Query Perplexity with AI-generated questions
                    const perplexityResponse = await askPerplexity(questions);

                    if (perplexityResponse) {
                        logger.log(`   ✅ Perplexity respondeu`);

                        // Enrich candidate with Perplexity data
                        candidate.perplexityEnrichment = perplexityResponse;
                        candidate.enrichmentSource = 'perplexity';

                        // Update ProductDNA with enriched info
                        if (candidate.productDNA) {
                            candidate.productDNA.fullText += `\n\n[PERPLEXITY ENRICHMENT]\n${perplexityResponse}`;
                            candidate.productDNA.fullTextRaw = (candidate.productDNA.fullTextRaw || '') + `\n\n[INFO EXTERNA]\n${perplexityResponse}`;
                        }

                        // RE-EVALUATE with enriched data
                        logger.log(`   🔄 Re-avaliando com dados enriquecidos...`);
                        const reEvaluation = await evaluateCandidateDirect(candidate, originalDescription, config);

                        // Update candidate with new evaluation
                        candidate.risk_score = reEvaluation.risk_score;
                        candidate.aiReasoning = reEvaluation.reasoning;
                        candidate.aiMatch = reEvaluation.risk_score <= 5;
                        candidate.wasEnriched = true;

                        logger.log(`   → Novo risco: ${reEvaluation.risk_score}/10`);

                        if (state.debugLogger) {
                            state.debugLogger.section(`CANDIDATE ${index + 1} - RE-EVALUATION AFTER PERPLEXITY`);
                            state.debugLogger._write(`New Risk Score: ${reEvaluation.risk_score}/10`);
                            state.debugLogger._write(`Perplexity Response: ${perplexityResponse.substring(0, 200)}...`);
                        }
                    } else {
                        logger.log(`   ⚠️ Perplexity não respondeu`);
                    }
                } catch (perplexityErr) {
                    logger.log(`   ❌ Erro Perplexity: ${perplexityErr.message}`);
                }
            }
        }

        // Sort by risk (lowest first), then by price
        candidates.sort((a, b) => {
            const riskDiff = (a.risk_score || 10) - (b.risk_score || 10);
            if (riskDiff !== 0) return riskDiff;
            return (a.totalPrice || a.price || 0) - (b.totalPrice || b.price || 0);
        });

        // Find winner: lowest risk that is acceptable (risk <= 7)
        const MAX_ACCEPTABLE_RISK = 7.0;
        const winnerIndex = candidates.findIndex(c => (c.risk_score || 10) <= MAX_ACCEPTABLE_RISK);

        state.candidates = candidates;
        state.winner = winnerIndex;

        if (winnerIndex >= 0) {
            const winner = candidates[winnerIndex];
            logger.log(`🏆 [Item ${itemId}] JUIZ: Vencedor: "${winner.title?.substring(0, 50)}..."`);
            logger.log(`📊 [Item ${itemId}] Risco: ${winner.risk_score}/10 ${winner.wasEnriched ? '(enriquecido)' : ''}`);
            logger.log(`💰 [Item ${itemId}] Preço: R$ ${winner.totalPrice || winner.price}`);
        } else {
            logger.log(`⚠️ [Item ${itemId}] JUIZ: Nenhum candidato com risco ≤ ${MAX_ACCEPTABLE_RISK}`);
        }

        // Debug summary
        if (state.debugLogger) {
            state.debugLogger.section('JUIZ EVALUATION SUMMARY');
            state.debugLogger._write(`Candidates evaluated: ${candidates.length}`);
            state.debugLogger._write(`Perplexity validations: ${candidatesNeedingPerplexity.length}`);
            state.debugLogger._write(`Winner index: ${winnerIndex}`);
            candidates.slice(0, 5).forEach((c, i) => {
                const enrichedIcon = c.wasEnriched ? '📡' : '';
                state.debugLogger._write(`  [${i + 1}] Risk ${c.risk_score}/10 ${enrichedIcon} - R$ ${c.totalPrice || c.price} - "${c.title?.substring(0, 40)}..."`);
            });

            const logFilePath = state.debugLogger.finalize();
            logger.log(`📝 [Item ${itemId}] Debug log salvo: ${logFilePath}`);
        }

        logState(state, `JUIZ avaliou ${candidates.length} candidatos, ${candidatesNeedingPerplexity.length} enriquecidos, vencedor idx ${winnerIndex}`, logger, itemId);

        state.current = STATES.COMPLETE;

    } catch (err) {
        logger.log(`❌ [Item ${itemId}] JUIZ Error: ${err.message}`);
        console.error(err);
        if (state.debugLogger) {
            state.debugLogger.error('JUIZ', err.message, err.stack);
            state.debugLogger.finalize();
        }
        state.current = STATES.COMPLETE;
    }

    return state;
}

// ============================================
// GOLDEN PATH: DATA ENRICHMENT PHASE
// ============================================

/**
 * Enrich candidates with missing specifications via external sources.
 * This solves "Contextual Blindness" - bad seller descriptions shouldn't cause rejections.
 * 
 * Logic:
 * 1. Filter candidates that passed price floor (cost optimization)
 * 2. For each candidate, check if we have enough info to judge
 * 3. If NOT → Query Perplexity for missing specs
 * 4. Fuse external data into candidate object
 */
async function runEnrichment(state, config, logger, itemId) {
    logger.log(`🔬 [Item ${itemId}] ENRICHMENT: Verificando dados incompletos...`);

    try {
        const killSpecs = state.killSpecs || [];
        const criticalSpecs = state.criticalSpecs || [];
        const minViablePrice = state.minViablePrice || 0;

        // Only enrich candidates that passed price filter (cost optimization)
        const viableCandidates = state.candidates.filter(c =>
            c.price >= minViablePrice && !c.priceFloorRejection && !c.priceAnomaly
        );

        logger.log(`📊 [Item ${itemId}] ENRICHMENT: ${viableCandidates.length}/${state.candidates.length} candidatos viáveis para enriquecimento`);

        if (state.debugLogger) {
            state.debugLogger.section('ENRICHMENT PHASE');
            state.debugLogger._write(`Kill specs: ${killSpecs.join(', ')}`);
            state.debugLogger._write(`Viable candidates: ${viableCandidates.length}`);
        }

        let enrichedCount = 0;
        const MAX_ENRICHMENTS = 5; // Limit API calls

        for (const candidate of viableCandidates) {
            if (enrichedCount >= MAX_ENRICHMENTS) {
                logger.log(`⚠️ [Item ${itemId}] ENRICHMENT: Limite de ${MAX_ENRICHMENTS} enriquecimentos atingido`);
                break;
            }

            const enrichmentCheck = preCheckCandidate(candidate, killSpecs, criticalSpecs);

            if (enrichmentCheck.required) {
                logger.log(`🔍 [Item ${itemId}] ENRICHMENT: "${candidate.title.substring(0, 40)}..."`);
                logger.log(`   Razão: ${enrichmentCheck.reason}`);
                logger.log(`   Missing: ${enrichmentCheck.missingSpecs.join(', ')}`);

                try {
                    const enrichmentResult = await enrichCandidateViaPerplexity(
                        candidate,
                        enrichmentCheck.missingSpecs,
                        config,
                        logger,
                        itemId
                    );

                    if (enrichmentResult && enrichmentResult.success) {
                        // Fuse enrichment data into candidate
                        candidate.enrichmentSource = 'perplexity';
                        candidate.enrichmentConfidence = enrichmentResult.confidence || 0.7;
                        candidate.enrichedSpecs = enrichmentResult.specs || {};
                        candidate.enrichmentRaw = enrichmentResult.raw;

                        // Update ProductDNA with enriched data
                        if (candidate.productDNA) {
                            const enrichedText = Object.entries(enrichmentResult.specs || {})
                                .filter(([_, v]) => v === true)
                                .map(([k, _]) => k)
                                .join(' ');
                            candidate.productDNA.fullText += `\n[ENRICHED] ${enrichedText}`;
                            candidate.productDNA.enrichedSpecs = enrichmentResult.specs;
                        }

                        enrichedCount++;
                        logger.log(`   ✅ Enriquecido com confiança ${(enrichmentResult.confidence * 100).toFixed(0)}%`);

                        if (state.debugLogger) {
                            state.debugLogger.section(`ENRICHMENT: ${candidate.title.substring(0, 40)}`);
                            state.debugLogger._write(`Source: perplexity`);
                            state.debugLogger._write(`Confidence: ${enrichmentResult.confidence}`);
                            for (const [spec, value] of Object.entries(enrichmentResult.specs || {})) {
                                const icon = value === true ? '✓' : value === false ? '✗' : '?';
                                state.debugLogger._write(`  ${icon} ${spec}: ${value}`);
                            }
                        }
                    } else {
                        logger.log(`   ⚠️ Enriquecimento falhou ou sem dados`);
                    }
                } catch (enrichErr) {
                    logger.log(`   ❌ Erro no enriquecimento: ${enrichErr.message}`);
                }
            } else {
                // Candidate has enough data, no enrichment needed
                if (state.debugLogger) {
                    state.debugLogger._write(`✓ "${candidate.title.substring(0, 40)}" - dados suficientes`);
                }
            }
        }

        logger.log(`📦 [Item ${itemId}] ENRICHMENT: ${enrichedCount} candidatos enriquecidos`);
        logState(state, `ENRICHMENT: ${enrichedCount} candidatos enriquecidos via Perplexity`, logger, itemId);

        state.current = STATES.JUIZ;

    } catch (err) {
        logger.log(`❌ [Item ${itemId}] ENRICHMENT Error: ${err.message}`);
        if (state.debugLogger) {
            state.debugLogger.error('ENRICHMENT', err.message, err.stack);
        }
        // On error, proceed to JUIZ anyway (don't block pipeline)
        state.current = STATES.JUIZ;
    }

    return state;
}

/**
 * Pre-check if a candidate needs enrichment.
 * Returns { required, reason, missingSpecs }
 */
function preCheckCandidate(candidate, killSpecs, criticalSpecs) {
    const productDNA = candidate.productDNA;

    // No ProductDNA at all
    if (!productDNA || !productDNA.fullText) {
        return {
            required: true,
            reason: 'Sem ProductDNA disponível',
            missingSpecs: killSpecs.slice(0, 5)
        };
    }

    const fullText = productDNA.fullText.toLowerCase();
    const title = (candidate.title || '').toLowerCase();
    const combinedText = `${fullText} ${title}`;

    // Check kill specs
    const missingKillSpecs = killSpecs.filter(spec => {
        const specLower = spec.toLowerCase();
        return !combinedText.includes(specLower);
    });

    // Check critical specs (those with high weight)
    const highWeightSpecs = criticalSpecs
        .filter(cs => cs.weight >= 20)
        .map(cs => cs.spec);

    const missingCritical = highWeightSpecs.filter(spec => {
        const specLower = spec.toLowerCase();
        return !combinedText.includes(specLower);
    });

    // Combined missing specs (unique)
    const allMissing = [...new Set([...missingKillSpecs, ...missingCritical])];

    // Threshold: Need enrichment if missing > 30% of critical specs
    const threshold = Math.ceil(killSpecs.length * 0.3);
    const needsEnrichment = allMissing.length >= Math.max(1, threshold);

    if (needsEnrichment) {
        return {
            required: true,
            reason: `Faltando ${allMissing.length}/${killSpecs.length} specs críticas`,
            missingSpecs: allMissing.slice(0, 5) // Max 5 to query
        };
    }

    return { required: false };
}

/**
 * Build a smart, targeted Perplexity query asking ONLY about missing specs.
 * 
 * Instead of generic "verify these specs", we ask specific natural language questions
 * like "Qual a velocidade do processador?" or "A tela é Full HD IPS?"
 * 
 * @param {string} productName - The product name/model
 * @param {string[]} missingSpecs - Array of missing specification strings
 * @returns {string} Natural language query for Perplexity
 */
function buildSmartPerplexityQuery(productName, missingSpecs) {
    // Map common spec types to natural language questions
    const specQuestionMap = {
        // Processing/Performance
        'processador': 'Qual é o modelo e velocidade do processador?',
        'cpu': 'Qual é o modelo e velocidade do processador (CPU)?',
        'ghz': 'Qual é a velocidade do processador em GHz?',
        'núcleos': 'Quantos núcleos tem o processador?',
        'cores': 'Quantos núcleos (cores) tem o processador?',

        // Memory
        'memória': 'Qual a capacidade de memória RAM?',
        'ram': 'Qual a capacidade de memória RAM em GB?',
        'gb ram': 'Quantos GB de RAM possui?',
        'ddr': 'Qual o tipo de memória (DDR3/DDR4/DDR5)?',

        // Storage
        'hd': 'Qual o tamanho do HD/armazenamento?',
        'ssd': 'Possui SSD? Qual a capacidade?',
        'armazenamento': 'Qual a capacidade de armazenamento?',
        'nvme': 'O SSD é NVMe?',

        // Display
        'tela': 'Qual o tamanho da tela em polegadas?',
        'full hd': 'A tela é Full HD (1920x1080)?',
        'ips': 'A tela é do tipo IPS?',
        'resolução': 'Qual a resolução da tela?',
        'lcd': 'A tela é LCD ou LED?',
        'amoled': 'A tela é AMOLED?',
        'polegadas': 'Quantas polegadas tem a tela?',

        // Power/Electrical
        'voltagem': 'Qual a voltagem de operação (110V/220V/bivolt)?',
        'bivolt': 'O produto é bivolt?',
        '110v': 'Funciona em 110V?',
        '220v': 'Funciona em 220V?',
        'watts': 'Qual a potência em Watts?',
        'bateria': 'Possui bateria? Qual a capacidade em mAh?',

        // Connectivity
        'wifi': 'Possui conectividade WiFi?',
        'bluetooth': 'Possui Bluetooth? Qual versão?',
        'usb': 'Quantas portas USB possui?',
        'hdmi': 'Possui saída HDMI?',
        'ethernet': 'Possui porta Ethernet (RJ-45)?',

        // Physical
        'peso': 'Qual o peso do produto?',
        'dimensões': 'Quais as dimensões (AxLxP)?',
        'cor': 'Qual a cor do produto?',
        'material': 'Qual o material de fabricação?',

        // Audio
        'cornetas': 'Quantas cornetas/alto-falantes possui?',
        'músicas': 'Quantas músicas pré-gravadas possui?',
        'alto-falante': 'Qual a potência dos alto-falantes?',
        'decibéis': 'Qual o volume em decibéis (dB)?',

        // Capacity/Quantity
        'capacidade': 'Qual a capacidade?',
        'litros': 'Qual a capacidade em litros?',
        'ml': 'Qual a capacidade em ml?',

        // Certification/Warranty
        'garantia': 'Qual o período de garantia?',
        'inmetro': 'Possui certificação INMETRO?',
        'anvisa': 'Possui registro na ANVISA?'
    };

    const questions = [];
    const usedQuestions = new Set();

    // Generate questions for each missing spec
    for (const spec of missingSpecs) {
        const specLower = spec.toLowerCase();
        let questionFound = false;

        // Try to match with known spec patterns
        for (const [keyword, question] of Object.entries(specQuestionMap)) {
            if (specLower.includes(keyword) && !usedQuestions.has(question)) {
                questions.push(question);
                usedQuestions.add(question);
                questionFound = true;
                break;
            }
        }

        // If no specific question found, create a generic one
        if (!questionFound) {
            const genericQuestion = `O produto possui ${spec}? Especifique os detalhes.`;
            if (!usedQuestions.has(genericQuestion)) {
                questions.push(genericQuestion);
                usedQuestions.add(genericQuestion);
            }
        }
    }

    // Build the final query
    const query = `Sobre o produto "${productName}":

${questions.map((q, i) => `${i + 1}. ${q}`).join('\n')}

IMPORTANTE:
- Busque nas especificações OFICIAIS do fabricante
- Se não encontrar a informação, diga "não encontrado"
- Seja objetivo e direto nas respostas

Responda em JSON:
{
    "answers": {
        "pergunta_resumida": "resposta"
    },
    "specs_confirmed": {
        "nome_spec": true/false/"unknown"
    },
    "source": "site_consultado",
    "confidence": 0.0-1.0
}`;

    return query;
}

/**
 * Enrich candidate via Perplexity search with SMART targeted queries.
 * 
 * Instead of generic "verify specs", we ask:
 * "Qual é a velocidade do processador do Dell Latitude 3410 i5?"
 * "A tela é Full HD IPS?"
 */
async function enrichCandidateViaPerplexity(candidate, missingSpecs, config, logger, itemId) {
    try {
        // Build SMART query - natural language questions about missing specs
        const productName = candidate.title.substring(0, 80);
        const query = buildSmartPerplexityQuery(productName, missingSpecs);

        logger.log(`   📡 [Item ${itemId}] Consultando Perplexity com ${missingSpecs.length} perguntas...`);

        const response = await askPerplexity(query);

        if (!response) {
            return { success: false, reason: 'No response from Perplexity' };
        }

        // Parse response
        try {
            // Try to extract JSON from response
            let json;
            const jsonMatch = response.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                json = JSON.parse(jsonMatch[0]);
            } else {
                // Try direct parse
                json = JSON.parse(response);
            }

            // Convert answers to specs_confirmed format if needed
            const specsConfirmed = json.specs_confirmed || {};

            // If answers exist but specs_confirmed doesn't, try to derive it
            if (json.answers && Object.keys(specsConfirmed).length === 0) {
                for (const [question, answer] of Object.entries(json.answers)) {
                    const answerLower = String(answer).toLowerCase();
                    // Determine if the answer confirms or denies the spec
                    if (answerLower.includes('sim') || answerLower.includes('possui') ||
                        answerLower.includes('yes') || /\d/.test(answer)) {
                        specsConfirmed[question] = true;
                    } else if (answerLower.includes('não') || answerLower.includes('no') ||
                        answerLower.includes('não encontrado')) {
                        specsConfirmed[question] = 'unknown';
                    } else {
                        specsConfirmed[question] = answer; // Keep raw answer
                    }
                }
            }

            return {
                success: true,
                specs: specsConfirmed,
                answers: json.answers || {},
                source: json.source || 'perplexity',
                confidence: parseFloat(json.confidence) || 0.7,
                raw: response
            };
        } catch (parseErr) {
            logger.log(`   ⚠️ [Item ${itemId}] Falha ao parsear resposta do Perplexity`);
            return {
                success: false,
                reason: 'Parse error',
                raw: response
            };
        }
    } catch (err) {
        logger.log(`   ❌ [Item ${itemId}] Erro na consulta Perplexity: ${err.message}`);
        return {
            success: false,
            reason: err.message
        };
    }
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
            // No more alternatives, proceed to ENRICHMENT (and then JUIZ)
            logger.log(`⚠️ [Item ${itemId}] AVALIACAO: Sem alternativas de busca. Procedendo para ENRICHMENT com ${totalCount} candidatos.`);
            state.current = STATES.ENRICHMENT;
        }
    } else {
        // We have enough candidates or exhausted retries
        if (state.elasticRetryCount >= MAX_ELASTIC_RETRIES) {
            logger.log(`⏹️ [Item ${itemId}] AVALIACAO: Limite de ${MAX_ELASTIC_RETRIES} retries atingido.`);
        } else {
            logger.log(`✅ [Item ${itemId}] AVALIACAO: ${promisingCount} candidatos suficientes. Enviando para ENRICHMENT.`);
        }

        // GOLDEN PATH: Route to ENRICHMENT before JUIZ
        state.current = STATES.ENRICHMENT;
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
