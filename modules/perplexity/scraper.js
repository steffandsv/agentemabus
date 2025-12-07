const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

async function scrapeGeneric(page, url) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        // Basic extraction
        const data = await page.evaluate(() => {
            // Remove scripts, styles
            document.querySelectorAll('script, style, nav, footer, header').forEach(e => e.remove());

            // Get text
            const text = document.body.innerText.substring(0, 5000); // Limit

            // Try to find price
            // Regex for price R$ ...
            const priceRegex = /R\$\s?([\d.,]+)/;
            const priceMatch = document.body.innerText.match(priceRegex);
            let price = 0;
            if (priceMatch) {
                price = parseFloat(priceMatch[1].replace(/\./g, '').replace(',', '.'));
            }

            return {
                text: text,
                price: price,
                title: document.title
            };
        });

        return data;
    } catch (e) {
        console.error(`Generic scrape failed for ${url}:`, e.message);
        return { text: "", price: 0, title: "Error" };
    }
}

module.exports = { scrapeGeneric };
