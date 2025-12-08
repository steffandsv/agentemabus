const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

async function scrapeGeneric(page, url) {
    try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

        const data = await page.evaluate(() => {
            // Get meta description
            const metaDesc = document.querySelector('meta[name="description"]')?.content ||
                             document.querySelector('meta[property="og:description"]')?.content || "";

            // Get title
            const title = document.title || "";

            // Get body text (limit length)
            const bodyText = document.body.innerText.slice(0, 15000);

            // Try to find price (simple heuristic)
            let price = 0;
            const priceRegex = /R\$\s?[\d.,]+/;
            const match = document.body.innerText.match(priceRegex);
            if (match) {
                try {
                    price = parseFloat(match[0].replace('R$', '').replace(/\./g, '').replace(',', '.').trim());
                } catch (e) {}
            }

            return {
                title,
                description: metaDesc,
                text: bodyText,
                price
            };
        });

        return {
            title: data.title,
            description: (data.description + "\n" + data.text).trim(), // Combine for AI
            price: data.price
        };

    } catch (e) {
        console.error(`Generic Scrape Error ${url}: ${e.message}`);
        return { title: '', description: '', price: 0 };
    }
}

module.exports = { scrapeGeneric };
