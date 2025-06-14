// renderer.js

// --- STATE ---
let taskHistory = [];

// --- SELECTORS ---
const goalInput = document.getElementById('goal-input');
const runButton = document.getElementById('run-button');
const activeTasksList = document.getElementById('active-tasks');
const archivedTasksList = document.getElementById('archived-tasks');
const noTasksMessage = document.getElementById('no-tasks-message');
const tabLinks = document.querySelectorAll('.tab-link');
const taskListsWrapper = document.getElementById('task-lists-wrapper');

// Modal Selectors
const qrModal = document.getElementById('qr-modal');
const connectButton = document.getElementById('connect-button');
const closeModalButton = document.getElementById('close-modal-button');
const qrCodeImage = document.getElementById('qr-code-image');
const qrSpinner = document.getElementById('qr-spinner');
const connectUrl = document.getElementById('connect-url');

// --- WEBSOCKET ---
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(`${wsProtocol}//${window.location.host}`);

socket.onmessage = (event) => {
    // A log message is expected to be in the format "TASK_ID::Log content"
    const [taskIdStr, ...logParts] = event.data.split('::');
    const logMessage = logParts.join('::');
    const taskId = parseInt(taskIdStr);

    if (isNaN(taskId)) {
        // Generic log, for now, let's log it to console
        console.log("Generic Log:", event.data);
        return;
    }

    const task = taskHistory.find(t => t.id === taskId);
    if (task) {
        task.log = (task.log || '') + logMessage + '\n';

        const stepInfo = parseStepProgress ? parseStepProgress(logMessage) : null;
        if (stepInfo) {
            task.progress = stepInfo;
            updateTaskProgressDisplay(task);
            localStorage.setItem('taskHistory', JSON.stringify(taskHistory));
        }

        const logElement = document.querySelector(`.task-item[data-task-id='${taskId}'] .status-log`);
        if (logElement) {
            logElement.textContent = task.log;
            logElement.scrollTop = logElement.scrollHeight;
        }
    }
};

socket.onopen = () => console.log('WebSocket connection established.');
socket.onerror = (error) => console.error('WebSocket Error:', error);


// --- UI RENDERING ---

const getStatusPill = (status) => {
    if (status === 'running') {
        return `<div class="status-pill status-running"><span class="running-indicator"></span>Running</div>`;
    }
    return `<div class="status-pill status-${status}">${status.charAt(0).toUpperCase() + status.slice(1)}</div>`;
};

const getProgressBar = (task) => {
    if (!task.progress || !task.progress.total) return '';
    return `<div class="task-progress"><progress value="${task.progress.current}" max="${task.progress.total}"></progress><span>Step ${task.progress.current} of ${task.progress.total}</span></div>`;
};

const updateTaskProgressDisplay = (task) => {
    const taskEl = document.querySelector(`.task-item[data-task-id='${task.id}']`);
    if (!taskEl) return;
    let progressEl = taskEl.querySelector('.task-progress');

    if (task.progress && task.progress.total) {
        if (!progressEl) {
            taskEl.querySelector('.task-status').insertAdjacentHTML('beforeend', getProgressBar(task));
        } else {
            const prog = progressEl.querySelector('progress');
            const span = progressEl.querySelector('span');
            prog.max = task.progress.total;
            prog.value = task.progress.current;
            span.textContent = `Step ${task.progress.current} of ${task.progress.total}`;
        }
    } else if (progressEl) {
        progressEl.remove();
    }
};

const getTaskActions = (task) => {
    switch(task.status) {
        case 'pending':
            return `
                <button class="task-action-btn confirm" data-action="confirm">Confirm & Run</button>
                <button class="task-action-btn" data-action="cancel">Cancel</button>
            `;
        case 'running':
            return `<button class="task-action-btn stop" data-action="stop">Stop Agent</button>`;
        case 'completed':
        case 'failed':
        case 'stopped':
            return `<button class="task-action-btn" data-action="archive">${task.archived ? 'Restore' : 'Archive'}</button>`;
        default:
            return '';
    }
};

const getTaskDetails = (task) => {
    let content = '';
    if (task.status === 'pending' && task.plan) {
        content += `
            <h4>Proposed Plan</h4>
            <div class="plan-details">
                <p><strong>URL:</strong> <code>${task.plan.targetURL}</code></p>
                <p><strong>Strategy:</strong> ${task.plan.strategy}</p>
            </div>
        `;
    }

    if (task.log) {
        content += `
            <h4>Agent Log</h4>
            <pre class="status-log">${task.log}</pre>
        `;
    }
    
    content += `<div class="task-actions">${getTaskActions(task)}</div>`;
    return content;
};

const createTaskElement = (task) => {
    const details = document.createElement('details');
    details.className = 'task-item';
    details.dataset.taskId = task.id;
    if (task.status === 'running' || task.status === 'pending') {
        details.open = true; // Auto-expand active tasks
    }

    details.innerHTML = `
        <summary class="task-summary">
            <div class="task-info">
                <h3>${task.summary}</h3>
                <p>${new Date(task.startTime).toLocaleString()}</p>
            </div>
            <div class="task-status">${getStatusPill(task.status)}${getProgressBar(task)}</div>
        </summary>
        <div class="task-details-content">
            ${getTaskDetails(task)}
        </div>
    `;
    return details;
};

