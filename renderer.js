// renderer.js

// --- STATE ---
let taskHistory = [];
let activeCredentialRequest = null;

// --- SELECTORS ---
const goalInput = document.getElementById('goal-input');
const runButton = document.getElementById('run-button');
const tasksList = document.getElementById('tasks-list');
const queueList = document.getElementById('queue-list');
const scheduledTasksList = document.getElementById('scheduled-tasks');
const archivedTasksList = document.getElementById('archived-tasks');
const settingsPanel = document.getElementById('settings-panel');
const tabLinks = document.querySelectorAll('.tab-link');
const taskListsWrapper = document.getElementById('task-lists-wrapper');
const toastContainer = document.getElementById('toast-container');
const archiveActionsHeader = document.getElementById('archive-actions');
const clearArchiveBtn = document.getElementById('clear-archive-btn');
const resetAllBtn = document.getElementById('reset-all-btn');

// QR Modal Selectors
const qrModal = document.getElementById('qr-modal');
const connectButton = document.getElementById('connect-button');
const closeModalButton = document.getElementById('close-modal-button');
const qrCodeImage = document.getElementById('qr-code-image');
const qrSpinner = document.getElementById('qr-spinner');
const connectUrl = document.getElementById('connect-url');

// Credentials Modal Selectors
const credentialsModal = document.getElementById('credentials-modal');
const closeCredentialsModalButton = document.getElementById('close-credentials-modal-button');
const credentialsForm = document.getElementById('credentials-form');
const credentialDomain = document.getElementById('credential-domain');
const usernameInput = document.getElementById('username-input');
const passwordInput = document.getElementById('password-input');

// --- NEW: Toast Notification Logic ---
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;

    toastContainer.appendChild(toast);

    setTimeout(() => {
        toast.classList.add('show');
    }, 100);

    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove());
    }, 5000);
}

// --- WEBSOCKET ---
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(`${wsProtocol}//${window.location.host}`);

