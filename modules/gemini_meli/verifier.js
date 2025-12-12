const { askPerplexity } = require('../perplexity/client');

async function resolveAmbiguityWithPerplexity(requiredSpecs, candidate) {
    const prompt = `
I need to verify if a product meets specific requirements.
Product Title: "${candidate.title}"
Link: "${candidate.link}"
Missing/Ambiguous Information identified: "${candidate.aiReasoning}"

Required Specs: "${requiredSpecs}"

Please search specifically for this product (using the link or title) and answer:
1. Does it meet the missing requirement?
2. Is it New or Used?

Return ONLY a JSON object:
{
  "confirmed": boolean, // true if it meets specs, false if it fails
  "risk_score": number, // 0 if confirmed good, 10 if confirmed bad, 5 if still unknown
  "reasoning": "string explanation"
}
`.trim();

    const messages = [
        { role: 'system', content: 'You are a technical product verifier. You answer with JSON only.' },
        { role: 'user', content: prompt }
    ];

    try {
        const response = await askPerplexity(messages);
        if (!response) return null;

        const jsonMatch = response.match(/```json\s*([\s\S]*?)\s*```/);
        const jsonStr = jsonMatch ? jsonMatch[1] : response.replace(/^[^{]*({[\s\S]*})[^}]*$/, '$1'); // Simple fallback
        
        try {
            return JSON.parse(jsonStr);
        } catch (e) {
            // If simple parse fails, try looser parse or return null
            return null;
        }
    } catch (e) {
        console.error("Perplexity verification failed:", e.message);
        return null;
    }
}

module.exports = { resolveAmbiguityWithPerplexity };
