// main.js

require('dotenv').config();

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const os = require('os');
const qrcode = require('qrcode');
const cron = require('node-cron');
const fs = require('fs');
const { interpretGoal, createPlan, createToolPlan } = require('./agent_api.js');
const { execFileSync, spawn } = require('child_process');
const { runAutonomousAgentMcp } = require('./mcp_executor.js');
const { fetchChromeDevtoolsToolCatalog } = require('./mcp_client.js');
const { setToolToggles } = require('./tools.js');

const PORT = process.env.PORT || 3000;

const SCHEDULED_TASKS_PATH = path.join(__dirname, 'scheduled_tasks.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credential_store.json');
const AUTH_STATE_PATH = path.join(__dirname, 'auth_state.json');

const engine = 'mcp';

let taskQueue = [];
let isAgentRunning = false;
const agentControls = {};
const scheduledJobs = {};

let credentialRequest = {
    isWaiting: false,
    resolver: null,
};

function loadAuthState() {
    if (!fs.existsSync(AUTH_STATE_PATH)) return {};
    try {
        return JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf-8'));
    } catch (error) {
        console.error('Failed to read auth state, resetting.', error);
        return {};
    }
}

function saveAuthState(state) {
    fs.writeFileSync(AUTH_STATE_PATH, JSON.stringify(state, null, 2));
}

function updateAuthState(patch) {
    const state = loadAuthState();
    const next = {
        ...state,
        ...patch,
        models: { ...(state.models || {}), ...(patch.models || {}) }
    };
    saveAuthState(next);
    return next;
}

function getToolToggles() {
    const state = loadAuthState();
    return {
        tavily: Boolean(state.toggles && state.toggles.tavily),
        firecrawl: Boolean(state.toggles && state.toggles.firecrawl),
    };
}

const toolCatalogCache = {
    engine: null,
    togglesKey: null,
    ts: 0,
    catalog: { tools: [] },
};

function getToolCatalogKey(engine, toggles) {
    return `${engine}|tavily:${toggles.tavily ? '1' : '0'}|firecrawl:${toggles.firecrawl ? '1' : '0'}`;
}

async function getPlanningToolCatalog() {
    const toggles = getToolToggles();
    const key = getToolCatalogKey(engine, toggles);
    const now = Date.now();
    if (toolCatalogCache.engine === engine && toolCatalogCache.togglesKey === key && (now - toolCatalogCache.ts) < 5 * 60 * 1000) {
        return toolCatalogCache.catalog;
    }

    let catalog = { tools: [] };
    const genericCatalog = {
        tools: [
            { name: 'navigate', description: 'Navigate to a URL.', inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] } },
            { name: 'click', description: 'Click an element by data-bx-id.', inputSchema: { type: 'object', properties: { bx_id: { type: 'string' } }, required: ['bx_id'] } },
            { name: 'type', description: 'Type into an element by data-bx-id.', inputSchema: { type: 'object', properties: { bx_id: { type: 'string' }, text: { type: 'string' } }, required: ['bx_id', 'text'] } },
            { name: 'scroll', description: 'Scroll page.', inputSchema: { type: 'object', properties: { direction: { type: 'string' } }, required: ['direction'] } },
            { name: 'wait', description: 'Wait for a short duration.', inputSchema: { type: 'object', properties: { reason: { type: 'string' } }, required: [] } },
            { name: 'press_enter', description: 'Press Enter key.', inputSchema: { type: 'object', properties: {}, required: [] } },
            { name: 'press_escape', description: 'Press Escape key.', inputSchema: { type: 'object', properties: {}, required: [] } },
            { name: 'summarize', description: 'Summarize main content.', inputSchema: { type: 'object', properties: { bx_id: { type: 'string' } }, required: [] } },
        ]
    };

    if (engine === 'mcp') {
        try {
            catalog = await fetchChromeDevtoolsToolCatalog();
        } catch (error) {
            console.error('Failed to fetch MCP tool catalog:', error.message);
            catalog = genericCatalog;
        }
    } else {
        catalog = genericCatalog;
    }

    if (toggles.tavily) {
        catalog.tools = catalog.tools || [];
        catalog.tools.push({
            name: 'tavily_search',
            description: 'Search the web using Tavily and return top results.',
            inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
        });
    }
    if (toggles.firecrawl) {
        catalog.tools = catalog.tools || [];
        catalog.tools.push({
            name: 'firecrawl_scrape',
            description: 'Scrape a URL and return markdown.',
            inputSchema: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] }
        });
    }

    toolCatalogCache.engine = engine;
    toolCatalogCache.togglesKey = key;
    toolCatalogCache.ts = now;
    toolCatalogCache.catalog = catalog;
    return catalog;
}

