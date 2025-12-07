const { GoogleGenerativeAI } = require("@google/generative-ai");

let genAI = null;
let model = null;

function initGemini() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.warn("⚠️ GEMINI_API_KEY not found. AI features will be mocked.");
        return false;
    }
    try {
        genAI = new GoogleGenerativeAI(apiKey);
        model = genAI.getGenerativeModel({ model: "gemini-3-pro-preview" });
        return true;
    } catch (e) {
        console.error("Error initializing Gemini:", e);
        return false;
    }
}

async function askGemini(prompt) {
    if (!genAI) {
        if (!initGemini()) return "Mock Gemini Response: API Key missing.";
    }
    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        console.error("Gemini API Error:", error.message);
        throw error;
    }
}

module.exports = { askGemini };
