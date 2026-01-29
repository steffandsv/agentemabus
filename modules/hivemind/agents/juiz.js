/**
 * JUIZ Agent - THE SKEPTICAL JUDGE v10.3 "FLEXÍVEL & IMPLACÁVEL"
 * 
 * Mission: Calculate Adherence Score using ProductDNA and weighted specs.
 * Philosophy: Flexible search, IMPLACABLE judgment on POSITIVE specs.
 * 
 * v10.3 CHANGES:
 * - REMOVED: Kill-words elimination (caused false positives like "manual")
 * - FOCUS: Verify specs the product MUST HAVE, not words it shouldn't have
 * 
 * Protocol: "Se não está escrito, não existe"
 * 
 * Output:
 * - validatedCandidates: Candidates with decimal risk scores
 * - winnerIndex: Index of best candidate (lowest risk)
 * - defenseReport: Technical defense report with scoring breakdown
 */

// FIXED: Import getApiKeyFromEnv for safe API key retrieval from .env
const { generateText, PROVIDERS, getApiKeyFromEnv } = require('../../../src/services/ai_manager');
const { getSetting } = require('../../../src/database');

// PRICE FLOOR: Minimum viable price as percentage of max tender price
// Items below this threshold are rejected as suspected accessories/scrap
const PRICE_FLOOR_PERCENTAGE = 0.15; // 15%

// SKEPTICAL JUDGE: Maximum acceptable risk for viable candidates
const MAX_ACCEPTABLE_RISK = 7.0;

/**
 * Calculate Adherence Score for a candidate using ProductDNA (THE SKEPTICAL JUDGE)
 * 
 * @param {object} productDNA - ProductDNA from deep scraping
 * @param {object} specs - Specs from PERITO (searchAnchor, negativeConstraints, criticalSpecs)
 * @param {string} detectedModel - Model name from DETETIVE (optional)
 * @param {string} originalDescription - Original tender description for ground-truth matching
 * @param {object} debugLogger - Optional debug logger
 * @returns {object} { score, risk, reason, breakdown }
 */