function normalizePlan(plan) {
    if (!plan) return plan;
    const goalText = String(plan.taskSummary || '').toLowerCase();
    if (!plan.targetURL || !plan.targetURL.trim()) {
        plan.targetURL = 'https://duckduckgo.com';
    }
    if (typeof plan.mcpHeadless !== 'boolean') {
        plan.mcpHeadless = true;
    }
    const isSearchGoal = /(search|find|identify|top|best|restaurants|reviews|ratings|website|web sitesi|url|link)/i.test(plan.taskSummary || '');
    const buildSearchUrl = (q) => `https://duckduckgo.com/?q=${encodeURIComponent(q)}`;
    if (Array.isArray(plan.plan)) {
        plan.plan = plan.plan.map(step => {
            if (!step.arguments) step.arguments = {};
            if (step.tool === 'navigate') {
                if (!step.arguments.url) {
                    step.arguments.url = isSearchGoal ? buildSearchUrl(plan.taskSummary || '') : plan.targetURL;
                }
                if (isSearchGoal && /google\.com\/search/i.test(step.arguments.url)) {
                    step.arguments.url = buildSearchUrl(plan.taskSummary || '');
                }
            }
            return step;
        });
        const hasSummarize = plan.plan.some(step => step.tool === 'summarize');
        if (!hasSummarize) {
            plan.plan.push({
                step: 'Summarize the findings and present the top three restaurants with their official website URLs.',
                tool: 'summarize',
                arguments: {
                    url: '',
                    query: '',
                    bx_id: '',
                    text: '',
                    direction: '',
                    selector: '',
                    reason: '',
                    timeoutMs: ''
                },
                successCriteria: 'Final response contains 3 restaurants and their official websites.',
                fallbacks: []
            });
        }
    }
    return plan;
}
function getDefaultModel(provider) {
    if (provider === 'codex') return 'gpt-5.1-codex-mini';
    if (provider === 'gemini') return 'gemini-3-flash';
    return null;
}

setToolToggles(getToolToggles());

function isCommandAvailable(command) {
    try {
        if (process.platform === 'win32') {
            execFileSync('where', [command], { stdio: 'ignore' });
        } else {
            execFileSync('sh', ['-c', `command -v ${command}`], { stdio: 'ignore' });
        }
        return true;
    } catch {
        return false;
    }
}

function getCodexStatus() {
    const available = isCommandAvailable('codex');
    if (!available) return { available, loggedIn: false };
    try {
        execFileSync('codex', ['login', 'status'], { stdio: 'ignore' });
        return { available, loggedIn: true };
    } catch {
        return { available, loggedIn: false };
    }
}

function getGeminiStatus() {
    const available = isCommandAvailable('gemini');
    if (!available) return { available, loggedIn: false };
    if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) {
        return { available, loggedIn: true };
    }
    const geminiCredsPath = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
    return { available, loggedIn: fs.existsSync(geminiCredsPath) };
}

function getOpenAIStatus() {
    return { available: true, loggedIn: Boolean(process.env.OPENAI_API_KEY) };
}

function resolveActiveProvider(status) {
    const state = loadAuthState();
    let activeProvider = state.provider || null;
    const providerReady = (provider) => {
        if (provider === 'openai') return status.openai.loggedIn;
        if (provider === 'codex') return status.codex.loggedIn;
        if (provider === 'gemini') return status.gemini.loggedIn;
        return false;
    };

    if (activeProvider && !providerReady(activeProvider)) {
        activeProvider = null;
    }
    if (!activeProvider) {
        if (status.openai.loggedIn) activeProvider = 'openai';
        else if (status.codex.loggedIn) activeProvider = 'codex';
        else if (status.gemini.loggedIn) activeProvider = 'gemini';
    }

    if (activeProvider !== state.provider) {
        updateAuthState({ provider: activeProvider });
    }
    process.env.AGENTX_PROVIDER = activeProvider || '';
    return activeProvider;
}

