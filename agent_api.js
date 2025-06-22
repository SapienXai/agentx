// agent_api.js

const axios = require("axios");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function createPlan(userGoal, onLog = console.log) {
    onLog(`🧠 Creating a high-level plan for goal: "${userGoal}"`);
    const systemPrompt = `You are a web automation planner. Your task is to analyze a user's goal and create a high-level, step-by-step plan for an autonomous web agent. The agent has access to a web browser and specialized tools like an advanced search engine (Tavily) and a web scraper (Firecrawl).

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
    try {
        const response = await axios.post("https://api.openai.com/v1/chat/completions", {
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
            max_tokens: 1000,
            response_format: { type: "json_object" }
        }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });
        
        return JSON.parse(response.data.choices[0].message.content);

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
         const response = await axios.post("https://api.openai.com/v1/chat/completions", {
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
            max_tokens: 1000,
        }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });
        return response.data.choices[0].message.content;
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
         const response = await axios.post("https://api.openai.com/v1/chat/completions", {
            model: "gpt-4o-mini",
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userMessage }],
            max_tokens: 1000,
        }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });
        return response.data.choices[0].message.content;
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
    
    const selfCorrectionInstruction = lastAiError 
        ? `\n# CRITICAL AI CORRECTION\nOn your previous attempt, you generated an invalid JSON command. The error was: "${lastAiError}". You MUST correct this mistake. Double-check your output to ensure it is a valid JSON object with a valid 'action' key.`
        : "";

    const systemPrompt = `You are an expert web agent. Your mission is to achieve a user's goal by following a plan and using available tools. You have access to a web browser for visual tasks and specialized API tools for efficiency.
${selfCorrectionInstruction}

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

    try {
        const response = await axios.post("https://api.openai.com/v1/chat/completions", {
            model: "gpt-4o-mini",
            messages: messages,
            max_tokens: 1000,
            response_format: { type: "json_object" }
        }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });

        const command = JSON.parse(response.data.choices[0].message.content);
        return command;

    } catch (error) {
        onLog(`🚨 An error occurred while deciding next action: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
        return {
            "thought": `A critical API error occurred: ${error.message}. I will wait for a moment before retrying.`,
            "action": "wait",
            "reason": "API call failed."
        }
    }
}

module.exports = { createPlan, decideNextAction, summarizeText, composePost };