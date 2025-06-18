// test_connection.js
// A simple script to test the Browserless connection outside of Electron.

require('dotenv').config();
const { chromium } = require('playwright');

async function testConnection() {
    console.log("--- Starting Standalone Playwright Test ---");

    const browserlessApiKey = process.env.BROWSERLESS_API_KEY;
    const browserlessWssUrl = process.env.BROWSERLESS_WSS_URL;

    if (!browserlessApiKey || !browserlessWssUrl) {
        console.error("🚨 BROWSERLESS_API_KEY and BROWSERLESS_WSS_URL must be set in .env file.");
        return;
    }

    const endpoint = `${browserlessWssUrl}?token=${browserlessApiKey}`;
    let browser;

    try {
        console.log(`🔌 Attempting to connect to ${browserlessWssUrl}...`);
        browser = await chromium.connect(endpoint, { timeout: 30000 });
        console.log("✅✅✅ SUCCESS: Connection to Browserless.io established!");

        const context = await browser.newContext();
        const page = await context.newPage();
        await page.goto("https://www.google.com");
        console.log(`✅ Navigated to: ${await page.title()}`);
        
    } catch (error) {
        console.error("❌❌❌ FAILED: Could not connect to Browserless.io.");
        console.error(error);
    } finally {
        if (browser) {
            await browser.close();
            console.log("🔌 Connection closed.");
        }
        console.log("--- Test Finished ---");
    }
}

testConnection();