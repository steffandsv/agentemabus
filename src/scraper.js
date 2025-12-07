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

    // Cookie Loading & Validation
    const cookiePath = path.resolve('cookies.json');
    if (fs.existsSync(cookiePath)) {
        try {
            const cookiesString = fs.readFileSync(cookiePath, 'utf8');
            if (cookiesString && cookiesString.trim()) {
                const cookies = JSON.parse(cookiesString);
                console.log(`[Scraper] Loading ${cookies.length} cookies from ${cookiePath}...`);

                await page.setCookie(...cookies);
                console.log(`[Scraper] Cookies successfully loaded into browser context.`);
            } else {
                console.warn(`[Scraper] Warning: cookies.json is empty.`);
            }
        } catch (e) {
            console.error(`[Scraper] CRITICAL: Failed to parse cookies.json: ${e.message}`);
        }
    } else {
        console.warn(`[Scraper] Warning: cookies.json not found! Scraper might be blocked.`);
    }

    try {
        await page.goto('https://www.mercadolivre.com.br/', { waitUntil: 'networkidle2' });

        if (await checkForBlock(page)) {
            const msg = "[Scraper] BLOCK DETECTED immediately after load. Aborting.";
            console.error(msg);
            throw new Error("BLOCKED_BY_PORTAL");
        }

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
        if (error.message === 'BLOCKED_BY_PORTAL') throw error;
        console.error('[Scraper] Error setting CEP:', error.message);
    }
}

async function checkForBlock(page) {
    try {
        const pageTitle = await page.title();
        const content = await page.content();

        if (pageTitle === 'Mercado Livre' &&
           (content.includes('suspicious-traffic-frontend') ||
            content.includes('Olá! Para continuar, acesse') ||
            content.includes('403 Forbidden'))) {
            return true;
        }
        return false;
    } catch (e) {
        return false;
    }
}

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                const scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;

                if (totalHeight >= scrollHeight - window.innerHeight || totalHeight > 5000) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100 + Math.random() * 100);
        });
    });
}

function getMockResults(query) {
    console.log('Returning MOCK results.');
    return [
        {
            title: `${query} - Modelo Avançado (MOCK)`,
            price: 150.00,
            link: 'http://mock-link.com/item1',
            isFull: true,
            isInternational: false
        }
    ];
}

async function scrapeCurrentPage(page) {
    return page.evaluate(() => {
        const items = [];
        const productCards = document.querySelectorAll('li.ui-search-layout__item');
        const listItems = document.querySelectorAll('.ui-search-result__content');
        const cards = productCards.length > 0 ? productCards : listItems;

        cards.forEach(card => {
            let titleEl = card.querySelector('.poly-component__title');
            let linkEl = titleEl;

            if (!titleEl) {
                titleEl = card.querySelector('h2.ui-search-item__title') || card.querySelector('.ui-search-item__title');
                linkEl = card.querySelector('a.ui-search-link') || (titleEl ? titleEl.closest('a') : null) || card.querySelector('a');
            }

            let priceEl = card.querySelector('.poly-price__current .andes-money-amount__fraction');
            if (!priceEl) {
                priceEl = card.querySelector('.ui-search-price__second-line .andes-money-amount__fraction') ||
                          card.querySelector('span.andes-money-amount__fraction');
            }

            const imageEl = card.querySelector('img.poly-component__picture') || card.querySelector('img');
            const isFull = !!(card.querySelector('.poly-component__shipped-from svg[aria-label="FULL"]') || card.querySelector('.ui-search-item__fulfillment'));
            const isInternational = (card.innerText || "").includes('Compra Internacional');

            if (titleEl && priceEl && linkEl) {
                items.push({
                    title: titleEl.innerText,
                    price: parseFloat(priceEl.innerText.replace(/\./g, '').replace(',', '.')),
                    link: linkEl.href,
                    image: imageEl ? (imageEl.dataset.src || imageEl.src) : null,
                    isFull: isFull,
                    isInternational: isInternational
                });
            }
        });
        return items;
    });
}

/**
 * Searches and scrapes a list of products.
 * Supports pagination (up to 2 pages).
 */
