// main.js

require('dotenv').config();

if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is not set.');
    console.error('Create a .env file with OPENAI_API_KEY or set it in your environment.');
    process.exit(1);
}

const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');
const cron = require('node-cron');
const fs = require('fs');
const { createPlan } = require('./agent_api.js');
const { runAutonomousAgent } = require('./playwright_executor.js');

const PORT = process.env.PORT || 3000;

const SCHEDULED_TASKS_PATH = path.join(__dirname, 'scheduled_tasks.json');
const CREDENTIALS_PATH = path.join(__dirname, 'credential_store.json');

let taskQueue = [];
let isAgentRunning = false;
const agentControls = {};
const scheduledJobs = {};

// --- New Credential Handling Logic ---
let credentialRequest = {
    isWaiting: false,
    resolver: null,
};

const expressApp = express();
const server = http.createServer(expressApp);
const wss = new WebSocketServer({ server });

expressApp.use(express.json());
// Serve frontend files from the root directory
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

// Replaces the old Electron IPC-based prompt
const promptForCredentials = (domain) => {
    return new Promise((resolve) => {
        // Store the resolver function and set the waiting flag
        credentialRequest = {
            isWaiting: true,
            resolver: resolve,
        };
        // Broadcast a request to the frontend
        broadcast(`CREDENTIALS_REQUEST::${JSON.stringify({ domain })}`);
    });
};

// New endpoint for the frontend to submit credentials
expressApp.post('/api/submit-credentials', async (req, res) => {
    const { domain, username, password, success, error } = req.body;

    if (!credentialRequest.isWaiting) {
        return res.status(400).json({ success: false, error: 'No active credential request.' });
    }

    if (success === false) {
        // User canceled the modal
        credentialRequest.resolver({ success: false, error: error || 'User canceled credential entry.' });
        credentialRequest = { isWaiting: false, resolver: null };
        return res.json({ success: true, message: 'Cancellation acknowledged.' });
    }
    
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

    // Resolve the promise to unblock the agent
    credentialRequest.resolver({ success: true });
    credentialRequest = { isWaiting: false, resolver: null };

    res.json({ success: true });
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
        
        const finalSummary = await runAutonomousAgent(
            userGoal, 
            taskPlan,
            taskLogger, 
            agentControls[taskId], 
            promptForCredentials
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
    // This feature is deprecated in the Tauri version for simplicity.
    res.status(404).json({ success: false, error: 'QR Code feature not available.' });
});

expressApp.post('/api/get-plan', async (req, res) => {
    const goal = req.body.goal;
    console.log(`Received goal: "${goal}". Generating plan with AI.`);
    
    const aiPlan = await createPlan(goal, (msg) => console.log(`[PlanGen] ${msg}`));

    if (aiPlan) {
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
        res.status(500).json({ success: false, plan: dummyPlan, error: "AI Planner failed to generate a valid plan." });
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

            const taskInstance = {
                taskPlan: { ...plan, isRecurring: false, parentId: taskId },
                taskId: newRunTaskId
            };
            taskQueue.push(taskInstance);
            
            const newTaskForUI = {
                id: newRunTaskId,
                summary: `Run of: ${plan.taskSummary}`,
                status: 'queued',
                startTime: new Date(),
                plan: taskInstance.taskPlan,
                isRecurring: false,
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

// The main entry point is now just starting the server.
server.listen(PORT, "0.0.0.0", () => {
    console.log(`--- AgentX Backend Server running at http://localhost:${PORT} ---`);
    console.log('--- This server is managed by the Tauri application ---');
});