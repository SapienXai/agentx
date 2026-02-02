// playwright_executor.js

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const sharp = require('sharp');
const { decideNextAction, summarizeText, composePost } = require('./agent_api.js');
const { tavilySearch, firecrawlScrape } = require('./tools.js');
const axios = require('axios');

const MAX_AGENT_STEPS = 25;
const MAX_ACTION_HISTORY = 10;
const MAX_AI_RETRIES = 3; 

const CREDENTIALS_PATH = path.join(__dirname, 'credential_store.json');
const USER_DATA_DIR = path.join(__dirname, 'playwright_session_data');

async function getInteractiveElements(page, onLog) {
    try {
        // Clear previous annotations
        await page.evaluate(() => {
            document.querySelectorAll('[data-bx-id]').forEach(el => el.removeAttribute('data-bx-id'));
        });

        // Run the main evaluation in the browser
        const elements = await page.evaluate(() => {
            const selectors = [
                'a[href]', 'button', 'input[type="button"]', 'input[type="submit"]',
                'input[type="text"]', 'input[type="search"]', 'input[type="email"]', 'input[type="password"]', 'textarea',
                '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]', '[role="option"]', '[role="menuitem"]',
                'select', '[onclick]'
            ];

            // +++ THIS LINE WAS MISSING +++
            const interactiveElements = Array.from(document.querySelectorAll(selectors.join(', ')));

            // Also get high-level content containers
            const contentElements = Array.from(document.querySelectorAll('h1, h2, h3, h4, main, article, section, [role="main"]'));
            
            // Now, interactiveElements is defined and can be used here
            const allElements = [...interactiveElements, ...contentElements];

            // Filter for unique, visible elements
            const uniqueVisibleElements = [];
            const seenElements = new Set();
            allElements.forEach(el => {
                const rect = el.getBoundingClientRect();
                const style = window.getComputedStyle(el);
                if (
                    rect.width > 0 &&
                    rect.height > 0 &&
                    style.visibility !== 'hidden' &&
                    style.display !== 'none' &&
                    !seenElements.has(el)
                ) {
                    uniqueVisibleElements.push(el);
                    seenElements.add(el);
                }
            });
            
            // Map elements to a serializable format and assign IDs
            return uniqueVisibleElements.map((el, index) => {
                const rect = el.getBoundingClientRect();
                const id = `bx-${index}`;
                el.setAttribute('data-bx-id', id);
                return {
                    bx_id: id,
                    x: rect.left,
                    y: rect.top,
                    text: el.innerText.trim().slice(0, 150) || el.ariaLabel || el.placeholder || '',
                    tag: el.tagName.toLowerCase(),
                    role: el.getAttribute('role') || 'n/a'
                };
            });
        });
        return elements;
    } catch (error) {
         if (error.message.includes('Execution context was destroyed')) {
            onLog("...Page navigated before analysis could complete. The step will be retried.");
            return []; 
        } else {
            // Rethrow other errors to be caught by the main loop
            throw error;
        }
    }
}

async function annotateScreenshot(screenshotBuffer, elements) {
    let image = sharp(screenshotBuffer);
    const { width: imageWidth, height: imageHeight } = await image.metadata();

    const annotationTasks = elements.map(el => {
        const svgText = `<svg width="60" height="20"><rect x="0" y="0" width="100%" height="100%" fill="#FF0000" rx="4" ry="4" opacity="0.8"/><text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" font-family="monospace" font-size="12" font-weight="bold" fill="white">${el.bx_id}</text></svg>`;
        const top = Math.max(0, Math.round(el.y - 20));
        const left = Math.max(0, Math.round(el.x));
        if (top > imageHeight - 20 || left > imageWidth - 60) return null;
        return { input: Buffer.from(svgText), left, top };
    }).filter(Boolean);

    if (annotationTasks.length > 0) {
        image.composite(annotationTasks);
    }
    return image.jpeg({ quality: 90 }).toBuffer();
}