async function searchAndScrape(page, query) {
    console.log(`[Scraper] Searching for: ${query}`);

    await page.setUserAgent(getRandomUserAgent());

    if (process.env.MOCK_SCRAPER === 'true') {
        return getMockResults(query);
    }

    const searchUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(query)}_Ord_PRICE_ASC`;

    let allResults = [];

    try {
        // Page 1
        await page.goto(searchUrl, { waitUntil: 'networkidle2' });
        await simulateHumanInteraction(page);

        if (await checkForBlock(page)) {
            console.error('[Scraper] BLOCKED detected on search page.');
            throw new Error("BLOCKED_BY_PORTAL");
        }

        const cookieBtn = await page.$('button[data-testid="action:understood-button"]');
        if (cookieBtn) {
            await cookieBtn.click();
            await new Promise(r => setTimeout(r, 500));
        }

        await autoScroll(page);

        let results = await scrapeCurrentPage(page);
        allResults = [...allResults, ...results];

        // Page 2 Check
        if (allResults.length < 40) {
             console.log('[Scraper] Checking next page...');
             const nextButton = await page.$('a.andes-pagination__link[title="Seguinte"]');
             if (nextButton) {
                 await nextButton.click();
                 await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
                 await simulateHumanInteraction(page);
                 await autoScroll(page);

                 const page2Results = await scrapeCurrentPage(page);
                 console.log(`[Scraper] Page 2 found ${page2Results.length} items.`);
                 allResults = [...allResults, ...page2Results];
             }
        }

        console.log(`[Scraper] Total items found for "${query}": ${allResults.length}`);
        return allResults;

    } catch (e) {
        if (e.message === 'BLOCKED_BY_PORTAL') throw e;
        console.error('[Scraper] Scraping error:', e.message);
        return allResults;
    }
}

/**
 * Executes the "Sniper" logic: Search specific model -> Scrape cheapest -> Validate.
 * Stops as soon as a perfect match (Score 0) is found.
 */
async function sniperScrape(page, modelQuery, originalDescription, cep) {
    console.log(`[Sniper] Hunting for model: "${modelQuery}"`);
    // This function can reuse searchAndScrape logic partially but it has specific "stop on first match" logic.
    // For now, I'm keeping it as it was but maybe using searchAndScrape inside could be cleaner?
    // Let's leave it independent to avoid breaking orchestrator if it relies on specific behavior.

    // Actually, let's keep the original implementation but maybe fix imports/deps if any.
    // It calls getProductDetails and validateProductWithAI.
    
    const searchUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(modelQuery)}_Ord_PRICE_ASC`; // Force sort by price
    
    try {
        await page.goto(searchUrl, { waitUntil: 'networkidle2' });
        await simulateHumanInteraction(page);

        // Extract basic results (Simplified version of searchAndScrape)
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

        const chunkSize = 3;
        for (let i = 0; i < candidates.length; i += chunkSize) {
            const chunk = candidates.slice(i, i + chunkSize);
            for (const candidate of chunk) {
                const details = await getProductDetails(page, candidate.link);
                candidate.attributes = details.attributes;
                candidate.description = details.description;
                candidate.shippingCost = details.shippingCost;
                candidate.totalPrice = candidate.price + candidate.shippingCost;

                const validation = await validateProductWithAI(originalDescription, candidate);

                candidate.aiMatch = validation.status;
                candidate.risk_score = validation.risk_score;
                candidate.reasoning = validation.reasoning;
                candidate.brand_model = validation.brand_model;

                if (candidate.risk_score === 0) {
                    console.log(`[Sniper] 🎯 PERFECT MATCH FOUND!`);
                    return candidate;
                }
                if (candidate.risk_score <= 3) return candidate;
            }
        }
        return null;
    } catch (e) {
        console.error('[Sniper] Error:', e.message);
        return null;
    }
}

async function getProductDetails(page, url) {
    if (url.includes('mock-link') || process.env.MOCK_SCRAPER === 'true') {
        return {
            shippingCost: 15.50,
            attributes: { 'Marca': 'MockBrand', 'Modelo': 'X-1000' },
            description: "Descrição simulada do produto."
        };
    }

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await simulateHumanInteraction(page);

        if (await checkForBlock(page)) {
             console.error('[Scraper] BLOCKED on Product Page.');
             throw new Error("BLOCKED_BY_PORTAL");
        }
        
        // Shipping Logic
        let shippingCost = 0;
        const freeShipping = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            return bodyText.includes('Frete grátis') || bodyText.includes('Chegará grátis');
        });

        if (!freeShipping) {
            const shippingPriceText = await page.evaluate(() => {
                 const el = document.querySelector('.ui-pdp-media__price-subtext') ||
                            document.querySelector('[class*="shipping"] .andes-money-amount__fraction');
                 return el ? el.parentElement.innerText : null;
            });
            if (shippingPriceText) {
                 const match = shippingPriceText.match(/R\$\s?([\d.,]+)/);
                 if (match) shippingCost = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
            }
        }

        // Attributes & Description
        const data = await page.evaluate(() => {
            const attrs = {};
            document.querySelectorAll('section.ui-pdp-specs tr').forEach(row => {
                const th = row.querySelector('th');
                const td = row.querySelector('td');
                if (th && td) attrs[th.innerText.trim()] = td.innerText.trim();
            });
            
            const descEl = document.querySelector('.ui-pdp-description__content');
            const description = descEl ? descEl.innerText.trim() : "";
            return { attrs, description };
        });

        return { attributes: data.attrs, description: data.description, shippingCost };
    } catch (e) {
        if (e.message === 'BLOCKED_BY_PORTAL') throw e;
        // Generic detail error just returns empty
        return { attributes: {}, description: "", shippingCost: 0 };
    }
}

module.exports = { initBrowser, setCEP, sniperScrape, searchAndScrape, getProductDetails };
