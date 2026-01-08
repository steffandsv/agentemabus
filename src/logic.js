
const { normalizeUnit } = require('./services/normalizer');

/**
 * Calculates the final risk score and ranks candidates.
 * Formula: Score = (Preço Normalizado * 0.4) + (Risco Técnico * 0.4) + (Fator Fornecedor * 0.2)
 *
 * Risk Definitions (0-100):
 * - 0-10 (Green): Perfect match (GTIN matches, specs match, new).
 * - 11-30 (Yellow): Cosmetic divergence or Bronze seller.
 * - 31-60 (Orange): Critical info inferred or no reputation.
 * - 61-100 (Red): Technical incompatibility or Used.
 *
 * @param {Array} candidates - The list of validated candidates.
 * @param {Object} tenderItem - The original tender item description/requirements.
 * @returns {Array} - Ranked candidates with enriched 'score' and 'risk_level'.
 */
function calculateRiskAndRank(candidates, tenderItem) {
    if (!candidates || candidates.length === 0) return [];

    // 1. Determine Price Range for Normalization
    // Filter out obvious outliers (e.g., price < 10% of avg) before calc?
    // For now, we take the min valid price as baseline.
    const validPrices = candidates
        .filter(c => c.price > 0 && c.status !== 'REJECTED')
        .map(c => c.price);
    
    const minPrice = validPrices.length > 0 ? Math.min(...validPrices) : 0;
    const maxPrice = validPrices.length > 0 ? Math.max(...validPrices) : 1; // Avoid div/0

    return candidates.map(c => {
        // Base Risk Calculation
        let technicalRisk = 0;
        
        // REJECTED items get max risk
        if (c.status === 'REJECTED') {
            technicalRisk = 100;
        } else {
            // Map technical_score (0.0-10.0) to Risk (100.0-0.0)
            // Score 10.0 -> Risk 0.0
            // Score 0.0 -> Risk 100.0
            // Invert: Risk = (10.0 - Score) * 10.0
            const techScore = parseFloat(c.technical_score) || 0;
            technicalRisk = Math.max(0, Math.min(100, (10.0 - techScore) * 10.0));

            // INTELLIGENT ADJUSTMENT: Dimension/Brand Flexibility
            // If AI flagged 'is_brand_mismatch' but status is APPROVED/UNCERTAIN, risk is low (Legal compliance).
            // If AI flagged 'is_dimension_mismatch', it's a "Flexible Factor", risk stays within Yellow (10-30).

            if (c.is_brand_mismatch && c.status === 'APPROVED') {
                // Do not penalize brand mismatch if specs match (it's legally allowed).
                // Maybe cosmetic risk (Risk ~10-15) just to prefer exact brand if price is same?
                // Let's add slight risk to prefer exact match if prices are identical.
                technicalRisk = Math.max(technicalRisk, 10);
            }

            if (c.is_dimension_mismatch && c.status !== 'REJECTED') {
                 // Dimensions didn't cause rejection, so it's acceptable but not perfect.
                 // Ensure risk is at least 15 (Yellow).
                 technicalRisk = Math.max(technicalRisk, 15);
            }

            // Adjust for condition (if not caught by hard filter)
            if (c.condition && (c.condition.toLowerCase().includes('usado') || c.condition.toLowerCase().includes('used'))) {
                technicalRisk = Math.max(technicalRisk, 80);
            }

            // Adjust for vendor
        }

        // Supplier Factor Logic (0.0 to 1.0)
        // platinum/official -> 1.0
        // gold -> 0.8
        // green thermometer -> 0.7
        // yellow -> 0.4
        // red/none -> 0.2
        let supplierFactor = 0.5;
        const rep = (c.seller_reputation || "").toLowerCase();

        if (rep.includes('official') || rep.includes('platinum')) supplierFactor = 1.0;
        else if (rep.includes('gold')) supplierFactor = 0.8;
        else if (rep.includes('green') || rep.includes('lider')) supplierFactor = 0.7; // MercadoLider often green
        else if (rep.includes('yellow')) supplierFactor = 0.4;
        else if (rep.includes('red')) supplierFactor = 0.2;
        else supplierFactor = 0.3; // Unknown/None

        // Price Score (Lower is better, so 0-1 scale where 1 is best price)
        // Normalized Price Score: 1 - ((Price - Min) / (Max - Min))
        // If Price is Min, score is 1. If Price is Max, score is 0.
        let priceScore = 0;
        if (c.price > 0 && maxPrice > minPrice) {
            priceScore = 1 - ((c.price - minPrice) / (maxPrice - minPrice));
        } else if (c.price > 0 && maxPrice === minPrice) {
            priceScore = 1;
        }

        // The user formula: Score = (Preço Normalizado * 0.4) + (Risco Técnico * 0.4) + (Fator Fornecedor * 0.2)
        // Wait, "Risco Técnico" is usually "Lower is Better" (0 is good).
        // "Preço Normalizado" usually "Higher is Better" (Cheap is good) or "Lower is Better" (Cheap is low score)?
        // Let's align: We want a FINAL SCORE where HIGHER IS BETTER (Best Candidate).

        // Risk: 0 is Best, 100 is Worst. Convert to 0-1 Score (1 is Best).
        const riskScoreNormalized = 1 - (technicalRisk / 100);

        // Formula Adaptation for "Higher is Better":
        // Final Score = (PriceScore * 0.4) + (RiskScoreNormalized * 0.4) + (SupplierFactor * 0.2)

        const finalScore = (priceScore * 0.4) + (riskScoreNormalized * 0.4) + (supplierFactor * 0.2);

        // Assign Risk Level Label
        let riskLevel = 'RED';
        if (technicalRisk <= 10) riskLevel = 'GREEN';
        else if (technicalRisk <= 30) riskLevel = 'YELLOW';
        else if (technicalRisk <= 60) riskLevel = 'ORANGE';

        // Check for "Opportunity"
        // Will be done after sorting.

        return {
            ...c,
            calculated_risk: technicalRisk,
            final_score: finalScore, // 0 to 1
            risk_level: riskLevel
        };
    }).sort((a, b) => b.final_score - a.final_score); // Sort Descending (Best First)
}

function checkBiddingStrategy(rankedCandidates) {
    if (rankedCandidates.length < 2) return null;

    const top1 = rankedCandidates[0];
    const top2 = rankedCandidates[1];

    // Strategy: If diff between Top1 (Risk ~20) and Top2 (Risk 0) > 15%, choose Risk 20.
    // We look for a situation where we have a Cheaper but Slightly Riskier item vs a Safe but Expensive item.

    // Check if Top 1 is riskier than Top 2
    if (top1.calculated_risk > top2.calculated_risk) {
        const priceDiff = (top2.price - top1.price) / top1.price; // How much cheaper is top1?

        if (priceDiff > 0.15 && top1.calculated_risk <= 30) {
            return {
                action: 'OPPORTUNITY_ALERT',
                message: `Oportunidade de Lucro: O item ${top1.title} é ${(priceDiff*100).toFixed(1)}% mais barato que a opção segura, com risco controlado (${top1.risk_level}).`
            };
        }
    }
    return null;
}

module.exports = {
    calculateRiskAndRank,
    checkBiddingStrategy
};
