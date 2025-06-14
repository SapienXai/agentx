// renderer.js

// --- STATE ---
let taskHistory = [];

// --- SELECTORS ---
const goalInput = document.getElementById('goal-input');
const runButton = document.getElementById('run-button');
const tasksList = document.getElementById('tasks-list');
const queueList = document.getElementById('queue-list');
const scheduledTasksList = document.getElementById('scheduled-tasks');
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
    const [taskIdStr, ...parts] = event.data.split('::');
    const command = parts[0];
    const payload = parts.slice(1).join('::');
    const taskId = parseInt(taskIdStr);

    if (isNaN(taskId)) {
        console.log("Generic Log:", event.data);
        return;
    }
    
    if (command === 'CREATE_RUN_INSTANCE') {
        const newRunTask = JSON.parse(payload);
        if (!taskHistory.find(t => t.id === newRunTask.id)) {
            taskHistory.push(newRunTask);
        }
        renderTasks();
        return;
    }

    const taskToUpdate = taskHistory.find(t => t.id === taskId);
    if (!taskToUpdate) return;
    
    if (command === 'TASK_STATUS_UPDATE') {
        const newStatus = payload;
        taskToUpdate.status = newStatus;
        if (['completed', 'failed', 'stopped'].includes(newStatus)) {
            taskToUpdate.progress = null;
        }
        renderTasks();
        return;
    }

    if (command === 'RUN_INCREMENT') {
        taskToUpdate.runCount = (taskToUpdate.runCount || 0) + 1;
        renderTasks();
        return;
    }
    
    // Default to log message if no other command matches
    const logMessage = parts.join('::');
    taskToUpdate.log = (taskToUpdate.log || '') + logMessage + '\n';

    const stepInfo = parseStepProgress ? parseStepProgress(logMessage) : null;
    if (stepInfo) {
        taskToUpdate.progress = stepInfo;
        updateTaskProgressDisplay(taskToUpdate);
    }

    const logElement = document.querySelector(`.task-item[data-task-id='${taskId}'] .status-log`);
    if (logElement) {
        logElement.textContent = taskToUpdate.log;
        logElement.scrollTop = logElement.scrollHeight;
    }
};

socket.onopen = () => console.log('WebSocket connection established.');
socket.onerror = (error) => console.error('WebSocket Error:', error);

// --- UI RENDERING ---

const getStatusPill = (status) => {
    if (status === 'running') return `<div class="status-pill status-running"><span class="running-indicator"></span>Running</div>`;
    if (status === 'scheduled') return `<div class="status-pill status-scheduled">Scheduled</div>`;
    if (status === 'queued') return `<div class="status-pill status-queued">Queued</div>`;
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
            return `<button class="task-action-btn confirm" data-action="confirm">Confirm & Run</button>
                    <button class="task-action-btn" data-action="cancel">Cancel</button>`;
        case 'queued':
             return `<button class="task-action-btn stop" data-action="stop">Dequeue</button>`;
        case 'running':
            return `<button class="task-action-btn stop" data-action="stop">Stop Agent</button>`;
        case 'scheduled':
            return `<button class="task-action-btn stop" data-action="cancel-schedule">Cancel Schedule</button>`;
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
    if (task.plan && task.status !== 'completed') {
        content += `<h4>Proposed Plan</h4><div class="plan-details">
            ${task.plan.isRecurring ? `<p><strong>Schedule:</strong> <i class="bi bi-clock-history" title="Recurring task"></i> ${task.plan.schedule}</p>` : ''}
            <p><strong>URL:</strong> <code>${task.plan.targetURL}</code></p>
            <p><strong>Strategy:</strong> ${task.plan.strategy}</p>
        </div>`;
    }

    if (task.log) {
        content += `<h4>Agent Log</h4><pre class="status-log">${task.log}</pre>`;
    }
    
    if (task.isRecurring) { // Show run count for original scheduled tasks
         content += `<div class="run-count-info">
            <i class="bi bi-arrow-repeat"></i>
            <span>Run count: <strong>${task.runCount || 0}</strong></span>
        </div>`;
    }
    
    content += `<div class="task-actions">${getTaskActions(task)}</div>`;
    return content;
};

const createTaskElement = (task) => {
    const details = document.createElement('details');
    details.className = 'task-item';
    details.dataset.taskId = task.id;
    if (['running', 'pending', 'queued'].includes(task.status)) {
        details.open = true;
    }

    details.innerHTML = `<summary class="task-summary">
            <div class="task-info">
                <h3>${task.summary}</h3>
                <p>${new Date(task.startTime).toLocaleString()}</p>
            </div>
            <div class="task-status">${getStatusPill(task.status)}${getProgressBar(task)}</div>
        </summary>
        <div class="task-details-content">${getTaskDetails(task)}</div>`;
    return details;
};

