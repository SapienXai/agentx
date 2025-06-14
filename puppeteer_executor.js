// puppeteer_executor.js

const fs = require('fs');
const path = require('path');
const puppeteer = require('puppeteer');

// ... (constants and helper functions like sanitizeSelectorId, randomDelay remain the same) ...
const DEFAULT_CHROME_PATHS = {
  win32: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  linux: '/usr/bin/google-chrome'
};
const CHROME_PATH = process.env.CHROME_PATH || DEFAULT_CHROME_PATHS[process.platform] || '/usr/bin/google-chrome';
const { createPlan, decideNextBrowserAction } = require('./agent_api.js'); 
const USER_DATA_DIR = path.join(__dirname, 'chrome_session_data');
const MAX_AGENT_STEPS = 15;
const MAX_ACTION_HISTORY = 4;
const randomDelay = (min = 1000, max = 3000) => new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1)) + min));
function sanitizeSelectorId(selectorId) {
  if (!selectorId || typeof selectorId !== 'string') return selectorId;
  const match = selectorId.match(/\[data-agent-id=(?:'|")(.*?)(?:'|")\]/);
  return match ? match[1] : selectorId;
}

// +++ FIX: The simplifyHtml function is heavily upgraded for reliability. +++
async function simplifyHtml(page) {
    return await page.evaluate(() => {
        // This function now prioritizes stable, developer-provided attributes over volatile ones.
        const generateStableId = (el) => {
            const sanitize = (str) => str.replace(/[^a-zA-Z0-9\s-]/g, '').replace(/\s+/g, '-').substring(0, 50);

            // Priority order for creating a stable ID
            const testId = el.getAttribute('data-testid');
            if (testId) return sanitize(testId);

            const ariaLabel = el.ariaLabel;
            if (ariaLabel) return `${el.tagName.toLowerCase()}-${sanitize(ariaLabel)}`;
            
            const placeholder = el.placeholder;
            if (placeholder) return `${el.tagName.toLowerCase()}-${sanitize(placeholder)}`;
            
            const text = el.innerText;
            if (text) return `${el.tagName.toLowerCase()}-${sanitize(text)}`;

            // Fallback for elements with no text or labels (e.g., icon buttons)
            if (el.id) return sanitize(el.id);
            if (el.name) return sanitize(el.name);
            
            return `${el.tagName.toLowerCase()}-no-identifier`;
        };

        let agentIdCounter = 0;
        // Query for standard interactive elements AND elements with data-testid, which are crucial for stable automation.
        const interactiveElements = document.querySelectorAll(
            'a, button, input, textarea, select, [role="button"], [role="link"], [role="textbox"], [role="alert"], [role="log"], [data-testid]'
        );
        
        // Clear previous IDs to ensure a fresh state for each step.
        document.querySelectorAll('[data-agent-id]').forEach(el => el.removeAttribute('data-agent-id'));
        
        let simplifiedHtml = '';
        const seenIds = new Set();

        interactiveElements.forEach(el => {
            if (agentIdCounter >= 150) return; // Increased limit slightly for complex pages
            
            // Filter out non-visible elements
            const rect = el.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0 || el.style.visibility === 'hidden' || el.getAttribute('aria-hidden') === 'true') {
                return;
            }

            let stableId = generateStableId(el);
            let originalId = stableId;
            let collisionCounter = 1;

            // Ensure the ID is unique on the page for this step
            while (seenIds.has(stableId)) {
                stableId = `${originalId}-${collisionCounter++}`;
            }
            seenIds.add(stableId);

            el.setAttribute('data-agent-id', stableId);
            agentIdCounter++;
            
            // Provide a richer description for the AI, including role and placeholder.
            const role = el.getAttribute('role');
            const placeholder = el.getAttribute('placeholder');
            const description = el.innerText || el.ariaLabel || `[${el.tagName.toLowerCase()}]`;
            
            let attributes = `data-agent-id="${stableId}"`;
            if (role) attributes += ` role="${role}"`;
            if (placeholder) attributes += ` placeholder="${placeholder}"`;
            
            // Use the actual tag name in the simplified HTML to give the AI more context.
            simplifiedHtml += `<${el.tagName.toLowerCase()} ${attributes}>${description.trim().substring(0, 150)}</${el.tagName.toLowerCase()}>\n`;
        });
        return simplifiedHtml;
    });
}


// +++ THIS FUNCTION IS MODIFIED TO MAKE THE 'wait' ACTION INTERRUPTIBLE +++
async function runAutonomousAgent(startUrl, taskSummary, strategy, onLog, agentControl) {
  onLog(`🚀 Launching browser with persistent session data...`);
  const browser = await puppeteer.launch({
    headless: false,
    executablePath: CHROME_PATH,
    args: [ '--no-sandbox', '--disable-setuid-sandbox', '--start-maximized', '--disable-infobars', '--window-position=0,0', '--window-size=1920,1080' ],
    userDataDir: USER_DATA_DIR,
    defaultViewport: null,
    ignoreDefaultArgs: ['--enable-automation'],
  });
  
  let page = null;
  const originalGoal = taskSummary;

  try {
    page = (await browser.pages())[0] || await browser.newPage();
    
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36');
    onLog('⚡️ Configuring network for human-like loading (slower but safer)...');
    await page.setRequestInterception(false); 

    onLog(`▶️ Session loaded automatically.`);
    onLog(`🚀 Navigating to ${startUrl}...`);
    await page.goto(startUrl, { waitUntil: 'networkidle2' });
    
    let previousAction = null;
    let previousState = { url: '', html: '' };
    let actionHistory = [];

    for (let i = 0; i < MAX_AGENT_STEPS; i++) {
      if (agentControl && agentControl.stop) {
        throw new Error('Agent stopped by user.');
      }

      onLog(`\n--- Step ${i + 1} / ${MAX_AGENT_STEPS} ---`);
      
      // Use shorter delay for 'think' loops, and longer for actual actions
      if (previousAction && previousAction.action === 'think') {
        await randomDelay(1000, 2000);
      } else {
        await randomDelay(1500, 3500);
      }
      
      const simplifiedHtml = await simplifyHtml(page);
      const currentURL = page.url();

      onLog("📸 Taking screenshot for analysis...");
      const screenshotBase64 = await page.screenshot({ 
          encoding: 'base64', type: 'jpeg', quality: 90
      });

      const isStuck = currentURL === previousState.url && simplifiedHtml === previousState.html;
      if (isStuck) {
          onLog('⚠️ Agent seems to be stuck. The last action had no effect.');
      }
      previousState = { url: currentURL, html: simplifiedHtml };

      let command;
      try {
        command = await decideNextBrowserAction(taskSummary, strategy, currentURL, simplifiedHtml, screenshotBase64, previousAction, isStuck, actionHistory, onLog);
      } catch (apiError) {
          onLog(`🧠 API call failed for this step. Will retry. Error: ${apiError.message}`);
          continue;
      }
      
      previousAction = command;
      actionHistory.unshift(command);
      if (actionHistory.length > MAX_ACTION_HISTORY) actionHistory.pop();

      switch (command.action) {
        // ... ('replan', 'type', 'click' cases remain the same) ...
        case 'replan':
          onLog(`🤔 Agent requested a re-plan. Reason: ${command.reason}`);
          const newGoalPrompt = `Original goal: "${originalGoal}". Re-plan context: "${command.reason}"`;
          const newPlan = await createPlan(newGoalPrompt, onLog);
          taskSummary = newPlan.taskSummary;
          strategy = newPlan.strategy;
          startUrl = newPlan.targetURL;
          onLog(`✅ New plan received! New summary: "${taskSummary}"`);
          onLog(`🚀 Navigating to new start URL: ${startUrl}`);
          await page.goto(startUrl, { waitUntil: 'networkidle2' });
          actionHistory = [];
          previousAction = null;
          continue;
        case 'type':
          const typeSelectorId = sanitizeSelectorId(command.selector);
          onLog(`▶️ Action: Typing "${command.text}" into ${typeSelectorId}`);
          await page.waitForSelector(`[data-agent-id="${typeSelectorId}"]`, { visible: true });
          await page.type(`[data-agent-id="${typeSelectorId}"]`, command.text, { delay: Math.random() * 80 + 60 });
          break;
        case 'click':
          const clickSelectorId = sanitizeSelectorId(command.selector);
          const selector = `[data-agent-id="${clickSelectorId}"]`;
          if (command.selector) {
            onLog(`▶️ Action: Clicking selector ${selector}`);
            await page.waitForSelector(selector, { visible: true });
            onLog(`    ...moving mouse to element first.`);
            await page.hover(selector);
            await randomDelay(200, 500);
            await page.evaluate(sel => document.querySelector(sel).click(), selector);
          } else if (command.x !== undefined && command.y !== undefined) {
            onLog(`▶️ Action: Clicking coordinates (X:${command.x}, Y:${command.y})`);
            if (command.reason) onLog(`   Reason: ${command.reason}`);
            await page.mouse.click(command.x, command.y);
          } else {
            throw new Error('Click command is missing both selector and coordinates.');
          }
          break;
        case 'think':
          onLog(`🤔 Agent is thinking: ${command.thought}`);
          // 'think' action does nothing but wait for the next loop iteration
          break;
        
        // +++ NEW: INTERRUPTIBLE WAIT LOGIC +++
        case 'wait':
          onLog(`⏸️ Action: Wait. Reason: ${command.reason}`);
          onLog('🟡 Please complete the required action in the browser. Agent is waiting for navigation...');
          
          const navigationPromise = page.waitForNavigation({ timeout: 0, waitUntil: 'networkidle2' });
          
          const stopSignalPromise = new Promise((resolve, reject) => {
              const interval = setInterval(() => {
                  if (agentControl.stop) {
                      clearInterval(interval);
                      reject(new Error('Agent stopped by user during wait.'));
                  }
              }, 500); // Check for stop signal every 500ms
          });

          await Promise.race([navigationPromise, stopSignalPromise]);
          
          onLog('✅ User action detected or navigation completed. Resuming agent...');
          previousAction = null;
          actionHistory = [];
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
    // The main try/catch block already handles logging the stop signal error correctly
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