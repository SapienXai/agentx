// main.js

require('dotenv').config();

const { app, BrowserWindow } = require('electron');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');
const os = require('os');
const qrcode = require('qrcode'); // +++ NEW
const { createPlan } = require('./agent_api.js');
const { runAutonomousAgent } = require('./puppeteer_executor.js');

const PORT = 3000;
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
        log(`📢 New client connected. Total clients: ${clients.size}`);
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
    
    // +++ THIS IS THE NEW ENDPOINT +++
    expressApp.get('/api/get-qr-code', async (req, res) => {
        try {
            const qrCodeDataUrl = await qrcode.toDataURL(serverUrl, {
                errorCorrectionLevel: 'H',
                type: 'image/png',
                margin: 2,
                width: 256
            });
            res.json({ success: true, qrCode: qrCodeDataUrl, url: serverUrl });
        } catch (err) {
            console.error('Failed to generate QR code', err);
            res.status(500).json({ success: false, error: 'Failed to generate QR code' });
        }
    });

    expressApp.post('/api/get-plan', async (req, res) => {
        try {
            log('🤖 Agent is thinking about a plan...');
            const plan = await createPlan(req.body.goal, log);
            log('✅ Plan received. Please review and confirm.');
            res.json({ success: true, plan: plan });
        } catch (error) {
            log(`🚨 FAILED TO CREATE PLAN: ${error.message}`);
            res.status(500).json({ success: false, error: error.message });
        }
    });

    expressApp.post('/api/run-task', async (req, res) => {
        agentControl.stop = false;
        try {
            const plan = req.body.plan;
            log(`▶️ Handing off to Autonomous Agent to execute goal: "${plan.taskSummary}"`);
            await runAutonomousAgent(plan.targetURL, plan.taskSummary, plan.strategy, log, agentControl);
            if (agentControl.stop) throw new Error("Agent stopped by user.");
            log('✅ Agent finished successfully!');
            res.json({ success: true });
        } catch (error) {
            const isUserStop = error.message.includes("Agent stopped by user");
            if (isUserStop) log('⏹️ Agent execution has been stopped by the user.');
            log(`🚨 FINAL ERROR: ${error.message}`);
            res.status(500).json({ success: false, error: error.message, isUserStop });
        }
    });

    expressApp.post('/api/stop-agent', async (req, res) => {
        log('🔴 Stop signal received. Halting agent...');
        if (!agentControl.stop) agentControl.stop = true;
        res.json({ success: true });
    });

    server.listen(PORT, () => {
        console.log(`Server is running at ${serverUrl}`);
        
        const win = new BrowserWindow({
            width: 800,
            height: 700,
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
            },
        });

        win.loadURL(`http://localhost:${PORT}`);
        
        win.webContents.once('dom-ready', () => {
             log('--- Welcome to BrowserX Agent ---');
             log(`🚀 Access this app from another device by scanning the QR code in the 'Connect' tab.`);
        });
    });
}

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});