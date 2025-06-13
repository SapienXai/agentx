// renderer.js

// --- STATE ---
let currentPlan = null;
let taskHistory = [];

// --- SCREEN SELECTORS ---
const screens = document.querySelectorAll('.screen');

// --- AGENT SCREEN ELEMENTS ---
const goalInput = document.getElementById('goal-input');
const planButton = document.getElementById('plan-button');
const planConfirmationView = document.getElementById('plan-confirmation');
const agentRunningView = document.getElementById('agent-running-view');
const planUrl = document.getElementById('plan-url');
const planTask = document.getElementById('plan-task');
const planStrategy = document.getElementById('plan-strategy');
const confirmButton = document.getElementById('confirm-button');
const cancelButton = document.getElementById('cancel-button');
const runningTaskSummary = document.getElementById('running-task-summary');
const statusLog = document.getElementById('status-log');
const stopButton = document.getElementById('stop-button');

// --- HISTORY SCREEN ELEMENTS ---
const historyList = document.getElementById('history-list');
const noHistoryMessage = document.getElementById('no-history-message');

// --- CONNECT SCREEN ELEMENTS ---
const qrCodeImage = document.getElementById('qr-code-image');
const qrSpinner = document.getElementById('qr-spinner');
const connectUrl = document.getElementById('connect-url');

// --- NAVBAR ELEMENTS ---
const navLinks = document.querySelectorAll('.nav-link');

// --- WEBSOCKET CONNECTION ---
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(`${wsProtocol}//${window.location.host}`);
socket.onmessage = (event) => logMessage(event.data);
socket.onopen = () => console.log('WebSocket connection established.');
socket.onerror = (error) => {
    console.error('WebSocket Error:', error);
    logMessage('--- ⚠️ WebSocket Connection Lost. Please refresh. ---');
};

// --- UI LOGIC ---

const logMessage = (message) => {
    if (statusLog.textContent.startsWith('Waiting for instructions...')) {
        statusLog.textContent = '';
    }
    statusLog.textContent += message + '\n';
    statusLog.scrollTop = statusLog.scrollHeight;
};

// +++ THIS FUNCTION IS REWRITTEN FOR BENTO GRID & MICRO-MOTION +++
const renderHistory = () => {
    localStorage.setItem('taskHistory', JSON.stringify(taskHistory));

    if (taskHistory.length === 0) {
        noHistoryMessage.classList.remove('d-none');
        historyList.innerHTML = '';
        return;
    }
    noHistoryMessage.classList.add('d-none');
    historyList.innerHTML = '';

    taskHistory.slice().reverse().forEach(task => {
        let badgeClass = '';
        let icon = '';
        switch(task.status) {
            case 'Running': badgeClass = 'bg-primary'; icon = '<i class="bi bi-arrow-repeat"></i>'; break;
            case 'Completed': badgeClass = 'bg-success'; icon = '<i class="bi bi-check-circle-fill"></i>'; break;
            case 'Failed': badgeClass = 'bg-danger'; icon = '<i class="bi bi-x-octagon-fill"></i>'; break;
            case 'Stopped': badgeClass = 'bg-warning text-dark'; icon = '<i class="bi bi-stop-circle-fill"></i>'; break;
        }
        
        const taskItem = document.createElement('div');
        // Add classes for bento tile and pop-in animation
        taskItem.className = 'history-tile animate-pop-in';
        
        // Add glow animation for completed tasks
        if (task.status === 'Completed') {
            taskItem.classList.add('completed-glow');
        }

        taskItem.innerHTML = `
            <div class="d-flex justify-content-between align-items-start">
                <div class="me-auto">
                    <div class="fw-bold">${task.summary}</div>
                    <small class="text-muted">${new Date(task.startTime).toLocaleString()}</small>
                </div>
                <span class="badge rounded-pill ${badgeClass} fs-6 p-2">${icon}</span>
            </div>
        `;
        historyList.appendChild(taskItem);
    });
};

// --- NAVIGATION LOGIC ---
const showScreen = (screenId) => {
    screens.forEach(screen => {
        // We check for d-none to avoid removing it from a screen that is already hidden
        if (!screen.classList.contains('d-none')) {
            screen.classList.add('d-none');
        }
    });

    const activeScreen = document.getElementById(screenId);
    if (activeScreen) {
        activeScreen.classList.remove('d-none');
    }

    navLinks.forEach(link => {
        link.classList.toggle('active', link.dataset.screen === screenId);
    });
    
    if (screenId === 'connect-screen') {
        fetchQrCode();
    }
};