socket.onmessage = (event) => {
    const [taskIdStr, ...parts] = event.data.split('::');
    const command = parts[0];
    const payload = parts.slice(1).join('::');
    const taskId = parseInt(taskIdStr);

    if (command === 'NEW_TASK_INSTANCE') {
        const newTask = JSON.parse(payload);
        taskHistory.push(newTask);
        renderTasks();
        switchToTab('queue-list');
        return;
    }

    if (isNaN(taskId)) {
        console.log("Generic Log:", event.data);
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
    
    if (command === 'TASK_RESULT') {
        taskToUpdate.result = payload;
        renderTasks();
        return;
    }

    if (command === 'RUN_INCREMENT') {
        taskToUpdate.runCount = (taskToUpdate.runCount || 0) + 1;
        renderTasks();
        return;
    }
    
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
    let contentWrapper = document.createElement('div');
    let content = '';

    if (task.status === 'completed' && task.result) {
        const formattedResult = task.result.replace(/\n/g, '<br>');
        content += `<div class="task-result">
            <h4><i class="bi bi-check-circle-fill"></i> Agent Result</h4>
            <p>${formattedResult}</p>
        </div>`;
    }
    
    if (task.plan && task.status !== 'completed') {
        const planSteps = task.plan.plan.map(p => `<li>${p.step}</li>`).join('');
        content += `<div><h4>Proposed Plan</h4><div class="plan-details">
            ${task.plan.isRecurring ? `<p><strong>Schedule:</strong> <i class="bi bi-clock-history" title="Recurring task"></i> ${task.plan.schedule}</p>` : ''}
            <p><strong>Initial URL:</strong> <code>${task.plan.targetURL}</code></p>
            <p><strong>Steps:</strong></p>
            <ol style="margin-left: 20px; padding-left: 10px;">${planSteps}</ol>
        </div></div>`;
    }

    if (task.log) {
        content += `<div><h4>Agent Log</h4><pre class="status-log">${task.log}</pre></div>`;
    }
    
    if (task.isRecurring) {
         content += `<div class="run-count-info">
            <i class="bi bi-arrow-repeat"></i>
            <span>Run count: <strong>${task.runCount || 0}</strong></span>
        </div>`;
    }
    
    content += `<div class="task-actions">${getTaskActions(task)}</div>`;
    
    contentWrapper.innerHTML = content;
    return contentWrapper;
};

const createTaskElement = (task) => {
    const details = document.createElement('details');
    details.className = 'task-item';
    details.dataset.taskId = task.id;
    if (['running', 'pending', 'queued', 'completed', 'scheduled'].includes(task.status)) {
        details.open = true;
    }

    const summary = document.createElement('summary');
    summary.className = 'task-summary';
    summary.innerHTML = `<div class="task-info">
                <h3>${task.summary}</h3>
                <p>${new Date(task.startTime).toLocaleString()}</p>
            </div>
            <div class="task-status">${getStatusPill(task.status)}${getProgressBar(task)}</div>`;

    const detailsContent = document.createElement('div');
    detailsContent.className = 'task-details-content';
    detailsContent.appendChild(getTaskDetails(task));

    details.appendChild(summary);
    details.appendChild(detailsContent);
    return details;
};

const renderTasks = () => {
    localStorage.setItem('taskHistory', JSON.stringify(taskHistory));

    const queue = taskHistory.filter(t => !t.archived && ['queued', 'running'].includes(t.status));
    const scheduled = taskHistory.filter(t => !t.archived && t.status === 'scheduled');
    const archived = taskHistory.filter(t => t.archived);
    const tasks = taskHistory.filter(t => !t.archived && !queue.includes(t) && !scheduled.includes(t) && t.status !== 'pending');
    const pending = taskHistory.filter(t => t.status === 'pending');

    const renderList = (listElement, tasks) => {
        listElement.querySelectorAll('.task-item').forEach(el => el.remove());
        const emptyState = listElement.querySelector('.empty-state-wrapper');

        if (tasks.length === 0) {
            if (emptyState) emptyState.classList.remove('d-none');
        } else {
            if (emptyState) emptyState.classList.add('d-none');
            const sortedTasks = [...tasks].sort((a,b) => b.id - a.id);
            sortedTasks.forEach(task => listElement.appendChild(createTaskElement(task)));
        }
    };
    
    queue.sort((a, b) => {
        if (a.status === 'running' && b.status !== 'running') return -1;
        if (a.status !== 'running' && b.status === 'running') return 1;
        return a.id - b.id;
    });

    renderList(tasksList, [...tasks, ...pending]);
    renderList(queueList, queue);
    renderList(scheduledTasksList, scheduled);
    renderList(archivedTasksList, archived);
    
    // Show/hide clear archive button
    if (archived.length > 0) {
        archiveActionsHeader.classList.remove('d-none');
    } else {
        archiveActionsHeader.classList.add('d-none');
    }

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
    document.querySelectorAll('.task-list, .settings-panel').forEach(list => {
        list.style.display = 'none';
    });
    document.getElementById(targetId).style.display = 'flex';
};

// --- EVENT LISTENERS ---
runButton.addEventListener('click', async () => {
    const goal = goalInput.value.trim();
    if (!goal) {
        showToast('Please enter a goal for the agent.', 'error');
        return;
    }

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
                result: null,
                runCount: 0
            };
            taskHistory.push(newTask);
            goalInput.value = '';
            renderTasks();
            switchToTab('tasks-list');
        } else { 
            showToast(`Failed to create plan: ${result.error || 'Unknown error'}`, 'error');
        }
    } catch (error) {
        showToast(`Network error: ${error.message}`, 'error');
    } finally {
        runButton.disabled = false;
        runButton.textContent = 'Create & Run Agent';
    }
});

