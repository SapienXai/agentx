// playwright_executor.js

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { createPlan, decideNextBrowserAction } = require('./agent_api.js'); 

const MAX_AGENT_STEPS = 15;
const MAX_ACTION_HISTORY = 4;
const CREDENTIALS_PATH = path.join(__dirname, 'credential_store.json');
// +++ NEW: Define a path for our persistent session data +++
const USER_DATA_DIR = path.join(__dirname, 'playwright_session_data');

function getCredentialsForUrl(url) {
    if (!fs.existsSync(CREDENTIALS_PATH)) {
        return null;
    }
    try {
        const store = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
        const urlObject = new URL(url);
        for (const domain in store) {
            if (urlObject.hostname.includes(domain)) {
                return store[domain];
            }
        }
        return null;
    } catch (error) {
        console.error('🚨 Error reading credential store:', error);
        return null;
    }
}

async function getPageStructure(page) {
    const accessibilityTree = await page.accessibility.snapshot({ interestingOnly: true, root: page.locator('body') });

    const testIdElements = await page.evaluate(() => {
        const elements = [];
        document.querySelectorAll('[data-testid]').forEach(el => {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                elements.push({
                    role: el.getAttribute('role') || el.tagName.toLowerCase(),
                    name: el.ariaLabel || el.innerText,
                    testid: el.getAttribute('data-testid')
                });
            }
        });
        return elements;
    });

    return {
        accessibilityTree,
        testIdElements
    };
}

async function runAutonomousAgent(startUrl, taskSummary, strategy, onLog, agentControl) {
  // +++ CHANGE: Use a persistent context instead of a fresh one +++
  onLog(`🚀 Launching browser with persistent session from: ${USER_DATA_DIR}`);
  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
      headless: false,
      viewport: { width: 1920, height: 1080 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  });
  
  // A persistent context can have 0 pages if the browser was already open.
  const page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
  
  const tracePath = path.join(__dirname, `trace_${Date.now()}.zip`);
  await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
  onLog(`📊 Trace file will be saved to: ${tracePath}`);

  const originalGoal = taskSummary;
  let browser = context.browser(); // Get browser instance for the finally block

  try {
    onLog(`🚀 Navigating to ${startUrl}...`);
    await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
    
    let actionHistory = [];

    for (let i = 0; i < MAX_AGENT_STEPS; i++) {
      if (agentControl && agentControl.stop) {
        throw new Error('Agent stopped by user.');
      }

      onLog(`\n--- Step ${i + 1} / ${MAX_AGENT_STEPS} ---`);
      
      await new Promise(r => setTimeout(r, 2000));

      const currentURL = page.url();
      const credentials = getCredentialsForUrl(currentURL);
      if (credentials) {
          onLog(`✅ Found credentials for ${currentURL}`);
      }

      onLog("🌳 Capturing page structure (Accessibility & Test IDs)...");
      const pageStructure = await getPageStructure(page);
      const structureString = JSON.stringify(pageStructure, null, 2);

      onLog("📸 Taking screenshot for analysis...");
      const screenshotBase64 = await page.screenshot({ type: 'jpeg', quality: 90 }).then(b => b.toString('base64'));

      let command;
      try {
        command = await decideNextBrowserAction(taskSummary, strategy, currentURL, structureString, screenshotBase64, credentials, actionHistory, onLog);
      } catch (apiError) {
          onLog(`🧠 API call failed for this step. Will retry. Error: ${apiError.message}`);
          continue;
      }
      
      if (command.thought) {
          onLog(`🧠 Agent Thought: ${command.thought}`);
      }
      
      actionHistory.unshift(command);
      if (actionHistory.length > MAX_ACTION_HISTORY) actionHistory.pop();

      switch (command.action) {
        case 'replan':
          onLog(`🤔 Agent requested a re-plan. Reason: ${command.reason}`);
          const newGoalPrompt = `Original goal: "${originalGoal}". Re-plan context: "${command.reason}"`;
          const newPlan = await createPlan(newGoalPrompt, onLog);
          taskSummary = newPlan.taskSummary;
          strategy = newPlan.strategy;
          startUrl = newPlan.targetURL;
          onLog(`✅ New plan received! New summary: "${taskSummary}"`);
          onLog(`🚀 Navigating to new start URL: ${startUrl}`);
          await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
          actionHistory = [];
          break;

        case 'type':
        case 'click': {
            if (!command.selector) {
                onLog(`⚠️ AI action '${command.action}' is missing a 'selector'. Re-evaluating.`);
                continue;
            }

            let selector;
            if (command.selector.testid) {
                onLog(`▶️ Action: Targeting unique testid '${command.selector.testid}'`);
                selector = page.getByTestId(command.selector.testid);
            } else if (command.selector.role && command.selector.name) {
                onLog(`▶️ Action: Targeting role '${command.selector.role}' with name '${command.selector.name}'`);
                selector = page.getByRole(command.selector.role, { name: command.selector.name, exact: false });
            } else {
                onLog(`⚠️ AI provided an invalid selector for '${command.action}'. Re-evaluating. Selector: ${JSON.stringify(command.selector)}`);
                continue;
            }

            if (command.action === 'type') {
                onLog(`   ... Typing "${command.text}"`);
                await selector.fill(command.text);
            } else {
                onLog(`   ... Clicking element.`);
                await selector.click();
            }
            break;
        }

        case 'think':
          onLog(`🤔 Agent is thinking... will re-evaluate in the next step.`);
          break;
        
        case 'wait':
          onLog(`⏸️ Action: Wait. Reason: ${command.reason}`);
          onLog('🟡 Please complete the required action in the browser. Agent is waiting for navigation...');
          
          const navigationPromise = page.waitForNavigation({ timeout: 0, waitUntil: 'domcontentloaded' });
          
          const stopSignalPromise = new Promise((resolve, reject) => {
              const interval = setInterval(() => {
                  if (agentControl.stop) {
                      clearInterval(interval);
                      reject(new Error('Agent stopped by user during wait.'));
                  }
              }, 500);
          });

          await Promise.race([navigationPromise, stopSignalPromise]);
          
          onLog('✅ User action detected, navigation completed. Resuming agent...');
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
      await page.waitForLoadState('domcontentloaded');
    }
    throw new Error('Agent reached maximum steps without finishing the task.');
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
    if (browser && browser.isConnected()) {
        await context.tracing.stop({ path: tracePath });
        onLog(`📊 Trace file saved. To view it, drag ${tracePath} into https://trace.playwright.dev/`);
    }
    // Closing the context will close the browser page.
    await context.close();
  }
}

module.exports = { runAutonomousAgent };