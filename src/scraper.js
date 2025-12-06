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
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/121.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:109.0) Gecko/20100101 Firefox/121.0'
];

function getRandomUserAgent() {
    return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function getProxies() {
    const proxyPath = path.resolve('proxies.txt');
    if (!fs.existsSync(proxyPath)) return [];
    
    try {
        const content = fs.readFileSync(proxyPath, 'utf-8');
        return content.split('\n')
            .map(line => line.trim())
            .filter(line => line && !line.startsWith('#'));
    } catch (e) {
        console.error('Error reading proxies.txt:', e);
        return [];
    }
}

function getRandomProxy(proxies) {
    if (!proxies || proxies.length === 0) return null;
    return proxies[Math.floor(Math.random() * proxies.length)];
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

    // Proxy Configuration
    // Priority: 1. proxies.txt (Random), 2. PROXY_URL env, 3. None
    const fileProxies = getProxies();
    let proxy = getRandomProxy(fileProxies);
    
    if (!proxy) {
        // Fallback to ENV
        proxy = process.env.PROXY_URL || process.env.HTTP_PROXY || process.env.http_proxy;
    }

    if (proxy) {
        console.log(`Using Proxy: ${proxy}`);
        args.push(`--proxy-server=${proxy}`);
    }

    const browser = await puppeteer.launch({
        headless: true, // Use standard headless
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || puppeteer.executablePath(),
        args: args
    });
    return browser;
}

// --- Human Simulation ---

async function simulateHumanInteraction(page) {
    try {
        // Random Mouse Movements
        await page.mouse.move(
            Math.floor(Math.random() * 500), 
            Math.floor(Math.random() * 500)
        );
        await new Promise(r => setTimeout(r, Math.random() * 500 + 200));
        
        await page.mouse.move(
            Math.floor(Math.random() * 500) + 100, 
            Math.floor(Math.random() * 500) + 100
        );

        // Small scroll
        await page.evaluate(() => {
            window.scrollBy(0, window.innerHeight / 2);
        });
        await new Promise(r => setTimeout(r, Math.random() * 1000 + 500));

    } catch (e) {
        // Ignore errors during simulation (e.g. page closed)
    }
}

async function setCEP(page, cep) {
    console.log(`Setting CEP to: ${cep}`);
    
    await page.setUserAgent(getRandomUserAgent());

    // Load cookies
    try {
        if (fs.existsSync('cookies.json')) {
            const cookiesString = fs.readFileSync('cookies.json');
            let cookies = JSON.parse(cookiesString);
            
            // Sanitize cookies (Fix ProtocolError)
            cookies = cookies.map(cookie => {
                const { partitionKey, ...rest } = cookie;
                return rest;
            });

            await page.setCookie(...cookies);
            console.log('Cookies loaded from cookies.json (sanitized)');
        }
    } catch (e) {
        console.warn('Failed to load cookies:', e);
    }

    // Mock mode
    if (process.env.MOCK_SCRAPER === 'true') {
        console.log('MOCK_SCRAPER is true. Skipping actual navigation.');
        return;
    }

    try {
        await page.goto('https://www.mercadolivre.com.br/', { waitUntil: 'networkidle2' });
        await simulateHumanInteraction(page);

        // Check for block
        if (await checkForBlock(page)) {
            console.error('IP Blocked detected during CEP setting.');
            return;
        }

        const addressSelector = '.nav-menu-cp'; 
        if (await page.$(addressSelector) !== null) {
           await page.click(addressSelector);
           await new Promise(r => setTimeout(r, 1000)); // Pause
        }

        try {
            await page.waitForSelector('input[name="zipcode"]', { timeout: 5000 });
            await page.type('input[name="zipcode"]', cep, { delay: 100 }); // Typing delay
            await new Promise(r => setTimeout(r, 500));
            await page.keyboard.press('Enter');
            await page.waitForNavigation({ waitUntil: 'networkidle2' }).catch(() => {});
            console.log('CEP set successfully.');
        } catch (e) {
            console.log('CEP input not found or not required immediately.');
        }

    } catch (error) {
        console.error('Error setting CEP:', error);
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

async function searchAndScrape(page, query) {
    console.log(`Searching for: ${query}`);
    
    await page.setUserAgent(getRandomUserAgent());

    if (process.env.MOCK_SCRAPER === 'true') {
        return getMockResults(query);
    }

    const searchUrl = `https://lista.mercadolivre.com.br/${encodeURIComponent(query)}`;
    
    try {
        await page.goto(searchUrl, { waitUntil: 'networkidle2' });
        await simulateHumanInteraction(page);

        if (await checkForBlock(page)) {
            console.warn('BLOCKED: Mercado Livre detected suspicious traffic.');
            return getMockResults(query); // Fallback
        }

        // Handle Cookies banner
        const cookieBtn = await page.$('button[data-testid="action:understood-button"]');
        if (cookieBtn) {
            await cookieBtn.click();
            await new Promise(r => setTimeout(r, 500));
        }

        await autoScroll(page);

        // Extract
        const results = await page.evaluate(() => {
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

        if (results.length === 0) {
            console.log('No results found. Taking screenshot...');
            const safeQuery = query.replace(/[^a-zA-Z0-9]/g, '_');
            const logDir = 'logs';
            if (!fs.existsSync(logDir)) fs.mkdirSync(logDir);
            await page.screenshot({ path: path.join(logDir, `debug_${safeQuery}.png`) });
        }

        return results;

    } catch (e) {
        console.error('Scraping error:', e);
        return [];
    }
}

function getMockResults(query) {
    console.log('Returning MOCK results.');
    return [
        {
            title: `${query} - Modelo Avançado 2024 (MOCK)`,
            price: 150.00,
            link: 'http://mock-link.com/item1',
            image: 'http://mock-link.com/img1.jpg',
            isFull: true,
            isInternational: false
        },
        {
            title: `${query} - Custo Benefício (MOCK)`,
            price: 99.90,
            link: 'http://mock-link.com/item2',
            image: 'http://mock-link.com/img2.jpg',
            isFull: false,
            isInternational: false
        },
        {
            title: `${query} - Kit Completo (MOCK)`,
            price: 199.50,
            link: 'http://mock-link.com/item3',
            image: 'http://mock-link.com/img3.jpg',
            isFull: true,
            isInternational: false
        }
    ];
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
            }, 100 + Math.random() * 100); // Variable scroll speed
        });
    });
}