function calculateAdherenceScore(productDNA, specs, detectedModel = null, originalDescription = null, debugLogger = null) {
    const breakdown = [];
    let score = 0;

    // Normalize text for matching
    const fullText = (productDNA?.fullText || '').toLowerCase();
    const title = (productDNA?.title || '').toLowerCase();

    if (!fullText) {
        return {
            score: 0,
            risk: '10.0',
            reason: 'ProductDNA vazio - sem dados para análise',
            breakdown: ['Sem ProductDNA']
        };
    }

    // ============================================
    // v10.3 "FLEXÍVEL & IMPLACÁVEL": KILL-WORDS REMOVIDAS
    // ============================================
    // A verificação de kill-words foi REMOVIDA porque causava falsos positivos.
    // Exemplo: A palavra "manual" rejeitava candidatos que tinham "acionamento manual"
    // como uma FEATURE do produto (exigida pelo edital).
    // 
    // NOVA FILOSOFIA:
    // - Busca FLEXÍVEL (encontrar muitos candidatos)
    // - Julgamento IMPLACÁVEL (baseado em specs POSITIVAS que o produto DEVE ter)
    // 
    // O JUIZ agora foca em verificar se o produto TEM as specs exigidas,
    // não em verificar se ele NÃO TEM certas palavras.
    breakdown.push('✓ v10.3: Análise sem kill-words (busca flexível)');

    // ============================================
    // PHASE 2: ANCHOR VERIFICATION (Prova Real)
    // ============================================
    const anchor = (specs.searchAnchor || '')
        .replace(/"/g, '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

    // CODEX OMNI v10.1: ANCHOR SANITY CHECK (Anti-Hallucination Defense)
    // Rejects anchors that are too short or match hallucination patterns like "72 m"
    const isAnchorSane = anchor.length >= 5 && !/^\d+\s*[a-záéíóú]{1,2}$/i.test(anchor);

    if (anchor && anchor.length > 0 && isAnchorSane) {
        const found = fullText.includes(anchor);

        if (debugLogger) {
            debugLogger.specMatching(
                specs._candidateIndex || 0,
                `Âncora: ${anchor}`,
                found,
                found ? fullText.substring(fullText.indexOf(anchor), fullText.indexOf(anchor) + 100) : null
            );
        }

        if (found) {
            score += 60;
            breakdown.push(`✓ Âncora "${anchor}" encontrada (+60pts)`);
        } else {
            score += 10;
            breakdown.push(`⚠ Âncora "${anchor}" NÃO encontrada (+10pts - penalidade severa)`);
        }
    } else if (anchor && anchor.length > 0) {
        // INSANE ANCHOR: Give neutral score instead of penalty
        score += 35;
        breakdown.push(`⚠ Âncora "${anchor}" ignorada (suspeita de alucinação, +35pts neutro)`);
        if (debugLogger) {
            debugLogger.specMatching(
                specs._candidateIndex || 0,
                `Âncora INSANA: ${anchor}`,
                false,
                'Ignorada por validação de sanidade'
            );
        }
    } else {
        // No anchor defined - treat as medium base
        score += 30;
        breakdown.push('~ Sem âncora definida (+30pts base)');
    }

    // ============================================
    // PHASE 3: CRITICAL SPECS (Somatória de Evidências)
    // ============================================
    const criticalSpecs = specs.criticalSpecs || [];
    let specsFound = 0;
    let specsTotal = criticalSpecs.length;

    for (const specObj of criticalSpecs) {
        const specText = (typeof specObj === 'string' ? specObj : specObj.spec || '')
            .toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        const weight = typeof specObj === 'object' ? (specObj.weight || 10) : 10;

        const found = specText && fullText.includes(specText);

        if (debugLogger) {
            debugLogger.specMatching(
                specs._candidateIndex || 0,
                specObj.spec || specObj,
                found
            );
        }

        if (found) {
            score += weight;
            specsFound++;
            breakdown.push(`✓ Spec "${specObj.spec || specObj}" (+${weight}pts)`);
        }
    }

    if (specsTotal > 0) {
        breakdown.push(`→ Specs encontradas: ${specsFound}/${specsTotal}`);
    }

    // ============================================
    // PHASE 3.5: GROUND-TRUTH CHECK FROM ORIGINAL DESCRIPTION
    // ============================================
    if (originalDescription) {
        // Extract key numeric specs from original description for verification
        const numericPatterns = [
            { regex: /(\d+)\s*músicas?/gi, spec: (m) => `${m[1]} músicas` },
            { regex: /(\d+)\s*programaç(?:ão|ões)/gi, spec: (m) => `${m[1]} programações` },
            { regex: /(\d+)\s*anos?\s+(?:de\s+)?garantia/gi, spec: (m) => `${m[1]} ano garantia` },
            { regex: /(\d+)\s*cornetas?/gi, spec: (m) => `${m[1]} cornetas` },
            { regex: /(\d+)\s*níveis?/gi, spec: (m) => `${m[1]} níveis` }
        ];

        let originalSpecsFound = 0;
        let originalSpecsTotal = 0;

        for (const pattern of numericPatterns) {
            const regex = new RegExp(pattern.regex);
            let match;
            while ((match = regex.exec(originalDescription)) !== null) {
                originalSpecsTotal++;
                const specToFind = pattern.spec(match).toLowerCase();
                const found = fullText.includes(specToFind);

                if (found) {
                    originalSpecsFound++;
                    breakdown.push(`✓ Ground-Truth "${specToFind}" verificada`);
                }

                if (debugLogger) {
                    debugLogger.specMatching(
                        specs._candidateIndex || 0,
                        `GROUND-TRUTH: ${specToFind}`,
                        found
                    );
                }
            }
        }

        if (originalSpecsTotal > 0) {
            const ratio = originalSpecsFound / originalSpecsTotal;
            if (ratio >= 0.7) {
                score += 20;
                breakdown.push(`✓ Ground-truth pass: ${originalSpecsFound}/${originalSpecsTotal} specs (+20pts bônus)`);
            } else if (ratio < 0.3) {
                score = Math.max(0, score - 30);
                breakdown.push(`⛔ Ground-truth fail: ${originalSpecsFound}/${originalSpecsTotal} specs (-30pts penalidade)`);
            }
        }
    }

    // ============================================
    // PHASE 4: GOLDEN MODEL BONUS
    // ============================================
    if (detectedModel && title.toLowerCase().includes(detectedModel.toLowerCase())) {
        score += 30;
        breakdown.push(`✓ Modelo detectado "${detectedModel}" no título (+30pts bônus)`);
    }

    // ============================================
    // PHASE 4.5: ENRICHMENT BONUS (GOLDEN PATH)
    // ============================================
    // If the ProductDNA was enriched with external data, use that info
    if (productDNA.enrichedSpecs || productDNA.enrichmentSource) {
        const enrichedSpecs = productDNA.enrichedSpecs || {};
        const enrichmentSource = productDNA.enrichmentSource || 'external';
        const enrichmentConfidence = parseFloat(productDNA.enrichmentConfidence) || 0.7;

        let enrichedConfirmed = 0;
        let enrichedDenied = 0;
        let enrichedUnknown = 0;

        for (const [specName, value] of Object.entries(enrichedSpecs)) {
            if (value === true) {
                enrichedConfirmed++;
            } else if (value === false) {
                enrichedDenied++;
            } else {
                enrichedUnknown++;
            }
        }

        // Apply enrichment scoring
        if (enrichedConfirmed > 0) {
            // Bonus is scaled by confidence (higher confidence = higher bonus)
            const enrichmentBonus = Math.round(enrichedConfirmed * 10 * enrichmentConfidence);
            score += enrichmentBonus;
            breakdown.push(`📡 ${enrichedConfirmed} specs confirmadas via ${enrichmentSource} (+${enrichmentBonus}pts, confiança ${(enrichmentConfidence * 100).toFixed(0)}%)`);
        }

        if (enrichedDenied > 0) {
            // External source confirms product DOESN'T have the spec - this is worse than "not found"
            const penalty = enrichedDenied * 15;
            score = Math.max(0, score - penalty);
            breakdown.push(`⛔ ${enrichedDenied} specs NEGADAS via ${enrichmentSource} (-${penalty}pts)`);
        }

        if (enrichedUnknown > 0) {
            // Unknown means even external sources couldn't confirm - mild penalty
            const uncertaintyPenalty = enrichedUnknown * 3;
            score = Math.max(0, score - uncertaintyPenalty);
            breakdown.push(`❓ ${enrichedUnknown} specs incertas via ${enrichmentSource} (-${uncertaintyPenalty}pts)`);
        }

        if (debugLogger) {
            debugLogger.section('ENRICHMENT SCORING');
            debugLogger._write(`Source: ${enrichmentSource}`);
            debugLogger._write(`Confidence: ${enrichmentConfidence}`);
            debugLogger._write(`Confirmed: ${enrichedConfirmed}, Denied: ${enrichedDenied}, Unknown: ${enrichedUnknown}`);
        }
    }

    // ============================================
    // CALCULATE DECIMAL RISK
    // ============================================
    // Score 100 = Risk 0.0
    // Score 60 = Risk 4.0
    // Score 10 = Risk 9.0
    // Score 0 = Risk 10.0
    const risk = Math.max(0, Math.min(10, 10.0 - (score / 10.0)));

    // Generate reason summary
    let reason;
    if (risk <= 2.0) {
        reason = `✅ APROVADO (Risco ${risk.toFixed(1)}). Aderência Alta. ${breakdown.slice(-2).join(' ')}`;
    } else if (risk <= 5.0) {
        reason = `⚠ INCERTO (Risco ${risk.toFixed(1)}). Aderência Média. Verificar specs ausentes.`;
    } else if (risk <= 7.0) {
        reason = `🔶 DUVIDOSO (Risco ${risk.toFixed(1)}). Aderência Baixa. Muitas specs faltando.`;
    } else {
        reason = `❌ REJEITADO (Risco ${risk.toFixed(1)}). Aderência Insuficiente. Não recomendado.`;
    }

    return {
        score,
        risk: risk.toFixed(1),
        reason,
        breakdown
    };
}

/**
 * Execute JUIZ agent - THE SKEPTICAL JUDGE v8.0
 * 
 * @param {object[]} candidates - Candidates from SNIPER (with ProductDNA)
 * @param {object} goldEntity - Gold Entity from AUDITOR
 * @param {string[]} killSpecs - Original Kill-Specs (legacy)
 * @param {object} item - Original tender item
 * @param {object} config - AI configuration
 * @param {object} specs - PERITO output (searchAnchor, negativeConstraints, criticalSpecs, originalDescription)
 * @param {string} detectedModel - Model name from DETETIVE (optional)
 * @param {object} debugLogger - Optional debug logger for detailed tracing
 */
async function executeJuiz(candidates, goldEntity, killSpecs, item, config, specs = {}, detectedModel = null, debugLogger = null) {
    console.log(`[JUIZ] CODEX OMNI v10.0 (THE SKEPTICAL JUDGE) - Analyzing ${candidates.length} candidates`);

    // DEBUG: Log original description being used
    const originalDescription = specs.originalDescription || item.description || '';
    if (debugLogger) {
        debugLogger.section('JUIZ - THE SKEPTICAL JUDGE v10.0');
        debugLogger.originalDescription(originalDescription);
        debugLogger.agentInput('JUIZ', {
            candidatesCount: candidates.length,
            searchAnchor: specs.searchAnchor,
            negativeConstraints: specs.negativeConstraints,
            criticalSpecsCount: (specs.criticalSpecs || []).length
        });
    }

    if (!candidates || candidates.length === 0) {
        if (debugLogger) {
            debugLogger.error('JUIZ', 'No candidates to analyze');
        }
        return {
            validatedCandidates: [],
            winnerIndex: -1,
            defenseReport: null
        };
    }

    // ============================================
    // PHASE 1: PRICE FLOOR - THE GUILLOTINE (CODEX OMNI v10.0)
    // ============================================
    const maxPrice = item.maxPrice || 0;
    // CODEX OMNI v10.0: Use minViablePrice from PERITO if available
    const minViablePrice = specs.minViablePrice || (maxPrice > 0 ? maxPrice * PRICE_FLOOR_PERCENTAGE : 0);

    if (minViablePrice > 0) {
        candidates = applyPriceFloorWithMinViable(candidates, minViablePrice, maxPrice);
        const rejected = candidates.filter(c => c.priceFloorRejection).length;
        if (rejected > 0) {
            console.log(`[JUIZ] 🚫 THE GUILLOTINE: ${rejected} candidatos rejeitados (preço < R$ ${minViablePrice.toFixed(2)})`);
            if (debugLogger) {
                debugLogger.section('PRICE FLOOR (THE GUILLOTINE)');
                debugLogger._write(`Preço mínimo viável: R$ ${minViablePrice.toFixed(2)}`);
                debugLogger._write(`Candidatos rejeitados: ${rejected}`);
            }
        }
    }

    // Separate viable from rejected
    const priceFloorRejected = candidates.filter(c => c.priceFloorRejection);
    const viableCandidates = candidates.filter(c => !c.priceFloorRejection);

    console.log(`[JUIZ] 📊 ${viableCandidates.length} candidatos viáveis para análise`);

    // ============================================
    // PHASE 2: ADHERENCE SCORING (THE SKEPTICAL JUDGE)
    // ============================================
    const validatedCandidates = [...priceFloorRejected]; // Keep rejected ones

    // Build specs object from available data
    const specsForScoring = {
        searchAnchor: specs.searchAnchor || null,
        negativeConstraints: specs.negativeConstraints || [],
        criticalSpecs: specs.criticalSpecs || killSpecs.map(s => ({ spec: s, weight: 10 }))
    };

    for (let i = 0; i < viableCandidates.length; i++) {
        const candidate = viableCandidates[i];

        // DEBUG: Log ProductDNA for this candidate
        if (debugLogger) {
            debugLogger.candidateDNA(i + 1, candidate.title || 'Unknown', candidate.productDNA);
        }

        // Price anomaly check (quick rejection)
        if (candidate.priceAnomaly) {
            candidate.aiMatch = 'UNCERTAIN';
            candidate.aiReasoning = candidate.anomalyReason;
            candidate.risk_score = 8;
            candidate.adherenceScore = 20;
            candidate.scoreBreakdown = ['Anomalia de preço detectada'];
            validatedCandidates.push(candidate);
            continue;
        }

        // ============================================
        // SKEPTICAL JUDGE: Use ProductDNA if available
        // ============================================
        if (candidate.productDNA && (specsForScoring.searchAnchor || specsForScoring.criticalSpecs.length > 0)) {
            // Add candidate index for debug logging
            specsForScoring._candidateIndex = i + 1;

            const adherence = calculateAdherenceScore(
                candidate.productDNA,
                specsForScoring,
                detectedModel,
                originalDescription,  // CRITICAL: Pass original description for ground-truth matching
                debugLogger
            );

            candidate.adherenceScore = adherence.score;
            candidate.risk_score = parseFloat(adherence.risk);
            candidate.aiReasoning = adherence.reason;
            candidate.scoreBreakdown = adherence.breakdown;

            // Determine status based on risk
            if (parseFloat(adherence.risk) <= 2.0) {
                candidate.aiMatch = 'APPROVED';
            } else if (parseFloat(adherence.risk) <= 5.0) {
                candidate.aiMatch = 'UNCERTAIN';
            } else if (parseFloat(adherence.risk) <= MAX_ACCEPTABLE_RISK) {
                candidate.aiMatch = 'DOUBTFUL';
            } else {
                candidate.aiMatch = 'REJECTED';
            }

            console.log(`[JUIZ] ${candidate.title.substring(0, 40)}... → Score: ${adherence.score}, Risco: ${adherence.risk}`);

            // DEBUG: Log scoring breakdown
            if (debugLogger) {
                debugLogger.scoringBreakdown(i + 1, [
                    `Status: ${candidate.aiMatch}`,
                    `Score: ${adherence.score}`,
                    `Risk: ${adherence.risk}`,
                    ...adherence.breakdown
                ]);
            }
        }
        // ============================================
        // FALLBACK: Old Gold Entity matching (backward compat)
        // ============================================
        else if (goldEntity && !goldEntity.isGeneric) {
            const entityMatch = await matchToGoldEntity(candidate, goldEntity, killSpecs, config);

            candidate.aiMatch = entityMatch.matches ? 'APPROVED' : (entityMatch.status || 'UNCERTAIN');
            candidate.aiReasoning = entityMatch.reasoning;
            candidate.risk_score = entityMatch.risk_score || 5;
            candidate.adherenceScore = (10 - (entityMatch.risk_score || 5)) * 10;
            candidate.crossReferenced = entityMatch.matches;
            candidate.goldEntityMatch = entityMatch.matches ? goldEntity.name : null;
        }
        // ============================================
        // NO DATA: Generic fallback
        // ============================================
        else {
            candidate.aiMatch = 'UNCERTAIN';
            candidate.aiReasoning = 'Sem ProductDNA ou Gold Entity - validação manual recomendada';
            candidate.risk_score = 5.0;
            candidate.adherenceScore = 50;
        }

        // Calculate technical score (inverse of risk)
        candidate.technical_score = Math.max(0, 10 - candidate.risk_score);

        validatedCandidates.push(candidate);
    }

    // ============================================
    // PHASE 3: HIERARCHICAL ORDERING (THE CRUCIAL CHANGE)
    // ORDER BY risk ASC, price ASC
    // ============================================

    // Filter candidates within acceptable risk
    const acceptableCandidates = validatedCandidates.filter(c =>
        !c.priceFloorRejection &&
        c.risk_score !== undefined &&
        parseFloat(c.risk_score) <= MAX_ACCEPTABLE_RISK
    );

    // Sort: Risk first, then price
    acceptableCandidates.sort((a, b) => {
        const riskA = parseFloat(a.risk_score) || 10;
        const riskB = parseFloat(b.risk_score) || 10;

        // Primary: Risk (lower is better)
        if (Math.abs(riskA - riskB) > 0.5) {
            return riskA - riskB;
        }

        // Secondary: Total price (lower is better)
        return (a.totalPrice || a.price) - (b.totalPrice || b.price);
    });

    // Determine winner
    let winnerIndex = -1;
    if (acceptableCandidates.length > 0) {
        const winner = acceptableCandidates[0];
        winnerIndex = validatedCandidates.indexOf(winner);
        console.log(`[JUIZ] 🏆 Vencedor: "${winner.title.substring(0, 50)}..." (Risco: ${winner.risk_score}, Preço: R$ ${winner.price})`);

        // DEBUG: Log final ranking and winner
        if (debugLogger) {
            debugLogger.finalRanking(acceptableCandidates.slice(0, 10));
            debugLogger.winner(winner, `Selecionado por menor risco (${winner.risk_score}) e preço (R$ ${winner.price})`);
        }
    } else {
        console.log(`[JUIZ] ⚠ Nenhum candidato com risco aceitável (<= ${MAX_ACCEPTABLE_RISK})`);
        if (debugLogger) {
            debugLogger.error('JUIZ', `Nenhum candidato com risco <= ${MAX_ACCEPTABLE_RISK}`);
        }
    }

    // ============================================
    // PHASE 4: GENERATE DEFENSE REPORT
    // ============================================
    const defenseReport = await generateDefenseReport(
        validatedCandidates,
        winnerIndex,
        goldEntity,
        killSpecs,
        item,
        config,
        specs
    );

    return {
        validatedCandidates,
        winnerIndex,
        defenseReport
    };
}

/**
 * Apply Price Floor defense (ANCHOR & LOCK doctrine)
 * Rejects candidates whose price is suspiciously low (< 15% of tender max price)
 * This prevents the system from accepting accessories/scrap as valid matches
 * 
 * @param {object[]} candidates - Candidates from SNIPER
 * @param {number} maxPrice - Maximum tender price
 * @returns {object[]} Candidates with price floor rejections marked
 */
function applyPriceFloor(candidates, maxPrice) {
    const minViablePrice = maxPrice * PRICE_FLOOR_PERCENTAGE;

    return candidates.map(candidate => {
        const candidatePrice = candidate.price || 0;

        if (candidatePrice < minViablePrice && candidatePrice > 0) {
            return {
                ...candidate,
                aiMatch: 'REJECTED',
                aiReasoning: `⛔ PREÇO VIL (R$ ${candidatePrice.toFixed(2)}). ` +
                    `Piso mínimo: R$ ${minViablePrice.toFixed(2)} (15% de R$ ${maxPrice.toFixed(2)}). ` +
                    `Suspeita de acessório, peça de reposição ou sucata.`,
                risk_score: 10,
                technical_score: 0,
                priceFloorRejection: true
            };
        }
        return candidate;
    });
}

/**
 * CODEX OMNI v10.0: THE GUILLOTINE - Apply Price Floor with pre-calculated minViablePrice
 * Uses minViablePrice from PERITO (20% of budget) instead of internal calculation
 * 
 * @param {object[]} candidates - Candidates from SNIPER
 * @param {number} minViablePrice - Minimum viable price from PERITO
 * @param {number} maxPrice - Maximum tender price (for reporting only)
 * @returns {object[]} Candidates with price floor rejections marked
 */
function applyPriceFloorWithMinViable(candidates, minViablePrice, maxPrice) {
    return candidates.map(candidate => {
        const candidatePrice = candidate.price || 0;

        if (candidatePrice < minViablePrice && candidatePrice > 0) {
            const percentage = maxPrice > 0 ? ((candidatePrice / maxPrice) * 100).toFixed(1) : 'N/A';
            return {
                ...candidate,
                aiMatch: 'REJECTED',
                aiReasoning: `⛔ THE GUILLOTINE: PREÇO VIL (R$ ${candidatePrice.toFixed(2)} = ${percentage}% do orçamento). ` +
                    `Piso mínimo: R$ ${minViablePrice.toFixed(2)} (20% do budget). ` +
                    `Provável acessório, peça de reposição ou sucata.`,
                risk_score: 10,
                technical_score: 0,
                priceFloorRejection: true
            };
        }
        return candidate;
    });
}

/**
 * Match a candidate to the Gold Entity
 */
async function matchToGoldEntity(candidate, goldEntity, killSpecs, config) {
    const prompt = `Você é um especialista em identificar produtos em anúncios de marketplace.

PRODUTO ALVO (GOLD ENTITY):
Nome: ${goldEntity.name}
Fabricante: ${goldEntity.manufacturer || 'Desconhecido'}
Especificações Validadas: ${(goldEntity.validatedSpecs || []).map(s => s.spec || s).join(', ')}

ANÚNCIO DO MARKETPLACE:
Título: ${candidate.title}
Preço: R$ ${candidate.price}
Atributos: ${(candidate.attributes || []).join(', ')}
Descrição: ${(candidate.description || '').substring(0, 500)}

ESPECIFICAÇÕES DO EDITAL:
${killSpecs.join(', ')}

TAREFA:
Determine se este anúncio é claramente o mesmo produto que o Gold Entity.

NOTA IMPORTANTE:
Mesmo que o anúncio seja "pobre" em descrição, se ele claramente identifica o modelo correto,
ele pode ser aprovado porque o AUDITOR já validou que este modelo atende às especificações.

RESPONDA EM JSON:
\`\`\`json
{
    "matches": true/false,
    "confidence": 0.0-1.0,
    "status": "APPROVED" | "REJECTED" | "UNCERTAIN",
    "risk_score": 0-10,
    "reasoning": "Explicação detalhada"
}
\`\`\``;

    // FIXED: Read JUIZ config from database, API key from .env (source of truth)
    let provider = config.provider || await getSetting('juiz_provider') || PROVIDERS.DEEPSEEK;
    let model = config.model || await getSetting('juiz_model') || 'deepseek-chat';
    let apiKey = getApiKeyFromEnv(provider);

    // Fallback to DeepSeek if provider's key not found
    if (!apiKey) {
        console.warn(`[JUIZ] ⚠️ No API key in .env for "${provider}". Falling back to DeepSeek.`);
        provider = PROVIDERS.DEEPSEEK;
        model = 'deepseek-chat';
        apiKey = getApiKeyFromEnv(PROVIDERS.DEEPSEEK);
    }

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
            return JSON.parse(jsonMatch[1] || jsonMatch[0]);
        }
    } catch (err) {
        console.warn(`[JUIZ] Entity matching failed: ${err.message}`);
    }

    // Fallback: simple name matching
    return fallbackEntityMatch(candidate, goldEntity);
}

