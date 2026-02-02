// agent_api.js

const axios = require("axios");
const fs = require('fs');
const path = require('path');
const { runCodex, runGemini, extractJson } = require('./cli_llm.js');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const AUTH_STATE_PATH = path.join(__dirname, 'auth_state.json');

function getActiveProvider() {
    if (process.env.AGENTX_PROVIDER) return process.env.AGENTX_PROVIDER;
    if (fs.existsSync(AUTH_STATE_PATH)) {
        try {
            const state = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf-8'));
            if (state.provider) return state.provider;
        } catch {
            return OPENAI_API_KEY ? 'openai' : '';
        }
    }
    return OPENAI_API_KEY ? 'openai' : '';
}

function getToolAvailabilityNote() {
    let toggles = { tavily: false, firecrawl: false };
    try {
        if (fs.existsSync(AUTH_STATE_PATH)) {
            const state = JSON.parse(fs.readFileSync(AUTH_STATE_PATH, 'utf-8'));
            if (state.toggles) toggles = state.toggles;
        }
    } catch {
        // ignore
    }
    const tavilyAvailable = Boolean(process.env.TAVILY_API_KEY) && Boolean(toggles.tavily);
    const firecrawlAvailable = Boolean(process.env.FIRECRAWL_API_KEY) && Boolean(toggles.firecrawl);
    if (tavilyAvailable && firecrawlAvailable) return '';
    const unavailable = [];
    if (!tavilyAvailable) unavailable.push('tavily_search');
    if (!firecrawlAvailable) unavailable.push('firecrawl_scrape');
    return `\n# TOOL AVAILABILITY\nThe following tools are NOT available: ${unavailable.join(', ')}. Do not select them.`;
}

async function callOpenAI(messages, { responseFormat } = {}) {
    const response = await axios.post("https://api.openai.com/v1/chat/completions", {
        model: "gpt-4o-mini",
        messages,
        max_tokens: 1000,
        response_format: responseFormat,
    }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });
    return response.data.choices[0].message.content;
}

async function callCodex(prompt, { schema } = {}) {
    return runCodex(prompt, { schema });
}

async function callGemini(prompt) {
    return runGemini(prompt);
}

