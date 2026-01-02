const { generateText } = require('../../src/services/ai_manager');
const { getSetting } = require('../../src/database');

async function resolveAmbiguityWithPerplexity(requiredSpecs, candidate, config = {}) {
    // If Perplexity is selected as the main provider for Sniper, we might use that config.
    // BUT this function specifically asks for "Perplexity" verification (it's a specific step).
    // So we should try to use the Perplexity Provider if possible, or fallback to the generic config if it supports search.
    // For now, let's stick to explicitly using Perplexity provider via AI Manager.

    // Check if we have a key
    // If config has a provider (selected in Admin), try to use it.
    // Otherwise fallback to Perplexity defaults.

    let effectiveProvider = config.provider || 'perplexity';
    let effectiveKey = config.apiKey || process.env.PERPLEXITY_API_KEY;
    let effectiveModel = config.model || 'sonar-pro';

    // If the provider is Perplexity specifically but no key in config, fallback to env
    if (effectiveProvider === 'perplexity' && !effectiveKey) {
        effectiveKey = process.env.PERPLEXITY_API_KEY;
    }

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
        const response = await generateText({
            provider: effectiveProvider,
            model: effectiveModel,
            apiKey: effectiveKey,
            messages: messages
        });

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
