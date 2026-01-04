const fs = require('fs');
const pdf = require('pdf-parse');
const { generateText, PROVIDERS } = require('./ai_manager');

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

    // 2. Send to AI (Qwen Turbo)
    // Using Qwen Turbo as requested (Cheap & Capable)
    // Falls back to generic extraction if keys missing, but assuming Env is set.
    const config = {
        provider: PROVIDERS.QWEN,
        model: 'qwen-turbo',
        apiKey: process.env.DASHSCOPE_API_KEY || process.env.QWEN_KEY,
        messages: [
            {
                role: 'user',
                content: `Você é um especialista em extração de dados de editais e tabelas de licitação.
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
                ${fullText.substring(0, 1000000)}`
            }
        ]
    };

    try {
        const responseText = await generateText(config);
        // Cleanup markdown if present (Qwen sometimes chats)
        let jsonStr = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        // Sometimes models add intro text, try to find the first { and last }
        const firstBrace = jsonStr.indexOf('{');
        const lastBrace = jsonStr.lastIndexOf('}');
        if (firstBrace !== -1 && lastBrace !== -1) {
            jsonStr = jsonStr.substring(firstBrace, lastBrace + 1);
        }

        return JSON.parse(jsonStr);
    } catch (e) {
        console.error("AI Extraction Error:", e);
        throw new Error("Falha ao processar dados com IA: " + e.message);
    }
}

module.exports = { extractItemsFromPdf };
