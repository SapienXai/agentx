// renderer.js

// --- STATE ---
let taskHistory = [];
let activeCredentialRequest = null;
let authState = null;
let authModalPinned = false;
let currentPlanController = null;
let latestPlannedTaskId = null;

function getDefaultModel(provider) {
    if (provider === 'codex') return 'gpt-5.1-codex-mini';
    if (provider === 'gemini') return 'gemini-3-flash';
    return '';
}

// --- SELECTORS ---
const goalInput = document.getElementById('goal-input');
const runButton = document.getElementById('run-button');
const intentBadge = document.getElementById('intent-badge');
const wizardPanel = document.getElementById('wizard-panel');
const wizardStatus = document.getElementById('wizard-status');
const wizardProgressBar = document.getElementById('wizard-progress-bar');
const wizardStepInput = document.getElementById('wizard-step-input');
const wizardStepIntent = document.getElementById('wizard-step-intent');
const wizardStepPlan = document.getElementById('wizard-step-plan');
const wizardStepQueue = document.getElementById('wizard-step-queue');
const wizardStopButton = document.getElementById('wizard-stop');
const wizardPlan = document.getElementById('wizard-plan');
const wizardPlanSteps = document.getElementById('wizard-plan-steps');
const wizardConfirmRun = document.getElementById('wizard-confirm-run');
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
const toggleTavily = document.getElementById('toggle-tavily');
const toggleFirecrawl = document.getElementById('toggle-firecrawl');

// Auth Modal Selectors
const authModal = document.getElementById('auth-modal');
const closeAuthModalButton = document.getElementById('close-auth-modal-button');
const authStatusCodex = document.getElementById('auth-status-codex');
const authStatusGemini = document.getElementById('auth-status-gemini');
const authActionCodexBtn = document.getElementById('auth-action-codex');
const authActionGeminiBtn = document.getElementById('auth-action-gemini');
const authModelCodex = document.getElementById('auth-model-codex');
const authModelGemini = document.getElementById('auth-model-gemini');
const authRefreshBtn = document.getElementById('auth-refresh');

// QR Modal Selectors
const qrModal = document.getElementById('qr-modal');
const connectButton = document.getElementById('connect-button');
const loginButton = document.getElementById('login-button');
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

// --- Toast Notification Logic ---
function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    toastContainer.appendChild(toast);
    setTimeout(() => { toast.classList.add('show'); }, 100);
    setTimeout(() => {
        toast.classList.remove('show');
        toast.addEventListener('transitionend', () => toast.remove());
    }, 5000);
}

function setWizardState({ statusText, activeStep, errorStep }) {
    if (!wizardPanel) return;
    wizardPanel.classList.remove('d-none');
    if (wizardStatus) wizardStatus.textContent = statusText || 'Working...';
    if (wizardStopButton) wizardStopButton.disabled = false;

    const steps = [wizardStepInput, wizardStepIntent, wizardStepPlan, wizardStepQueue].filter(Boolean);
    steps.forEach((step) => {
        step.classList.remove('is-active', 'is-done', 'is-error');
    });

    const stepOrder = {
        input: wizardStepInput,
        intent: wizardStepIntent,
        plan: wizardStepPlan,
        queue: wizardStepQueue
    };

    let reachedActive = false;
    Object.entries(stepOrder).forEach(([key, stepEl]) => {
        if (!stepEl) return;
        if (key === errorStep) {
            stepEl.classList.add('is-error');
            reachedActive = true;
            return;
        }
        if (key === activeStep && !reachedActive) {
            stepEl.classList.add('is-active');
            reachedActive = true;
            return;
        }
        if (!reachedActive) {
            stepEl.classList.add('is-done');
        }
    });

    const progressMap = { input: 20, intent: 45, plan: 70, queue: 100 };
    if (wizardProgressBar) {
        wizardProgressBar.style.width = `${progressMap[activeStep] || 0}%`;
    }
}

