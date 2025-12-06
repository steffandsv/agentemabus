const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');
const { validateProductWithAI } = require('./ai_validator');

puppeteer.use(StealthPlugin());

// --- Helper Functions ---
const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
];

function getRandomUserAgent() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

// --- Browser Control ---
async function initBrowser() {
    const args = [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--window-size=1920,1080',
        '--disable-blink-features=AutomationControlled',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
    ];
    
    // Simple proxy support via env or file
    let proxy = process.env.PROXY_URL;
    if (proxy) args.push(`--proxy-server=${proxy}`);

    const browser = await puppeteer.launch({
        headless: true,
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
        args: args
    });
    return browser;
}

async function simulateHumanInteraction(page) {
    try {
        await page.mouse.move(Math.floor(Math.random()*500), Math.floor(Math.random()*500));
        await new Promise(r => setTimeout(r, Math.random() * 500 + 200));
    } catch(e) {}
}

async function setCEP(page, cep) {
    console.log(`[Scraper] Setting CEP: ${cep}`);
    try {
        await page.goto('https://www.mercadolivre.com.br/', { waitUntil: 'networkidle2' });

        const addressSelector = '.nav-menu-cp'; 
        if (await page.$(addressSelector) !== null) {
           await page.click(addressSelector);
           await new Promise(r => setTimeout(r, 1000));
        }

        try {
            await page.waitForSelector('input[name="zipcode"]', { timeout: 5000 });
            await page.type('input[name="zipcode"]', cep, { delay: 100 });
            await page.keyboard.press('Enter');
            await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
        } catch (e) {
            console.log('[Scraper] CEP input skipped or not found.');
        }
    } catch (error) {
        console.error('[Scraper] Error setting CEP:', error.message);
    }
}

/**
 * Executes the "Sniper" logic: Search specific model -> Scrape cheapest -> Validate.
 * Stops as soon as a perfect match (Score 0) is found.
 */
async function sniperScrape(page, modelQuery, originalDescription, cep) {
    console.log(`[Sniper] Hunting for model: "${modelQuery}"`);
    
    const searchUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(modelQuery)}_Ord_PRICE_ASC`; // Force sort by price
    
    try {
        await page.goto(searchUrl, { waitUntil: 'networkidle2' });
        await simulateHumanInteraction(page);

        // Extract basic results
        const candidates = await page.evaluate(() => {
            const items = [];
            const cards = document.querySelectorAll('li.ui-search-layout__item');
            cards.forEach(card => {
                const titleEl = card.querySelector('.poly-component__title') || card.querySelector('h2');
                const linkEl = card.querySelector('a.poly-component__title') || card.querySelector('a');
                const priceEl = card.querySelector('.poly-price__current .andes-money-amount__fraction') ||
                                card.querySelector('.ui-search-price__second-line .andes-money-amount__fraction');

                if (titleEl && linkEl && priceEl) {
                    items.push({
                        title: titleEl.innerText,
                        link: linkEl.href,
                        price: parseFloat(priceEl.innerText.replace(/\./g, '').replace(',', '.'))
                    });
                }
            });
            return items;
        });

        console.log(`[Sniper] Found ${candidates.length} candidates for "${modelQuery}".`);
        if (candidates.length === 0) return null;

        // Process in chunks of 3 to find the first valid one
        const chunkSize = 3;
        for (let i = 0; i < candidates.length; i += chunkSize) {
            const chunk = candidates.slice(i, i + chunkSize);
            console.log(`[Sniper] Checking candidates ${i+1} to ${i+chunk.length}...`);

            for (const candidate of chunk) {
                // Get details
                const details = await getProductDetails(page, candidate.link);
                candidate.attributes = details.attributes;
                candidate.description = details.description;
                candidate.shippingCost = details.shippingCost;
                candidate.totalPrice = candidate.price + candidate.shippingCost;

                // Validate
                console.log(`[Sniper] Validating: ${candidate.title.substring(0, 40)}...`);
                const validation = await validateProductWithAI(originalDescription, candidate);

                candidate.aiMatch = validation.match; // boolean or string? let's check validator
                candidate.risk_score = validation.risk_score;
                candidate.reasoning = validation.reasoning;
                candidate.brand_model = validation.brand_model;

                if (candidate.risk_score === 0) {
                    console.log(`[Sniper] 🎯 PERFECT MATCH FOUND! Stopping search for this item.`);
                    return candidate;
                }

                if (candidate.risk_score <= 3) {
                     console.log(`[Sniper] Good match (Risk ${candidate.risk_score}). Keeping as potential backup.`);
                     return candidate; // Return the first "good enough" if we want to speed up, or wait for 0?
                     // Strategy: Return first Risk <= 3.
                }
            }
        }

        return null; // No good match found in this model query

    } catch (e) {
        console.error('[Sniper] Error:', e.message);
        return null;
    }
}

async function getProductDetails(page, url) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        
        // Basic scraping logic (simplified from original)
        const details = await page.evaluate(() => {
            const attrs = {};
            document.querySelectorAll('section.ui-pdp-specs tr').forEach(row => {
                const th = row.querySelector('th');
                const td = row.querySelector('td');
                if (th && td) attrs[th.innerText.trim()] = td.innerText.trim();
            });
            
            const descEl = document.querySelector('.ui-pdp-description__content');
            const description = descEl ? descEl.innerText.trim() : "";

            // Shipping logic is complex, returning 0 for now or parsing simplified
            return { attributes: attrs, description: description, shippingCost: 0 };
        });
        return details;
    } catch (e) {
        return { attributes: {}, description: "", shippingCost: 0 };
    }
}

module.exports = { initBrowser, setCEP, sniperScrape, getProductDetails };
