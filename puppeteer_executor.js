// puppeteer_executor.js

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');
const { decideNextBrowserAction } = require('./agent_api.js');

const USER_DATA_DIR = path.join(__dirname, 'chrome_session_data');
const MAX_AGENT_STEPS = 15;

// This function simplifies the page's HTML to only include interactive elements...
// ... (simplifyHtml function remains unchanged) ...
async function simplifyHtml(page) {
    return await page.evaluate(() => {
        const generateStableId = (el) => {
            const text = (el.innerText || el.ariaLabel || el.placeholder || '').trim();
            let sanitizedText = text.replace(/[^a-zA-Z0-9\s]/g, '').replace(/\s+/g, '-').substring(0, 50);
            if (!sanitizedText) {
                sanitizedText = el.id || el.name || el.className.split(' ')[0] || 'no-text';
            }
            return `${el.tagName.toLowerCase()}-${sanitizedText}`;
        };

        let agentIdCounter = 0;
        const interactiveElements = document.querySelectorAll('a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="alert"], [role="log"], [data-testid="toast"]');
        
        document.querySelectorAll('[data-agent-id]').forEach(el => el.removeAttribute('data-agent-id'));
        
        let simplifiedHtml = '';
        const seenIds = new Set();
        
        interactiveElements.forEach(el => {
            if (agentIdCounter >= 100) return;
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0 || el.style.visibility === 'hidden') return;

            let stableId = generateStableId(el);
            let originalId = stableId;
            let collisionCounter = 1;
            while (seenIds.has(stableId)) {
                stableId = `${originalId}-${collisionCounter++}`;
            }
            seenIds.add(stableId);

            el.setAttribute('data-agent-id', stableId);
            agentIdCounter++;
            
            const description = el.innerText || el.ariaLabel || el.placeholder || `[${el.tagName.toLowerCase()}]`;
            simplifiedHtml += `<element data-agent-id="${stableId}">${description.trim().substring(0, 100)}</element>\n`;
        });
        
        return simplifiedHtml;
    });
}


// +++ THIS IS THE CORRECTED FUNCTION WITH SCREENSHOT CAPABILITIES +++
// The main function that orchestrates the agent's actions in the browser.
async function runAutonomousAgent(startUrl, goal, strategy, onLog, agentControl) {
  onLog(`🚀 Launching browser with persistent session data...`);
  const browser = await puppeteer.launch({ 
    headless: false, 
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', 
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized'], 
    userDataDir: USER_DATA_DIR, 
    defaultViewport: null 
  });
  
  let page = null;

  try {
    page = (await browser.pages())[0] || await browser.newPage();

    onLog('⚡️ Enabling network interception to block non-essential resources...');
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const blockList = ['image', 'stylesheet', 'font', 'media', 'csp_report'];
      if (blockList.includes(req.resourceType())) req.abort();
      else req.continue();
    });

    onLog(`▶️ Session loaded automatically from cache.`);
    onLog(`🚀 Navigating to ${startUrl}...`);
    await page.goto(startUrl, { waitUntil: 'networkidle2' });
    
    let previousAction = null;
    let previousState = { url: '', html: '' };

    for (let i = 0; i < MAX_AGENT_STEPS; i++) {
      if (agentControl && agentControl.stop) {
        throw new Error('Agent stopped by user.');
      }

      onLog(`\n--- Step ${i + 1} / ${MAX_AGENT_STEPS} ---`);
      await new Promise(r => setTimeout(r, 2000));
      
      const simplifiedHtml = await simplifyHtml(page);
      const currentURL = page.url();

      // +++ NEW: Take a screenshot for the vision model +++
      onLog("📸 Taking screenshot for analysis...");
      const screenshotBase64 = await page.screenshot({ 
          encoding: 'base64',
          type: 'jpeg', // JPEG is more compact than PNG for smaller API payloads
          quality: 75   // A good balance of size and quality
      });

      const isStuck = currentURL === previousState.url && simplifiedHtml === previousState.html;
      if (isStuck) {
          onLog('⚠️ Agent seems to be stuck. The last action had no effect. Forcing a new action.');
      }
      previousState = { url: currentURL, html: simplifiedHtml };

      let command;
      try {
        // +++ UPDATED: Pass the screenshot to the decision-making function +++
        command = await decideNextBrowserAction(goal, strategy, currentURL, simplifiedHtml, screenshotBase64, previousAction, isStuck, onLog);
      } catch (apiError) {
          onLog(`🧠 API call failed for this step. Will retry on the next loop. Error: ${apiError.message}`);
          continue;
      }
      previousAction = command;

      switch (command.action) {
        case 'type':
          onLog(`▶️ Action: Typing text into selector ${command.selector}`);
          await page.waitForSelector(command.selector, { visible: true });
          await page.type(command.selector, command.text, { delay: 100 });
          break;
        case 'click':
          onLog(`▶️ Action: Clicking selector ${command.selector}`);
          await page.waitForSelector(command.selector, { visible: true });
          // Using a robust click method
          await page.evaluate(selector => document.querySelector(selector).click(), command.selector);
          break;
        case 'think':
          onLog(`🤔 Agent is thinking: ${command.thought}`);
          break;
        case 'wait':
          onLog(`⏸️ Action: Wait. Reason: ${command.reason}`);
          onLog('🟡 Please complete the required action in the browser (e.g., login)...');
          await page.waitForNavigation({ timeout: 0, waitUntil: 'networkidle2' });
          onLog('✅ User action detected. Resuming agent...');
          previousAction = null;
          break;
        case 'finish':
          onLog(`✅ Action: Finish. ${command.summary}`);
          onLog(`🎉 Browser will close in 5 seconds.`);
          await new Promise(r => setTimeout(r, 5000));
          return;
        default:
          throw new Error(`Unknown command action: ${command.action}`);
      }
    }
    throw new Error('Agent reached maximum steps without finishing the task.');
  } catch (err) {
    onLog(`🚨 Puppeteer Failure: ${err.message}`);
    if (page && !page.isClosed()) {
        try { 
            const errorScreenshotPath = path.join(__dirname, 'error-screenshot.png');
            await page.screenshot({ path: errorScreenshotPath, fullPage: true });
            onLog(`📸 Screenshot saved to ${errorScreenshotPath}`);
        } catch (screenshotError) {
            onLog(`Could not take screenshot: ${screenshotError.message}`);
        }
    }
    throw err;
  } finally {
    if (browser && browser.isConnected()) {
        await browser.close();
        onLog('🔌 Browser has been closed.');
    }
  }
}

module.exports = { runAutonomousAgent };