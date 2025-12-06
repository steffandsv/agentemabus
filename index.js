const { readInput } = require('./src/input');
const { parseDescription } = require('./src/parser');
const { initBrowser, setCEP, searchAndScrape, getProductDetails } = require('./src/scraper');
const { writeOutput } = require('./src/output');
const { generateSearchQuery, filterTitles, validateProductWithAI } = require('./src/ai_validator');
const readline = require('readline');

// Simple CLI interaction
const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
});

function askQuestion(query) {
    return new Promise(resolve => rl.question(query, resolve));
}

(async () => {
    console.log('=== Mercado Livre Auto-Quotation System ===');
    
    // 1. Get Inputs
    let cep = process.argv[2];
    let csvPath = process.argv[3];

    if (!cep) {
        cep = await askQuestion('Please enter the destination CEP (Zip Code): ');
    }
    
    if (!csvPath) {
        csvPath = await askQuestion('Enter path to CSV file (default: itens.csv): ');
        if (!csvPath) csvPath = 'itens.csv';
    }

    rl.close();

    console.log(`Starting process with CEP: ${cep} and File: ${csvPath}`);
    
    // 2. Read Input
    let items;
    try {
        items = await readInput(csvPath);
        console.log(`Loaded ${items.length} items.`);
    } catch (e) {
        console.error('Error reading CSV:', e);
        process.exit(1);
    }

    // 3. Init Browser
    const browser = await initBrowser();
    const page = await browser.newPage();
    
    // 4. Set CEP (Global for the session)
    await setCEP(page, cep);

    const finalResults = [];

    // 5. Process each item
    for (const item of items) {
        const id = item.ID || item.id;
        const description = item.Descricao || item.Description || item.description;
        
        console.log(`\n--------------------------------------------------`);
        console.log(`Processing Item ${id}: ${description.substring(0, 50)}...`);
        
        // --- STEP 1: Generate AI Search Query ---
        console.log(`[AI] Generating optimized search query...`);
        const searchQuery = await generateSearchQuery(description);
        console.log(`[AI] Query: "${searchQuery}"`);
        
        // --- STEP 2: Search & Scrape (Get ~40-50 results) ---
        let searchResults = await searchAndScrape(page, searchQuery);
        console.log(`[Scraper] Found ${searchResults.length} raw results.`);

        if (searchResults.length > 0) {
            // --- Price Optimization Logic ---
            // 1. Filter invalid prices
            searchResults = searchResults.filter(r => r.price && !isNaN(r.price) && r.price > 0);
            
            // 2. Sort by Price ASCENDING (Cheapest first)
            searchResults.sort((a, b) => a.price - b.price);
            
            // 3. Take the top 20 Cheapest items to check against AI
            // We focus on the cheapest chunk to ensure we find the best deal.
            const candidatesToCheck = searchResults.slice(0, 20);

            console.log(`[Logic] Sorted by price and sending top ${candidatesToCheck.length} cheapest items to AI filter.`);

            // --- STEP 3: AI Title Filtering ---
            const selectedIndices = await filterTitles(description, candidatesToCheck);
            
            // Map indices back to our chunk
            let selectedCandidates = selectedIndices
                .map(i => candidatesToCheck[i])
                .filter(item => item !== undefined);

            console.log(`[AI] Selected ${selectedCandidates.length} potential candidates from the cheapest list.`);

            // Limit to top 5 cheapest VALID candidates for detailed scraping
            const topCandidates = selectedCandidates.slice(0, 5); 
            
            // --- STEP 4: Detail Scraping & Final Validation ---
            for (const candidate of topCandidates) {
                console.log(`  > Checking details for: ${candidate.title.substring(0, 40)}... (R$ ${candidate.price})`);
                const details = await getProductDetails(page, candidate.link, cep);
                
                candidate.shippingCost = details.shippingCost;
                candidate.attributes = details.attributes;
                candidate.description = details.description;
                candidate.totalPrice = candidate.price + candidate.shippingCost;

                console.log(`    Validating with DeepSeek Reasoner...`);
                const aiResult = await validateProductWithAI(description, candidate);
                candidate.aiMatch = aiResult.match;
                candidate.aiReasoning = aiResult.reasoning;
            }

            // Final Sort: Prioritize Verified Matches by Price
            topCandidates.sort((a, b) => {
                if (a.aiMatch === b.aiMatch) {
                    return a.totalPrice - b.totalPrice;
                }
                return a.aiMatch ? -1 : 1;
            });
            
            finalResults.push({
                id,
                description,
                offers: topCandidates
            });
            
            console.log(`Selected ${topCandidates.length} offers for item ${id}.`);
        } else {
            console.log("No results found to process.");
            finalResults.push({ id, description, offers: [] });
        }
    }

    // 6. Output
    await writeOutput(finalResults, 'cotacao_final.csv');
    console.log('\nDone! Results written to cotacao_final.csv');

    await browser.close();
})();