async function createToolPlan(userGoal, toolCatalog, onLog = console.log) {
    const provider = getActiveProvider();
    const toolList = (toolCatalog && toolCatalog.tools) ? toolCatalog.tools : [];
    const toolDescriptions = toolList.map(tool => {
        const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema) : '{}';
        return `- ${tool.name}: ${tool.description || 'No description'} | schema: ${schema}`;
    }).join('\n');

    const systemPrompt = `You are a tool-aware planner.\nOutput ONLY JSON.\nRules:\n- Use only tools listed.\n- Each step must call exactly one tool with valid arguments.\n- Provide clear success criteria.\n- Prefer minimal steps.\n- Always include all argument keys (use empty string when not needed).\n- Fallbacks only need { tool, why } and reuse the original step arguments.\n- Decide whether MCP should run headless based on the task (true/false).\n\nTOOLS:\n${toolDescriptions}\n\nArguments object keys (always present):\n{\n  \"url\": \"\",\n  \"query\": \"\",\n  \"bx_id\": \"\",\n  \"text\": \"\",\n  \"direction\": \"\",\n  \"selector\": \"\",\n  \"reason\": \"\",\n  \"timeoutMs\": \"\"\n}\n\nJSON format:\n{\n  \"taskSummary\": \"...\",\n  \"targetURL\": \"...\",\n  \"isRecurring\": boolean,\n  \"schedule\": \"\",\n  \"cron\": \"\",\n  \"mcpHeadless\": boolean,\n  \"plan\": [\n    {\n      \"step\": \"...\",\n      \"tool\": \"tool_name\",\n      \"arguments\": { \"url\": \"\", \"query\": \"\", \"bx_id\": \"\", \"text\": \"\", \"direction\": \"\", \"selector\": \"\", \"reason\": \"\", \"timeoutMs\": \"\" },\n      \"successCriteria\": \"...\",\n      \"fallbacks\": [ { \"tool\": \"...\", \"why\": \"...\" } ]\n    }\n  ]\n}\n`;

    const userMessage = `Plan the exact tool calls to achieve: "${userGoal}".`;
    const schema = {
        type: "object",
        additionalProperties: false,
        required: ["taskSummary", "targetURL", "isRecurring", "schedule", "cron", "mcpHeadless", "plan"],
        properties: {
            taskSummary: { type: "string" },
            targetURL: { type: "string" },
            isRecurring: { type: "boolean" },
            schedule: { type: "string" },
            cron: { type: "string" },
            mcpHeadless: { type: "boolean" },
            plan: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["step", "tool", "arguments", "successCriteria", "fallbacks"],
                    properties: {
                        step: { type: "string" },
                        tool: { type: "string" },
                        arguments: {
                            type: "object",
                            additionalProperties: false,
                            properties: {
                                url: { type: "string" },
                                query: { type: "string" },
                                bx_id: { type: "string" },
                                text: { type: "string" },
                                direction: { type: "string" },
                                selector: { type: "string" },
                                reason: { type: "string" },
                                timeoutMs: { type: "string" }
                            },
                            required: ["url", "query", "bx_id", "text", "direction", "selector", "reason", "timeoutMs"]
                        },
                        successCriteria: { type: "string" },
                        fallbacks: {
                            type: "array",
                            items: {
                                type: "object",
                                additionalProperties: false,
                                required: ["tool", "why"],
                                properties: {
                                    tool: { type: "string" },
                                    why: { type: "string" }
                                }
                            }
                        }
                    }
                }
            }
        }
    };

    try {
        if (provider === 'openai') {
            if (!OPENAI_API_KEY) throw new Error('OpenAI API key is missing.');
            const content = await callOpenAI(
                [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
                { responseFormat: { type: "json_object" } }
            );
            return JSON.parse(content);
        }
        if (provider === 'codex') {
            const prompt = `${systemPrompt}\n\n${userMessage}\n\nRespond ONLY with valid JSON.`;
            const content = await callCodex(prompt, { schema });
            return JSON.parse(content);
        }
        if (provider === 'gemini') {
            const prompt = `${systemPrompt}\n\n${userMessage}\n\nRespond ONLY with valid JSON.`;
            const content = await callGemini(prompt);
            const parsed = extractJson(content);
            if (!parsed) throw new Error('Gemini response did not contain valid JSON.');
            return parsed;
        }
        throw new Error('No active provider is configured.');
    } catch (error) {
        onLog(`🚨 Tool plan creation failed: ${error.message}`);
        return null;
    }
}