const renderTasks = () => {
    localStorage.setItem('taskHistory', JSON.stringify(taskHistory));

    activeTasksList.innerHTML = '';
    archivedTasksList.innerHTML = '';

    const active = taskHistory.filter(t => !t.archived);
    const archived = taskHistory.filter(t => t.archived);

    if (taskHistory.length === 0) {
        noTasksMessage.classList.remove('d-none');
    } else {
        noTasksMessage.classList.add('d-none');
    }

    [...active].reverse().forEach(task => activeTasksList.appendChild(createTaskElement(task)));
    [...archived].reverse().forEach(task => archivedTasksList.appendChild(createTaskElement(task)));
};

// --- EVENT LISTENERS ---

runButton.addEventListener('click', async () => {
    const goal = goalInput.value.trim();
    if (!goal) return alert('Please enter a goal for the agent.');

    runButton.disabled = true;
    runButton.textContent = 'Planning...';

    try {
        const response = await fetch('/api/get-plan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ goal })
        });
        const result = await response.json();

        if (result.success) {
            const newTask = {
                id: Date.now(),
                summary: result.plan.taskSummary,
                status: 'pending',
                startTime: new Date(),
                plan: result.plan,
                archived: false,
                log: `Plan for "${result.plan.taskSummary}" received. Please confirm to run.\n`,
                progress: null
            };
            taskHistory.push(newTask);
            goalInput.value = '';
            renderTasks();
        } else {
            alert(`Failed to create plan: ${result.error}`);
        }
    } catch (error) {
        alert(`Network error: ${error.message}`);
    } finally {
        runButton.disabled = false;
        runButton.textContent = 'Create & Run Agent';
    }
});

taskListsWrapper.addEventListener('click', async (e) => {
    const button = e.target.closest('[data-action]');
    if (!button) return;

    const action = button.dataset.action;
    const taskItem = button.closest('.task-item');
    const taskId = parseInt(taskItem.dataset.taskId);
    const task = taskHistory.find(t => t.id === taskId);
    if (!task) return;

    switch (action) {
        case 'confirm':
            task.status = 'running';
            task.log += "Confirmed. Handing off to autonomous agent...\n";
            renderTasks(); // Update UI to "running" state immediately
            
            const response = await fetch('/api/run-task', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plan: task.plan, taskId: task.id }) // Pass taskId to backend
            });
            const result = await response.json();
            
            // Final status update
            const finalTask = taskHistory.find(t => t.id === taskId);
            if(result.success) {
                finalTask.status = 'completed';
            } else if (result.isUserStop) {
                finalTask.status = 'stopped';
            } else {
                finalTask.status = 'failed';
            }
            finalTask.progress = null;
            renderTasks();
            break;

        case 'cancel':
            taskHistory = taskHistory.filter(t => t.id !== taskId);
            renderTasks();
            break;

        case 'stop':
            button.disabled = true;
            button.textContent = "Stopping...";
            await fetch('/api/stop-agent', { method: 'POST' });
            break;

        case 'archive':
            task.archived = !task.archived;
            // A slight delay for the animation
            taskItem.style.transition = 'opacity 0.3s, transform 0.3s';
            taskItem.style.opacity = '0';
            taskItem.style.transform = 'scale(0.95)';
            setTimeout(renderTasks, 300);
            break;
    }
});


// Tab Switching
tabLinks.forEach(tab => {
    tab.addEventListener('click', (e) => {
        e.preventDefault();
        tabLinks.forEach(link => link.classList.remove('active'));
        e.currentTarget.classList.add('active');
        
        const targetId = e.currentTarget.dataset.target;
        document.getElementById('active-tasks').style.display = targetId === 'active-tasks' ? 'flex' : 'none';
        document.getElementById('archived-tasks').style.display = targetId === 'archived-tasks' ? 'flex' : 'none';
    });
});


// --- MODAL LOGIC ---
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
        connectUrl.textContent = 'Error loading QR Code.';
    } finally {
        qrSpinner.classList.add('d-none');
        qrCodeImage.classList.remove('d-none');
    }
};

connectButton.addEventListener('click', () => {
    qrModal.classList.remove('d-none');
    fetchQrCode();
});

closeModalButton.addEventListener('click', () => {
    qrModal.classList.add('d-none');
});

qrModal.addEventListener('click', (e) => {
    if (e.target === qrModal) { // only close if clicking on the overlay itself
        qrModal.classList.add('d-none');
    }
});


// --- INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    const storedHistory = localStorage.getItem('taskHistory');
    if (storedHistory) {
        try {
            // Revive task statuses - tasks that were 'running' or 'pending' should be considered 'stopped' on restart.
            taskHistory = JSON.parse(storedHistory).map(task => {
                if (task.status === 'running' || task.status === 'pending') {
                    task.status = 'stopped';
                    task.log = (task.log || '') + '\n--- Task interrupted by app restart. ---\n';
                    task.progress = null;
                }
                return task;
            });
        } catch (e) {
            console.error("Failed to parse task history:", e);
            taskHistory = [];
        }
    }
    renderTasks();
});