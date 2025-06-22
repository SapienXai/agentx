// playwright_executor.js

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const sharp = require('sharp');
const { decideNextAction, summarizeText, composePost } = require('./agent_api.js');
const { tavilySearch, firecrawlScrape } = require('./tools.js');

const MAX_AGENT_STEPS = 25;
const MAX_ACTION_HISTORY = 10;
const MAX_AI_RETRIES = 3; 

const CREDENTIALS_PATH = path.join(__dirname, 'credential_store.json');
const USER_DATA_DIR = path.join(__dirname, 'playwright_session_data');

async function getInteractiveElements(page, onLog) {
    try {
        await page.evaluate(() => {
            document.querySelectorAll('[data-bx-id]').forEach(el => el.removeAttribute('data-bx-id'));
        });
        const elements = await page.evaluate(() => {
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
                if (rect.width > 0 && rect.height > 0 && !seenElements.has(el)) {
                    uniqueVisibleElements.push(el);
                    seenElements.add(el);
                }
            });
            
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

async function runAutonomousAgent(userGoal, plan, onLog, agentControl, screenSize, promptForCredentials) {
  onLog(`🚀 Launching browser for goal: "${userGoal}"`);
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: screenSize || { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  
  let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  
  await page.goto('about:blank');

  const tracePath = path.join(__dirname, `trace_${Date.now()}.zip`);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  onLog(`📊 Trace file will be saved to: ${tracePath}`);
  
  let actionHistory = [];
  let lastActionResult = { status: "success", message: "Agent started. Initial navigation required." };

  try {
    for (let i = 0; i < MAX_AGENT_STEPS; i++) {
        if (agentControl && agentControl.stop) throw new Error('Agent stopped by user.');
      
        onLog(`\n--- Step ${i + 1} / ${MAX_AGENT_STEPS} ---`);
      
        const currentURL = page.url();
        const credentials = getCredentialsForUrl(currentURL);
        
        let pageElements = [];
        let screenshotBase64 = '';

        // Only do browser-specific analysis if the agent isn't exclusively using API tools
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
                    onLog(`▶️ Action: Navigating to ${command.url}`);
                    await page.goto(command.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    lastActionResult = { status: "success", message: `Successfully navigated to ${command.url}` };
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
                    await sleep(2000); 

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
                     await sleep(1000);
                     lastActionResult = { status: "success", message: `Successfully pressed 'Escape'.` };
                     break;
                case 'scroll':
                    onLog(`▶️ Action: Scrolling ${command.direction}.`);
                    await page.evaluate(dir => {
                        window.scrollBy(0, dir === 'down' ? window.innerHeight * 0.7 : -window.innerHeight * 0.7);
                    }, command.direction);
                    await sleep(1000);
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
                     await promptForCredentials(domain); 
                     onLog('✅ Credentials received. Resuming agent...');
                     lastActionResult = { status: "success", message: `Credentials for ${domain} were provided.` };
                     break;
                case 'wait':
                    onLog(`⏸️ Action: Waiting.`);
                    await sleep(5000);
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
    if (!page.isClosed()) {
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