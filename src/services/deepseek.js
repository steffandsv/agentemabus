async function callDeepSeek(messages, model = "deepseek-chat") {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        console.warn("DEEPSEEK_API_KEY missing.");
        return null;
    }

    let apiEndpoint = 'https://api.deepseek.com/chat/completions';
    if (process.env.DEEPSEEK_API_URL) apiEndpoint = process.env.DEEPSEEK_API_URL;

    try {
        const response = await fetch(apiEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`
            },
            body: JSON.stringify({
                model: model === 'deepseek-v3.2' ? 'deepseek-reasoner' : model,
                messages: messages,
                stream: false
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API Error ${response.status}: ${errText}`);
        }

        const json = await response.json();
        return {
            content: json.choices[0].message.content,
            reasoning_content: json.choices[0].message.reasoning_content || null
        };
    } catch (error) {
        console.error(`DeepSeek API Error (${model}):`, error.message);
        throw error; // Re-throw to let the fallback logic handle it
    }
}

module.exports = { callDeepSeek };
