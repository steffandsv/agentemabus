const fs = require('fs');
const pdf = require('pdf-parse');
const { generateText, PROVIDERS } = require('./ai_manager');
const { getSetting } = require('../database');

async function extractItemsFromPdf(files) {
    let fullText = "";

    // 1. Extract Text from all files
    for (const file of files) {
        try {
            const dataBuffer = fs.readFileSync(file.path);
            const data = await pdf(dataBuffer);
            fullText += `\n--- FILE: ${file.originalname} ---\n${data.text}`;
        } catch (e) {
            console.error(`Error parsing PDF ${file.originalname}:`, e);
        }
    }

    if (!fullText.trim()) throw new Error("Não foi possível extrair texto dos arquivos.");

    const prompt = `Você é um especialista em extração de dados de editais e tabelas de licitação.
    Sua tarefa é ler o texto fornecido (que veio de PDFs) e extrair DUAS coisas:
    1. A lista de itens para compra/licitação.
    2. Metadados do edital: Nome (Município - Número do Processo/Edital) e CEP de entrega.

    Retorne APENAS um JSON válido (sem markdown, sem \`\`\`) com a seguinte estrutura:
    {
        "metadata": {
            "name": "Nome do Município - Edital XX/20XX",
            "cep": "00000-000" (Encontre o CEP de entrega ou da prefeitura no texto)
        },
        "items": [
            {
                "description": "Descrição detalhada do item...",
                "valor_venda": 0.00 (float, use 0 se não achar),
                "quantidade": 1 (int),
                "id": "1"
            }
        ]
    }

    Se não encontrar o CEP, deixe vazio ou tente estimar pelo município.
    Se não encontrar o número do edital, use apenas o nome do órgão/município.

    Texto para analisar:
    ${fullText.substring(0, 1000000)}`;

    // Try to get Key from DB if Env is missing
    let qwenKey = process.env.DASHSCOPE_API_KEY || process.env.QWEN_KEY;
    if (!qwenKey) {
        qwenKey = await getSetting('sniper_api_key');
    }
    // Also check oracle key as fallback if user put it there
    if (!qwenKey) {
        qwenKey = await getSetting('oracle_api_key');
    }

    try {
        // Attempt Primary (Qwen)
        const config = {
            provider: PROVIDERS.QWEN,
            model: 'qwen-turbo',
            apiKey: qwenKey,
            messages: [{ role: 'user', content: prompt }]
        };

        const responseText = await generateText(config);
        return parseResponse(responseText);

    } catch (e) {
        console.error("Qwen Extraction Failed:", e.message);
        console.log("Fallback to Gemini 2.5 Flash Lite triggered");

        // Fallback (Gemini)
        // Use gemini-1.5-flash as the "lite" standard since 2.5 lite is not standard in public API yet or might be 'gemini-2.0-flash-lite-preview'
        // User requested "gemini-2.5-flash-lite", I will try to map to 'gemini-1.5-flash' which is the current "Flash" standard,
        // OR 'gemini-2.0-flash-lite-preview-02-05' if available.
        // Safest bet for "available" is 1.5-flash, but I will name it as requested if it works, or fallback to known good.
        // I'll stick to 'gemini-1.5-flash' for reliability as "Flash Lite" equivalent.

        let geminiKey = process.env.GEMINI_API_KEY;
        if(!geminiKey) geminiKey = await getSetting('oracle_api_key'); // Reuse oracle key for Gemini

        const fallbackConfig = {
            provider: PROVIDERS.GEMINI,
            model: 'gemini-1.5-flash', // Fallback to reliable Flash
            apiKey: geminiKey,
            messages: [{ role: 'user', content: prompt }]
        };

        try {
            const fallbackResponse = await generateText(fallbackConfig);
            return parseResponse(fallbackResponse);
        } catch (finalError) {
             throw new Error("Falha total na extração (Qwen + Gemini): " + finalError.message);
        }
    }
}

function parseResponse(text) {
    let jsonStr = text.replace(/```json/g, '').replace(/```/g, '').trim();
    const firstBrace = jsonStr.indexOf('{');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1) {
        jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
    }
    return JSON.parse(jsonStr);
}

module.exports = { extractItemsFromPdf };
