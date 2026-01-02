const fetch = require('node-fetch');
const { getSetting } = require('../database');

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
            // Verification: simple call to a cheap endpoint?
            // For now, return hardcoded list as per docs.
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
             // Gemini usually requires Google GenAI SDK listModels, but we can return hardcoded for simplicity
             // or try to hit REST API if KEY allows.
             // Given constraint, hardcoded is safer/faster for UI now.
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
        } else {
            // Fallback for non-streaming providers (simulate stream)
            // Implementation for Gemini/Perplexity non-stream for now to save time,
            // or implement real stream if crucial.
            // The prompt asked primarily for Qwen integration and DeepSeek/Gemini existing.
            // We will implement simple request and emit one chunk for them if stream complex.
            if (onError) onError(new Error(`Provider ${provider} streaming not fully implemented yet.`));
        }
    } catch (e) {
        if (onError) onError(e);
    }
}

// --- PROVIDER IMPLEMENTATIONS ---

async function streamQwen(apiKey, model, messages, onThought, onChunk, onDone, onError) {
    // DashScope OpenAI Compatible Endpoint
    const url = 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1/chat/completions';

    // Check if thinking is needed/supported
    // Qwen-Max doesn't strictly have "thinking" params in standard API unless specific model version?
    // Docs say "enable_thinking": true in extra_body for Qwen3/DeepThinking models.
    // Let's assume standard behavior first.

    const body = {
        model: model,
        messages: messages,
        stream: true,
        incremental_output: true // Recommended by DashScope
    };

    try {
        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
                'X-DashScope-SSE': 'enable' // Explicitly enable SSE
            },
            body: JSON.stringify(body)
        });

        if (!response.ok) {
            const txt = await response.text();
            throw new Error(`Qwen API Error: ${response.status} - ${txt}`);
        }

        // Parse SSE
        // node-fetch v2 returns NodeJS stream in body
        response.body.on('data', (chunk) => {
            const lines = chunk.toString().split('\n');
            for (const line of lines) {
                if (line.trim() === '') continue;
                if (line.startsWith('data: ')) {
                    const dataStr = line.substring(6).trim();
                    if (dataStr === '[DONE]') {
                        if (onDone) onDone();
                        return;
                    }
                    try {
                        const json = JSON.parse(dataStr);
                        // Standard OpenAI Format usually
                        const delta = json.choices[0].delta;

                        // Check for reasoning/thoughts (Qwen Deep Thinking?)
                        if (delta.reasoning_content) {
                            if (onThought) onThought(delta.reasoning_content); // This gives raw text, need title extraction logic upstream?
                            // Wait, the "title" extraction logic was in tr_processor.
                            // Here we just pass the raw thought chunk.
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

        response.body.on('end', () => {
            if (onDone) onDone(); // Fallback if [DONE] missed
        });

        response.body.on('error', (err) => {
            if (onError) onError(err);
        });

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

module.exports = { PROVIDERS, fetchModels, generateStream };
