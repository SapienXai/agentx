// tools.js

const TavilyClient = require('@tavily/core').tavily;
const FirecrawlApp = require('@mendable/firecrawl-js').default;

const tavilyClient = process.env.TAVILY_API_KEY
    ? new TavilyClient({ apiKey: process.env.TAVILY_API_KEY })
    : null;

const firecrawl = process.env.FIRECRAWL_API_KEY
    ? new FirecrawlApp({ apiKey: process.env.FIRECRAWL_API_KEY })
    : null;

let toolToggles = { tavily: false, firecrawl: false };

function setToolToggles(next) {
    toolToggles = {
        tavily: Boolean(next && next.tavily),
        firecrawl: Boolean(next && next.firecrawl),
    };
}

/**
 * Performs a search using the Tavily API.
 * @param {string} query The search query.
 * @param {Function} onLog Logger function.
 * @returns {Promise<string>} A string containing the search results.
 */
async function tavilySearch(query, onLog = console.log) {
    onLog(`🔎 Performing Tavily search for: "${query}"`);
    if (!toolToggles.tavily) {
        const message = 'Tavily is disabled in settings.';
        onLog(`🚨 ${message}`);
        throw new Error(message);
    }
    if (!tavilyClient) {
        const message = 'Tavily API key is missing. Set TAVILY_API_KEY to enable search.';
        onLog(`🚨 ${message}`);
        throw new Error(message);
    }
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
    if (!toolToggles.firecrawl) {
        const message = 'Firecrawl is disabled in settings.';
        onLog(`🚨 ${message}`);
        throw new Error(message);
    }
    if (!firecrawl) {
        const message = 'Firecrawl API key is missing. Set FIRECRAWL_API_KEY to enable scraping.';
        onLog(`🚨 ${message}`);
        throw new Error(message);
    }
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

module.exports = { tavilySearch, firecrawlScrape, setToolToggles };
