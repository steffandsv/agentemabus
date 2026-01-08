const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const fs = require('fs');
const path = require('path');

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

    // Cookie Loading
    const cookiePath = path.resolve('cookies.json');
    if (fs.existsSync(cookiePath)) {
        try {
            const cookiesString = fs.readFileSync(cookiePath, 'utf8');
            if (cookiesString && cookiesString.trim()) {
                const cookies = JSON.parse(cookiesString);
                console.log(`[Scraper] Loading ${cookies.length} cookies from ${cookiePath}...`);
                await page.setCookie(...cookies);
            }
        } catch (e) {
            console.error(`[Scraper] Failed to parse cookies.json: ${e.message}`);
        }
    }

    try {
        await page.goto('https://www.mercadolivre.com.br/', { waitUntil: 'networkidle2' });

        if (await checkForBlock(page)) {
            console.error("[Scraper] BLOCK DETECTED immediately after load.");
            throw new Error("BLOCKED_BY_PORTAL");
        }

        // Try standard address selector (usually top bar)
        let addressSelector = '.nav-menu-cp';
        let addressEl = await page.$(addressSelector);

        // If not found, try finding by text or aria-label (ML changes classes often)
        if (!addressEl) {
             console.log('[Scraper] Standard CEP selector not found. Trying fallback...');
             // Sometimes it's a link with text like "Informe seu CEP" or address pin icon
             const link = await page.evaluateHandle(() => {
                 const anchors = Array.from(document.querySelectorAll('a'));
                 return anchors.find(a => a.innerText.includes('Informe seu CEP') || a.innerText.includes('Enviar para')) || null;
             });
             if (link) addressEl = link;
        }

        if (addressEl) {
           await addressEl.click();
           await new Promise(r => setTimeout(r, 1500)); // Wait for modal
        }

        // Input Logic inside Modal
        // ML Modal usually has an iframe or shadow DOM, but Puppeteer handles frames transparently often if not nested weirdly.
        // The input name is usually 'zipcode' or similar.

        const inputSelector = 'input[name="zipcode"]';
        try {
            await page.waitForSelector(inputSelector, { timeout: 5000 });

            // Clear input first
            await page.click(inputSelector);
            await page.keyboard.down('Control');
            await page.keyboard.press('A');
            await page.keyboard.up('Control');
            await page.keyboard.press('Backspace');

            await page.type(inputSelector, cep, { delay: 150 });
            await new Promise(r => setTimeout(r, 500));

            // Press "Usar" or "Salvar" button
            // Usually type Enter works
            await page.keyboard.press('Enter');

            // Wait for reload or modal close
            await new Promise(r => setTimeout(r, 3000));
            console.log('[Scraper] CEP input submitted.');

        } catch (e) {
            console.log('[Scraper] CEP input field skipped or not found (maybe already set?).');
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
    return [
        {
            title: `${query} - Modelo Avançado (MOCK)`,
            price: 150.00,
            link: 'http://mock-link.com/item1',
            isFull: true,
            isInternational: false,
            condition: 'new'
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

            // Check condition (New/Used)
            // Usually implicit "Used" tag exists. If not present, assume New.
            // Improved Condition Check
            let condition = 'new';
            const conditionEl = card.querySelector('.ui-search-item__group__element.ui-search-item__condition');
            if (conditionEl) {
                const text = conditionEl.innerText.toLowerCase();
                if (text.includes('usado')) condition = 'used';
                if (text.includes('recondicionado')) condition = 'refurbished';
            }

            // Also check title for keywords
            const titleText = titleEl ? titleEl.innerText.toLowerCase() : '';
            if (titleText.includes('usado') || titleText.includes('recondicionado') || titleText.includes('seminovo')) {
                condition = 'used';
            }

            if (titleEl && priceEl && linkEl) {
                items.push({
                    title: titleEl.innerText,
                    price: parseFloat(priceEl.innerText.replace(/\./g, '').replace(',', '.')),
                    link: linkEl.href,
                    image: imageEl ? (imageEl.dataset.src || imageEl.src) : null,
                    isFull: isFull,
                    isInternational: isInternational,
                    condition: condition
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

    // Force new items only using filter if possible, or just default search and filter later.
    // _ItemTypeID_2230284 = Novo? No, dynamic.
    // Better to filter post-scrape or add "novo" to query?
    // Let's filter in `scrapeCurrentPage` and here.

    const searchUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(query)}_Ord_PRICE_ASC_ITEM*CONDITION_2230284`; // Try forcing NEW condition via URL param if standard?
    // Actually simpler: `_Condition_2230284` is unstable.
    // Let's just search and filter `condition === 'new'`.

    const simpleUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(query)}_Ord_PRICE_ASC`;

    let allResults = [];

    try {
        await page.goto(simpleUrl, { waitUntil: 'networkidle2' });
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

        // Filter Used & Refurbished
        results = results.filter(r => r.condition === 'new');

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

                 let page2Results = await scrapeCurrentPage(page);
                 page2Results = page2Results.filter(r => r.condition === 'new');

                 console.log(`[Scraper] Page 2 found ${page2Results.length} new items.`);
                 allResults = [...allResults, ...page2Results];
             }
        }

        console.log(`[Scraper] Total NEW items found for "${query}": ${allResults.length}`);
        return allResults;

    } catch (e) {
        if (e.message === 'BLOCKED_BY_PORTAL') throw e;
        console.error('[Scraper] Scraping error:', e.message);
        return allResults;
    }
}

async function getProductDetails(page, url) {
    if (url.includes('mock-link') || process.env.MOCK_SCRAPER === 'true') {
        return { shippingCost: 15.50, attributes: {}, description: "Mock desc" };
    }

    try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        await simulateHumanInteraction(page);

        if (await checkForBlock(page)) {
             console.error('[Scraper] BLOCKED on Product Page.');
             throw new Error("BLOCKED_BY_PORTAL");
        }

        // Lazy Load: Scroll to bottom to trigger scripts
        await page.evaluate(async () => {
            await new Promise((resolve) => {
                let totalHeight = 0;
                const distance = 100;
                const timer = setInterval(() => {
                    const scrollHeight = document.body.scrollHeight;
                    window.scrollBy(0, distance);
                    totalHeight += distance;

                    if (totalHeight >= scrollHeight - window.innerHeight) {
                        clearInterval(timer);
                        resolve();
                    }
                }, 100);
            });
        });
        // Wait a bit for lazy elements
        await new Promise(r => setTimeout(r, 1000));

        // Shipping Logic
        let shippingCost = 0;
        let shippingText = "";

        const freeShipping = await page.evaluate(() => {
            const bodyText = document.body.innerText;
            return bodyText.includes('Frete grátis') || bodyText.includes('Chegará grátis');
        });

        if (!freeShipping) {
            // Click to see options if needed
            // Selector: .ui-pdp-action-modal or .ui-pdp-shipping__action
            // Or look for text "Ver mais formas de entrega"
            try {
                const shippingTrigger = await page.$('.ui-pdp-media__action.ui-pdp-shipping__action, .ui-pdp-action-modal__link');
                if (shippingTrigger) {
                    await shippingTrigger.click();
                    await new Promise(r => setTimeout(r, 2000)); // Wait for modal

                    // Extract lowest price from modal
                    // .andes-money-amount inside modal
                    const lowestPrice = await page.evaluate(() => {
                        const prices = [];
                        // Look inside the modal container
                        const modal = document.querySelector('.andes-modal') || document.body;
                        const amounts = modal.querySelectorAll('.andes-money-amount__fraction');
                        amounts.forEach(el => {
                            // Filter out the product price if visible (usually shipping is smaller)
                            // Better heuristic: look for shipping specific classes or context
                            // But usually modal only shows shipping options.
                            const val = parseFloat(el.innerText.replace(/\./g, '').replace(',', '.'));
                            if (!isNaN(val)) prices.push(val);
                        });
                        return prices.length > 0 ? Math.min(...prices) : 0;
                    });

                    if (lowestPrice > 0) shippingCost = lowestPrice;

                    // Close modal (Escape)
                    await page.keyboard.press('Escape');
                    await new Promise(r => setTimeout(r, 500));
                } else {
                    // Try parsing text on main page if no modal link
                    const priceText = await page.evaluate(() => {
                        const el = document.querySelector('[class*="shipping"] .andes-money-amount__fraction');
                        return el ? el.innerText : null;
                    });
                    if (priceText) {
                        shippingCost = parseFloat(priceText.replace(/\./g, '').replace(',', '.'));
                    }
                }
            } catch (e) {
                console.log(`[Scraper] Failed to extract complex shipping: ${e.message}`);
            }
        }

        // Attributes & Description & JSON-LD
        const data = await page.evaluate(() => {
            const getJsonLd = () => {
                const scripts = document.querySelectorAll('script[type="application/ld+json"]');
                for (const script of scripts) {
                    try {
                        const json = JSON.parse(script.innerText);
                        // Look for Product type
                        if (json['@type'] === 'Product') {
                            return {
                                gtin: json.gtin || json.gtin13 || json.gtin14 || null,
                                mpn: json.mpn || json.sku || null,
                                brand: json.brand?.name || null,
                                model: json.model || null,
                                condition: json.offers?.itemCondition || null,
                                price_ld: json.offers?.price || null
                            };
                        }
                    } catch (e) { continue; }
                }
                return {};
            };

            const attrs = {};
            // Strategy 1: Highlighted specs (often hidden in stripes)
            document.querySelectorAll('.ui-vpp-highlighted-specs__striped-specs .ui-vpp-highlighted-specs__striped-specs__row').forEach(row => {
                const key = row.querySelector('.ui-vpp-highlighted-specs__striped-specs__row__key')?.innerText.trim();
                const value = row.querySelector('.ui-vpp-highlighted-specs__striped-specs__row__value')?.innerText.trim();
                if (key && value) attrs[key] = value;
            });

            // Strategy 2: Table specs
            document.querySelectorAll('.ui-pdp-specs__table tr').forEach(row => {
                const key = row.querySelector('th')?.innerText.trim();
                const value = row.querySelector('td')?.innerText.trim();
                if (key && value) attrs[key] = value;
            });

            const jsonLd = getJsonLd();
            // Merge JSON-LD into specs
            if (jsonLd.gtin) attrs['GTIN'] = jsonLd.gtin;
            if (jsonLd.mpn) attrs['MPN'] = jsonLd.mpn;
            if (jsonLd.brand) attrs['Brand'] = jsonLd.brand;
            if (jsonLd.model) attrs['Model'] = jsonLd.model;
            if (jsonLd.condition) attrs['Condition'] = jsonLd.condition;

            const descEl = document.querySelector('.ui-pdp-description__content');
            const description = descEl ? descEl.innerText.trim() : "";

            // Seller Reputation Extraction
            const getSellerReputation = () => {
                const sellerHeader = document.querySelector('.ui-pdp-seller__header__title');
                if (sellerHeader && sellerHeader.innerText.includes('Loja oficial')) {
                    return 'platinum'; // Official Store is high trust
                }

                const medals = document.querySelectorAll('.ui-seller-info .ui-pdp-seller__reputation-info [class*="ui-pdp-seller__medal"]');
                for (const m of medals) {
                    const cl = m.className;
                    if (cl.includes('platinum')) return 'platinum';
                    if (cl.includes('gold')) return 'gold';
                    if (cl.includes('silver')) return 'silver'; // Does Silver exist on ML? Usually Platinum/Gold/Leader.
                }

                // If no medal, check thermometer level
                const thermometer = document.querySelectorAll('.ui-seller-info .ui-thermometer li');
                // The levels are 1 to 5. The active one has a class or style.
                // ML often puts 'ui-thermometer__level--active'
                let level = 0;
                thermometer.forEach((li, index) => {
                    if (li.className.includes('active') || li.getAttribute('class').includes('active')) {
                        level = index + 1;
                    }
                });

                if (level === 5) return 'green'; // Good
                if (level >= 3) return 'yellow';
                return 'red'; // Low rep
            };

            return {
                attrs,
                description,
                gtin: jsonLd.gtin,
                mpn: jsonLd.mpn,
                brand: jsonLd.brand,
                model: jsonLd.model,
                condition: jsonLd.condition,
                seller_reputation: getSellerReputation()
            };
        });

        return {
            attributes: data.attrs,
            description: data.description,
            shippingCost,
            gtin: data.gtin,
            mpn: data.mpn,
            brand: data.brand,
            model: data.model,
            condition: data.condition,
            seller_reputation: data.seller_reputation
        };
    } catch (e) {
        if (e.message === 'BLOCKED_BY_PORTAL') throw e;
        return { attributes: {}, description: "", shippingCost: 0 };
    }
}

module.exports = { initBrowser, setCEP, searchAndScrape, getProductDetails };