function launchTerminalCommand(command) {
    if (process.platform === 'darwin') {
        const sanitized = command.replace(/"/g, '\\"');
        execFileSync('osascript', ['-e', `tell application "Terminal" to do script "${sanitized}"`], { stdio: 'ignore' });
        return { method: 'terminal' };
    }
    spawn(command, { shell: true, detached: true, stdio: 'ignore' }).unref();
    return { method: 'spawn' };
}

function getLocalIpAddress() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

const expressApp = express();
const server = http.createServer(expressApp);
const wss = new WebSocketServer({ server });

expressApp.use(express.json());
expressApp.use(express.static(path.join(__dirname))); 

const clients = new Set();
wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    console.log(`📢 New client connected. Total clients: ${clients.size}`);
});

function broadcast(message) {
    for (const client of clients) {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    }
}

const promptForCredentials = (domain) => {
    return new Promise((resolve) => {
        credentialRequest = {
            isWaiting: true,
            resolver: resolve,
        };
        broadcast(`CREDENTIALS_REQUEST::${JSON.stringify({ domain })}`);
    });
};

expressApp.post('/api/submit-credentials', async (req, res) => {
    const { domain, username, password, success, error } = req.body;
    if (!credentialRequest.isWaiting) {
        return res.status(400).json({ success: false, error: 'No active credential request.' });
    }
    if (success === false) {
        credentialRequest.resolver({ success: false, error: error || 'User canceled credential entry.' });
        credentialRequest = { isWaiting: false, resolver: null };
        return res.json({ success: true, message: 'Cancellation acknowledged.' });
    }
    console.log(`Received credentials for ${domain}`);
    let store = {};
    if (fs.existsSync(CREDENTIALS_PATH)) {
        try {
            store = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
        } catch (e) { console.error("Error reading credential store, will overwrite.", e); }
    }
    store[domain] = { username, password };
    fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(store, null, 2));
    console.log(`✅ Credentials for ${domain} saved.`);
    credentialRequest.resolver({ success: true });
    credentialRequest = { isWaiting: false, resolver: null };
    res.json({ success: true });
});

expressApp.get('/api/auth/status', (req, res) => {
    const state = loadAuthState();
    const status = {
        openai: getOpenAIStatus(),
        codex: getCodexStatus(),
        gemini: getGeminiStatus(),
    };
    const activeProvider = resolveActiveProvider(status);
    res.json({
        success: true,
        activeProvider,
        status,
        models: state.models || {},
        browserEngine: 'mcp',
        toggles: state.toggles || { tavily: false, firecrawl: false }
    });
});

expressApp.post('/api/auth/set-provider', (req, res) => {
    const { provider } = req.body;
    if (!['openai', 'codex', 'gemini'].includes(provider)) {
        return res.status(400).json({ success: false, error: 'Invalid provider.' });
    }
    const status = {
        openai: getOpenAIStatus(),
        codex: getCodexStatus(),
        gemini: getGeminiStatus(),
    };
    const providerReady = (provider === 'openai' && status.openai.loggedIn)
        || (provider === 'codex' && status.codex.loggedIn)
        || (provider === 'gemini' && status.gemini.loggedIn);

    if (!providerReady) {
        return res.status(400).json({ success: false, error: `${provider} is not logged in.` });
    }
    updateAuthState({ provider });
    process.env.AGENTX_PROVIDER = provider;
    res.json({ success: true, provider });
});

expressApp.post('/api/auth/login', (req, res) => {
    const { provider } = req.body;
    if (!['codex', 'gemini'].includes(provider)) {
        return res.status(400).json({ success: false, error: 'Invalid provider for login.' });
    }
    const status = provider === 'codex' ? getCodexStatus() : getGeminiStatus();
    if (!status.available) {
        return res.status(400).json({ success: false, error: `${provider} CLI is not installed.` });
    }
    const command = provider === 'codex' ? 'codex login' : 'gemini';
    try {
        const launched = launchTerminalCommand(command);
        return res.json({ success: true, command, launched });
    } catch (error) {
        return res.status(500).json({ success: false, error: error.message });
    }
});

