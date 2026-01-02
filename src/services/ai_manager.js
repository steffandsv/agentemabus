const fetch = require('node-fetch');
const { getSetting } = require('../database');
const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * AI Manager
 * Unifies calls to different AI providers (Qwen, DeepSeek, Gemini, Perplexity).
 */

const PROVIDERS = {
    QWEN: 'qwen',
    DEEPSEEK: 'deepseek',
    GEMINI: 'gemini',
    PERPLEXITY: 'perplexity'
};

/**
 * Fetch available models from a provider.
 * @param {string} provider
 * @param {string} apiKey
 * @returns {Promise<Array>} List of models [{id, name, description}]
 */
async function fetchModels(provider, apiKey) {
    if (!apiKey) return [];

    try {
        if (provider === PROVIDERS.QWEN) {
            // DashScope doesn't have a simple public "list models" endpoint like OpenAI.
            // We return the known supported list + any found if we can verify the key.
            return [
                { id: 'qwen-max', name: 'Qwen-Max (Trillion Params)', description: 'Most capable model for complex reasoning.' },
                { id: 'qwen-plus', name: 'Qwen-Plus', description: 'Balanced performance and speed.' },
                { id: 'qwen-turbo', name: 'Qwen-Turbo', description: 'Fastest, low latency.' },
                { id: 'qwen-long', name: 'Qwen-Long', description: 'Specialized for massive context (documents).' },
                { id: 'qwen-vl-max', name: 'Qwen-VL-Max', description: 'Vision + Language capability.' }
            ];
        }
        else if (provider === PROVIDERS.DEEPSEEK) {
            // DeepSeek is OpenAI compatible
            const response = await fetch('https://api.deepseek.com/models', {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (!response.ok) throw new Error(`DeepSeek Error: ${response.status}`);
            const data = await response.json();
            return data.data.map(m => ({ id: m.id, name: m.id, description: 'DeepSeek Model' }));
        }
        else if (provider === PROVIDERS.GEMINI) {
             return [
                 { id: 'gemini-2.0-flash-exp', name: 'Gemini 2.0 Flash (Experimental)', description: 'Fastest multimodal.' },
                 { id: 'gemini-1.5-pro', name: 'Gemini 1.5 Pro', description: 'High reasoning.' },
                 { id: 'gemini-1.5-flash', name: 'Gemini 1.5 Flash', description: 'Cost effective.' }
             ];
        }
        else if (provider === PROVIDERS.PERPLEXITY) {
            return [
                { id: 'sonar-pro', name: 'Sonar Pro', description: 'Search-enabled large model.' },
                { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro', description: 'Deep reasoning with search.' }
            ];
        }
    } catch (e) {
        console.error(`Error fetching models for ${provider}:`, e);
        return [{ id: 'error', name: 'Error loading models', description: e.message }];
    }
    return [];
}

/**
 * Generate content (Streaming)
 * @param {object} config { provider, model, apiKey, messages }
 * @param {object} callbacks { onThought, onChunk, onDone, onError }
 */
async function generateStream(config, callbacks) {
    const { provider, model, apiKey, messages } = config;
    const { onThought, onChunk, onDone, onError } = callbacks;

    if (!apiKey) {
        if (onError) onError(new Error("Missing API Key"));
        return;
    }

    try {
        if (provider === PROVIDERS.QWEN) {
            await streamQwen(apiKey, model, messages, onThought, onChunk, onDone, onError);
        } else if (provider === PROVIDERS.DEEPSEEK) {
            await streamDeepSeek(apiKey, model, messages, onThought, onChunk, onDone, onError);
        } else if (provider === PROVIDERS.GEMINI) {
            await streamGemini(apiKey, model, messages, onThought, onChunk, onDone, onError);
        } else if (provider === PROVIDERS.PERPLEXITY) {
             // Fallback for Perplexity non-stream
             const text = await generateText(config);
             if (onChunk) onChunk(text);
             if (onDone) onDone();
        } else {
            if (onError) onError(new Error(`Provider ${provider} streaming not fully implemented yet.`));
        }
    } catch (e) {
        if (onError) onError(e);
    }
}

/**
 * Generate Text (Promise wrapper for non-streaming calls)
 * @param {object} config { provider, model, apiKey, messages }
 * @returns {Promise<string>}
 */
async function generateText(config) {
    const { provider, model, apiKey, messages } = config;
    if (!apiKey) throw new Error("Missing API Key");

    if (provider === PROVIDERS.GEMINI) {
        try {
            const genAI = new GoogleGenerativeAI(apiKey);
            const m = genAI.getGenerativeModel({ model: model });

            // Construct full prompt from messages including System instructions
            // Gemini doesn't strictly support 'system' role in generateContent well without specific beta APIs or using 'user' role.
            // Concatenating content is safer for standard models.
            let fullPrompt = "";
            for (const msg of messages) {
                if (msg.role === 'system') fullPrompt += `[SYSTEM INSTRUCTION]: ${msg.content}\n\n`;
                else if (msg.role === 'user') fullPrompt += `[USER]: ${msg.content}\n\n`;
                else fullPrompt += `[MODEL]: ${msg.content}\n\n`;
            }

            const result = await m.generateContent(fullPrompt);
            return result.response.text();
        } catch (e) {
            throw new Error(`Gemini Error: ${e.message}`);
        }
    }
    else if (provider === PROVIDERS.PERPLEXITY) {
        // Perplexity (OpenAI Compatible)
        try {
            const response = await fetch('https://api.perplexity.ai/chat/completions', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${apiKey}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages
                })
            });
            const data = await response.json();
            if (data.error) throw new Error(JSON.stringify(data.error));
            return data.choices[0].message.content;
        } catch(e) {
            throw new Error(`Perplexity Error: ${e.message}`);
        }
    }
    // Reuse stream logic for Qwen/DeepSeek if they support non-stream endpoints,
    // or just collect the stream. Collecting stream is safer for unified logic.
    else {
        let fullText = "";
        return new Promise((resolve, reject) => {
            generateStream(config, {
                onChunk: (chunk) => fullText += chunk,
                onDone: () => resolve(fullText),
                onError: (e) => reject(e)
            });
        });
    }
}

