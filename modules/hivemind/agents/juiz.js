/**
 * JUIZ Agent (The Cross-Referencer)
 * 
 * Mission: Resolve poor seller descriptions using entity matching.
 * If an ML listing matches the Gold Entity but has incomplete description,
 * the JUIZ can approve it based on the AUDITOR's validation.
 * 
 * Output:
 * - validatedCandidates: Candidates with updated validation status
 * - winnerIndex: Index of the best candidate
 * - defenseReport: Technical defense report for the selection
 */

const { generateText, PROVIDERS } = require('../../../src/services/ai_manager');
const { getSetting } = require('../../../src/database');

// PRICE FLOOR: Minimum viable price as percentage of max tender price
// Items below this threshold are rejected as suspected accessories/scrap
const PRICE_FLOOR_PERCENTAGE = 0.15; // 15%

/**
 * Execute JUIZ agent
 * @param {object[]} candidates - Candidates from SNIPER
 * @param {object} goldEntity - Gold Entity from AUDITOR
 * @param {string[]} killSpecs - Original Kill-Specs
 * @param {object} item - Original tender item
 * @param {object} config - AI configuration
 */
async function executeJuiz(candidates, goldEntity, killSpecs, item, config) {
    console.log(`[JUIZ] Cross-referencing ${candidates.length} candidates`);
    
    if (!candidates || candidates.length === 0) {
        return {
            validatedCandidates: [],
            winnerIndex: -1,
            defenseReport: null
        };
    }
    
    // ============================================
    // PRICE FLOOR - Primeira Linha de Defesa
    // (ANCHOR & LOCK doctrine)
    // ============================================
    const maxPrice = item.maxPrice || 0;
    if (maxPrice > 0) {
        candidates = applyPriceFloor(candidates, maxPrice);
        const rejected = candidates.filter(c => c.priceFloorRejection).length;
        if (rejected > 0) {
            console.log(`[JUIZ] 🚫 Price Floor rejeitou ${rejected} candidatos (preço < R$ ${(maxPrice * PRICE_FLOOR_PERCENTAGE).toFixed(2)})`);
        }
    }
    
    // Filter out price floor rejections before AI analysis (saves tokens)
    const viableCandidates = candidates.filter(c => !c.priceFloorRejection);
    
    // 1. Validate each VIABLE candidate against Gold Entity
    // (price floor rejections are kept but not analyzed by AI)
    const validatedCandidates = [...candidates.filter(c => c.priceFloorRejection)];
    
    for (let i = 0; i < viableCandidates.length; i++) {
        const candidate = viableCandidates[i];
        
        // If candidate is from Gold Entity search and has price anomaly, mark as uncertain
        if (candidate.priceAnomaly) {
            candidate.aiMatch = 'UNCERTAIN';
            candidate.aiReasoning = candidate.anomalyReason;
            candidate.risk_score = 8;
            candidate.technical_score = 2;
            validatedCandidates.push(candidate);
            continue;
        }
        
        // Check if this is clearly the Gold Entity
        if (goldEntity && !goldEntity.isGeneric) {
            const entityMatch = await matchToGoldEntity(candidate, goldEntity, killSpecs, config);
            
            if (entityMatch.matches) {
                // Cross-reference approval
                candidate.aiMatch = 'APPROVED';
                candidate.aiReasoning = entityMatch.reasoning;
                candidate.risk_score = entityMatch.risk_score || 1;
                candidate.technical_score = 10 - (entityMatch.risk_score || 1);
                candidate.crossReferenced = true;
                candidate.goldEntityMatch = goldEntity.name;
            } else {
                // Doesn't clearly match Gold Entity
                candidate.aiMatch = entityMatch.status || 'UNCERTAIN';
                candidate.aiReasoning = entityMatch.reasoning;
                candidate.risk_score = entityMatch.risk_score || 5;
                candidate.technical_score = 10 - (entityMatch.risk_score || 5);
            }
        } else {
            // Generic search - use standard validation
            candidate.aiMatch = 'UNCERTAIN';
            candidate.aiReasoning = 'Busca genérica - validação manual recomendada';
            candidate.risk_score = 5;
            candidate.technical_score = 5;
        }
        
        validatedCandidates.push(candidate);
    }
    
    // 2. Select winner (lowest risk, then lowest price)
    const approved = validatedCandidates.filter(c => 
        c.aiMatch === 'APPROVED' || (c.risk_score && c.risk_score <= 3)
    );
    
    let winnerIndex = -1;
    
    if (approved.length > 0) {
        // Sort by risk (ascending) then by total price (ascending)
        approved.sort((a, b) => {
            if (a.risk_score !== b.risk_score) {
                return a.risk_score - b.risk_score;
            }
            return (a.totalPrice || a.price) - (b.totalPrice || b.price);
        });
        
        const winner = approved[0];
        winnerIndex = validatedCandidates.indexOf(winner);
    } else if (validatedCandidates.length > 0) {
        // No approved candidates - pick lowest risk
        validatedCandidates.sort((a, b) => a.risk_score - b.risk_score);
        winnerIndex = 0;
    }
    
    // 3. Generate defense report
    const defenseReport = await generateDefenseReport(
        validatedCandidates,
        winnerIndex,
        goldEntity,
        killSpecs,
        item,
        config
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
 * Generate a technical defense report for the selection
 */
async function generateDefenseReport(candidates, winnerIndex, goldEntity, killSpecs, item, config) {
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
        selection: {
            title: winner.title,
            price: winner.price,
            shippingCost: winner.shippingCost || 0,
            totalPrice: winner.totalPrice || winner.price,
            link: winner.link,
            aiMatch: winner.aiMatch,
            aiReasoning: winner.aiReasoning,
            risk_score: winner.risk_score,
            crossReferenced: winner.crossReferenced || false
        },
        kitComponents: winner.kitComponents || null,
        totalWithKit: winner.totalPriceWithKit || null,
        methodology: buildMethodologyText(goldEntity, killSpecs),
        candidates: candidates.length
    };
    
    return report;
}

/**
 * Build methodology explanation text
 */
function buildMethodologyText(goldEntity, killSpecs) {
    if (!goldEntity || goldEntity.isGeneric) {
        return 'Busca direta no marketplace com validação por IA.';
    }
    
    return `Metodologia HIVE-MIND:
1. PERITO extraiu Kill-Specs: ${killSpecs.slice(0, 3).join(', ')}
2. DETETIVE descobriu o fabricante/modelo na web aberta
3. AUDITOR validou "${goldEntity.name}" no site do fabricante (${goldEntity.sourceUrl || 'fonte confirmada'})
4. SNIPER buscou especificamente pelo modelo validado
5. JUIZ confirmou que o anúncio corresponde ao modelo homologado

Esta metodologia garante que mesmo anúncios com descrição incompleta sejam aceitos,
desde que claramente identifiquem o modelo que foi previamente validado.`;
}

module.exports = { executeJuiz };
