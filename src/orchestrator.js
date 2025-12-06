const pLimit = require('p-limit');
const { readInput } = require('./input');
const { writeOutput } = require('./output');
const { initBrowser, setCEP, sniperScrape } = require('./scraper');
const { findBestModels } = require('./discovery');

async function main() {
    console.log('=== Ultimate Quotation System (Discovery -> Sniper) ===');

    const cep = process.argv[2] || '01001-000'; // Default CEP if not provided
    const csvPath = process.argv[3] || 'itens.csv';

    // 1. Load Items
    let items;
    try {
        items = await readInput(csvPath);
        console.log(`Loaded ${items.length} items to process.`);
    } catch (e) {
        console.error('Failed to read input CSV:', e);
        process.exit(1);
    }

    // 2. Initialize Browser (Single Instance for now, or per thread if needed?)
    // Puppeteer is not thread-safe if we share the same page, but we can share the browser.
    // However, for "12 threads", sharing one browser instance might be a bottleneck or crashy.
    // Best practice: One browser, multiple pages (contexts).
    const browser = await initBrowser();

    // Set CEP globally for the session (cookie sharing)
    // Actually, each new page might need cookies. Let's handle CEP per page if needed,
    // or set it on a "master" page and hope cookies persist to others?
    // Puppeteer cookies are usually per-context. If we use default context, they persist.
    const masterPage = await browser.newPage();
    await setCEP(masterPage, cep);
    await masterPage.close();
    // Cookies should be stored in the browser context now.

    // 3. Concurrency Limit (12 threads)
    const limit = pLimit(12);

    const tasks = items.map(item => limit(async () => {
        const id = item.ID || item.id;
        const description = item.Descricao || item.Description || item.description;

        console.log(`\n[Job ${id}] Starting processing...`);

        // Phase 1: Discovery
        const models = await findBestModels(description);

        // Phase 2: Sniper Scrape (Try models in order)
        let bestCandidate = null;
        const page = await browser.newPage(); // New tab for this task

        try {
            for (const model of models) {
                const result = await sniperScrape(page, model, description, cep);
                if (result) {
                    bestCandidate = result;
                    break; // Stop if we found a good match
                }
            }
        } catch (e) {
            console.error(`[Job ${id}] Error during scraping:`, e);
        } finally {
            await page.close(); // Close tab to free memory
        }

        return {
            id,
            description,
            result: bestCandidate,
            models_tried: models
        };
    }));

    // 4. Execute All
    const results = await Promise.all(tasks);

    // 5. Output
    console.log('\nAll jobs finished. Writing results...');
    await writeOutput(results, 'planilha-modelo.xlsx'); // Now writing to Excel directly

    console.log('Done.');
    await browser.close();
}

main();
