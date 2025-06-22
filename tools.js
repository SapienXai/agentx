// tools.js

const TavilyClient = require('@tavily/core').tavily;
const FirecrawlApp = require('@mendable/firecrawl-js').default;

const tavilyClient = new TavilyClient({
    apiKey: process.env.TAVILY_API_KEY
});

const firecrawl = new FirecrawlApp({
    apiKey: process.env.FIRECRAWL_API_KEY
});

/**
 * Performs a search using the Tavily API.
 * @param {string} query The search query.
 * @param {Function} onLog Logger function.
 * @returns {Promise<string>} A string containing the search results.
 */
async function tavilySearch(query, onLog = console.log) {
    onLog(`🔎 Performing Tavily search for: "${query}"`);
    try {
        const response = await tavilyClient.search(query, {
            search_depth: "advanced",
            max_results: 5,
        });
        return JSON.stringify(response.results, null, 2);
    } catch (error) {
        onLog(`🚨 Tavily search failed: ${error.message}`);
        throw new Error(`Tavily search failed: ${error.message}`);
    }
}

/**
 * Scrapes a URL using the Firecrawl API.
 * @param {string} url The URL to scrape.
 * @param {Function} onLog Logger function.
 * @returns {Promise<string>} The scraped content in Markdown format.
 */
async function firecrawlScrape(url, onLog = console.log) {
    onLog(`🔥 Performing Firecrawl scrape for: "${url}"`);
    try {
        // +++ THE DEFINITIVE FIX +++
        // The `pageOptions` key is deprecated. The options should be passed directly at the top level.
        const response = await firecrawl.scrapeUrl(url, {
            onlyMainContent: true
        });
        
        if (!response.data || !response.data.markdown) {
             throw new Error("Firecrawl did not return valid markdown content.");
        }

        return response.data.markdown;
    } catch (error) {
        onLog(`🚨 Firecrawl scrape failed: ${error.message}`);
        throw new Error(`Firecrawl scrape failed: ${error.message}`);
    }
}

module.exports = { tavilySearch, firecrawlScrape };