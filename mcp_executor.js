// mcp_executor.js

const { createChromeDevtoolsMcpClient } = require('./mcp_client.js');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { createToolPlan, decideNextToolAction, summarizeText } = require('./agent_api.js');
const { tavilySearch, firecrawlScrape } = require('./tools.js');

const MAX_AGENT_STEPS = 25;
const MAX_ACTION_HISTORY = 10;
const MAX_AI_RETRIES = 3;
const AUTH_STATE_PATH = path.join(__dirname, 'auth_state.json');

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

function findTool(tools, patterns) {
    const list = tools?.tools || [];
    const regexes = patterns.map(p => new RegExp(p, 'i'));
    return list.find(tool => regexes.some(r => r.test(tool.name)));
}

function buildParams(tool, desired) {
    if (!tool || !tool.inputSchema || !tool.inputSchema.properties) return desired;
    const props = tool.inputSchema.properties;
    const params = {};

    const keyFor = (candidates) => candidates.find(k => Object.prototype.hasOwnProperty.call(props, k));

    const urlKey = keyFor(['url', 'targetUrl', 'href']);
    if (urlKey && desired.url) params[urlKey] = desired.url;

    const selectorKey = keyFor(['selector', 'cssSelector', 'query']);
    if (selectorKey && desired.selector) params[selectorKey] = desired.selector;

    const textKey = keyFor(['text', 'value', 'input', 'content']);
    if (textKey && desired.text !== undefined) params[textKey] = desired.text;

    const directionKey = keyFor(['direction', 'scrollDirection']);
    if (directionKey && desired.direction) params[directionKey] = desired.direction;

    const timeoutKey = keyFor(['timeoutMs', 'timeout', 'ms']);
    if (timeoutKey && desired.timeoutMs) params[timeoutKey] = desired.timeoutMs;

    const scriptKey = keyFor(['script', 'function', 'code', 'expression']);
    if (scriptKey && desired.script) params[scriptKey] = desired.script;

    if (Object.keys(params).length === 0) {
        return desired;
    }
    return params;
}

async function getPageElements(client, tools) {
    const evalTool = findTool(tools, ['evaluate_script', 'evaluate', 'execute_script', 'run_script']);
    if (!evalTool) return [];
    const script = `(() => {
        document.querySelectorAll('[data-bx-id]').forEach(el => el.removeAttribute('data-bx-id'));
        const selectors = [
            'a[href]', 'button', 'input[type="button"]', 'input[type="submit"]',
            'input[type="text"]', 'input[type="search"]', 'input[type="email"]', 'input[type="password"]', 'textarea',
            '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]', '[role="option"]', '[role="menuitem"]',
            'select', '[onclick]'
        ];
        const interactiveElements = Array.from(document.querySelectorAll(selectors.join(', ')));
        const contentElements = Array.from(document.querySelectorAll('h1, h2, h3, h4, main, article, section, [role="main"]'));
        const allElements = [...interactiveElements, ...contentElements];
        const uniqueVisibleElements = [];
        const seenElements = new Set();
        allElements.forEach(el => {
            const rect = el.getBoundingClientRect();
            const style = window.getComputedStyle(el);
            if (rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && !seenElements.has(el)) {
                uniqueVisibleElements.push(el);
                seenElements.add(el);
            }
        });
        return uniqueVisibleElements.map((el, index) => {
            const rect = el.getBoundingClientRect();
            const id = 'bx-' + index;
            el.setAttribute('data-bx-id', id);
            return {
                bx_id: id,
                x: rect.left,
                y: rect.top,
                text: (el.innerText || '').trim().slice(0, 150) || el.ariaLabel || el.placeholder || '',
                tag: el.tagName.toLowerCase(),
                role: el.getAttribute('role') || 'n/a'
            };
        });
    })();`;

    const params = buildParams(evalTool, { script });
    const result = await client.callTool({ name: evalTool.name, arguments: params });
    return result?.content || [];
}

async function getCurrentUrl(client, tools) {
    const evalTool = findTool(tools, ['evaluate_script', 'evaluate', 'execute_script', 'run_script']);
    if (!evalTool) return 'about:blank';
    const params = buildParams(evalTool, { script: 'window.location.href' });
    const result = await client.callTool({ name: evalTool.name, arguments: params });
    if (typeof result?.content === 'string') return result.content;
    return 'about:blank';
}