function resetWizard() {
    if (!wizardPanel) return;
    wizardPanel.classList.add('d-none');
    if (wizardStatus) wizardStatus.textContent = 'Idle';
    if (wizardProgressBar) wizardProgressBar.style.width = '0%';
    [wizardStepInput, wizardStepIntent, wizardStepPlan, wizardStepQueue].forEach(step => {
        if (step) step.classList.remove('is-active', 'is-done', 'is-error');
    });
    if (wizardStepInput) wizardStepInput.classList.add('is-active');
    if (wizardStopButton) wizardStopButton.disabled = true;
    if (wizardPlan) wizardPlan.classList.add('d-none');
    if (wizardPlanSteps) wizardPlanSteps.innerHTML = '';
    latestPlannedTaskId = null;
}

function setAuthStatusBadge(el, status, isActive) {
    if (!el || !status) return;
    el.classList.remove('ready', 'missing');
    if (isActive) {
        el.textContent = 'Active';
        el.classList.add('ready');
        return;
    }
    if (!status.available) {
        el.textContent = 'Not installed';
        el.classList.add('missing');
        return;
    }
    if (status.loggedIn) {
        el.textContent = 'Logged in';
        el.classList.add('ready');
        return;
    }
    el.textContent = 'Login required';
    el.classList.add('missing');
}

function updateAuthModal() {
    if (!authState) return;
    if (!authStatusCodex || !authStatusGemini || !authActionCodexBtn || !authActionGeminiBtn) {
        console.error('Auth UI elements missing. Check index.html IDs.');
        return;
    }
    const activeProvider = authState.activeProvider;
    setAuthStatusBadge(authStatusCodex, authState.status.codex, activeProvider === 'codex');
    setAuthStatusBadge(authStatusGemini, authState.status.gemini, activeProvider === 'gemini');

    const codexStatus = authState.status.codex;
    if (!codexStatus.available) {
        authActionCodexBtn.textContent = 'Install Codex';
        authActionCodexBtn.disabled = true;
        authActionCodexBtn.dataset.action = 'install';
    } else if (!codexStatus.loggedIn) {
        authActionCodexBtn.textContent = 'Login with Codex';
        authActionCodexBtn.disabled = false;
        authActionCodexBtn.dataset.action = 'login';
    } else if (activeProvider === 'codex') {
        authActionCodexBtn.textContent = 'Active';
        authActionCodexBtn.disabled = true;
        authActionCodexBtn.dataset.action = 'active';
    } else {
        authActionCodexBtn.textContent = 'Use Codex';
        authActionCodexBtn.disabled = false;
        authActionCodexBtn.dataset.action = 'use';
    }

    const geminiStatus = authState.status.gemini;
    if (!geminiStatus.available) {
        authActionGeminiBtn.textContent = 'Install Gemini';
        authActionGeminiBtn.disabled = true;
        authActionGeminiBtn.dataset.action = 'install';
    } else if (!geminiStatus.loggedIn) {
        authActionGeminiBtn.textContent = 'Login with Gemini';
        authActionGeminiBtn.disabled = false;
        authActionGeminiBtn.dataset.action = 'login';
    } else if (activeProvider === 'gemini') {
        authActionGeminiBtn.textContent = 'Active';
        authActionGeminiBtn.disabled = true;
        authActionGeminiBtn.dataset.action = 'active';
    } else {
        authActionGeminiBtn.textContent = 'Use Gemini';
        authActionGeminiBtn.disabled = false;
        authActionGeminiBtn.dataset.action = 'use';
    }

    if (authModelCodex && authState.models && authState.models.codex) {
        authModelCodex.value = authState.models.codex;
    }
    if (authModelGemini && authState.models && authState.models.gemini) {
        authModelGemini.value = authState.models.gemini;
    }
    if (toggleTavily && authState.toggles) {
        toggleTavily.checked = Boolean(authState.toggles.tavily);
    }
    if (toggleFirecrawl && authState.toggles) {
        toggleFirecrawl.checked = Boolean(authState.toggles.firecrawl);
    }

    if (!authModalPinned) {
        if (authState.activeProvider) {
            authModal.classList.add('d-none');
        } else {
            authModal.classList.remove('d-none');
        }
    }
}

