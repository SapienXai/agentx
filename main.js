// main.js

require('dotenv').config();

if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is not set.');
    console.error('Create a .env file with OPENAI_API_KEY or set it in your environment.');
    process.exit(1);
}

const { app, BrowserWindow, screen, ipcMain } = require('electron'); // +++ MODIFIED
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
const CREDENTIALS_PATH = path.join(__dirname, 'credential_store.json'); // +++ NEW
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

function createWindow(win) { // +++ MODIFIED to accept win
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

    // +++ NEW: Function to prompt for credentials via IPC
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

    function scheduleTask(task) {
        const { id: taskId, plan } = task;

        if (!cron.validate(plan.cron)) {
            console.error(`Attempted to schedule task ${taskId} with invalid cron: ${plan.cron}`);
            return;
        }

        const job = cron.schedule(plan.cron, () => {
            broadcast(`${taskId}::RUN_INCREMENT`);
            broadcast(`${taskId}::log::⏰ Cron triggered. Creating a new run instance...`);

            const runInstanceId = Date.now();
            const runInstancePlan = { ...plan, isRecurring: false, schedule: '', cron: '' };
            runInstancePlan.parentId = taskId; 
            
            const runInstanceTask = {
                id: runInstanceId,
                summary: plan.taskSummary,
                status: 'queued',
                startTime: new Date(),
                plan: runInstancePlan,
                isRecurring: false,
                archived: false,
                log: `[Run Instance] Created by scheduled task ${taskId}.\n`,
                progress: null,
                runCount: 0
            };

            broadcast(`${runInstanceId}::CREATE_RUN_INSTANCE::${JSON.stringify(runInstanceTask)}`);
            taskQueue.push({ plan: runInstancePlan, taskId: runInstanceId });
            processQueue();
        });

        scheduledJobs[taskId] = job;
        activeSchedules[taskId] = task;
        console.log(`✅ Task ${taskId} successfully scheduled with pattern: "${plan.schedule}"`);
    }
    
    function saveSchedulesToFile() {
        try {
            fs.writeFileSync(SCHEDULED_TASKS_PATH, JSON.stringify(activeSchedules, null, 2));
            console.log('🗓️  Schedules saved to disk.');
        } catch (error) {
            console.error('🚨 Failed to save schedules to file:', error);
        }
    }

    function loadAndRescheduleTasks() {
        try {
            if (fs.existsSync(SCHEDULED_TASKS_PATH)) {
                const data = fs.readFileSync(SCHEDULED_TASKS_PATH, 'utf8');
                if (data) {
                    const loadedSchedules = JSON.parse(data);
                    activeSchedules = loadedSchedules;
                    console.log(`... Found ${Object.keys(activeSchedules).length} schedules to load.`);
                    for (const taskId in activeSchedules) {
                        scheduleTask(activeSchedules[taskId]);
                    }
                }
            } else {
                 console.log('No existing schedules file found. Starting fresh.');
            }
        } catch (error) {
            console.error('🚨 Failed to load and reschedule tasks:', error);
            activeSchedules = {};
        }
    }
    
    async function processQueue() {
        if (isAgentRunning || taskQueue.length === 0) {
            return;
        }

        isAgentRunning = true;
        const { plan, taskId } = taskQueue.shift();
        const taskLogger = (message) => broadcast(`${taskId}::log::${message}`);

        try {
            console.log(`▶️ Picking up task ${taskId} from queue.`);
            broadcast(`${taskId}::TASK_STATUS_UPDATE::running`);
            
            agentControls[taskId] = { stop: false, isRunning: true };
            
            taskLogger(`▶️ Agent starting execution for: "${plan.taskSummary}"`);
            await runAutonomousAgent(
                plan.targetURL, 
                plan.taskSummary, 
                plan.plan, 
                taskLogger, 
                agentControls[taskId], 
                screenSize, 
                promptForCredentials // +++ MODIFIED
            );
            taskLogger('✅ Agent finished successfully!');
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
        try {
            const genericLogger = (message) => console.log(message);
            genericLogger('🤖 Agent is thinking about a plan...');
            const plan = await createPlan(req.body.goal, genericLogger);
            genericLogger('✅ Plan received. Please review and confirm.');
            res.json({ success: true, plan: plan });
        } catch (error) {
            console.error(`🚨 FAILED TO CREATE PLAN: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    expressApp.post('/api/run-task', async (req, res) => {
        const { plan, taskId } = req.body;
        
        if (plan.isRecurring) {
            const taskToSchedule = { id: taskId, plan, summary: plan.taskSummary, isRecurring: true, status: 'scheduled' };
            scheduleTask(taskToSchedule);
            saveSchedulesToFile();
            res.json({ success: true, scheduled: true });
        } else {
            taskQueue.push({ plan, taskId });
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

                delete activeSchedules[taskId];
                saveSchedulesToFile();
                
                const initialQueueLength = taskQueue.length;
                taskQueue = taskQueue.filter(task => {
                    if (task.plan.parentId === taskId) {
                        console.log(`... also removing its queued instance ${task.taskId}.`);
                        broadcast(`${task.taskId}::TASK_STATUS_UPDATE::stopped`);
                        broadcast(`${task.taskId}::log::⏹️ Parent schedule was canceled.`);
                        return false;
                    }
                    return true;
                });
                if (taskQueue.length < initialQueueLength) {
                    console.log(`... cleared ${initialQueueLength - taskQueue.length} instances from the queue.`);
                }

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

    server.listen(PORT, "0.0.0.0", () => { // Modified to listen on all interfaces
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

    // +++ NEW: IPC Handler for saving credentials
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
    
    createWindow(win); // Pass window object
    win.loadURL(`http://localhost:${PORT}`);
    win.webContents.once('dom-ready', () => { console.log('--- Welcome to BrowserX Agent ---'); });
}

app.whenReady().then(main);

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });