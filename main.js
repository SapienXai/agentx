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
    
    function saveSchedulesToFile() {
        // This function would be more robust in a real app, saving active cron jobs
        // For now, we are not persisting schedules across restarts.
        console.log("Saving schedules is a stub for now.");
    }

    function loadAndRescheduleTasks() {
        // This function would load from a file and restart cron jobs
        console.log("Loading and rescheduling tasks is a stub for now.");
    }
    
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
            
            // +++ CAPTURE THE RESULT FROM THE AGENT +++
            const finalSummary = await runAutonomousAgent(
                userGoal, 
                taskPlan,
                taskLogger, 
                agentControls[taskId], 
                screenSize, 
                promptForCredentials
            );
            
            // +++ BROADCAST THE RESULT IF IT EXISTS +++
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
            // The AI now provides all necessary fields, including for scheduling.
            res.json({ success: true, plan: aiPlan });
        } else {
            console.log(`AI plan generation failed. Creating dummy plan for UI.`);
            const dummyPlan = {
                taskSummary: goal,
                plan: [{ step: "Agent will decide the best course of action dynamically (AI planner failed)." }],
                isRecurring: false,
                schedule: "",
                cron: "",
                targetURL: "about:blank",
            };
            res.json({ success: false, plan: dummyPlan, error: "AI Planner failed to generate a valid plan." });
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
                const newRunTaskId = Date.now(); // Create a new, unique ID for this specific run
                broadcast(`${taskId}::log::⏰ Triggering scheduled run. New task ID: ${newRunTaskId}`);
                broadcast(`${taskId}::RUN_INCREMENT`);

                // Create a new task instance for the queue
                const taskInstance = {
                    taskPlan: { ...plan, isRecurring: false, parentId: taskId }, // It's a single run now
                    taskId: newRunTaskId
                };
                taskQueue.push(taskInstance);
                
                // Manually create the task in the frontend UI under the queue
                const newTaskForUI = {
                    id: newRunTaskId,
                    summary: `Run of: ${plan.taskSummary}`,
                    status: 'queued',
                    startTime: new Date(),
                    plan: taskInstance.taskPlan,
                    isRecurring: false, // This instance is not recurring
                    parentId: taskId,
                    log: `Queued by schedule "${plan.schedule}".\n`,
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