function getCredentialsForUrl(url) {
    if (!fs.existsSync(CREDENTIALS_PATH)) return null;
    try {
        const store = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
        const urlObject = new URL(url);
        for (const domain in store) {
            if (urlObject.hostname.includes(domain)) return store[domain];
        }
        return null;
    } catch (error) {
        console.error('🚨 Error reading credential store:', error);
        return null;
    }
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function sleepWithAbort(ms, agentControl) {
    const interval = 200;
    let elapsed = 0;
    while (elapsed < ms) {
        if (agentControl && agentControl.stop) {
            throw new Error('Agent stopped by user.');
        }
        await sleep(Math.min(interval, ms - elapsed));
        elapsed += interval;
    }
}

function isTrivialGoal(goal) {
    if (!goal) return false;
    const trimmed = goal.trim().toLowerCase();
    if (trimmed.length > 20) return false;
    return /^(merhaba|selam|salam|hi|hello|hey|yo|hallo|hola)\b/.test(trimmed);
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
    const linkRegex = /<a[^>]+href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gi;
    const skipHosts = ['duckduckgo.com', 'bing.com', 'brave.com', 'google.com', 'microsoft.com'];

    let match;
    while ((match = linkRegex.exec(html)) !== null && links.length < limit) {
        const rawUrl = match[1];
        const rawText = match[2].replace(/<[^>]+>/g, '').trim();
        let url = rawUrl;

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
                 continue;
             }
        }
        
        if (!/^https?:\/\//i.test(url)) continue;
        if (skipHosts.some(host => url.includes(host))) continue;
        if (seen.has(url)) continue;
        
        if (rawText.length < 3) continue;

        seen.add(url);
        links.push({ title: rawText, url });
    }
    return links;
}

async function runLiteSearchFallback(query, onLog) {
    onLog('🧭 Switching to lite search mode.');
    for (const engine of LITE_SEARCH_ENGINES) {
        try {
            const response = await axios.get(engine.url(query), { timeout: 15000 });
            const links = extractLinksFromHtml(response.data);
            if (links.length > 0) {
                const summarySeed = links.map((l, i) => `${i + 1}. ${l.title}\n${l.url}`).join('\n\n');
                return { engine: engine.name, summarySeed };
            }
        } catch (error) {
            onLog(`⚠️ Lite search failed for ${engine.name}: ${error.message}`);
        }
    }
    return null;
}

function isInfoGoal(goal) {
    if (!goal) return false;
    const text = goal.toLowerCase();
    if (/(login|sign in|post|publish|schedule|tweet|dm|message|buy|checkout|fill form)/.test(text)) return false;
    return /(find|identify|top|best|list|compare|reviews|ratings|recommend|summary|summarize|restaurants|hotels|news)/.test(text);
}

function needsOfficialWebsites(goal) {
    if (!goal) return false;
    return /(official website|official site|website|web sitesi|url|link)/i.test(goal);
}