async function refreshAuthStatus() {
    try {
        const response = await fetch('/api/auth/status');
        if (!response.ok) throw new Error('Failed to fetch auth status.');
        const result = await response.json();
        if (!result.success) throw new Error(result.error || 'Auth status failed.');
        authState = result;
        updateAuthModal();
    } catch (error) {
        showToast(`Auth status error: ${error.message}`, 'error');
    }
}

// --- WEBSOCKET ---
const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const socket = new WebSocket(`${wsProtocol}//${window.location.host}`);

socket.onmessage = (event) => {
    const [taskIdStr, ...parts] = event.data.split('::');
    const command = parts[0];
    const payload = parts.slice(1).join('::');

    if (taskIdStr === 'CREDENTIALS_REQUEST') {
        const data = JSON.parse(command);
        activeCredentialRequest = data;
        credentialDomain.textContent = data.domain;
        credentialsModal.classList.remove('d-none');
        usernameInput.focus();
        return;
    }
    
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
        taskToUpdate.status = payload;
        if (['completed', 'failed', 'stopped'].includes(payload)) {
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

const getLatestReason = (logText) => {
    if (!logText) return '';
    const matches = [...logText.matchAll(/🧠 Reason:\s*(.+)/g)];
    if (!matches.length) return '';
    return matches[matches.length - 1][1].trim();
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
            return `<button class="task-action-btn" data-action="rerun">Rerun</button>
                    <button class="task-action-btn" data-action="archive">${task.archived ? 'Restore' : 'Archive'}</button>`;
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
    const providerTag = task.provider ? `<span class="provider-tag provider-${task.provider}">${task.provider.toUpperCase()}</span>` : '';
    const effectiveModel = task.model || getDefaultModel(task.provider);
    const modelTag = effectiveModel ? `<span class="model-tag">${effectiveModel}</span>` : '';
    const latestReason = getLatestReason(task.log || '');
    const reasonTag = latestReason ? `<span class="reason-tag">Reason: ${latestReason}</span>` : '';
    summary.innerHTML = `<div class="task-info">
                <h3>${task.summary} ${providerTag}</h3>
                ${modelTag}
                ${reasonTag}
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
async function runGoal(goal) {
    if (!goal) {
        showToast('Please enter a goal for the agent.', 'error');
        return;
    }
    if (!authState || !authState.activeProvider) {
        showToast('Please log in with Codex or Gemini to run tasks.', 'error');
        authModal.classList.remove('d-none');
        return;
    }
    runButton.disabled = true;
    runButton.textContent = 'Thinking...';
    try {
        currentPlanController = new AbortController();
        setWizardState({ statusText: 'Understanding intent…', activeStep: 'intent' });
        if (intentBadge) {
            intentBadge.textContent = 'Detected: ...';
            intentBadge.classList.remove('d-none');
        }
        const intentResponse = await fetch('/api/interpret-goal', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ goal }),
            signal: currentPlanController.signal
        });
        const intentResult = await intentResponse.json();
        if (!intentResponse.ok || !intentResult.success) {
            throw new Error(intentResult.error || 'Failed to interpret goal.');
        }

        const { intent, response: directResponse, normalizedGoal } = intentResult.interpretation;
        const finalGoal = normalizedGoal || goal;
        if (intentBadge) {
            intentBadge.textContent = `Detected: ${intent}`;
            intentBadge.classList.remove('d-none');
        }

        if (intent === 'chat') {
            setWizardState({ statusText: 'Responding…', activeStep: 'plan' });
            const newTask = {
                id: Date.now(),
                summary: finalGoal,
                status: 'completed',
                startTime: new Date(),
                plan: null,
                isRecurring: false,
                archived: false,
                log: `Direct response generated for "${finalGoal}".\n`,
                progress: null,
                result: directResponse || 'Bunu yanıtlayacak bilgi yok.',
                runCount: 0,
                provider: authState.activeProvider,
                model: authState.models && authState.models[authState.activeProvider]
                    ? authState.models[authState.activeProvider]
                    : getDefaultModel(authState.activeProvider),
                originalGoal: finalGoal
            };
            taskHistory.push(newTask);
            goalInput.value = '';
            renderTasks();
            switchToTab('tasks-list');
            showToast('Direct answer provided.', 'success');
            setWizardState({ statusText: 'Done', activeStep: 'queue' });
            return;
        }

        if (intent === 'schedule') {
            showToast('Recurring task detected. Preparing a schedule-aware plan...', 'info');
        }

        setWizardState({ statusText: 'Generating plan…', activeStep: 'plan' });
        const planResponse = await fetch('/api/get-plan', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ goal: finalGoal }), signal: currentPlanController.signal });
        const result = await planResponse.json();
        if (planResponse.ok) {
            setWizardState({ statusText: 'Plan ready', activeStep: 'queue' });
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
                runCount: 0,
                provider: authState.activeProvider,
                model: authState.models && authState.models[authState.activeProvider]
                    ? authState.models[authState.activeProvider]
                    : getDefaultModel(authState.activeProvider),
                originalGoal: finalGoal
            };
            taskHistory.push(newTask);
            goalInput.value = '';
            latestPlannedTaskId = newTask.id;
            if (wizardPlan && wizardPlanSteps) {
                wizardPlan.classList.remove('d-none');
                wizardPlanSteps.innerHTML = '';
                const steps = (result.plan.plan || []).slice(0, 4);
                steps.forEach(step => {
                    const li = document.createElement('li');
                    li.textContent = step.step;
                    wizardPlanSteps.appendChild(li);
                });
            }
            renderTasks();
            switchToTab('tasks-list');
        } else { 
            showToast(`Failed to create plan: ${result.error || 'Unknown error'}`, 'error');
            setWizardState({ statusText: 'Plan failed', activeStep: 'plan', errorStep: 'plan' });
        }
    } catch (error) {
        if (error.name === 'AbortError') {
            showToast('Planning stopped.', 'info');
            resetWizard();
            return;
        }
        showToast(`Network error: ${error.message}`, 'error');
        setWizardState({ statusText: 'Network error', activeStep: 'intent', errorStep: 'intent' });
    } finally {
        runButton.disabled = false;
        runButton.textContent = 'Create & Run Agent';
        currentPlanController = null;
        if (wizardStopButton) wizardStopButton.disabled = true;
    }
}

runButton.addEventListener('click', async () => {
    const goal = goalInput.value.trim();
    await runGoal(goal);
});

async function confirmAndRunTask(task) {
    if (!task) return;
    task.status = task.isRecurring ? 'scheduled' : 'queued';
    task.log += task.isRecurring ? "Confirmed. Scheduling task...\n" : "Confirmed. Adding to queue...\n";

    renderTasks();
    try {
        const response = await fetch('/api/run-task', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ plan: task.plan, taskId: task.id })
        });
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
}

if (wizardConfirmRun) {
    wizardConfirmRun.addEventListener('click', async () => {
        const task = taskHistory.find(t => t.id === latestPlannedTaskId);
        if (!task) {
            showToast('No plan available to run.', 'error');
            return;
        }
        await confirmAndRunTask(task);
    });
}

if (wizardStopButton) {
    wizardStopButton.addEventListener('click', () => {
        if (currentPlanController) {
            currentPlanController.abort();
        }
    });
}

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
            await confirmAndRunTask(task);
            if (!task.isRecurring) {
                switchToTab('queue-list');
            } else {
                switchToTab('scheduled-tasks');
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
                    // Backend will broadcast status update
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
        case 'rerun':
            {
                const goalToRun = task.originalGoal || task.summary;
                if (!goalToRun) {
                    showToast('No original goal found for rerun.', 'error');
                    return;
                }
                goalInput.value = goalToRun;
                await runGoal(goalToRun);
            }
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
        const runningTask = taskHistory.find(t => t.status === 'running');
        if (runningTask) {
             fetch('/api/stop-agent', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ taskId: runningTask.id }) });
        }
        
        taskHistory = [];
        renderTasks();
        showToast('Application has been reset.', 'success');
    }
});

// --- AUTH MODAL LOGIC ---
async function startAuthLogin(provider) {
    try {
        const response = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider })
        });
        const result = await response.json();
        if (!response.ok) {
            showToast(result.error || 'Login failed to start.', 'error');
            return;
        }
        showToast(`Login started: ${result.command}`, 'success');
    } catch (error) {
        showToast(`Login error: ${error.message}`, 'error');
    }
}

async function setAuthProvider(provider) {
    try {
        const response = await fetch('/api/auth/set-provider', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider })
        });
        const result = await response.json();
        if (!response.ok) {
            showToast(result.error || 'Failed to set provider.', 'error');
            return;
        }
        showToast(`Provider set to ${provider}.`, 'success');
        await refreshAuthStatus();
    } catch (error) {
        showToast(`Provider error: ${error.message}`, 'error');
    }
}

async function setAuthModel(provider, model) {
    try {
        const response = await fetch('/api/auth/set-model', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ provider, model })
        });
        const result = await response.json();
        if (!response.ok) {
            showToast(result.error || 'Failed to set model.', 'error');
            return;
        }
        showToast(`${provider.toUpperCase()} model set to ${model}.`, 'success');
        await refreshAuthStatus();
    } catch (error) {
        showToast(`Model error: ${error.message}`, 'error');
    }
}

if (authActionCodexBtn) {
    authActionCodexBtn.addEventListener('click', () => {
        const action = authActionCodexBtn.dataset.action;
        if (action === 'login') startAuthLogin('codex');
        if (action === 'use') setAuthProvider('codex');
    });
}
if (authActionGeminiBtn) {
    authActionGeminiBtn.addEventListener('click', () => {
        const action = authActionGeminiBtn.dataset.action;
        if (action === 'login') startAuthLogin('gemini');
        if (action === 'use') setAuthProvider('gemini');
    });
}
if (authModelCodex) {
    authModelCodex.addEventListener('change', (e) => setAuthModel('codex', e.target.value));
}
if (authModelGemini) {
    authModelGemini.addEventListener('change', (e) => setAuthModel('gemini', e.target.value));
}
async function setToolToggle(tool, enabled) {
    try {
        const response = await fetch('/api/settings/tool-toggle', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tool, enabled })
        });
        const result = await response.json();
        if (!response.ok) {
            showToast(result.error || 'Failed to update tool toggle.', 'error');
            return;
        }
        showToast(`${tool} ${enabled ? 'enabled' : 'disabled'}.`, 'success');
    } catch (error) {
        showToast(`Toggle error: ${error.message}`, 'error');
    }
}
if (toggleTavily) {
    toggleTavily.addEventListener('change', (e) => setToolToggle('tavily', e.target.checked));
}
if (toggleFirecrawl) {
    toggleFirecrawl.addEventListener('change', (e) => setToolToggle('firecrawl', e.target.checked));
}
if (authRefreshBtn) {
    authRefreshBtn.addEventListener('click', refreshAuthStatus);
}
if (closeAuthModalButton) {
    closeAuthModalButton.addEventListener('click', () => {
        authModalPinned = false;
        authModal.classList.add('d-none');
    });
}
if (loginButton) {
    loginButton.addEventListener('click', () => {
        authModalPinned = true;
        authModal.classList.remove('d-none');
        refreshAuthStatus();
    });
}

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

credentialsForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeCredentialRequest) return;
    const credentials = { 
        success: true,
        domain: activeCredentialRequest.domain, 
        username: usernameInput.value, 
        password: passwordInput.value 
    };

    try {
        const response = await fetch('/api/submit-credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(credentials)
        });
        if (response.ok) {
            credentialsModal.classList.add('d-none');
            credentialsForm.reset();
            activeCredentialRequest = null;
        } else {
            showToast('Failed to submit credentials to backend.', 'error');
        }
    } catch (error) {
        showToast(`Network error: ${error.message}`, 'error');
    }
});

closeCredentialsModalButton.addEventListener('click', () => {
    credentialsModal.classList.add('d-none');
    if (activeCredentialRequest) {
        fetch('/api/submit-credentials', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ success: false, error: 'User canceled.' })
        });
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
    refreshAuthStatus();
});
