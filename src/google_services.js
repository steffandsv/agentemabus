const { GoogleGenerativeAI } = require("@google/generative-ai");
const { google } = require('googleapis');

const customSearch = google.customsearch('v1');

// --- Gemini Configuration ---
let genAI = null;
let model = null;

function initGemini() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.warn("⚠️ GEMINI_API_KEY not found. AI features will be mocked or fail.");
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

// --- Google Search Configuration ---
function initGoogleSearch() {
    // Explicitly disabled by default unless ENABLE_GOOGLE_SEARCH is true
    if (process.env.ENABLE_GOOGLE_SEARCH !== 'true') {
        return false;
    }

    if (!process.env.GOOGLE_SEARCH_API_KEY || !process.env.GOOGLE_SEARCH_CX) {
        console.warn("⚠️ GOOGLE_SEARCH_API_KEY or GOOGLE_SEARCH_CX not found. Web search features will be disabled.");
        return false;
    }
    return true;
}

/**
 * Ask Gemini a question or give it a task.
 * @param {string} prompt - The text prompt.
 * @param {object} options - Optional config (temperature, etc.)
 * @returns {Promise<string>} - The response text.
 */
async function askGemini(prompt, options = {}) {
    if (!genAI) {
        if (!initGemini()) {
            // Mock response for development if key is missing
            return "Mock Gemini Response: API Key missing.";
        }
    }

    try {
        const result = await model.generateContent(prompt);
        const response = await result.response;
        const text = response.text();
        return text;
    } catch (error) {
        console.error("Gemini API Error:", error.message);
        throw error;
    }
}

/**
 * Search the web using Google Custom Search JSON API.
 * @param {string} query - The search query.
 * @returns {Promise<array>} - List of results [{title, link, snippet}].
 */
async function googleSearch(query) {
    if (!initGoogleSearch()) {
        console.log("[GoogleSearch] Search disabled or not configured. Returning empty list.");
        return [];
    }

    try {
        const res = await customSearch.cse.list({
            cx: process.env.GOOGLE_SEARCH_CX,
            q: query,
            auth: process.env.GOOGLE_SEARCH_API_KEY,
            num: 5 // Default to top 5
        });

        if (res.data.items) {
            return res.data.items.map(item => ({
                title: item.title,
                link: item.link,
                snippet: item.snippet
            }));
        }
        return [];
    } catch (error) {
        console.error("Google Search API Error:", error.message);
        return [];
    }
}

module.exports = { askGemini, googleSearch };