function extractUrls(text) {
    if (!text) return [];
    const matches = text.match(/https?:\/\/[^\s)"]+/g) || [];
    return Array.from(new Set(matches));
}

async function runFastResearch(userGoal, onLog, agentControl) {
    onLog('⚡ Fast research mode: using API tools without browser automation.');
    if (agentControl && agentControl.stop) throw new Error('Agent stopped by user.');

    const searchJson = await tavilySearch(userGoal, onLog);
    let results;
    try {
        results = JSON.parse(searchJson);
    } catch (error) {
        throw new Error('Failed to parse Tavily results.');
    }
    const topResults = Array.isArray(results) ? results.slice(0, 5) : [];
    if (topResults.length === 0) {
        throw new Error('Tavily returned no results.');
    }

    let contentBlocks = topResults.map((item, index) => {
        const snippet = item.content || item.snippet || '';
        return `[${index + 1}] ${item.title}\n${item.url}\n${snippet}`;
    }).join('\n\n');

    if (process.env.FIRECRAWL_API_KEY) {
        const scrapeTargets = topResults.slice(0, 3);
        const scraped = [];
        for (const item of scrapeTargets) {
            if (agentControl && agentControl.stop) throw new Error('Agent stopped by user.');
            try {
                const markdown = await firecrawlScrape(item.url, onLog);
                if (markdown) scraped.push(markdown.slice(0, 4000));
            } catch (error) {
                onLog(`⚠️ Firecrawl failed for ${item.url}: ${error.message}`);
            }
        }
        if (scraped.length > 0) {
            contentBlocks += `\n\nSCRAPED CONTENT:\n${scraped.join('\n\n---\n\n')}`;
        }
    }

    const summary = await summarizeText(contentBlocks, userGoal, onLog);
    return {
        summary: summary || 'Fast research completed, but summarization failed.',
        sources: contentBlocks
    };
}

async function runAutonomousAgent(userGoal, plan, onLog, agentControl, promptForCredentials) {
  if (isTrivialGoal(userGoal)) {
      onLog('ℹ️ Trivial goal detected. Responding immediately without browser automation.');
      return 'Merhaba! Size nasıl yardımcı olabilirim?';
  }
  if (process.env.TAVILY_API_KEY && isInfoGoal(userGoal)) {
      try {
          const fastResult = await runFastResearch(userGoal, onLog, agentControl);
          const urls = extractUrls(fastResult.sources || '');
          if (needsOfficialWebsites(userGoal) && urls.length < 3) {
              onLog('⚠️ Fast research missing official websites. Falling back to browser automation.');
          } else {
              onLog('✅ Fast research completed.');
              return fastResult.summary;
          }
      } catch (error) {
          onLog(`⚠️ Fast research failed, falling back to browser: ${error.message}`);
      }
  }
  onLog(`🚀 Launching browser for goal: "${userGoal}"`);
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: { width: 1280, height: 720 }, // Uses a default viewport size
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  
  let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  
  await page.goto('about:blank');

  const tracePath = path.join(__dirname, `trace_${Date.now()}.zip`);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  onLog(`📊 Trace file will be saved to: ${tracePath}`);
  
  let actionHistory = [];
  let lastActionResult = { status: "success", message: "Agent started. Initial navigation required." };
  let aiFailureCount = 0;

  let lastSearchQuery = '';
  let engineIndex = 0;
  const triedEngines = new Set();

  const navigateToSearch = async (query) => {
      const engine = SEARCH_ENGINES[engineIndex % SEARCH_ENGINES.length];
      const targetUrl = engine.url(query);
      onLog(`🧭 CAPTCHA fallback: switching to ${engine.name}`);
      triedEngines.add(engine.name);
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      lastActionResult = { status: "success", message: `Navigated to ${targetUrl}` };
  };

  try {
    if (Array.isArray(plan.plan) && plan.plan.length > 0 && plan.plan[0].tool) {
        for (let i = 0; i < plan.plan.length; i++) {
            if (agentControl && agentControl.stop) throw new Error('Agent stopped by user.');
            const step = plan.plan[i];
            onLog(`\n--- Plan Step ${i + 1} / ${plan.plan.length} ---`);
            onLog(`🧭 Plan: ${step.step}`);
            try {
                switch (step.tool) {
                    case 'tavily_search':
                        lastActionResult = { status: "success", message: await tavilySearch(step.arguments.query, onLog) };
                        break;
                    case 'firecrawl_scrape':
                        lastActionResult = { status: "success", message: await firecrawlScrape(step.arguments.url, onLog) };
                        break;
                    case 'navigate':
                        await page.goto(step.arguments.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                        lastActionResult = { status: "success", message: `Successfully navigated to ${step.arguments.url}` };
                        break;
                    case 'click':
                        await page.locator(`[data-bx-id="${step.arguments.bx_id}"]`).click({ force: true, timeout: 10000 });
                        lastActionResult = { status: "success", message: `Successfully clicked ${step.arguments.bx_id}` };
                        break;
                    case 'type':
                        await page.locator(`[data-bx-id="${step.arguments.bx_id}"]`).fill(step.arguments.text);
                        if (step.arguments.text) lastSearchQuery = step.arguments.text;
                        lastActionResult = { status: "success", message: `Successfully typed into ${step.arguments.bx_id}` };
                        break;
                    case 'scroll':
                        await page.evaluate(dir => { window.scrollBy(0, dir === 'down' ? window.innerHeight * 0.7 : -window.innerHeight * 0.7); }, step.arguments.direction);
                        lastActionResult = { status: "success", message: `Successfully scrolled ${step.arguments.direction}` };
                        break;
                    case 'press_enter':
                        await page.keyboard.press('Enter');
                        lastActionResult = { status: "success", message: `Pressed Enter.` };
                        break;
                    case 'press_escape':
                        await page.keyboard.press('Escape');
                        lastActionResult = { status: "success", message: `Pressed Escape.` };
                        break;
                    case 'wait':
                        await sleepWithAbort(2000, agentControl);
                        lastActionResult = { status: "success", message: `Waited.` };
                        break;
                    case 'summarize':
                        {
                            const textToSummarize = step.arguments.bx_id
                                ? await page.locator(`[data-bx-id="${step.arguments.bx_id}"]`).innerText()
                                : await page.locator('body').innerText();
                            const summaryText = await summarizeText(textToSummarize, userGoal);
                            lastActionResult = { status: "success", message: summaryText };
                        }
                        break;
                    default:
                        throw new Error(`Unknown plan tool: ${step.tool}`);
                }
                const pageText = await page.locator('body').innerText().catch(() => '');
                if (isCaptchaContent(pageText)) {
                    const query = lastSearchQuery || userGoal;
                    engineIndex += 1;
                    if (engineIndex >= SEARCH_ENGINES.length || triedEngines.size >= SEARCH_ENGINES.length) {
                        const lite = await runLiteSearchFallback(query, onLog);
                        if (lite) {
                            const summary = await summarizeText(lite.summarySeed, userGoal, onLog);
                            return summary || lite.summarySeed;
                        }
                        throw new Error('Captcha detected on multiple search engines.');
                    } else {
                        await navigateToSearch(query);
                    }
                }
            } catch (error) {
                onLog(`⚠️ Step failed: ${error.message}`);
                let recovered = false;
                for (const fallback of step.fallbacks || []) {
                    try {
                        onLog(`↪️ Fallback: ${fallback.why}`);
                        step.tool = fallback.tool;
                        step.arguments = fallback.arguments || step.arguments;
                        i -= 1;
                        recovered = true;
                        break;
                    } catch (fallbackError) {
                        onLog(`⚠️ Fallback failed: ${fallbackError.message}`);
                    }
                }
                if (!recovered) {
                    throw new Error(`Plan step failed: ${step.step}`);
                }
            }
        }
        const finalText = await page.locator('body').innerText().catch(() => '');
        if (isCaptchaContent(finalText)) {
            return 'Captcha detected. I could not access the results page.';
        }
        if (!lastActionResult?.message || /Executed\s+/i.test(lastActionResult.message)) {
            const summary = await summarizeText(finalText || 'Summarize current page', userGoal);
            return summary || 'Completed plan.';
        }
        return lastActionResult?.message || 'Completed plan.';
    }
    for (let i = 0; i < MAX_AGENT_STEPS; i++) {
        if (agentControl && agentControl.stop) throw new Error('Agent stopped by user.');
      
        onLog(`\n--- Step ${i + 1} / ${MAX_AGENT_STEPS} ---`);
      
        const currentURL = page.url();
        const credentials = getCredentialsForUrl(currentURL);
        
        let pageElements = [];
        let screenshotBase64 = '';

        if (currentURL !== 'about:blank') {
            onLog("Visual analysis: Labeling interactive elements...");
            pageElements = await getInteractiveElements(page, onLog);
            if (pageElements.length === 0 && currentURL !== 'about:blank') {
                onLog("...No elements found, likely due to a page navigation or an empty page. Retrying step...");
                await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
                continue;
            }
            onLog("📸 Taking and annotating screenshot for analysis...");
            const rawScreenshot = await page.screenshot();
            const annotatedScreenshot = await annotateScreenshot(rawScreenshot, pageElements);
            screenshotBase64 = annotatedScreenshot.toString('base64');
        }

        const structureString = JSON.stringify(pageElements, null, 2);
        
        let command;
        let commandIsValid = false;
        let aiRetries = 0;
        let lastAiError = "";

        if (currentURL === 'about:blank' && plan.targetURL !== 'about:blank') {
            onLog("Initial state detected, forcing navigation to target URL.");
            command = {
                thought: `The page is blank. I must navigate to the starting URL from the plan: ${plan.targetURL}`,
                action: 'navigate',
                url: plan.targetURL
            }
        } else {
             while (aiRetries < MAX_AI_RETRIES && !commandIsValid) {
                if (aiRetries > 0) {
                    onLog(`... AI response was invalid. Retrying with error message (Attempt ${aiRetries + 1}/${MAX_AI_RETRIES})`);
                }
                const aiResponse = await decideNextAction(
                    userGoal, plan, actionHistory, lastActionResult,
                    currentURL, structureString, screenshotBase64,
                    credentials, onLog, lastAiError
                );

                command = aiResponse;
                
                if (command && command.action) {
                    commandIsValid = true;
                } else {
                    lastAiError = "Invalid JSON structure. The response must contain an 'action' key.";
                    aiRetries++;
                }
            }
        }
       
        if (!command) {
            throw new Error(`AI failed to provide a valid command after ${MAX_AI_RETRIES} attempts. Last error: ${lastAiError}`);
        }
        
        if (command.aiError) {
            aiFailureCount += 1;
            onLog(`⚠️ AI decision failed (${aiFailureCount}/2).`);
            if (aiFailureCount >= 2) {
                throw new Error('AI failed to decide next action twice. Stopping to avoid loops.');
            }
        } else {
            aiFailureCount = 0;
        }

        if (command.thought) onLog(`🧠 Agent Thought: ${command.thought}`);
        actionHistory.push(command);
        if (actionHistory.length > MAX_ACTION_HISTORY) actionHistory.shift();

        try {
            switch (command.action) {
                case 'tavily_search':
                    onLog(`▶️ Action: Tavily Search with query: "${command.query}"`);
                    const searchResult = await tavilySearch(command.query, onLog);
                    lastActionResult = { status: "success", message: searchResult };
                    onLog(`   ... Tavily Result: "${searchResult.slice(0, 200)}..."`);
                    break;
                case 'firecrawl_scrape':
                    onLog(`▶️ Action: Firecrawl Scrape of URL: "${command.url}"`);
                    const scrapeResult = await firecrawlScrape(command.url, onLog);
                    lastActionResult = { status: "success", message: scrapeResult };
                    onLog(`   ... Firecrawl Result (Markdown): "${scrapeResult.slice(0, 200)}..."`);
                    break;
                case 'navigate':
                case 'navigate_page': // Fallback alias
                    const navUrl = command.url || command.arguments?.url || command.query;
                    onLog(`▶️ Action: Navigating to ${navUrl}`);
                    if (!navUrl) throw new Error('No URL provided for navigation.');
                    await page.goto(navUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    lastActionResult = { status: "success", message: `Successfully navigated to ${navUrl}` };
                    break;
                case 'type':
                    onLog(`▶️ Action: Typing into element ${command.bx_id}`);
                    await page.locator(`[data-bx-id="${command.bx_id}"]`).fill(command.text);
                    lastActionResult = { status: "success", message: `Successfully typed into element ${command.bx_id}.` };
                    break;
                case 'click':
                    onLog(`▶️ Action: Clicking element ${command.bx_id}`);
                    const initialPageCount = context.pages().length;
                    await page.locator(`[data-bx-id="${command.bx_id}"]`).click({ force: true, timeout: 10000 });
                    
                    onLog("...Waiting for page to react to click...");
                    await sleepWithAbort(2000, agentControl); 

                    if (context.pages().length > initialPageCount) {
                        onLog("✅ Detected new tab. Switching focus.");
                        page = context.pages()[context.pages().length - 1]; 
                        await page.bringToFront();
                        await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => onLog("...New tab did not fully load, but continuing."));
                    } else {
                        onLog("...No new tab detected. Waiting for same-page navigation...");
                        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => onLog("...Network did not become fully idle, but continuing."));
                    }
                    lastActionResult = { status: "success", message: `Successfully clicked element ${command.bx_id}.` };
                    break;
                case 'press_enter':
                     onLog(`▶️ Action: Pressing 'Enter' key.`);
                     await page.keyboard.press('Enter');
                     onLog("...Waiting for page to react to 'Enter' key...");
                     await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => onLog("...Network did not become fully idle, but continuing."));
                     lastActionResult = { status: "success", message: `Successfully pressed 'Enter'.` };
                     break;
                case 'press_escape':
                     onLog(`▶️ Action: Pressing 'Escape' key.`);
                     await page.keyboard.press('Escape');
                     await sleepWithAbort(1000, agentControl);
                     lastActionResult = { status: "success", message: `Successfully pressed 'Escape'.` };
                     break;
                case 'scroll':
                    onLog(`▶️ Action: Scrolling ${command.direction}.`);
                    await page.evaluate(dir => {
                        window.scrollBy(0, dir === 'down' ? window.innerHeight * 0.7 : -window.innerHeight * 0.7);
                    }, command.direction);
                    await sleepWithAbort(1000, agentControl);
                    lastActionResult = { status: "success", message: `Successfully scrolled ${command.direction}.` };
                    break;
                case 'scrape_text':
                     onLog(`▶️ Action: Scraping text from ${command.bx_id}`);
                     const scrapedText = await page.locator(`[data-bx-id="${command.bx_id}"]`).innerText();
                     lastActionResult = { status: "success", message: scrapedText };
                     onLog(`   ... Scraped Text: "${scrapedText.slice(0, 100)}..."`);
                     break;
                case 'summarize':
                     onLog(`▶️ Action: Summarizing text from ${command.bx_id}`);
                     const textToSummarize = await page.locator(`[data-bx-id="${command.bx_id}"]`).innerText();
                     const summary = await summarizeText(textToSummarize, userGoal);
                     lastActionResult = { status: "success", message: summary };
                     onLog(`   ... Summary: "${summary.slice(0, 150)}..."`);
                     break;
                case 'request_credentials':
                     onLog(`⏸️ Action: Requesting credentials.`);
                     const urlObject = new URL(page.url());
                     const domain = urlObject.hostname.replace('www.', '');
                     // The promptForCredentials function is now passed in from the new server logic
                     const result = await promptForCredentials(domain); 
                     if (result.success) {
                        onLog('✅ Credentials received. Resuming agent...');
                        lastActionResult = { status: "success", message: `Credentials for ${domain} were provided.` };
                     } else {
                        throw new Error(`User canceled credential entry for ${domain}.`);
                     }
                     break;
                case 'wait':
                    onLog(`⏸️ Action: Waiting.`);
                    await sleepWithAbort(5000, agentControl);
                    lastActionResult = { status: "success", message: `Waited for 5 seconds.` };
                    break;
                case 'finish':
                    onLog(`🎉 GOAL ACHIEVED! Summary: ${command.summary}`);
                    onLog(`✅ Agent finished successfully!`);
                    return command.summary;
                default:
                    throw new Error(`Unknown command action: ${command.action}`);
            }
        } catch (error) {
            onLog(`🚨 Action Failed: ${error.message.split('\n')[0]}`);
            lastActionResult = { status: "error", message: `Action '${command.action}' failed. Error: ${error.message}` };
        }
    }
    throw new Error('Agent reached maximum steps without finishing the goal.');
  } catch (err) {
    onLog(`🚨 FATAL ERROR: ${err.message}`);
    if (page && !page.isClosed()) {
        const errorScreenshotPath = path.join(__dirname, 'error-screenshot.png');
        await page.screenshot({ path: errorScreenshotPath, fullPage: true });
        onLog(`📸 Screenshot of failure saved to ${errorScreenshotPath}`);
    }
    throw err;
  } finally {
    onLog('🔌 Closing browser...');
    if (context) {
        if (context.browser()?.isConnected()) {
            await context.tracing.stop({ path: tracePath });
            onLog(`📊 Trace file saved. To view it, drag ${tracePath} into https://trace.playwright.dev/`);
        }
        await context.close();
    }
  }
}

module.exports = { runAutonomousAgent };
