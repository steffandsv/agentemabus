const { GoogleGenerativeAI } = require("@google/generative-ai");

let genAI = null;
let currentModelName = "gemini-3-pro-preview"; // Default start
let model = null;

function initGemini() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.warn("⚠️ GEMINI_API_KEY not found. AI features will be mocked.");
        return false;
    }
    try {
        genAI = new GoogleGenerativeAI(apiKey);
        model = genAI.getGenerativeModel({ model: currentModelName });
        return true;
    } catch (e) {
        console.error("Error initializing Gemini:", e);
        return false;
    }
}

async function askGemini(prompt, retryCount = 0) {
    if (!genAI) {
        if (!initGemini()) return "Mock Gemini Response: API Key missing.";
    }

    try {
        // Safety: Ensure model is initialized with current name
        if (!model) model = genAI.getGenerativeModel({ model: currentModelName });
        
        const result = await model.generateContent(prompt);
        const response = await result.response;
        return response.text();
    } catch (error) {
        const errorMsg = error.message || "";
        
        // Handle 429 (Quota Exceeded) or Model Not Found
        if (errorMsg.includes("429") || errorMsg.includes("Too Many Requests") || errorMsg.includes("not found")) {
            if (retryCount < 2) {
                console.warn(`⚠️ [Gemini] Quota exceeded or error on ${currentModelName}. Switching model...`);
                
                // Switch Strategy
                if (currentModelName === "gemini-3-pro-preview") {
                    currentModelName = "gemini-2.5-pro"; // User requested specific backup
                } else if (currentModelName === "gemini-2.5-pro") {
                    currentModelName = "gemini-1.5-flash"; // Ultimate backup (cheap & high limits)
                } else {
                    // Already on backup, just wait a bit?
                    await new Promise(r => setTimeout(r, 2000));
                }

                console.log(`🔄 [Gemini] Retrying with ${currentModelName}...`);
                
                // Re-init model object
                model = genAI.getGenerativeModel({ model: currentModelName });
                
                return askGemini(prompt, retryCount + 1);
            }
        }
        
        console.error(`❌ [Gemini] Fatal Error (${currentModelName}):`, errorMsg);
        // Fallback to null/empty so the app doesn't crash completely, or rethrow? 
        // Logic says rethrow, but we might want to return null to allow partial continuation.
        // But caller expects string.
        throw error;
    }
}

module.exports = { askGemini };