/**
 * Fallback entity matching using string similarity
 */
function fallbackEntityMatch(candidate, goldEntity) {
    const titleLower = candidate.title.toLowerCase();
    const entityNameLower = goldEntity.name.toLowerCase();

    // Check for model name in title
    const entityWords = entityNameLower.split(/\s+/).filter(w => w.length > 2);
    const matchedWords = entityWords.filter(w => titleLower.includes(w));
    const matchRatio = matchedWords.length / entityWords.length;

    if (matchRatio > 0.7) {
        return {
            matches: true,
            confidence: matchRatio,
            status: 'APPROVED',
            risk_score: 2,
            reasoning: `Título contém ${matchedWords.length}/${entityWords.length} palavras do modelo`
        };
    } else if (matchRatio > 0.4) {
        return {
            matches: false,
            confidence: matchRatio,
            status: 'UNCERTAIN',
            risk_score: 5,
            reasoning: 'Correspondência parcial - requer verificação'
        };
    }

    return {
        matches: false,
        confidence: matchRatio,
        status: 'REJECTED',
        risk_score: 8,
        reasoning: 'Modelo não identificado no anúncio'
    };
}

/**
 * Generate a technical defense report for the selection (SKEPTICAL JUDGE v8.0)
 */
async function generateDefenseReport(candidates, winnerIndex, goldEntity, killSpecs, item, config, specs = {}) {
    if (winnerIndex < 0 || !candidates[winnerIndex]) {
        return null;
    }

    const winner = candidates[winnerIndex];

    const report = {
        timestamp: new Date().toISOString(),
        item: {
            id: item.id,
            description: item.description,
            maxPrice: item.maxPrice
        },
        goldEntity: goldEntity ? {
            name: goldEntity.name,
            manufacturer: goldEntity.manufacturer,
            sourceUrl: goldEntity.sourceUrl,
            isGeneric: goldEntity.isGeneric
        } : null,
        killSpecs,
        // SKEPTICAL JUDGE v8.0 data
        skepticalJudge: {
            searchAnchor: specs.searchAnchor || null,
            negativeConstraints: specs.negativeConstraints || [],
            criticalSpecsCount: (specs.criticalSpecs || []).length
        },
        selection: {
            title: winner.title,
            price: winner.price,
            shippingCost: winner.shippingCost || 0,
            totalPrice: winner.totalPrice || winner.price,
            link: winner.link,
            aiMatch: winner.aiMatch,
            aiReasoning: winner.aiReasoning,
            risk_score: winner.risk_score,
            adherenceScore: winner.adherenceScore || null,
            scoreBreakdown: winner.scoreBreakdown || [],
            crossReferenced: winner.crossReferenced || false
        },
        kitComponents: winner.kitComponents || null,
        totalWithKit: winner.totalPriceWithKit || null,
        methodology: buildMethodologyText(goldEntity, killSpecs, specs),
        candidates: candidates.length
    };

    return report;
}

