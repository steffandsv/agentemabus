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
        // Updated to gemini-2.5-flash-lite as requested.
        const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash-lite" });

        const prompt = `
        You are an expert data extraction assistant specialized in Brazilian Public Bidding Documents (Editais).
        Analyze the provided Terms of Reference (TR) / Edital text.

        Extract three things:
        1. "global_info":
           - "name": Create a concise task name using the Process Number (Processo/Pregão) and the Public Organ/Municipality name (e.g., "PE 12/2024 - Pref. São Paulo").
           - "cep": The ZIP code (CEP) for delivery (usually found near "Local de Entrega"). Format: 00000-000.

        2. "metadata": A simple key-value object containing important details about the bidding process (e.g., "prazo_entrega", "validade_proposta", "condicoes_pagamento", "garantia", "data_abertura", "objeto"). Only include found details.

        3. "items": An array of objects, where each object has:
           - "id": Item number.
           - "description": Full description of the item.
           - "valor_venda": Maximum unit price (numeric, no currency symbols). Use 0 if not found.
           - "quantidade": Quantity (numeric). Use 1 if not found.

        Return ONLY a valid JSON object with keys "global_info", "metadata", and "items". Do not include markdown formatting.

        Text to analyze:
        ${combinedText.substring(0, 60000)}
        `;

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let textResponse = response.text();

        // Cleanup markdown if AI ignores instruction
        textResponse = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();

        const parsed = JSON.parse(textResponse);

        // Ensure structure
        if (!parsed.items && Array.isArray(parsed)) {
            // Fallback if AI returned just array
            return {
                global_info: { name: "", cep: "" },
                metadata: {},
                items: parsed
            };
        }

        return parsed;

    } catch (e) {
        console.error("AI TR Processing Failed:", e);
        throw new Error("Falha ao processar PDF com IA: " + e.message);
    }
}

module.exports = { processPDF };
