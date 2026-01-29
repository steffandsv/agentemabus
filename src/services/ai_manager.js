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
    // If no API key provided, try environment variables
    if (!apiKey || apiKey.trim() === '') {
        if (provider === PROVIDERS.QWEN) apiKey = process.env.QWEN_KEY || process.env.DASHSCOPE_API_KEY;
        else if (provider === PROVIDERS.DEEPSEEK) apiKey = process.env.DEEPSEEK_API_KEY;
        else if (provider === PROVIDERS.GEMINI) apiKey = process.env.GEMINI_API_KEY;
        else if (provider === PROVIDERS.PERPLEXITY) apiKey = process.env.PERPLEXITY_API_KEY;
    }

    if (!apiKey || apiKey.trim() === '') {
        console.log(`[AI Manager] No API key for ${provider}`);
        return [];
    }

    console.log(`[AI Manager] Fetching models for ${provider}...`);

    try {
        if (provider === PROVIDERS.GEMINI) {
            // Gemini: GET https://generativelanguage.googleapis.com/v1beta/models?key=API_KEY
            const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Gemini API Error: ${response.status} - ${errorText}`);
            }
            const data = await response.json();
            // Filter to generative models only and map to our format
            const generativeModels = (data.models || [])
                .filter(m => m.name && m.supportedGenerationMethods && 
                        m.supportedGenerationMethods.includes('generateContent'))
                .map(m => ({
                    id: m.name.replace('models/', ''),
                    name: m.displayName || m.name.replace('models/', ''),
                    description: m.description || ''
                }));
            console.log(`[AI Manager] Gemini: ${generativeModels.length} models found`);
            return generativeModels;
        }
        else if (provider === PROVIDERS.DEEPSEEK) {
            // DeepSeek: GET https://api.deepseek.com/models (OpenAI compatible)
            const response = await fetch('https://api.deepseek.com/models', {
                headers: { 'Authorization': `Bearer ${apiKey}` }
            });
            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`DeepSeek API Error: ${response.status} - ${errorText}`);
            }
            const data = await response.json();
            const models = (data.data || []).map(m => ({ 
                id: m.id, 
                name: m.id, 
                description: 'DeepSeek Model' 
            }));
            console.log(`[AI Manager] DeepSeek: ${models.length} models found`);
            return models;
        }
        else if (provider === PROVIDERS.QWEN) {
            // Qwen/DashScope doesn't have a public list endpoint - return known models
            console.log(`[AI Manager] Qwen: Returning static model list`);
            return [
                { id: 'qwen-max', name: 'Qwen-Max', description: 'Modelo mais capaz para raciocínio complexo' },
                { id: 'qwen-max-latest', name: 'Qwen-Max Latest', description: 'Versão mais recente do Qwen-Max' },
                { id: 'qwen-plus', name: 'Qwen-Plus', description: 'Equilíbrio entre performance e velocidade' },
                { id: 'qwen-turbo', name: 'Qwen-Turbo', description: 'Mais rápido, baixa latência' },
                { id: 'qwen-turbo-latest', name: 'Qwen-Turbo Latest', description: 'Versão mais recente do Qwen-Turbo' },
                { id: 'qwen-flash', name: 'Qwen-Flash', description: 'Ultra rápido e econômico' },
                { id: 'qwen-vl-max', name: 'Qwen-VL-Max', description: 'Visão + Linguagem' },
                { id: 'qwen-vl-plus', name: 'Qwen-VL-Plus', description: 'Visão + Linguagem (rápido)' },
                { id: 'qwen2.5-72b-instruct', name: 'Qwen 2.5 72B', description: 'Modelo grande instruct' },
                { id: 'qwen2.5-14b-instruct', name: 'Qwen 2.5 14B', description: 'Modelo médio instruct' }
            ];
        }
        else if (provider === PROVIDERS.PERPLEXITY) {
            // Perplexity doesn't have a list endpoint - return known Sonar models
            console.log(`[AI Manager] Perplexity: Returning static model list`);
            return [
                { id: 'sonar', name: 'Sonar', description: 'Modelo base, rápido e econômico' },
                { id: 'sonar-pro', name: 'Sonar Pro', description: 'Mais profundo, mais buscas' },
                { id: 'sonar-reasoning', name: 'Sonar Reasoning', description: 'Com raciocínio chain-of-thought' },
                { id: 'sonar-reasoning-pro', name: 'Sonar Reasoning Pro', description: 'Raciocínio avançado (DeepSeek-R1)' },
                { id: 'sonar-deep-research', name: 'Sonar Deep Research', description: 'Pesquisa profunda e abrangente' }
            ];
        }
    } catch (e) {
        console.error(`[AI Manager] Error fetching models for ${provider}:`, e.message);
        return [{ id: 'error', name: `Erro: ${e.message}`, description: 'Falha ao carregar modelos' }];
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
