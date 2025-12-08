async function askPerplexity(input) {
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
            { role: 'system', content: 'You are a helpful shopping assistant. Search the brazilian web for products.' },
            { role: 'user', content: input }
        ];
    }

    try {
        const response = await fetch('https://api.perplexity.ai/chat/completions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: 'sonar-pro', // or sonar-reasoning-pro
                messages: messages,
                max_tokens: 3000
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`Perplexity API Error: ${response.status} - ${errText}`);
        }

        const json = await response.json();
        return json.choices[0].message.content;
    } catch (e) {
        console.error("Perplexity Client Error:", e.message);
        return null;
    }
}

module.exports = { askPerplexity };