async function getProductDetails(page, url, cep) {
    // Mock check
    if (url.includes('mock-link') || process.env.MOCK_SCRAPER === 'true') {
        return {
            shippingCost: 15.50,
            attributes: { 'Marca': 'MockBrand', 'Modelo': 'X-1000' },
            description: "Descrição simulada do produto."
        };
    }

    try {
        await page.setUserAgent(getRandomUserAgent());
        await page.goto(url, { waitUntil: 'domcontentloaded' }); 
        await simulateHumanInteraction(page);
        
        if (await checkForBlock(page)) {
             console.warn('BLOCKED on Product Page.');
             return {
                shippingCost: 0,
                attributes: { 'Status': 'Blocked' },
                description: "Bloqueado."
            };
        }

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
                 if (match) {
                     shippingCost = parseFloat(match[1].replace(/\./g, '').replace(',', '.'));
                 }
            }
        }
        
        const attributes = await page.evaluate(() => {
             const attrs = {};
             const specsTable = document.querySelector('section.ui-pdp-specs');
             if (specsTable) {
                 specsTable.querySelectorAll('tr').forEach(row => {
                    const th = row.querySelector('th');
                    const td = row.querySelector('td');
                    if (th && td) {
                        attrs[th.innerText.trim()] = td.innerText.trim();
                    }
                 });
             }
             return attrs;
        });

        const description = await page.evaluate(() => {
            const descEl = document.querySelector('.ui-pdp-description__content');
            return descEl ? descEl.innerText.trim() : "";
        });

        return {
            shippingCost,
            attributes,
            description
        };

    } catch (e) {
        console.error(`Error getting details for ${url}:`, e);
        return { shippingCost: 0, attributes: {}, description: "" };
    }
}

module.exports = { initBrowser, setCEP, searchAndScrape, getProductDetails };