/**
 * Build methodology explanation text (SKEPTICAL JUDGE v8.0)
 */
function buildMethodologyText(goldEntity, killSpecs, specs = {}) {
    const hasSkepticalJudge = specs.negativeConstraints?.length > 0 || specs.criticalSpecs?.length > 0;

    if (!goldEntity || goldEntity.isGeneric) {
        if (hasSkepticalJudge) {
            return `SKEPTICAL JUDGE v8.0: Validação por ProductDNA com ${specs.negativeConstraints?.length || 0} Kill-Words e ${specs.criticalSpecs?.length || 0} Critical Specs ponderadas.`;
        }
        return 'Busca direta no marketplace com validação por IA.';
    }

    return `Metodologia HIVE-MIND + SKEPTICAL JUDGE v8.0:
1. PERITO extraiu Kill-Specs: ${killSpecs.slice(0, 3).join(', ')}
   ${specs.negativeConstraints?.length > 0 ? `   → Kill-Words: ${specs.negativeConstraints.join(', ')}` : ''}
2. DETETIVE descobriu o fabricante/modelo na web aberta
3. AUDITOR validou "${goldEntity.name}" no site do fabricante (${goldEntity.sourceUrl || 'fonte confirmada'})
4. SNIPER buscou especificamente pelo modelo validado + extraiu ProductDNA
5. JUIZ calculou Adherence Score via ProductDNA (Risco Decimal 0.0-10.0)

Ordenação: ORDER BY risk ASC, price ASC (técnica sobre preço)`;
}