async function decideNextToolAction(
    userGoal,
    plan,
    previousActions,
    lastActionResult,
    currentURL,
    pageStructure,
    screenshotBase64,
    toolCatalog,
    onLog = console.log,
    lastAiError = ""
) {
    const provider = getActiveProvider();
    const toolList = (toolCatalog && toolCatalog.tools) ? toolCatalog.tools : [];
    const toolDescriptions = toolList.map(tool => {
        const schema = tool.inputSchema ? JSON.stringify(tool.inputSchema) : '{}';
        return `- ${tool.name}: ${tool.description || 'No description'} | schema: ${schema}`;
    }).join('\n');

    const systemPrompt = `You are a tool-aware step controller.\nOutput ONLY JSON.\nRules:\n- Use only tools listed.\n- Choose one next action at a time.\n- If the page state blocks progress (captcha, access denied, empty content), you must pick a different search engine or use lite_search, or output action \"replan\" with a reason.\n- Prefer search engines in this order for general search tasks: DuckDuckGo → Bing → Brave → Google (last resort).\n- If the goal is complete, output action \"finish\" with a concise summary.\n- Always include all argument keys (use empty string when not needed).\n\nTOOLS:\n${toolDescriptions}\n\nArguments object keys (always present):\n{\n  \"url\": \"\",\n  \"query\": \"\",\n  \"bx_id\": \"\",\n  \"text\": \"\",\n  \"direction\": \"\",\n  \"selector\": \"\",\n  \"reason\": \"\",\n  \"timeoutMs\": \"\"\n}\n\nJSON format:\n{\n  \"action\": \"tool_name|replan|finish\",\n  \"arguments\": { \"url\": \"\", \"query\": \"\", \"bx_id\": \"\", \"text\": \"\", \"direction\": \"\", \"selector\": \"\", \"reason\": \"\", \"timeoutMs\": \"\" },\n  \"summary\": \"\",\n  \"reason\": \"\"\n}\n`;

    let historyLog = "No history yet.";
    if (previousActions.length > 0) {
        historyLog = previousActions.map((action, index) => `${index + 1}. ${JSON.stringify(action)}`).join('\n');
    }

    const planSteps = (plan.plan || []).map((p, i) => `${i + 1}. ${p.step}`).join('\n');

    const userPrompt = `
Goal: "${userGoal}"

High-level plan:
${planSteps}

Current URL: ${currentURL}

Last action result:
${JSON.stringify(lastActionResult, null, 2)}

Page elements:
${pageStructure}

Previous actions:
${historyLog}

Decide the single next action.`;

    const schema = {
        type: "object",
        additionalProperties: false,
        required: ["action", "arguments", "summary", "reason"],
        properties: {
            action: { type: "string" },
            arguments: {
                type: "object",
                additionalProperties: false,
                properties: {
                    url: { type: "string" },
                    query: { type: "string" },
                    bx_id: { type: "string" },
                    text: { type: "string" },
                    direction: { type: "string" },
                    selector: { type: "string" },
                    reason: { type: "string" },
                    timeoutMs: { type: "string" }
                },
                required: ["url", "query", "bx_id", "text", "direction", "selector", "reason", "timeoutMs"]
            },
            summary: { type: "string" },
            reason: { type: "string" }
        }
    };

    try {
        if (provider === 'openai') {
            if (!OPENAI_API_KEY) throw new Error('OpenAI API key is missing.');
            const content = await callOpenAI(
                [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
                { responseFormat: { type: "json_object" } }
            );
            return JSON.parse(content);
        }
        if (provider === 'codex') {
            const prompt = `${systemPrompt}\n\n${userPrompt}\n\nRespond ONLY with valid JSON.`;
            const content = await callCodex(prompt, { schema });
            return JSON.parse(content);
        }
        if (provider === 'gemini') {
            const prompt = `${systemPrompt}\n\n${userPrompt}\n\nRespond ONLY with valid JSON.`;
            const content = await callGemini(prompt);
            const parsed = extractJson(content);
            if (!parsed) throw new Error('Gemini response did not contain valid JSON.');
            return parsed;
        }
        throw new Error('No active provider is configured.');
    } catch (error) {
        onLog(`🚨 Step controller failed: ${error.message}`);
        return { action: 'replan', arguments: { url: '', query: '', bx_id: '', text: '', direction: '', selector: '', reason: '', timeoutMs: '' }, reason: error.message };
    }
}

async function interpretGoal(userGoal, onLog = console.log) {
    const provider = getActiveProvider();
    const systemPrompt = `You are a task intent classifier for an autonomous web agent.\nDecide the best handling for the user's input:\n- intent = "chat" if the user is just greeting, chatting, asking a simple question that can be answered directly, or not asking for web automation.\n- intent = "schedule" if the user clearly wants a recurring task (daily/weekly/hourly/etc).\n- intent = "plan" for one-time web automation tasks.\n\nReturn strict JSON with:\n{\n  \"intent\": \"chat|schedule|plan\",\n  \"response\": \"If chat, provide a direct helpful response in the user's language. Otherwise empty string.\",\n  \"normalizedGoal\": \"Rewrite the goal as a clear instruction for the agent.\"\n}\n`;
    const userMessage = `User input: "${userGoal}"`;
    const schema = {
        type: "object",
        additionalProperties: false,
        required: ["intent", "response", "normalizedGoal"],
        properties: {
            intent: { type: "string", enum: ["chat", "schedule", "plan"] },
            response: { type: "string" },
            normalizedGoal: { type: "string" }
        }
    };

    try {
        if (provider === 'openai') {
            if (!OPENAI_API_KEY) throw new Error('OpenAI API key is missing.');
            const content = await callOpenAI(
                [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
                { responseFormat: { type: "json_object" } }
            );
            return JSON.parse(content);
        }
        if (provider === 'codex') {
            const prompt = `${systemPrompt}\n\n${userMessage}\n\nRespond ONLY with valid JSON.`;
            const content = await callCodex(prompt, { schema });
            return JSON.parse(content);
        }
        if (provider === 'gemini') {
            const prompt = `${systemPrompt}\n\n${userMessage}\n\nRespond ONLY with valid JSON.`;
            const content = await callGemini(prompt);
            const parsed = extractJson(content);
            if (!parsed) throw new Error('Gemini response did not contain valid JSON.');
            return parsed;
        }
        throw new Error('No active provider is configured.');
    } catch (error) {
        onLog(`🚨 Goal interpretation failed: ${error.message}`);
        return { error: error.message };
    }
}

async function createPlan(userGoal, onLog = console.log) {
    onLog(`🧠 Creating a high-level plan for goal: "${userGoal}"`);
    const systemPrompt = `You are a web automation planner. Your task is to analyze a user's goal and create a high-level, step-by-step plan for an autonomous web agent. The agent has access to a web browser and specialized tools like an advanced search engine (Tavily) and a web scraper (Firecrawl).${getToolAvailabilityNote()}

# Task Analysis
1.  **Identify the Core Task:** What is the user trying to achieve? (e.g., "post to Twitter", "find jobs", "summarize news").
2.  **Identify Scheduling:** Does the user want this to be a recurring task? Look for keywords like "every day", "at 9am", "hourly", "weekly", "weekdays".
    *   If scheduling is mentioned, you MUST set "isRecurring" to true and generate a standard CRON string.
    *   If no schedule is mentioned, "isRecurring" MUST be false.

# CRON String Generation Rules (if isRecurring is true)
-   'every morning at 8am' -> '0 8 * * *'
-   'every day at 5:30 PM' -> '30 17 * * *'
-   'every hour' -> '0 * * * *'
-   'every weekday at 9am' -> '0 9 * * 1-5'
-   'every Sunday at noon' -> '0 12 * * 0'

You MUST respond with a JSON object with the following structure:
{
  "taskSummary": "A concise summary of the user's goal.",
  "targetURL": "The most logical starting URL for the task. For general search tasks, you can suggest a search engine like 'https://www.google.com' or you can just start at 'about:blank' and let the agent use its Tavily search tool.",
  "isRecurring": boolean, // true if a schedule is detected, otherwise false
  "schedule": "A human-readable description of the schedule (e.g., 'Every day at 8:00 AM'). Empty string if not recurring.",
  "cron": "A valid CRON string for the schedule. Empty string if not recurring.",
  "plan": [
    { "step": "A high-level description of the first step. For a search task, this could be 'Use the Tavily search tool to find information about X'." },
    { "step": "A high-level description of the second step." },
    ...
  ]
}`;
    const userMessage = `Please create a plan for the following goal: "${userGoal}"`;
    const provider = getActiveProvider();
    const planSchema = {
        type: "object",
        additionalProperties: false,
        required: ["taskSummary", "targetURL", "isRecurring", "schedule", "cron", "plan"],
        properties: {
            taskSummary: { type: "string" },
            targetURL: { type: "string" },
            isRecurring: { type: "boolean" },
            schedule: { type: "string" },
            cron: { type: "string" },
            plan: {
                type: "array",
                items: {
                    type: "object",
                    additionalProperties: false,
                    required: ["step"],
                    properties: { step: { type: "string" } }
                }
            }
        }
    };
    try {
        if (provider === 'openai') {
            if (!OPENAI_API_KEY) {
                onLog(`🚨 OpenAI API key is missing. Please log in with Codex or Gemini CLI.`);
                return null;
            }
            const content = await callOpenAI(
                [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
                { responseFormat: { type: "json_object" } }
            );
            return JSON.parse(content);
        }

        if (provider === 'codex') {
            const prompt = `${systemPrompt}\n\n${userMessage}\n\nRespond ONLY with valid JSON.`;
            const content = await callCodex(prompt, { schema: planSchema });
            return JSON.parse(content);
        }

        if (provider === 'gemini') {
            const prompt = `${systemPrompt}\n\n${userMessage}\n\nRespond ONLY with valid JSON.`;
            const content = await callGemini(prompt);
            const parsed = extractJson(content);
            if (!parsed) throw new Error('Gemini response did not contain valid JSON.');
            return parsed;
        }

        onLog(`🚨 No active provider is configured. Please log in.`);
        return null;
    } catch (error) {
        onLog(`🚨 Plan creation failed: ${error.message}`);
        return null;
    }
}

async function composePost(postDescription, onLog = console.log) {
    onLog(`🧠 Composing post based on description: "${postDescription}"`);
    const systemPrompt = `You are a creative and witty social media copywriter. Your task is to write a post based on a user's description. The post should be concise, engaging, and match the requested tone.`;
    const userMessage = `Please write a social media post based on this description: "${postDescription}"`;
    try {
        const provider = getActiveProvider();
        if (provider === 'openai') {
            if (!OPENAI_API_KEY) throw new Error('OpenAI API key is missing.');
            return await callOpenAI(
                [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }]
            );
        }
        if (provider === 'codex') {
            const prompt = `${systemPrompt}\n\n${userMessage}`;
            return await callCodex(prompt);
        }
        if (provider === 'gemini') {
            const prompt = `${systemPrompt}\n\n${userMessage}`;
            return await callGemini(prompt);
        }
        throw new Error('No active provider is configured.');
    } catch (error) {
        onLog(`🚨 Composition failed: ${error.message}`);
        return "AI agents are coming for your jobs... and they're starting with mine. #AI #JobSearch";
    }
}

async function summarizeText(textToSummarize, userGoal, onLog = console.log) {
    onLog(`🧠 Summarizing text for goal: "${userGoal}"`);
    const systemPrompt = `You are a text summarization assistant. A user has provided a large block of text scraped from a website. Your task is to summarize it concisely, focusing ONLY on the information relevant to the user's original goal.`;
    const userMessage = `Original Goal: "${userGoal}"\n\nText to Summarize:\n---\n${textToSummarize}`;
    try {
        const provider = getActiveProvider();
        if (provider === 'openai') {
            if (!OPENAI_API_KEY) throw new Error('OpenAI API key is missing.');
            return await callOpenAI(
                [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }]
            );
        }
        if (provider === 'codex') {
            const prompt = `${systemPrompt}\n\n${userMessage}`;
            return await callCodex(prompt);
        }
        if (provider === 'gemini') {
            const prompt = `${systemPrompt}\n\n${userMessage}`;
            return await callGemini(prompt);
        }
        throw new Error('No active provider is configured.');
    } catch (error) {
        onLog(`🚨 Summarization failed: ${error.message}`);
        return "Could not summarize the text due to an error.";
    }
}

async function decideNextAction(
    originalGoal,
    plan,
    previousActions, 
    lastActionResult,
    currentURL,
    pageStructure, 
    screenshotBase64,
    credentials,
    onLog = console.log,
    lastAiError = ""
) {
    onLog(`🧠 Agent is thinking... What is the next best step for the goal: "${originalGoal}"`);
    const provider = getActiveProvider();
    
    const selfCorrectionInstruction = lastAiError 
        ? `\n# CRITICAL AI CORRECTION\nOn your previous attempt, you generated an invalid JSON command. The error was: "${lastAiError}". You MUST correct this mistake. Double-check your output to ensure it is a valid JSON object with a valid 'action' key.`
        : "";

    const systemPrompt = `You are an expert web agent. Your mission is to achieve a user's goal by following a plan and using available tools. You have access to a web browser for visual tasks and specialized API tools for efficiency.
${selfCorrectionInstruction}${getToolAvailabilityNote()}

# CORE LOGIC & RULES - YOU MUST FOLLOW THESE IN ORDER
1.  **RULE #1: ANALYZE THE LAST ACTION'S FEEDBACK.** This is your most important piece of information.
    *   If \`"status": "error"\`, the previous action failed. **You MUST analyze the error message and choose a DIFFERENT action to recover.** 
    *   **Loop Prevention:** If a \`firecrawl_scrape\` action on a URL fails, do not immediately try to scrape the same URL again. Look at the previous \`tavily_search\` results in your history and choose a **DIFFERENT URL** to scrape. If Firecrawl fails on multiple domains, assume it's broken and fall back to using the browser tools: \`navigate\` to the URL, then use \`summarize\` on the main content.

2.  **RULE #2: CHOOSE THE BEST TOOL FOR THE JOB.**
    *   **For general web search & questions:** The \`tavily_search\` tool is your primary choice.
    *   **For scraping a specific URL:** The \`firecrawl_scrape\` tool is your first choice. If it fails, fall back to browser navigation.
    *   **For visual interaction:** Use browser actions (\`click\`, \`type\`, \`scroll\`) when you need to interact with a page visually.

3.  **RULE #3: ADHERE TO THE PLAN.** Use your tools and actions to execute the steps in the provided high-level plan.

4.  **RULE #4: FINISH WHEN THE GOAL IS MET.** Examine the \`originalGoal\`. If you have found the required information (e.g., using \`tavily_search\` or \`firecrawl_scrape\`), the task is COMPLETE. You MUST use the \`finish\` action and provide the answer.

# AVAILABLE ACTIONS (JSON FORMAT ONLY)

### API Tools (Preferred for speed & reliability)
*   **\`tavily_search\`**: \`{"thought": "...", "action": "tavily_search", "query": "..."}\`
*   **\`firecrawl_scrape\`**: \`{"thought": "...", "action": "firecrawl_scrape", "url": "..."}\`

### Browser Tools (For visual interaction & fallback)
*   **\`navigate\`**: \`{"thought": "...", "action": "navigate", "url": "..."}\`
*   **\`click\`**: \`{"thought": "...", "action": "click", "bx_id": "..."}\`
*   **\`type\`**: \`{"thought": "...", "action": "type", "bx_id": "...", "text": "..."}\`
*   **\`scroll\`**: \`{"thought": "...", "action": "scroll", "direction": "down|up"}\`
*   **\`wait\`**: \`{"thought": "...", "action": "wait", "reason": "..."}\`
*   **\`finish\`**: \`{"thought": "...", "action": "finish", "summary": "..."}\`
*   **\`summarize\`**: \`{"thought": "...", "action": "summarize", "bx_id": "..."}\`
*   **\`press_enter\`**: \`{"thought": "...", "action": "press_enter"}\`
*   **\`press_escape\`**: \`{"thought": "...", "action": "press_escape"}\`
*   **\`request_credentials\`**: \`{"thought": "...", "action": "request_credentials", "reason": "..."}\`
`;

    let historyLog = "No history yet.";
    if (previousActions.length > 0) {
        historyLog = previousActions.map((action, index) => `${index + 1}. ${JSON.stringify(action)}`).join('\n');
    }

    const planSteps = plan.plan.map((p, i) => `${i + 1}. ${p.step}`).join('\n');

    const userPrompt = `
## Original Goal
"${originalGoal}"

## High-Level Strategic Plan
Initial URL: ${plan.targetURL}
Steps:
${planSteps}

## Current URL
\`${currentURL}\`

## Last Action Result (Critical Feedback)
\`\`\`json
${JSON.stringify(lastActionResult, null, 2)}
\`\`\`

## Previous Actions
${historyLog}

## Page Elements (from screenshot, if browser is active)
\`\`\`json
${pageStructure}
\`\`\`

**Your Task:** Following the CORE LOGIC & RULES, look at the feedback, the current state, and decide the single best next action to achieve the original goal. Choose the most efficient tool for the job. Output a single, valid JSON object.`;

    try {
        if (provider === 'openai') {
            if (!OPENAI_API_KEY) throw new Error('OpenAI API key is missing.');
            const messages = [
                { role: "system", content: systemPrompt },
                {
                    role: "user",
                    content: [
                        { type: "text", text: userPrompt },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${screenshotBase64}`,
                                detail: "high"
                            }
                        }
                    ]
                }
            ];
            const content = await callOpenAI(messages, { responseFormat: { type: "json_object" } });
            return JSON.parse(content);
        }

        const actionSchema = {
            type: "object",
            additionalProperties: true,
            required: ["action", "thought"],
            properties: {
                action: { type: "string" },
                thought: { type: "string" },
                query: { type: "string" },
                url: { type: "string" },
                bx_id: { type: "string" },
                text: { type: "string" },
                direction: { type: "string" },
                reason: { type: "string" },
                summary: { type: "string" }
            }
        };

        if (provider === 'codex') {
            const prompt = `${systemPrompt}\n\n${userPrompt}\n\nRespond ONLY with valid JSON.`;
            const content = await callCodex(prompt, { schema: actionSchema });
            return JSON.parse(content);
        }

        if (provider === 'gemini') {
            const prompt = `${systemPrompt}\n\n${userPrompt}\n\nRespond ONLY with valid JSON.`;
            const content = await callGemini(prompt);
            const parsed = extractJson(content);
            if (!parsed) throw new Error('Gemini response did not contain valid JSON.');
            return parsed;
        }

        throw new Error('No active provider is configured.');

    } catch (error) {
        onLog(`🚨 An error occurred while deciding next action: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
        return {
            "thought": `A critical API error occurred: ${error.message}. I will wait for a moment before retrying.`,
            "action": "wait",
            "reason": "API call failed.",
            "aiError": true,
            "errorMessage": error.message
        }
    }
}

module.exports = { interpretGoal, createPlan, createToolPlan, decideNextToolAction, decideNextAction, summarizeText, composePost };
