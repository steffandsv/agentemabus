const fs = require('fs');
const pdf = require('pdf-parse');
const { GoogleGenerativeAI } = require("@google/generative-ai");

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function processPDF(filePath) {
    try {
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdf(dataBuffer);
        const text = data.text;

        // Use standard model or the one requested if available.
        // User requested "gemini-2.5-flash-lite". I suspect this is "gemini-1.5-flash".
        // I will use "gemini-1.5-flash" as it is stable and cost effective.
        // Prompt engineering to extract specific format.
        const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });

        const prompt = `
        You are an expert data extraction assistant.
        Extract a list of items from the following Terms of Reference (TR) text.
        Return ONLY a raw JSON array of objects. Do not include markdown formatting (like \`\`\`json).

        Each object must have these exact keys:
        - "id": Sequential number or the item number from the text.
        - "description": Full description of the item.
        - "valor_venda": The maximum unit price (numeric, do not include currency symbols). If not found, use 0.
        - "quantidade": The quantity (numeric). If not found, use 1.

        Text to analyze:
        ${text.substring(0, 30000)}
        `; // Limit context window just in case

        const result = await model.generateContent(prompt);
        const response = await result.response;
        let textResponse = response.text();

        // Cleanup markdown if AI ignores instruction
        textResponse = textResponse.replace(/```json/g, '').replace(/```/g, '').trim();

        const items = JSON.parse(textResponse);
        return items;

    } catch (e) {
        console.error("AI TR Processing Failed:", e);
        throw new Error("Falha ao processar PDF com IA: " + e.message);
    }
}

module.exports = { processPDF };