// ============================================
// SMART CANDIDATE SELECTION - Phase 6B
// Direct Evaluation with Simple Prompt
// ============================================

/**
 * Evaluate a candidate with a simple, direct AI prompt
 * No complex scoring - just ask "what's the risk?"
 * 
 * @param {object} candidate - The candidate to evaluate
 * @param {string} originalDescription - Full tender description (NO TRUNCATION)
 * @param {object} config - AI configuration
 * @returns {object} { risk_score, reasoning }
 */
async function evaluateCandidateDirect(candidate, originalDescription, config) {
    // Build the full ad text - NO TRUNCATION
    const productDNA = candidate.productDNA || {};
    const adText = productDNA.fullTextRaw ||
        productDNA.descriptionText ||
        candidate.description ||
        candidate.title ||
        'N/A';

    const prompt = `Uma prefeitura está querendo comprar este item:

--- DESCRIÇÃO DO EDITAL ---
${originalDescription}

--- ANÚNCIO ENCONTRADO ---
Título: ${candidate.title}
Preço: R$ ${candidate.price?.toFixed(2) || 'N/A'}

Descrição completa do anúncio:
${adText}

---

De 0 a 10, qual o RISCO de eu vender este item para a prefeitura e por quê?

ESCALA DE RISCO:
- 0-2: ✅ Baixíssimo risco, produto claramente compatível
- 3-4: ⚠️ Baixo risco, pequenas diferenças aceitáveis
- 5-6: 🔶 Médio risco, algumas especificações podem não atender
- 7-8: 🔴 Alto risco, diferenças significativas que podem causar problemas
- 9-10: ❌ Altíssimo risco, produto provavelmente incompatível

IMPORTANTE:
- Use emojis para destacar pontos chaves
- Seja específico sobre O QUE pode dar errado
- Mencione as especificações que batem e as que NÃO batem
- Se o anúncio não menciona algo importante, diga que isso aumenta o risco

Responda em JSON:
{
    "risk_score": 0-10,
    "reasoning": "Explicação detalhada com emojis"
}`;

    console.log(`[JUIZ] 🎯 Avaliação DIRETA: "${candidate.title?.substring(0, 40)}..."`);

    try {
        // Get AI configuration
        let provider = config.provider || await getSetting('juiz_provider') || PROVIDERS.DEEPSEEK;
        let model = config.model || await getSetting('juiz_model') || 'deepseek-chat';
        let apiKey = getApiKeyFromEnv(provider);

        if (!apiKey) {
            console.warn(`[JUIZ] ⚠️ No API key for "${provider}", using DeepSeek`);
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

        console.log(`[JUIZ] 🤖 IA respondeu: "${response.substring(0, 80)}..."`);

        // Parse JSON response
        const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/) ||
            response.match(/\{[\s\S]*\}/);

        if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[1] || jsonMatch[0]);
            return {
                risk_score: parseFloat(parsed.risk_score) || 5.0,
                reasoning: parsed.reasoning || 'Avaliação sem detalhes'
            };
        }

        // Fallback: try to extract numbers from response
        const numberMatch = response.match(/\b(\d+(?:\.\d+)?)\s*(?:\/\s*10|de\s*risco)/i);
        if (numberMatch) {
            return {
                risk_score: parseFloat(numberMatch[1]),
                reasoning: response.replace(/```json[\s\S]*?```/g, '').trim() || 'Risco avaliado'
            };
        }

        console.warn(`[JUIZ] ⚠️ Não conseguiu parsear resposta da IA`);
        return {
            risk_score: 5.0,
            reasoning: '🔶 Avaliação inconclusiva - resposta da IA não estruturada'
        };

    } catch (err) {
        console.error(`[JUIZ] ❌ Erro na avaliação direta: ${err.message}`);
        return {
            risk_score: 6.0,
            reasoning: `⚠️ Erro na avaliação automática: ${err.message}`
        };
    }
}

module.exports = { executeJuiz, evaluateCandidateDirect };