expressApp.post('/api/auth/set-model', (req, res) => {
    const { provider, model } = req.body;
    if (!['codex', 'gemini'].includes(provider)) {
        return res.status(400).json({ success: false, error: 'Invalid provider.' });
    }
    if (!model || typeof model !== 'string') {
        return res.status(400).json({ success: false, error: 'Model is required.' });
    }
    const state = updateAuthState({ models: { [provider]: model } });
    res.json({ success: true, models: state.models });
});


expressApp.post('/api/settings/tool-toggle', (req, res) => {
    const { tool, enabled } = req.body;
    if (!['tavily', 'firecrawl'].includes(tool)) {
        return res.status(400).json({ success: false, error: 'Invalid tool.' });
    }
    const state = updateAuthState({ toggles: { [tool]: Boolean(enabled) } });
    setToolToggles(state.toggles || {});
    res.json({ success: true, toggles: state.toggles || {} });
});


async function processQueue() {
    if (isAgentRunning || taskQueue.length === 0) {
        return;
    }

    isAgentRunning = true;
    const { taskPlan, taskId } = taskQueue.shift();
    const userGoal = taskPlan.taskSummary;
    const taskLogger = (message) => broadcast(`${taskId}::log::${message}`);

    try {
        console.log(`▶️ Picking up task ${taskId} from queue.`);
        broadcast(`${taskId}::TASK_STATUS_UPDATE::running`);
        agentControls[taskId] = { stop: false, isRunning: true };
        taskLogger(`▶️ Agent starting execution for: "${userGoal}"`);
        let finalSummary;
        finalSummary = await runAutonomousAgentMcp(
            userGoal,
            taskPlan,
            taskLogger,
            agentControls[taskId]
        );
        if (finalSummary) {
            broadcast(`${taskId}::TASK_RESULT::${finalSummary}`);
        }
        broadcast(`${taskId}::TASK_STATUS_UPDATE::completed`);
    } catch (error) {
        const isUserStop = error.message.includes("Agent stopped by user") || error.message.includes("User canceled");
        if (isUserStop) {
            taskLogger(`⏹️ Agent execution has been stopped by the user. Reason: ${error.message}`);
            broadcast(`${taskId}::TASK_STATUS_UPDATE::stopped`);
        } else {
             taskLogger(`🚨 FINAL ERROR: ${error.message}`);
             broadcast(`${taskId}::TASK_STATUS_UPDATE::failed`);
        }
    } finally {
        delete agentControls[taskId];
        isAgentRunning = false;
        process.nextTick(processQueue);
    }
}

expressApp.get('/api/qr-code', async (req, res) => {
    try {
        const localIp = getLocalIpAddress();
        const serverUrl = `http://${localIp}:${PORT}`;
        const qrCodeDataUrl = await qrcode.toDataURL(serverUrl, { errorCorrectionLevel: 'H', type: 'image/png', margin: 2, width: 256 });
        res.json({ success: true, qrCode: qrCodeDataUrl, url: serverUrl });
    } catch (err) {
        console.error('Failed to generate QR code', err);
        res.status(500).json({ success: false, error: 'Failed to generate QR code' });
    }
});

expressApp.post('/api/get-plan', async (req, res) => {
    const goal = req.body.goal;
    console.log(`Received goal: "${goal}". Generating plan with AI.`);
    const catalog = await getPlanningToolCatalog();
    if (!catalog.tools || catalog.tools.length === 0) {
        console.log('Tool catalog is empty. Cannot create tool-level plan.');
        return res.status(500).json({ success: false, error: 'No tools available for planning. Check MCP engine or tool toggles.' });
    }

    const aiPlan = await createToolPlan(goal, catalog, (msg) => console.log(`[PlanGen] ${msg}`));
    if (aiPlan) {
        res.json({ success: true, plan: normalizePlan(aiPlan) });
        return;
    }
    console.log(`AI plan generation failed.`);
    res.status(500).json({ success: false, error: "AI Planner failed to generate a valid plan." });
});

expressApp.post('/api/interpret-goal', async (req, res) => {
    const goal = req.body.goal;
    console.log(`Interpreting goal: "${goal}"`);
    const interpretation = await interpretGoal(goal, (msg) => console.log(`[Intent] ${msg}`));
    if (interpretation && interpretation.error) {
        res.status(500).json({ success: false, error: interpretation.error });
    } else if (interpretation) {
        res.json({ success: true, interpretation });
    } else {
        res.status(500).json({ success: false, error: 'Failed to interpret goal.' });
    }
});

