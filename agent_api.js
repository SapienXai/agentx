// agent_api.js

const axios = require("axios");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function createPlan(userGoal, onLog = console.log) {
    onLog(`🧠 Creating a high-level plan for goal: "${userGoal}"`);
    const systemPrompt = `You are a web automation planner. Your task is to analyze a user's goal and create a high-level, step-by-step plan for an autonomous web agent. The plan should be logical and easy for a non-technical user to understand. The agent can search, navigate, click, type, and summarize content.

You MUST respond with a JSON object with the following structure:
{
  "taskSummary": "A concise summary of the user's goal.",
  "targetURL": "The most logical starting URL for the task. This could be a search engine like 'https://www.google.com' or a specific website if mentioned in the goal.",
  "plan": [
    { "step": "A high-level description of the first step." },
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

    const systemPrompt = `You are an expert web agent. Your mission is to achieve a user's goal by following a plan and reacting to action outcomes.
${selfCorrectionInstruction}

# CORE LOGIC & RULES - YOU MUST FOLLOW THESE IN ORDER
1.  **RULE #1: ANALYZE THE LAST ACTION'S FEEDBACK.** You will be given a 'Last Action Result' object. This is your most important piece of information.
    *   If \`"status": "error"\`, the previous action failed. **You MUST analyze the error message and choose a DIFFERENT action to recover.** Do NOT repeat the failed action. For example, if a \`navigate\` to a URL fails, try searching for the website on Google instead. If a \`click\` fails, maybe you should \`wait\`, or scroll the element into view, or choose a different element.
    *   If \`"status": "success"\`, the action worked. Proceed with the plan.

2.  **RULE #2: ADHERE TO THE PLAN.** Your primary job is to execute the steps in the provided high-level plan based on the current screen. If the current URL is \`about:blank\`, your first action MUST be to navigate to the plan's \`targetURL\`.

3.  **RULE #3: FINISH WHEN THE GOAL IS MET.** Examine the \`originalGoal\`. If the goal was to *find information* (like a link, a price, an address), and that information is now visible on the screen or was in the \`lastActionResult\`, the task is COMPLETE. You MUST use the \`finish\` action and provide the information in the summary. Do not get stuck in loops.

4.  **RULE #4: HANDLE BLOCKERS.** Before anything else (after checking feedback), check for overlays like cookie banners or login modals and deal with them first.

# AVAILABLE ACTIONS (JSON FORMAT ONLY) - Adhere strictly to this schema.

*   **\`navigate\`**: \`{"thought": "...", "action": "navigate", "url": "..."}\`
*   **\`click\`**: \`{"thought": "...", "action": "click", "bx_id": "..."}\`
*   **\`type\`**: \`{"thought": "...", "action": "type", "bx_id": "...", "text": "..."}\`
*   **\`scroll\`**: \`{"thought": "...", "action": "scroll", "direction": "down|up"}\`
*   **\`wait\`**: \`{"thought": "...", "action": "wait", "reason": "..."}\`
*   **\`finish\`**: \`{"thought": "...", "action": "finish", "summary": "..."}\`
*   **\`scrape_text\`**: \`{"thought": "...", "action": "scrape_text", "bx_id": "..."}\`
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

## Page Elements (from screenshot)
\`\`\`json
${pageStructure}
\`\`\`

**Your Task:** Following the CORE LOGIC & RULES, look at the feedback, screenshot, and elements. Decide the single best next action to achieve the original goal. Output a single, valid JSON object.`;

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