// main.js

require('dotenv').config();

if (!process.env.OPENAI_API_KEY) {
    console.error('Error: OPENAI_API_KEY environment variable is not set.');
    console.error('Create a .env file with OPENAI_API_KEY or set it in your environment.');
    process.exit(1);
}

const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const os = require('os');
const qrcode = require('qrcode');
const { createPlan } = require('./agent_api.js');
const { runAutonomousAgent } = require('./puppeteer_executor.js');

const PORT = process.env.PORT || 3000;
const agentControl = { stop: false };

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

function createWindow() {
    const localIp = getLocalIpAddress();
    const serverUrl = `http://${localIp}:${PORT}`;
    
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

    const log = (message) => broadcast(message);

    // --- API ENDPOINTS ---
    
    expressApp.get('/api/qr-code', async (req, res) => {
        try {
            const qrCodeDataUrl = await qrcode.toDataURL(serverUrl, {
                errorCorrectionLevel: 'H', type: 'image/png', margin: 2, width: 256
            });
            res.json({ success: true, qrCode: qrCodeDataUrl, url: serverUrl });
        } catch (err) {
            console.error('Failed to generate QR code', err);
            res.status(500).json({ success: false, error: 'Failed to generate QR code' });
        }
    });

    expressApp.post('/api/get-plan', async (req, res) => {
        try {
            const genericLogger = (message) => console.log(message); // Use console for planning phase
            genericLogger('🤖 Agent is thinking about a plan...');
            const plan = await createPlan(req.body.goal, genericLogger);
            genericLogger('✅ Plan received. Please review and confirm.');
            res.json({ success: true, plan: plan });
        } catch (error) {
            console.error(`🚨 FAILED TO CREATE PLAN: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    // +++ FIX: Added 'async' keyword to the function definition +++
    expressApp.post('/api/run-task', async (req, res) => {
        agentControl.stop = false;
        const { plan, taskId } = req.body;
        const taskLogger = (message) => broadcast(`${taskId}::${message}`);

        try {
            taskLogger(`▶️ Handing off to Autonomous Agent to execute goal: "${plan.taskSummary}"`);
            await runAutonomousAgent(plan.targetURL, plan.taskSummary, plan.strategy, taskLogger, agentControl);
            if (agentControl.stop) throw new Error("Agent stopped by user.");
            taskLogger('✅ Agent finished successfully!');
            res.json({ success: true });
        } catch (error) {
            const isUserStop = error.message.includes("Agent stopped by user");
            if (isUserStop) {
                taskLogger('⏹️ Agent execution has been stopped by the user.');
            }
            taskLogger(`🚨 FINAL ERROR: ${error.message}`);
            res.status(500).json({ success: false, error: error.message, isUserStop });
        }
    });

    expressApp.post('/api/stop-agent', async (req, res) => {
        console.log('🔴 Stop signal received. Halting agent...');
        if (!agentControl.stop) agentControl.stop = true;
        res.json({ success: true });
    });

    server.listen(PORT, () => {
        console.log(`Server is running at ${serverUrl}`);
        
        const win = new BrowserWindow({
            width: 600,  // Adjusted width for the new UI
            height: 800, // Adjusted height
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
            },
        });

        win.loadURL(`http://localhost:${PORT}`);
        
        win.webContents.once('dom-ready', () => {
             console.log('--- Welcome to BrowserX Agent ---');
        });
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});