const renderTasks = () => {
    localStorage.setItem('taskHistory', JSON.stringify(taskHistory));

    tasksList.innerHTML = '';
    queueList.innerHTML = '';
    scheduledTasksList.innerHTML = '';
    archivedTasksList.innerHTML = '';

    const queue = taskHistory.filter(t => !t.archived && ['queued', 'running'].includes(t.status));
    const scheduled = taskHistory.filter(t => !t.archived && t.status === 'scheduled');
    const archived = taskHistory.filter(t => t.archived);
    const tasks = taskHistory.filter(t => !t.archived && !queue.includes(t) && !scheduled.includes(t));

    if (taskHistory.length === 0) { noTasksMessage.classList.remove('d-none'); } 
    else { noTasksMessage.classList.add('d-none'); }

    queue.sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        return a.id - b.id;
    });

    [...tasks].reverse().forEach(task => tasksList.appendChild(createTaskElement(task)));
    queue.forEach(task => queueList.appendChild(createTaskElement(task)));
    [...scheduled].reverse().forEach(task => scheduledTasksList.appendChild(createTaskElement(task)));
    [...archived].reverse().forEach(task => archivedTasksList.appendChild(createTaskElement(task)));
    
    const updateCountBadge = (badgeId, count) => {
        const badge = document.getElementById(badgeId);
        if (count > 0) {
            badge.textContent = count;
            badge.style.display = 'inline-block';
        } else {
            badge.style.display = 'none';
        }
    };
    updateCountBadge('queue-count', queue.length);
    updateCountBadge('scheduled-count', scheduled.length);
};

const switchToTab = (targetId) => {
    tabLinks.forEach(link => {
        link.classList.remove('active');
        if (link.dataset.target === targetId) {
            link.classList.add('active');
        }
    });
    document.querySelectorAll('.task-list').forEach(list => {
        list.style.display = 'none';
    });
    document.getElementById(targetId).style.display = 'flex';
};

// --- EVENT LISTENERS ---

runButton.addEventListener('click', async () => {
    const goal = goalInput.value.trim();
    if (!goal) return alert('Please enter a goal for the agent.');

    runButton.disabled = true;
    runButton.textContent = 'Planning...';

    try {
        const response = await fetch('/api/get-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal }) });
        const result = await response.json();
        if (result.success) {
            const newTask = {
                id: Date.now(),
                summary: result.plan.taskSummary,
                status: 'pending',
                startTime: new Date(),
                plan: result.plan,
                isRecurring: result.plan.isRecurring,
                archived: false, 
                log: `Plan for "${result.plan.taskSummary}" received. ${result.plan.isRecurring ? 'Please confirm to schedule.' : 'Please confirm to run.'}\n`,
                progress: null,
                runCount: 0
            };
            taskHistory.push(newTask);
            goalInput.value = '';
            renderTasks();
            switchToTab('tasks-list');
        } else { alert(`Failed to create plan: ${result.error}`); }
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
            task.status = task.isRecurring ? 'scheduled' : 'queued';
            task.log += task.isRecurring ? "Confirmed. Scheduling task...\n" : "Confirmed. Adding to queue...\n";
            renderTasks();
            
            const response = await fetch('/api/run-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: task.plan, taskId: task.id }) });
            if (!response.ok) {
                const errorResult = await response.json();
                task.status = 'failed';
                task.log += `Error: ${errorResult.error}\n`;
                renderTasks();
            }
            break;
        case 'cancel':
            taskHistory = taskHistory.filter(t => t.id !== taskId);
            renderTasks();
            break;
        case 'stop':
            button.disabled = true;
            button.textContent = "Stopping...";
            await fetch('/api/stop-agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: task.id }) });
            break;
        case 'cancel-schedule':
            button.disabled = true;
            button.textContent = "Canceling...";
            try {
                const stopResponse = await fetch('/api/stop-agent', { method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({ taskId: task.id }) });
                if (stopResponse.ok) {
                    task.status = 'stopped';
                    task.log += 'Schedule has been canceled by the user.\n';
                    renderTasks();
                } else {
                    task.log += 'Error: Failed to cancel schedule on the server.\n';
                    button.disabled = false;
                    button.textContent = "Cancel Schedule";
                }
            } catch (error) {
                task.log += `Error: Network failure while canceling schedule. ${error.message}\n`;
                button.disabled = false;
                button.textContent = "Cancel Schedule";
            }
            break;
        case 'archive':
            task.archived = !task.archived;
            taskItem.style.transition = 'opacity 0.3s, transform 0.3s';
            taskItem.style.opacity = '0';
            taskItem.style.transform = 'scale(0.95)';
            setTimeout(renderTasks, 300);
            break;
    }
});

tabLinks.forEach(tab => {
    tab.addEventListener('click', (e) => {
        e.preventDefault();
        switchToTab(e.currentTarget.dataset.target);
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
    if (e.target === qrModal) {
        qrModal.classList.add('d-none');
    }
});

// --- ROBUST INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    const storedHistory = localStorage.getItem('taskHistory');
    if (storedHistory) {
        try {
            const loadedTasks = JSON.parse(storedHistory);
            taskHistory = loadedTasks.map(task => {
                // On any reload, the backend queue is ALWAYS empty.
                // Therefore, any task that was running or queued is now considered stopped.
                if (['running', 'queued'].includes(task.status)) {
                    task.status = 'stopped';
                    task.log = (task.log || '') + `\n--- Task stopped due to application restart. ---\n`;
                    task.progress = null;
                }
                
                // Pending tasks that were never confirmed are just removed.
                if (task.status === 'pending') {
                    return null; // This will be filtered out later.
                }

                // Scheduled tasks remain, as the backend will re-awaken them.
                if (task.status === 'scheduled') {
                    task.log = (task.log || '') + `\n--- Application restarted. Schedule remains active. ---\n`;
                }

                return task;
            }).filter(Boolean); // Filter out any null tasks (the pending ones)

        } catch (e) { 
            console.error("Failed to parse task history:", e); 
            taskHistory = []; 
        }
    }
    document.getElementById('tasks-list').style.display = 'flex';
    renderTasks();
});