navLinks.forEach(link => {
    link.addEventListener('click', (e) => {
        e.preventDefault();
        showScreen(e.currentTarget.dataset.screen);
    });
});

let qrCodeFetched = false;
const fetchQrCode = async () => {
    if (qrCodeFetched) return;

    qrSpinner.classList.remove('d-none');
    qrCodeImage.classList.add('d-none');

    try {
        const response = await fetch('/api/qr-code');
        const data = await response.json();
        if (data.success) {
            qrCodeImage.src = data.qrCode;
            connectUrl.textContent = data.url;
            qrCodeFetched = true;
        } else {
            connectUrl.textContent = 'Error loading QR Code.';
        }
    } catch (error) {
        console.error('Failed to fetch QR code:', error);
        connectUrl.textContent = 'Error loading QR Code.';
    } finally {
        qrSpinner.classList.add('d-none');
        qrCodeImage.classList.remove('d-none');
    }
};

// --- EVENT LISTENERS ---
planButton.addEventListener('click', async () => {
    const goal = goalInput.value.trim();
    if (!goal) return alert('Please enter a goal first.');

    planButton.disabled = true;
    planButton.textContent = 'Planning...';
    
    showScreen('agent-screen');
    planConfirmationView.classList.add('d-none');
    agentRunningView.classList.remove('d-none');
    statusLog.textContent = 'Waiting for instructions...';
    
    const response = await fetch('/api/get-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ goal })
    });
    
    const result = await response.json();

    if (result.success) {
        currentPlan = result.plan;
        planUrl.textContent = currentPlan.targetURL;
        planTask.textContent = currentPlan.taskSummary;
        planStrategy.textContent = currentPlan.strategy;
        agentRunningView.classList.add('d-none');
        planConfirmationView.classList.remove('d-none');
    } else {
        setTimeout(() => showScreen('home-screen'), 3000);
    }

    planButton.disabled = false;
    planButton.textContent = 'Create Plan';
});

confirmButton.addEventListener('click', async () => {
    if (!currentPlan) return;
    
    confirmButton.disabled = true;
    cancelButton.disabled = true;
    stopButton.disabled = false;
    stopButton.textContent = 'Stop Agent';

    const newTask = { id: Date.now(), summary: currentPlan.taskSummary, status: 'Running', startTime: new Date() };
    taskHistory.push(newTask);
    renderHistory();
    
    planConfirmationView.classList.add('d-none');
    agentRunningView.classList.remove('d-none');
    runningTaskSummary.textContent = currentPlan.taskSummary;
    statusLog.textContent = '';
    
    const response = await fetch('/api/run-task', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: currentPlan })
    });
    
    const result = await response.json();
    const task = taskHistory.find(t => t.id === newTask.id);

    if(task) {
        if (result.success) {
            task.status = 'Completed';
        } else if (result.isUserStop) {
            task.status = 'Stopped';
        } else {
            task.status = 'Failed';
        }
    }
    renderHistory();

    confirmButton.disabled = false;
    cancelButton.disabled = false;
    stopButton.disabled = true;
});

cancelButton.addEventListener('click', () => {
    logMessage('🟡 Plan cancelled by user.');
    goalInput.value = '';
    showScreen('home-screen');
});

stopButton.addEventListener('click', async () => {
    stopButton.disabled = true;
    stopButton.textContent = 'Stopping...';
    await fetch('/api/stop-agent', { method: 'POST' });
});

// +++ NEW: COMMAND PALETTE SHORTCUTS +++
document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') {
        return; // Don't trigger shortcuts while typing
    }

    if (e.metaKey || e.ctrlKey) { // Meta for Mac, Ctrl for Win/Linux
        switch(e.key) {
            case '1':
                e.preventDefault();
                showScreen('home-screen');
                break;
            case '2':
                e.preventDefault();
                showScreen('agent-screen');
                break;
            case '3':
                e.preventDefault();
                showScreen('history-screen');
                break;
            case '4':
                e.preventDefault();
                showScreen('connect-screen');
                break;
            case 'k': // A simple "help" shortcut
                e.preventDefault();
                alert('App Shortcuts:\n\n⌘/Ctrl + 1: Home\n⌘/Ctrl + 2: Agent\n⌘/Ctrl + 3: History\n⌘/Ctrl + 4: Connect');
                break;
        }
    }
});


// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    const stored = localStorage.getItem('taskHistory');
    if (stored) {
        try {
            taskHistory = JSON.parse(stored);
        } catch (err) {
            console.error('Failed to parse stored history', err);
            taskHistory = [];
        }
    }
    showScreen('home-screen');
    renderHistory();
    statusLog.textContent = 'Waiting for instructions...';
});