expressApp.post('/api/run-task', async (req, res) => {
    const { plan, taskId } = req.body;
    if (plan.isRecurring) {
        if (!plan.cron || !cron.validate(plan.cron)) {
            const errorMsg = `Invalid or missing CRON string: "${plan.cron}"`;
            broadcast(`${taskId}::log::🚨 ERROR: ${errorMsg}`);
            broadcast(`${taskId}::TASK_STATUS_UPDATE::failed`);
            return res.status(400).json({ success: false, error: errorMsg });
        }
        broadcast(`${taskId}::log::✅ Task scheduled successfully with schedule: "${plan.schedule}"`);
        const job = cron.schedule(plan.cron, () => {
            console.log(`⏰ Cron job triggered for parent task ${taskId} (${plan.taskSummary})`);
            const newRunTaskId = Date.now();
            broadcast(`${taskId}::log::⏰ Triggering scheduled run. New task ID: ${newRunTaskId}`);
            broadcast(`${taskId}::RUN_INCREMENT`);
            const taskInstance = { taskPlan: { ...plan, isRecurring: false, parentId: taskId }, taskId: newRunTaskId };
            taskQueue.push(taskInstance);
            const newTaskForUI = {
                id: newRunTaskId, summary: `Run of: ${plan.taskSummary}`, status: 'queued',
                startTime: new Date(), plan: taskInstance.taskPlan, isRecurring: false, parentId: taskId,
                log: `Queued by schedule "${plan.schedule}".\n`,
                provider: process.env.AGENTX_PROVIDER || null,
                model: (loadAuthState().models && loadAuthState().models[process.env.AGENTX_PROVIDER])
                    ? loadAuthState().models[process.env.AGENTX_PROVIDER]
                    : getDefaultModel(process.env.AGENTX_PROVIDER),
            };
            broadcast(`${newRunTaskId}::NEW_TASK_INSTANCE::${JSON.stringify(newTaskForUI)}`);
            processQueue();
        });
        scheduledJobs[taskId] = job;
        res.json({ success: true, scheduled: true });
    } else {
        taskQueue.push({ taskPlan: plan, taskId });
        broadcast(`${taskId}::log::✅ Task has been added to the queue.`);
        res.json({ success: true, queued: true });
        processQueue();
    }
});

expressApp.post('/api/stop-agent', async (req, res) => {
    const { taskId } = req.body;
    let wasActionTaken = false;
    try {
        if (agentControls[taskId]) {
            console.log(`🔴 Stop signal received for RUNNING task ${taskId}.`);
            agentControls[taskId].stop = true;
            wasActionTaken = true;
        }
        let taskIndex = taskQueue.findIndex(task => task.taskId === taskId);
        if(taskIndex > -1) {
            console.log(`🔴 Removing QUEUED task ${taskId}.`);
            taskQueue.splice(taskIndex, 1);
            broadcast(`${taskId}::TASK_STATUS_UPDATE::stopped`);
            broadcast(`${taskId}::log::⏹️ Task removed from queue.`);
            wasActionTaken = true;
        }
        if (scheduledJobs[taskId]) {
            console.log(`🔴 Stop signal received for SCHEDULED task ${taskId}.`);
            scheduledJobs[taskId].stop();
            delete scheduledJobs[taskId];
            broadcast(`${taskId}::TASK_STATUS_UPDATE::stopped`);
            broadcast(`${taskId}::log::⏹️ Schedule has been canceled.`);
            wasActionTaken = true;
        }
        if (!wasActionTaken) {
            console.log(`⚠️ Stop request for task ${taskId}, but it was not found as running, queued, or scheduled.`);
        }
        res.json({ success: true });
    } catch (error) {
         console.error(`🚨 Error in /api/stop-agent for task ${taskId}:`, error);
         res.status(500).json({ success: false, error: error.message });
    }
});

resolveActiveProvider({
    openai: getOpenAIStatus(),
    codex: getCodexStatus(),
    gemini: getGeminiStatus(),
});

server.listen(PORT, "0.0.0.0", () => {
    console.log(`--- AgentX Backend Server running at http://localhost:${PORT} ---`);
    console.log('--- This server is managed by the Tauri application ---');
});