// --- PROVIDER IMPLEMENTATIONS ---

async function streamQwen(apiKey, model, messages, onThought, onChunk, onDone, onError) {
    // DashScope OpenAI Compatible Endpoint
    const url = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';

    const body = {
        model: model,
        messages: messages,
        stream: true,
        incremental_output: true
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'X-DashScope-SSE': 'enable'
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const txt = await response.text();
            throw new Error(`Qwen API Error: ${response.status} - ${txt}`);
        }

        let buffer = '';
        response.body.on('data', (chunk) => {
            buffer += chunk.toString();
            const lines = buffer.split('\n');
            buffer = lines.pop(); // Keep partial line in buffer

            for (const line of lines) {
                if (line.trim() === '') continue;
                if (line.startsWith('data: ')) {
                    const dataStr = line.substring(6).trim();
                    if (dataStr === '[DONE]') {
                        // Normally wait for 'end' but can signal early if needed
                        continue;
                    }
                    try {
                        const json = JSON.parse(dataStr);
                        const delta = json.choices[0].delta;
                        if (delta.reasoning_content) {
                            if (onThought) onThought(delta.reasoning_content);
                        }
                        if (delta.content) {
                            if (onChunk) onChunk(delta.content);
                        }
                    } catch (e) {
                        // ignore parse error of partial json
                    }
                }
            }
        });

        response.body.on('end', () => { if (onDone) onDone(); });
        response.body.on('error', (err) => { if (onError) onError(err); });

    } catch (e) {
        if (onError) onError(e);
    }
}

async function streamDeepSeek(apiKey, model, messages, onThought, onChunk, onDone, onError) {
    const url = 'https://api.deepseek.com/chat/completions';

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                model: model,
                messages: messages,
                stream: true
            })
        });

        if (!response.ok) {
            const txt = await response.text();
            throw new Error(`DeepSeek API Error: ${response.status} - ${txt}`);
        }

        response.body.on('data', (chunk) => {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
                if (line.trim() === '') continue;
                if (line.startsWith('data: ')) {
                    const dataStr = line.substring(6).trim();
                    if (dataStr === '[DONE]') return;
                    try {
                        const json = JSON.parse(dataStr);
                        const delta = json.choices[0].delta;
                        if (delta.reasoning_content && onThought) onThought(delta.reasoning_content);
                        if (delta.content && onChunk) onChunk(delta.content);
                    } catch (e) {}
                }
            }
        });

        response.body.on('end', () => { if (onDone) onDone(); });
        response.body.on('error', (err) => { if (onError) onError(err); });

    } catch (e) {
        if (onError) onError(e);
    }
}

async function streamGemini(apiKey, model, messages, onThought, onChunk, onDone, onError) {
    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const m = genAI.getGenerativeModel({ model: model });

        // Construct History
        // Gemini expects { role: 'user'|'model', parts: [{ text: ... }] }
        // Simple adaptation:
        const geminiHistory = messages.map(msg => ({
            role: msg.role === 'assistant' ? 'model' : 'user',
            parts: [{ text: msg.content }]
        }));

        // Extract last message as the prompt
        const lastMsg = geminiHistory.pop();

        const chat = m.startChat({
            history: geminiHistory
        });

        const result = await chat.sendMessageStream(lastMsg.parts[0].text);

        for await (const chunk of result.stream) {
            const chunkText = chunk.text();
            if (onChunk) onChunk(chunkText);
        }

        if (onDone) onDone();

    } catch (e) {
        if (onError) onError(e);
    }
}

module.exports = { PROVIDERS, fetchModels, generateStream, generateText };
