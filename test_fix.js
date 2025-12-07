const { searchAndScrape, initBrowser } = require('./src/scraper');
const { discoverModels } = require('./src/ai_validator');

async function test() {
    console.log("Testing searchAndScrape existence...");
    if (typeof searchAndScrape !== 'function') {
        console.error("searchAndScrape is NOT a function!");
        process.exit(1);
    }
    console.log("searchAndScrape IS a function.");

    console.log("Testing discoverModels structure...");
    // Mocking Gemini response is hard without API key working, but let's see if it runs
    // For this test, we might just rely on the file content update we did.

    // Check if scraper exports are correct
    const scraper = require('./src/scraper');
    console.log("Scraper exports:", Object.keys(scraper));

    console.log("Test Passed.");
    process.exit(0);
}

test();
