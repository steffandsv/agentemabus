/**
 * JUIZ Agent - THE SKEPTICAL JUDGE v8.0
 * 
 * Mission: Calculate Adherence Score using ProductDNA and weighted specs.
 * Uses KILL-WORDS elimination, anchor verification, and decimal risk scoring.
 * 
 * Protocol: "Se não está escrito, não existe"
 * 
 * Output:
 * - validatedCandidates: Candidates with decimal risk scores
 * - winnerIndex: Index of best candidate (lowest risk)
 * - defenseReport: Technical defense report with scoring breakdown
 */

const { generateText, PROVIDERS } = require('../../../src/services/ai_manager');
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
 * @returns {object} { score, risk, reason, breakdown }
 */
function calculateAdherenceScore(productDNA, specs, detectedModel = null) {
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
    // PHASE 1: KILL-WORDS CHECK (Morte Súbita)
    // ============================================
    const negativeConstraints = specs.negativeConstraints || [];
    for (const killWord of negativeConstraints) {
        const normalized = killWord.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        
        if (fullText.includes(normalized)) {
            return {
                score: 0,
                risk: '10.0',
                reason: `⛔ KILL-WORD: "${killWord}" detectada. Incompatibilidade tecnológica.`,
                breakdown: [`KILL-WORD "${killWord}" encontrada`]
            };
        }
    }
    breakdown.push('✓ Nenhuma kill-word detectada');
    
    // ============================================
    // PHASE 2: ANCHOR VERIFICATION (Prova Real)
    // ============================================
    const anchor = (specs.searchAnchor || '')
        .replace(/"/g, '')
        .toLowerCase()
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    if (anchor && anchor.length > 0) {
        if (fullText.includes(anchor)) {
            score += 60;
            breakdown.push(`✓ Âncora "${anchor}" encontrada (+60pts)`);
        } else {
            score += 10;
            breakdown.push(`⚠ Âncora "${anchor}" NÃO encontrada (+10pts - penalidade severa)`);
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
        
        if (specText && fullText.includes(specText)) {
            score += weight;
            specsFound++;
            breakdown.push(`✓ Spec "${specObj.spec || specObj}" (+${weight}pts)`);
        }
    }
    
    if (specsTotal > 0) {
        breakdown.push(`→ Specs encontradas: ${specsFound}/${specsTotal}`);
    }
    
    // ============================================
    // PHASE 4: GOLDEN MODEL BONUS
    // ============================================
    if (detectedModel && title.toLowerCase().includes(detectedModel.toLowerCase())) {
        score += 30;
        breakdown.push(`✓ Modelo detectado "${detectedModel}" no título (+30pts bônus)`);
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
 * @param {object} specs - PERITO output (searchAnchor, negativeConstraints, criticalSpecs)
 * @param {string} detectedModel - Model name from DETETIVE (optional)
 */
async function executeJuiz(candidates, goldEntity, killSpecs, item, config, specs = {}, detectedModel = null) {
    console.log(`[JUIZ] THE SKEPTICAL JUDGE v8.0 - Analyzing ${candidates.length} candidates`);
    
    if (!candidates || candidates.length === 0) {
        return {
            validatedCandidates: [],
            winnerIndex: -1,
            defenseReport: null
        };
    }
    
    // ============================================
    // PHASE 1: PRICE FLOOR - Primeira Linha de Defesa
    // ============================================
    const maxPrice = item.maxPrice || 0;
    if (maxPrice > 0) {
        candidates = applyPriceFloor(candidates, maxPrice);
        const rejected = candidates.filter(c => c.priceFloorRejection).length;
        if (rejected > 0) {
            console.log(`[JUIZ] 🚫 Price Floor: ${rejected} candidatos rejeitados (preço < R$ ${(maxPrice * PRICE_FLOOR_PERCENTAGE).toFixed(2)})`);
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
    
    for (const candidate of viableCandidates) {
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
            const adherence = calculateAdherenceScore(
                candidate.productDNA, 
                specsForScoring, 
                detectedModel
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
    } else {
        console.log(`[JUIZ] ⚠ Nenhum candidato com risco aceitável (<= ${MAX_ACCEPTABLE_RISK})`);
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

module.exports = { executeJuiz };
