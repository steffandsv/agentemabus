const fs = require('fs');
const pdf = require('pdf-parse');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function processPDF(filePaths) {
    try {
        if (typeof filePaths === 'string') {
            filePaths = [filePaths];
        }

        let combinedText = "";

        for (const filePath of filePaths) {
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdf(dataBuffer);
            combinedText += `\n--- START OF FILE ${filePath} ---\n` + data.text + `\n--- END OF FILE ${filePath} ---\n`;
        }

        // Use standard model or the one requested if available.
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

        // NEW PROMPT STRUCTURE: "ORÁCULO ESTRATÉGICO UNIVERSAL (v3.0)" + Extraction
        const prompt = `
        You are the ORACLE OF BIDS (Mabus Oracle). You are an expert data extraction and strategic analysis assistant for Brazilian Public Bidding Documents (Editais).

        Analyze the provided Terms of Reference (TR) / Edital text.

        Your task is to produce a JSON object containing three main sections: "global_info", "oracle_analysis", and "items".

        1. "global_info":
           - "name": Create a concise task name using the Process Number (Processo/Pregão) and the Public Organ/Municipality name. IMPORTANT: You MUST include the Municipality and State (UF) if detected (e.g., "PE 000014 / 2025 - CAMARA MUNICIPAL DE BOITUVA / SP").
           - "cep": The ZIP code (CEP) for delivery (usually found near "Local de Entrega"). Format: 00000-000.

        2. "oracle_analysis": STRICT JSON STRUCTURE as follows:
           {
             "metadata": {
               "titulo_resumo": "Short catchy title",
               "ipm_score": number (0-100),
               "classificacao": "OCEANO AZUL" | "OPORTUNIDADE" | "RISCO ALTO",
               "cor_hex": "#D4AF37" (for high score) or other,
               "potencial_lucro_estimado": "Range string (e.g. R$ 15k - 20k)",
               "tags_gatilho": ["Tag1", "Tag2"],
               "resumo_teaser": "Aggressive copywriting summary selling the opportunity."
             },
             "locked_content": {
               "analise_completa_markdown": "Full strategic report in Markdown.",
               "lista_armadilhas": ["Trap 1", "Trap 2"],
               "itens_estrategicos": ["Item 1 (High Margin)", "Item 2"]
             }
           }

           *CALCULATE IPM SCORE based on:*
           - City Size (Small/Isolated = better)
           - Portal Obscurity (Hard to find = better)
           - Object Complexity (Mixed lots = better)
           - Barriers (Samples, Visits = better)

        3. "items": An array of objects to populate the bidding grid. Each object must have:
           - "id": Item number.
           - "description": Full description of the item.
           - "valor_venda": Maximum unit price (numeric, no currency symbols). Use 0 if not found.
           - "quantidade": Quantity (numeric). Use 1 if not found.

        Return ONLY valid JSON. No markdown.

        Text to analyze:
        ${combinedText.substring(0, 80000)}
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let textResponse = response.text();

        // Cleanup markdown if AI ignores instruction
        textResponse = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();

        const parsed = JSON.parse(textResponse);

        // Ensure structure
        if (!parsed.global_info) parsed.global_info = {};
        if (!parsed.oracle_analysis) {
            // Fallback
            parsed.oracle_analysis = {
                metadata: {
                    ipm_score: 50,
                    resumo_teaser: "Análise indisponível.",
                    tags_gatilho: []
                },
                locked_content: {
                    analise_completa_markdown: "Erro ao gerar análise.",
                    lista_armadilhas: []
                }
            };
        }
        if (!parsed.items) parsed.items = [];

        // Compatibility mapping: The controller expects { global_info, metadata, items }
        // We will pass oracle_analysis as "metadata" (overwriting the old simple metadata concept)
        // BUT wait, the controller saves metadataJSON.
        // So we return:
        // global_info
        // metadata (The FULL oracle_analysis object, so the frontend can use it)
        // items

        return {
            global_info: parsed.global_info,
            metadata: parsed.oracle_analysis, // This will be saved as JSON
            items: parsed.items
        };

    } catch (e) {
        console.error("AI TR Processing Failed:", e);
        throw new Error("Falha ao processar PDF com IA: " + e.message);
    }
}

module.exports = { processPDF };
