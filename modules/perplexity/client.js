const PERPLEXITY_API_URL = 'https://api.perplexity.ai/chat/completions';

/**
 * Ask Perplexity with full request/response logging
 * 
 * @param {string|Array} input - Query string or messages array
 * @param {object} options - Optional: { logger, itemId }
 * @returns {object} { content, debug: { url, requestBody, rawResponse, timestamp } }
 */
async function askPerplexity(input, options = {}) {
    const { logger, itemId } = options;
    const apiKey = process.env.PERPLEXITY_API_KEY;

    if (!apiKey) {
        console.warn("PERPLEXITY_API_KEY missing.");
        return null;
    }

    let messages = [];
    if (Array.isArray(input)) {
        messages = input;
    } else {
        messages = [
            { role: 'system', content: 'Você é um assistente de pesquisa especializado em produtos. Busque informações técnicas oficiais do fabricante.' },
            { role: 'user', content: input }
        ];
    }

    const requestBody = {
        model: 'sonar-pro',
        messages: messages,
        max_tokens: 3000
    };

    // Log request details
    const debugInfo = {
        url: PERPLEXITY_API_URL,
        requestBody: requestBody,
        rawInput: input,
        timestamp: new Date().toISOString()
    };

    console.log(`[PERPLEXITY] 📡 Request to: ${PERPLEXITY_API_URL}`);
    console.log(`[PERPLEXITY] 📝 Input: ${typeof input === 'string' ? input.substring(0, 100) : JSON.stringify(input).substring(0, 100)}...`);

    if (logger && itemId) {
        logger.log(`   📡 [Item ${itemId}] PERPLEXITY URL: ${PERPLEXITY_API_URL}`);
        logger.log(`   📝 [Item ${itemId}] PERPLEXITY Input: ${typeof input === 'string' ? input.substring(0, 80) : 'messages[]'}...`);
    }

    try {
        const response = await fetch(PERPLEXITY_API_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(requestBody)
        });

        const rawResponseText = await response.text();
        debugInfo.rawResponse = rawResponseText;
        debugInfo.statusCode = response.status;

        console.log(`[PERPLEXITY] 📥 Status: ${response.status}`);
        console.log(`[PERPLEXITY] 📥 Response (first 200 chars): ${rawResponseText.substring(0, 200)}...`);

        if (logger && itemId) {
            logger.log(`   📥 [Item ${itemId}] PERPLEXITY Status: ${response.status}`);
            logger.log(`   📥 [Item ${itemId}] PERPLEXITY Raw (100 chars): ${rawResponseText.substring(0, 100)}...`);
        }

        if (!response.ok) {
            throw new Error(`Perplexity API Error: ${response.status} - ${rawResponseText}`);
        }

        const json = JSON.parse(rawResponseText);
        const content = json.choices?.[0]?.message?.content || null;

        return {
            content,
            debug: debugInfo
        };
    } catch (e) {
        console.error("[PERPLEXITY] ❌ Error:", e.message);
        debugInfo.error = e.message;

        return {
            content: null,
            debug: debugInfo
        };
    }
}

/**
 * Simple wrapper for backward compatibility
 * Returns just the content string
 */
async function askPerplexitySimple(input) {
    const result = await askPerplexity(input);
    return result?.content || null;
}

module.exports = { askPerplexity, askPerplexitySimple, PERPLEXITY_API_URL };
