// playwright_executor.js

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const sharp = require('sharp');
const { decideNextAction, summarizeText } = require('./agent_api.js'); // Import summarizeText

const MAX_AGENT_STEPS = 25;
const MAX_ACTION_HISTORY = 10;

const CREDENTIALS_PATH = path.join(__dirname, 'credential_store.json');
const USER_DATA_DIR = path.join(__dirname, 'playwright_session_data');

// +++ MODIFIED: This function is now more selective to reduce token usage +++
async function getInteractiveElements(page) {
    await page.evaluate(() => {
        document.querySelectorAll('[data-bx-id]').forEach(el => el.removeAttribute('data-bx-id'));
    });
    const elements = await page.evaluate(() => {
        // Focus on elements that are clearly interactive
        const selectors = [
            'a[href]', 'button', 'input[type="button"]', 'input[type="submit"]',
            'input[type="text"]', 'input[type="search"]', 'input[type="email"]', 'input[type="password"]', 'textarea',
            '[role="button"]', '[role="link"]', '[role="tab"]', '[role="checkbox"]', '[role="option"]', '[role="menuitem"]',
            'select', '[onclick]'
        ];
        const interactiveElements = Array.from(document.querySelectorAll(selectors.join(', ')));

        // We also want to label headings and main content areas for scraping, but not every single text element
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

async function runAutonomousAgent(userGoal, onLog, agentControl, screenSize, promptForCredentials) {
  onLog(`🚀 Launching browser for goal: "${userGoal}"`);
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: screenSize || { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  await page.goto('about:blank');

  const tracePath = path.join(__dirname, `trace_${Date.now()}.zip`);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  onLog(`📊 Trace file will be saved to: ${tracePath}`);
  
  let actionHistory = [];
  let lastActionResult = null;
  let fullScrapedText = null; // Store full text for summarization

  try {
    for (let i = 0; i < MAX_AGENT_STEPS; i++) {
        if (agentControl && agentControl.stop) throw new Error('Agent stopped by user.');
      
        onLog(`\n--- Step ${i + 1} / ${MAX_AGENT_STEPS} ---`);
      
        await sleep(1000);

        const currentURL = page.url();
        const credentials = getCredentialsForUrl(currentURL);
        
        onLog("視覺分析：標記所有互動元素...");
        const pageElements = await getInteractiveElements(page);
        const structureString = JSON.stringify(pageElements, null, 2);

        onLog("📸 Taking and annotating screenshot for analysis...");
        const rawScreenshot = await page.screenshot();
        const annotatedScreenshot = await annotateScreenshot(rawScreenshot, pageElements);
        const screenshotBase64 = annotatedScreenshot.toString('base64');
        
        // +++ Truncate the last action result before sending to AI to save tokens +++
        let truncatedResult = lastActionResult;
        if (truncatedResult && truncatedResult.length > 500) {
            truncatedResult = truncatedResult.slice(0, 500) + '... [truncated]';
        }
        
        const command = await decideNextAction(
            userGoal,
            actionHistory,
            truncatedResult, // Pass the potentially truncated result
            currentURL,
            structureString,
            screenshotBase64,
            credentials,
            onLog
        );
      
        lastActionResult = null; // Reset after each decision

        if (command.thought) onLog(`🧠 Agent Thought: ${command.thought}`);
        actionHistory.push(command);
        if (actionHistory.length > MAX_ACTION_HISTORY) actionHistory.shift();

        switch (command.action) {
            case 'navigate':
                onLog(`▶️ Action: Navigating to ${command.url}`);
                await page.goto(command.url, { waitUntil: 'domcontentloaded' });
                break;
            case 'type':
                onLog(`▶️ Action: Typing into element ${command.bx_id}`);
                await page.locator(`[data-bx-id="${command.bx_id}"]`).fill(command.text);
                break;
            case 'click':
                onLog(`▶️ Action: Clicking element ${command.bx_id}`);
                await page.locator(`[data-bx-id="${command.bx_id}"]`).click({timeout: 10000});
                break;
            case 'press_enter':
                 onLog(`▶️ Action: Pressing 'Enter' key.`);
                 await page.keyboard.press('Enter');
                 break;
            case 'scroll':
                onLog(`▶️ Action: Scrolling ${command.direction}.`);
                await page.evaluate(dir => {
                    window.scrollBy(0, dir === 'down' ? window.innerHeight : -window.innerHeight);
                }, command.direction);
                break;
            case 'scrape_text':
                 onLog(`▶️ Action: Scraping text from element ${command.bx_id}`);
                 const scrapedText = await page.locator(`[data-bx-id="${command.bx_id}"]`).innerText();
                 fullScrapedText = scrapedText; // Save the full text
                 lastActionResult = scrapedText; // This will be truncated for the next prompt
                 onLog(`   ... Scraped Text: "${scrapedText.slice(0, 100)}..."`);
                 break;
            case 'summarize': // +++ NEW ACTION HANDLER +++
                 onLog(`▶️ Action: Summarizing text from element ${command.bx_id}`);
                 const textToSummarize = await page.locator(`[data-bx-id="${command.bx_id}"]`).innerText();
                 onLog(`   ... Text is ${textToSummarize.length} characters long. Summarizing...`);
                 const summary = await summarizeText(textToSummarize, userGoal);
                 lastActionResult = summary; // The summary becomes the result for the next step
                 onLog(`   ... Summary: "${summary.slice(0, 150)}..."`);
                 break;
            case 'wait':
                onLog(`⏸️ Action: Wait. Reason: ${command.reason}`);
                await sleep(3000);
                onLog('✅ Resuming agent...');
                break;
            case 'finish':
                onLog(`🎉 GOAL ACHIEVED! Summary: ${command.summary}`);
                onLog(`✅ Agent finished successfully!`);
                return;
            default:
                throw new Error(`Unknown or invalid command action: ${command.action}`);
        }
        await page.waitForLoadState('domcontentloaded', {timeout: 5000}).catch(() => onLog('...Page did not fully reload, continuing.'));
    }
    throw new Error('Agent reached maximum steps without finishing the goal.');
  } catch (err) {
    onLog(`🚨 Playwright Failure: ${err.message}`);
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