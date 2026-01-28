/**
 * HIVEMIND Scraper
 * Re-exports from gemini_meli scraper for marketplace operations
 */

const { 
    initBrowser, 
    setCEP, 
    searchAndScrape, 
    getProductDetails 
} = require('../gemini_meli/scraper');

module.exports = { 
    initBrowser, 
    setCEP, 
    searchAndScrape, 
    getProductDetails 
};
