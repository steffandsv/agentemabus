const fetch = require('node-fetch'); // Ensure node-fetch is available if not global in this env, but usually global in Node 18+ or handled via project deps.
// Assuming native fetch or already polyfilled based on previous file content.

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

/**
 * Streams the DeepSeek response.
 * @param {Array} messages - Chat messages.
 * @param {string} model - Model name.
 * @param {Function} onChunk - Callback for regular content chunks (optional).
 * @param {Function} onReasoning - Callback for reasoning content chunks (optional).
 * @returns {Promise<string>} - The full final content.
 */
async function callDeepSeekStream(messages, model = "deepseek-reasoner", onChunk = null, onReasoning = null) {
    const apiKey = process.env.DEEPSEEK_API_KEY;
    if (!apiKey) {
        throw new Error("DEEPSEEK_API_KEY missing.");
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
                model: model,
                messages: messages,
                stream: true
            })
        });

        if (!response.ok) {
            const errText = await response.text();
            throw new Error(`API Error ${response.status}: ${errText}`);
        }

        const reader = response.body.getReader ? response.body.getReader() : null;
        // Node 18+ fetch implementation returns a body that is a ReadableStream.
        // If 'node-fetch' is used in older nodes, it might be response.body (NodeJS Readable).

        let fullContent = "";
        let fullReasoning = "";

        // Handle NodeJS Readable Stream (if not Web Stream)
        if (!reader && response.body.on) {
            for await (const chunk of response.body) {
                 const lines = chunk.toString().split('\n');
                 for (const line of lines) {
                     if (line.trim() === '') continue;
                     if (line.trim() === 'data: [DONE]') continue;
                     if (line.startsWith('data: ')) {
                         try {
                             const json = JSON.parse(line.substring(6));
                             const delta = json.choices[0].delta;

                             if (delta.reasoning_content) {
                                 if (onReasoning) onReasoning(delta.reasoning_content);
                                 fullReasoning += delta.reasoning_content;
                             }

                             if (delta.content) {
                                 if (onChunk) onChunk(delta.content);
                                 fullContent += delta.content;
                             }
                         } catch (e) {
                             // Ignore parse errors for partial lines
                         }
                     }
                 }
            }
        } else if (reader) {
            // Web Streams API (Node 18+ native fetch)
            const decoder = new TextDecoder("utf-8");
            while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                const chunk = decoder.decode(value);
                const lines = chunk.split('\n');
                 for (const line of lines) {
                     if (line.trim() === '') continue;
                     if (line.trim() === 'data: [DONE]') continue;
                     if (line.startsWith('data: ')) {
                         try {
                             const json = JSON.parse(line.substring(6));
                             const delta = json.choices[0].delta;

                             if (delta.reasoning_content) {
                                 if (onReasoning) onReasoning(delta.reasoning_content);
                                 fullReasoning += delta.reasoning_content;
                             }

                             if (delta.content) {
                                 if (onChunk) onChunk(delta.content);
                                 fullContent += delta.content;
                             }
                         } catch (e) {
                             // Ignore parse errors
                         }
                     }
                 }
            }
        } else {
             throw new Error("Response body is not iterable.");
        }

        return {
            content: fullContent,
            reasoning_content: fullReasoning
        };

    } catch (error) {
        console.error(`DeepSeek Stream API Error (${model}):`, error.message);
        throw error;
    }
}

module.exports = { callDeepSeek, callDeepSeekStream };
