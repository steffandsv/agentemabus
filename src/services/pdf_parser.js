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

    // 2. Send to AI (Gemini 1.5 Flash - Cheapest & Good Context)
    const config = {
        provider: PROVIDERS.GEMINI,
        model: 'gemini-1.5-flash',
        apiKey: process.env.GEMINI_API_KEY,
        messages: [
            {
                role: 'user',
                content: `Você é um especialista em extração de dados de editais e tabelas de licitação.
                Sua tarefa é ler o texto fornecido (que veio de PDFs) e extrair a lista de itens para compra/licitação.

                Retorne APENAS um JSON válido (sem markdown, sem \`\`\`) contendo um array de objetos.
                Cada objeto deve ter:
                - "description": Descrição detalhada do item.
                - "valor_venda": O valor máximo aceitável (ou valor de referência/unitário). Converta para número (float). Se não encontrar, use 0.
                - "quantidade": A quantidade solicitada. Converta para inteiro. Se não encontrar, use 1.
                - "id": O número do item (ex: 1, 2, 3).

                Ignore cabeçalhos, rodapés e textos legais. Foque na tabela de itens.

                Texto para analisar:
                ${fullText.substring(0, 1000000)}`
            }
        ]
    };

    try {
        const responseText = await generateText(config);
        // Cleanup markdown if present
        const jsonStr = responseText.replace(/```json/g, '').replace(/```/g, '').trim();
        return JSON.parse(jsonStr);
    } catch (e) {
        console.error("AI Extraction Error:", e);
        throw new Error("Falha ao processar dados com IA: " + e.message);
    }
}

module.exports = { extractItemsFromPdf };