taskListsWrapper.addEventListener('click', async (e) => {
    const exampleButton = e.target.closest('.example-run-btn, .example-task-card');
    if (exampleButton) {
        const card = exampleButton.closest('.example-task-card');
        const goal = card.dataset.goal;
        if (goal) {
            goalInput.value = goal;
            runButton.click();
            goalInput.focus();
        }
        return;
    }

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
            
            if (!task.isRecurring) {
                switchToTab('queue-list');
            } else {
                switchToTab('scheduled-tasks');
            }

            renderTasks();
            
            try {
                const response = await fetch('/api/run-task', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ plan: task.plan, taskId: task.id }) });
                if (!response.ok) {
                    const errorResult = await response.json();
                    task.status = 'failed';
                    task.log += `Error: ${errorResult.error || 'Task could not be started.'}\n`;
                    renderTasks();
                }
            } catch (error) {
                task.status = 'failed';
                task.log += `Network Error: ${error.message}\n`;
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
                    // The backend will send a TASK_STATUS_UPDATE, so no need to set it here
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
            taskItem.classList.add('archiving');
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

clearArchiveBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to permanently delete all archived tasks?')) {
        taskHistory = taskHistory.filter(t => !t.archived);
        renderTasks();
        showToast('Archived tasks cleared.', 'success');
    }
});

resetAllBtn.addEventListener('click', () => {
    if (confirm('DANGER: Are you sure you want to delete ALL tasks and reset the application? This cannot be undone.')) {
        // Stop any running agent first
        const runningTask = taskHistory.find(t => t.status === 'running');
        if (runningTask) {
             fetch('/api/stop-agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: runningTask.id }) });
        }
        
        taskHistory = [];
        renderTasks();
        showToast('Application has been reset.', 'success');
    }
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
        } else { connectUrl.textContent = 'Error loading QR Code.'; }
    } catch (error) { connectUrl.textContent = 'Error loading QR Code.'; } 
    finally {
        qrSpinner.classList.add('d-none');
        qrCodeImage.classList.remove('d-none');
    }
};

connectButton.addEventListener('click', () => {
    qrModal.classList.remove('d-none');
    fetchQrCode();
});
closeModalButton.addEventListener('click', () => { qrModal.classList.add('d-none'); });
qrModal.addEventListener('click', (e) => { if (e.target === qrModal) qrModal.classList.add('d-none'); });

window.electronAPI.onShowCredentialsModal((data) => {
    activeCredentialRequest = data;
    credentialDomain.textContent = data.domain;
    credentialsModal.classList.remove('d-none');
    usernameInput.focus();
});

credentialsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeCredentialRequest) return;
    const credentials = { domain: activeCredentialRequest.domain, username: usernameInput.value, password: passwordInput.value };
    await window.electronAPI.saveCredentials(credentials);
    window.electronAPI.credentialsSubmitted({success: true});
    credentialsModal.classList.add('d-none');
    credentialsForm.reset();
    activeCredentialRequest = null;
});

closeCredentialsModalButton.addEventListener('click', () => {
    credentialsModal.classList.add('d-none');
    if (activeCredentialRequest) {
        window.electronAPI.credentialsSubmitted({success: false, error: 'User canceled.'});
        activeCredentialRequest = null;
    }
});

// --- ROBUST INITIALIZATION ---
document.addEventListener('DOMContentLoaded', () => {
    const storedHistory = localStorage.getItem('taskHistory');
    if (storedHistory) {
        try {
            const loadedTasks = JSON.parse(storedHistory);
            taskHistory = loadedTasks.map(task => {
                if (['running', 'queued'].includes(task.status)) {
                    task.status = 'stopped';
                    task.log = (task.log || '') + `\n--- Task stopped due to application restart. ---\n`;
                    task.progress = null;
                }
                if (task.status === 'pending') return null;
                if (task.status === 'scheduled') {
                    task.status = 'stopped';
                     task.log = (task.log || '') + `\n--- Schedule canceled due to application restart. Please reschedule. ---\n`;
                }
                return task;
            }).filter(Boolean);
        } catch (e) { 
            console.error("Failed to parse task history:", e); 
            taskHistory = []; 
        }
    }
    document.getElementById('tasks-list').style.display = 'flex';
    renderTasks();
});