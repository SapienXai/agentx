// main.js

require('dotenv').config();

if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is not set.');
    console.error('Create a .env file with OPENAI_API_KEY or set it in your environment.');
    process.exit(1);
}

const { app, BrowserWindow, screen, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const os = require('os');
const qrcode = require('qrcode');
const cron = require('node-cron');
const fs = require('fs');
const { createPlan } = require('./agent_api.js');
const { runAutonomousAgent } = require('./playwright_executor.js');

const PORT = process.env.PORT || 3000;

const SCHEDULED_TASKS_PATH = path.join(__dirname, 'scheduled_tasks.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credential_store.json');
let activeSchedules = {};

let taskQueue = [];
let isAgentRunning = false;

const agentControls = {};
const scheduledJobs = {};

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

function createWindow(win) {
    const localIp = getLocalIpAddress();
    const serverUrl = `http://${localIp}:${PORT}`;
    
    const primaryDisplay = screen.getPrimaryDisplay();
    const screenSize = primaryDisplay.workAreaSize;
    console.log(`🖥️  Detected screen work area: ${screenSize.width}x${screenSize.height}`);

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
            if (client.readyState === client.OPEN) {
                client.send(message);
            }
        }
    }

    const promptForCredentials = (domain) => {
        return new Promise((resolve, reject) => {
            win.webContents.send('show-credentials-modal', { domain });

            ipcMain.once('credentials-submitted', (event, {success, error}) => {
                if (success) {
                    resolve();
                } else {
                    reject(new Error(error || 'User canceled credential entry.'));
                }
            });
        });
    };

    // +++ NEW PROMPTER FOR HUMAN INTERVENTION +++
    const promptForHumanInput = (reason) => {
        return new Promise((resolve, reject) => {
            win.webContents.send('show-human-input-modal', { reason });

            ipcMain.once('human-input-provided', (event, { success, error }) => {
                if (success) {
                    resolve();
                } else {
                    reject(new Error(error || 'User canceled the operation.'));
                }
            });
        });
    };

    function scheduleTask(task) {
        console.warn("Scheduling is not fully supported in the new goal-oriented model yet.");
    }
    
    function saveSchedulesToFile() { /* ... unchanged ... */ }
    function loadAndRescheduleTasks() { /* ... unchanged ... */ }
    
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
            await runAutonomousAgent(
                userGoal, 
                taskPlan,
                taskLogger, 
                agentControls[taskId], 
                screenSize, 
                promptForCredentials,
                promptForHumanInput // +++ Pass the new prompter function
            );
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
        
        const aiPlan = await createPlan(goal, (msg) => console.log(`[PlanGen] ${msg}`));

        if (aiPlan) {
            const fullPlan = {
                ...aiPlan,
                isRecurring: false,
                requiresLogin: false, 
                searchTerm: goal.split(' ').slice(0, 4).join(' '),
                schedule: "",
                cron: ""
            };
            res.json({ success: true, plan: fullPlan });
        } else {
            console.log(`AI plan generation failed. Creating dummy plan for UI.`);
            const dummyPlan = {
                taskSummary: goal,
                plan: [{ step: "Agent will decide the best course of action dynamically (AI planner failed)." }],
                isRecurring: false,
                requiresLogin: false,
                targetURL: "about:blank",
                searchTerm: goal.split(' ').slice(0, 2).join(' '),
                schedule: "",
                cron: ""
            };
            res.json({ success: true, plan: dummyPlan });
        }
    });

    expressApp.post('/api/run-task', async (req, res) => {
        const { plan, taskId } = req.body;
        
        if (plan.isRecurring) {
            broadcast(`${taskId}::log::⚠️ Scheduling is not fully implemented in this version.`);
            res.status(400).json({ success: false, error: "Scheduling not implemented." });
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
                 // ... unchanged ...
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

    server.listen(PORT, "0.0.0.0", () => {
        console.log(`Server is running at ${serverUrl}`);
        loadAndRescheduleTasks();
    });
}

function main() {
    const win = new BrowserWindow({ 
        width: 600, 
        height: 800, 
        webPreferences: { 
            preload: path.join(__dirname, 'preload.js'), 
        }, 
    });

    ipcMain.handle('save-credentials', (event, { domain, username, password }) => {
        console.log(`Received credentials for ${domain}`);
        let store = {};
        if (fs.existsSync(CREDENTIALS_PATH)) {
            try {
                store = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf-8'));
            } catch (e) {
                console.error("Error reading credential store, will overwrite.", e);
            }
        }
        store[domain] = { username, password };
        fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify(store, null, 2));
        console.log(`✅ Credentials for ${domain} saved.`);
        return { success: true };
    });
    
    createWindow(win);
    win.loadURL(`http://localhost:${PORT}`);
    win.webContents.once('dom-ready', () => { console.log('--- Welcome to BrowserX Agent ---'); });
}

app.whenReady().then(main);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });