const { initDB, setSetting, getSetting } = require('./src/database');

(async () => {
    try {
        await initDB();
        console.log("Setting 'test_key' to 'hello world'...");
        await setSetting('test_key', 'hello world');

        console.log("Reading 'test_key'...");
        const val = await getSetting('test_key');
        console.log(`Value: ${val}`);

        if (val === 'hello world') {
            console.log("SUCCESS: Settings table working.");
        } else {
            console.error("FAILURE: Settings table returned wrong value.");
        }
        process.exit(0);
    } catch (e) {
        console.error("Test Failed:", e);
        process.exit(1);
    }
})();
