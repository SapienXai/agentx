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
        // Return null on error. The calling function will handle this.
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
        ? `\n# CRITICAL CORRECTION\n${lastAiError} You MUST correct this mistake. Double-check your output to ensure it is a valid JSON object with all required keys for the chosen action. Do NOT repeat the failed action.`
        : "";

    const systemPrompt = `You are an expert web agent. Your mission is to achieve a user's goal by navigating and interacting with web pages.
${selfCorrectionInstruction}

# CORE LOGIC & RULES - YOU MUST FOLLOW THESE IN ORDER
1.  **RULE #1: ADHERE TO THE PLAN.** Your primary job is to execute the steps in the provided high-level plan. Use the current screen to determine the best action to accomplish the *next* logical step of the plan.
2.  **RULE #2: HANDLE BLOCKERS.** Before anything else, check for overlays.
    *   **CAPTCHA/BOT-CHECKS:** If you see a CAPTCHA ("I'm not a robot", etc.), you CANNOT solve it. You MUST use the \`request_human_intervention\` action immediately.
    *   **MODALS:** For login/signup modals, cookie banners, etc., your priority is to deal with it by clicking a "Log in", "Accept", or "Close" button. If you are stuck in a modal you don't understand, use the \`press_escape\` action.
3.  **RULE #3: DON'T GET STUCK.** If you are instructed that you are in a loop (your previous actions did not change the page), you MUST take a DIFFERENT action. Try scrolling, waiting, or if completely blocked, use \`request_human_intervention\`.
4.  **RULE #4: FINISH.** When the goal is verifiably complete, you MUST use the \`finish\` action.

# AVAILABLE ACTIONS (JSON FORMAT ONLY) - Adhere strictly to this schema.

*   **\`navigate\`**: \`{"thought": "...", "action": "navigate", "url": "..."}\`
*   **\`click\`**: \`{"thought": "...", "action": "click", "bx_id": "..."}\`
*   **\`type\`**: \`{"thought": "...", "action": "type", "bx_id": "...", "text": "..."}\`
*   **\`compose_text\`**: \`{"thought": "...", "action": "compose_text", "bx_id": "...", "description": "..."}\`
*   **\`press_enter\`**: \`{"thought": "...", "action": "press_enter"}\`
*   **\`press_escape\`**: \`{"thought": "...", "action": "press_escape"}\`
*   **\`scrape_text\`**: \`{"thought": "...", "action": "scrape_text", "bx_id": "..."}\`
*   **\`summarize\`**: \`{"thought": "...", "action": "summarize", "bx_id": "..."}\`
*   **\`request_credentials\`**: \`{"thought": "...", "action": "request_credentials", "reason": "..."}\`
*   **\`request_human_intervention\`**: \`{"thought": "...", "action": "request_human_intervention", "reason": "..."}\`
*   **\`finish\`**: \`{"thought": "...", "action": "finish", "summary": "..."}\`
*   **\`scroll\`**: \`{"thought": "...", "action": "scroll", "direction": "down|up"}\`
*   **\`wait\`**: \`{"thought": "...", "action": "wait", "reason": "..."}\`
`;

    let historyLog = "No history yet.";
    if (previousActions.length > 0) {
        historyLog = previousActions.map((action, index) => `${index + 1}. ${JSON.stringify(action)}`).join('\n');
    }

    const planSteps = plan.plan.map((p, i) => `${i + 1}. ${p.step}`).join('\n');

    const userPrompt = `
## Original Goal
"${originalGoal}"

## High-Level Strategic Plan (Follow This!)
Initial URL: ${plan.targetURL}
Steps:
${planSteps}

## Current URL
\`${currentURL}\`

## Credentials Found
${credentials ? `Yes (username: ${credentials.username})` : 'No'}

## Previous Actions
${historyLog}

## Last Action Result (may be truncated)
\`\`\`
${lastActionResult || "N/A"}
\`\`\`

## Page Elements (from screenshot)
\`\`\`json
${pageStructure}
\`\`\`

**Your Task:** Following the CORE LOGIC & RULES, look at the screenshot and elements. Decide the single best next action to achieve the original goal by following the high-level plan. Output a single, valid JSON object that strictly follows the schema.`;

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