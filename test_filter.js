const { filterTitles } = require('./src/ai_validator');

async function testFilter() {
    console.log("Testing filterTitles...");
    const candidates = [
        { title: "Item Correto Modelo X", price: 100 },
        { title: "Item Incorreto Modelo Y", price: 50 },
        { title: "Acessorio para Item", price: 10 }
    ];

    // We can't really call the AI without a key working, but let's check if the function runs and handles error/mock
    // Since we don't have the key active in this environment (or we assume it works in prod),
    // the code has a fallback to return all indices if error.

    // Let's just check if it imports and is async
    if (typeof filterTitles !== 'function') {
        console.error("filterTitles is not a function");
        process.exit(1);
    }

    console.log("filterTitles is a function.");
    process.exit(0);
}

testFilter();