async function getPageText(client, tools) {
    const evalTool = findTool(tools, ['evaluate_script', 'evaluate', 'execute_script', 'run_script']);
    if (!evalTool) return '';
    const params = buildParams(evalTool, { script: 'document.body ? document.body.innerText.slice(0, 6000) : \"\"' });
    const result = await client.callTool({ name: evalTool.name, arguments: params });
    if (typeof result?.content === 'string') return result.content;
    return '';
}

function isCaptchaContent(text) {
    if (!text) return false;
    return /(captcha|are you human|verify you are human|robot|güvenlik doğrulaması|ben robot değilim)/i.test(text);
}

const SEARCH_ENGINES = [
    { name: 'duckduckgo', url: (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}` },
    { name: 'google', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}` },
    { name: 'bing', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
    { name: 'brave', url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}` }
];

const LITE_SEARCH_ENGINES = [
    { name: 'duckduckgo_html', url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}` },
    { name: 'bing_html', url: (q) => `https://www.bing.com/search?q=${encodeURIComponent(q)}` },
    { name: 'google_lite', url: (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}&gbv=1` },
];

function extractLinksFromHtml(html, limit = 5) {
    if (!html) return [];
    const links = [];
    const seen = new Set();
    
    // Simple robust regex to find all hrefs first, then filter
    // <a ... href="..."> ... </a>
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
    
    const skipHosts = ['duckduckgo.com', 'bing.com', 'brave.com', 'google.com', 'microsoft.com', 'search.yahoo.com'];
    
    let match;
    while ((match = linkRegex.exec(html)) !== null && links.length < limit) {
        const rawUrl = match[1];
        const rawText = match[2].replace(/<[^>]+>/g, '').trim(); // Strip HTML tags from text
        
        let url = rawUrl;
        
        // Normalize URL
        if (url.startsWith('//')) url = `https:${url}`;
        if (url.startsWith('/')) {
             if (url.startsWith('/url?')) {
                 const params = new URLSearchParams(url.split('?')[1] || '');
                 const q = params.get('q');
                 if (q) url = q;
             } else if (url.includes('duckduckgo.com/l/?')) {
                 const params = new URLSearchParams(url.split('?')[1] || '');
                 const uddg = params.get('uddg');
                 if (uddg) url = decodeURIComponent(uddg);
             } else {
                 // Skip internal relative links usually
                 continue;
             }
        }
        
        if (!/^https?:\/\//i.test(url)) continue;
        if (skipHosts.some(host => url.includes(host))) continue;
        if (seen.has(url)) continue;
        
        // Filter out junk text
        if (rawText.length < 3 || /^(here|click here|more|details)$/i.test(rawText)) continue;

        seen.add(url);
        links.push({ title: rawText || url, url });
    }
    return links;
}

async function runLiteSearchFallback(query, onLog) {
    onLog('🧭 Switching to lite search mode.');
    for (const engine of LITE_SEARCH_ENGINES) {
        try {
            const response = await axios.get(engine.url(query), {
                timeout: 15000,
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'en-US,en;q=0.9,tr;q=0.8'
                }
            });
            const links = extractLinksFromHtml(response.data);
            if (links.length > 0) {
                const summarySeed = links.map((l, i) => `${i + 1}. ${l.title}\n${l.url}`).join('\n\n');
                return { engine: engine.name, summarySeed };
            }
            onLog(`⚠️ Lite search (${engine.name}) returned no links.`);
        } catch (error) {
            const status = error.response ? `${error.response.status} ${error.response.statusText}` : 'no response';
            onLog(`⚠️ Lite search failed for ${engine.name}: ${status} - ${error.message}`);
        }
    }
    return null;
}

async function getScreenshotBase64(client, tools) {
    const screenshotTool = findTool(tools, ['take_screenshot', 'screenshot', 'capture_screenshot']);
    if (!screenshotTool) return '';
    const params = buildParams(screenshotTool, {});
    const result = await client.callTool({ name: screenshotTool.name, arguments: params });
    if (result?.content && typeof result.content === 'string') return result.content;
    if (result?.content?.data) return result.content.data;
    return '';
}

function loadToolToggles() {
    try {
        if (fs.existsSync(AUTH_STATE_PATH)) {
            const state = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf-8'));
            return {
                tavily: Boolean(state.toggles && state.toggles.tavily),
                firecrawl: Boolean(state.toggles && state.toggles.firecrawl),
            };
        }
    } catch {
        // ignore
    }
    return { tavily: false, firecrawl: false };
}

function buildCombinedToolCatalog(tools) {
    const catalog = { tools: Array.isArray(tools?.tools) ? [...tools.tools] : [] };
    const toggles = loadToolToggles();
    catalog.tools.push({
        name: 'lite_search',
        description: 'HTML-only search fallback using DuckDuckGo/Bing/Brave (no JS, captcha-resistant).',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    });
    if (toggles.tavily && process.env.TAVILY_API_KEY) {
        catalog.tools.push({
            name: 'tavily_search',
            description: 'Search the web using Tavily and return top results.',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        });
    }
    if (toggles.firecrawl && process.env.FIRECRAWL_API_KEY) {
        catalog.tools.push({
            name: 'firecrawl_scrape',
            description: 'Scrape a URL and return markdown.',
            inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
        });
    }
    return catalog;
}

function getActionSignature(command) {
    if (!command) return '';
    const args = command.arguments || {};
    return `${command.action}|${args.url || ''}|${args.query || ''}|${args.bx_id || ''}|${args.text || ''}|${args.direction || ''}`;
}

async function runAutonomousAgentMcp(userGoal, plan, onLog, agentControl) {
    onLog(`🚀 MCP browser mode starting for goal: "${userGoal}"`);
    onLog(`⚙️ MCP headless: ${plan.mcpHeadless ? 'on' : 'off'}`);
    const { client, tools } = await createChromeDevtoolsMcpClient({ headless: Boolean(plan.mcpHeadless) });
    const toolCatalog = buildCombinedToolCatalog(tools);

    const navigateTool = findTool(tools, ['navigate_page', 'navigate', 'goto']);
    const clickTool = findTool(tools, ['click', 'mouse_click', 'input_click']);
    const typeTool = findTool(tools, ['type', 'input_text', 'insert_text', 'set_value']);
    const scrollTool = findTool(tools, ['scroll']);
    const waitTool = findTool(tools, ['wait_for', 'wait']);
    const evalTool = findTool(tools, ['evaluate_script', 'evaluate', 'execute_script', 'run_script']);

    let actionHistory = [];
    let lastActionResult = { status: 'success', message: 'Agent started. Initial navigation required.' };
    let currentPlan = plan;
    let aiFailureCount = 0;
    let lastSearchQuery = '';
    let engineIndex = 0;
    const triedEngines = new Set();
    let captchaCount = 0;

    try {
        if (navigateTool && currentPlan.targetURL !== 'about:blank') {
            onLog(`▶️ MCP: Navigating to ${currentPlan.targetURL}`);
            const params = buildParams(navigateTool, { url: currentPlan.targetURL });
            await client.callTool({ name: navigateTool.name, arguments: params });
            lastActionResult = { status: 'success', message: `Successfully navigated to ${currentPlan.targetURL}` };
        }

        const callDirectTool = async (toolName, args) => {
            const targetTool = (tools?.tools || []).find(t => t.name === toolName);
            if (!targetTool) return false;
            const normalizedArgs = { ...args };
            if (normalizedArgs.bx_id && !normalizedArgs.selector) {
                normalizedArgs.selector = `[data-bx-id=\"${normalizedArgs.bx_id}\"]`;
            }
            const params = buildParams(targetTool, normalizedArgs);
            await client.callTool({ name: targetTool.name, arguments: params });
            lastActionResult = { status: 'success', message: `Executed ${toolName}` };
            return true;
        };

        for (let i = 0; i < MAX_AGENT_STEPS; i++) {
            if (agentControl && agentControl.stop) throw new Error('Agent stopped by user.');
            onLog(`\n--- Step ${i + 1} / ${MAX_AGENT_STEPS} ---`);
            const currentURL = await getCurrentUrl(client, tools);
            const pageElements = await getPageElements(client, tools);
            const screenshotBase64 = await getScreenshotBase64(client, tools);
            const pageText = await getPageText(client, tools);
            const structureString = JSON.stringify(pageElements, null, 2);

            let command;
            let commandIsValid = false;
            let aiRetries = 0;
            let lastAiError = '';

            if (isCaptchaContent(pageText)) {
                captchaCount += 1;
                lastActionResult = { status: 'error', message: 'Captcha detected. Choose a different search engine or use lite_search.' };
            } else if (captchaCount > 0) {
                captchaCount = 0;
            }

            while (aiRetries < MAX_AI_RETRIES && !commandIsValid) {
                if (aiRetries > 0) {
                    onLog(`... AI response was invalid. Retrying with error message (Attempt ${aiRetries + 1}/${MAX_AI_RETRIES})`);
                }
                const aiResponse = await decideNextToolAction(
                    userGoal, currentPlan, actionHistory, lastActionResult,
                    currentURL, structureString, screenshotBase64,
                    toolCatalog, onLog, lastAiError
                );
                command = aiResponse;
                if (command && command.action) {
                    commandIsValid = true;
                } else {
                    lastAiError = "Invalid JSON structure. The response must contain an 'action' key.";
                    aiRetries++;
                }
            }

            if (!command) {
                throw new Error(`AI failed to provide a valid command after ${MAX_AI_RETRIES} attempts. Last error: ${lastAiError}`);
            }
            if (!command.arguments) {
                command.arguments = { url: '', query: '', bx_id: '', text: '', direction: '', selector: '', reason: '', timeoutMs: '' };
            }

            const signature = getActionSignature(command);
            const lastSignature = actionHistory.length > 0 ? getActionSignature(actionHistory[actionHistory.length - 1]) : '';
            if (signature && signature === lastSignature) {
                aiFailureCount += 1;
                onLog(`⚠️ Repeated action detected (${aiFailureCount}/2).`);
            } else {
                aiFailureCount = 0;
            }
            if (aiFailureCount >= 2) {
                onLog('🔄 Replanning due to repeated actions.');
                const replanned = await createToolPlan(userGoal, toolCatalog, onLog);
                if (replanned) currentPlan = replanned;
                aiFailureCount = 0;
                continue;
            }

            onLog(`🧠 Next action: ${command.action}`);
            if (command.reason) onLog(`🧠 Reason: ${command.reason}`);
            actionHistory.push(command);
            if (actionHistory.length > MAX_ACTION_HISTORY) actionHistory.shift();

            try {
                switch (command.action) {
                    case 'tavily_search':
                        onLog(`▶️ Action: Tavily Search with query: "${command.arguments.query}"`);
                        const searchResult = await tavilySearch(command.arguments.query, onLog);
                        lastActionResult = { status: 'success', message: searchResult };
                        onLog(`   ... Tavily Result: "${searchResult.slice(0, 200)}..."`);
                        break;
                    case 'firecrawl_scrape':
                        onLog(`▶️ Action: Firecrawl Scrape of URL: "${command.arguments.url}"`);
                        const scrapeResult = await firecrawlScrape(command.arguments.url, onLog);
                        lastActionResult = { status: 'success', message: scrapeResult };
                        onLog(`   ... Firecrawl Result (Markdown): "${scrapeResult.slice(0, 200)}..."`);
                        break;
                    case 'lite_search':
                        onLog(`▶️ Action: Lite search with query: "${command.arguments.query}"`);
                        const lite = await runLiteSearchFallback(command.arguments.query || userGoal, onLog);
                        if (lite) {
                            const summary = await summarizeText(lite.summarySeed, userGoal, onLog);
                            lastActionResult = { status: 'success', message: summary || lite.summarySeed };
                        } else {
                            throw new Error('Lite search failed on all engines.');
                        }
                        break;
                    case 'navigate':
                    case 'navigate_page': // Fallback alias
                        if (!navigateTool) throw new Error('Navigate tool not available in MCP.');
                        const navUrl = command.arguments.url || command.url || command.arguments.query;
                        onLog(`▶️ MCP: Navigating to ${navUrl}`);
                        if (!navUrl) throw new Error('No URL provided for navigation.');
                        await client.callTool({ name: navigateTool.name, arguments: buildParams(navigateTool, { url: navUrl }) });
                        lastActionResult = { status: 'success', message: `Successfully navigated to ${navUrl}` };
                        try {
                            const parsed = new URL(navUrl);
                            const q = parsed.searchParams.get('q');
                            if (q) lastSearchQuery = q;
                        } catch {
                            // ignore
                        }
                        break;
                    case 'click':
                        if (!clickTool) throw new Error('Click tool not available in MCP.');
                        onLog(`▶️ MCP: Clicking element ${command.arguments.bx_id}`);
                        await client.callTool({
                            name: clickTool.name,
                            arguments: buildParams(clickTool, { selector: `[data-bx-id=\"${command.arguments.bx_id}\"]` })
                        });
                        lastActionResult = { status: 'success', message: `Successfully clicked element ${command.arguments.bx_id}.` };
                        break;
                    case 'type':
                        if (!typeTool) throw new Error('Type tool not available in MCP.');
                        onLog(`▶️ MCP: Typing into element ${command.arguments.bx_id}`);
                        await client.callTool({
                            name: typeTool.name,
                            arguments: buildParams(typeTool, { selector: `[data-bx-id=\"${command.arguments.bx_id}\"]`, text: command.arguments.text })
                        });
                        lastActionResult = { status: 'success', message: `Successfully typed into element ${command.arguments.bx_id}.` };
                        if (command.arguments.text) lastSearchQuery = command.arguments.text;
                        break;
                    case 'scroll':
                        if (!scrollTool) throw new Error('Scroll tool not available in MCP.');
                        onLog(`▶️ MCP: Scrolling ${command.arguments.direction}.`);
                        await client.callTool({ name: scrollTool.name, arguments: buildParams(scrollTool, { direction: command.arguments.direction }) });
                        lastActionResult = { status: 'success', message: `Successfully scrolled ${command.arguments.direction}.` };
                        break;
                    case 'press_enter':
                        if (!evalTool) throw new Error('Press enter tool not available in MCP.');
                        await client.callTool({ name: evalTool.name, arguments: buildParams(evalTool, { script: `document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter'}));` }) });
                        lastActionResult = { status: 'success', message: 'Pressed Enter.' };
                        break;
                    case 'press_escape':
                        if (!evalTool) throw new Error('Press escape tool not available in MCP.');
                        await client.callTool({ name: evalTool.name, arguments: buildParams(evalTool, { script: `document.activeElement && document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'}));` }) });
                        lastActionResult = { status: 'success', message: 'Pressed Escape.' };
                        break;
                    case 'wait':
                        if (waitTool) {
                            await client.callTool({ name: waitTool.name, arguments: buildParams(waitTool, { timeoutMs: 2000 }) });
                        } else {
                            await sleep(2000);
                        }
                        lastActionResult = { status: 'success', message: 'Waited briefly.' };
                        break;
                    case 'summarize':
                        onLog(`▶️ Action: Summarizing current page`);
                        const latestText = await getPageText(client, tools);
                        const textSummary = await summarizeText(latestText || 'Summarize current page', userGoal);
                        lastActionResult = { status: 'success', message: textSummary };
                        break;
                    case 'replan':
                        onLog(`🔄 Replan requested: ${command.reason || 'No reason provided.'}`);
                        const newPlan = await createToolPlan(userGoal, toolCatalog, onLog);
                        if (newPlan) currentPlan = newPlan;
                        lastActionResult = { status: 'success', message: 'Replanned with updated steps.' };
                        break;
                    case 'finish':
                        if (!command.summary) {
                            const finalText = await getPageText(client, tools);
                            command.summary = await summarizeText(finalText || 'Summarize current page', userGoal);
                        }
                        onLog(`🎉 GOAL ACHIEVED! Summary: ${command.summary}`);
                        onLog(`✅ Agent finished successfully!`);
                        return command.summary;
                    case 'request_credentials':
                        throw new Error(command.arguments.reason || 'Credentials are required to continue.');
                    default:
                        if (!(await callDirectTool(command.action, command.arguments))) {
                            throw new Error(`Unknown command action: ${command.action}`);
                        }
                }
                if (command.action === 'tavily_search' && command.arguments.query) {
                    lastSearchQuery = command.arguments.query;
                }
            } catch (error) {
                onLog(`🚨 Action Failed: ${error.message.split('\n')[0]}`);
                lastActionResult = { status: 'error', message: `Action '${command.action}' failed. Error: ${error.message}` };
            }
        }
        throw new Error('Agent reached maximum steps without finishing the goal.');
    } finally {
        await client.close();
    }
}

module.exports = { runAutonomousAgentMcp };
