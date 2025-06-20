// agent_api.js

const axios = require("axios");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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
    previousActions, 
    lastActionResult,
    currentURL,
    pageStructure, 
    screenshotBase64,
    credentials,
    onLog = console.log,
    lastAiError = "" // +++ NEW PARAMETER FOR SELF-CORRECTION +++
) {
    onLog(`🧠 Agent is thinking... What is the next best step for the goal: "${originalGoal}"`);
    
    // +++ NEW: Add self-correction instruction if there was a previous error +++
    const selfCorrectionInstruction = lastAiError 
        ? `\n# CRITICAL CORRECTION\nOn your previous attempt, you generated an invalid command. The error was: "${lastAiError}". You MUST correct this mistake. Double-check your output to ensure it is a valid JSON object with all required keys for the chosen action.`
        : "";

    const systemPrompt = `You are an expert web agent. Your mission is to achieve a user's goal by navigating and interacting with web pages.
${selfCorrectionInstruction}

# CORE LOGIC & RULES - YOU MUST FOLLOW THESE IN ORDER
1.  **RULE #1: HANDLE BLOCKERS & MODALS.** Before anything else, check for overlays. If a login/signup modal, cookie banner, or any other popup is blocking the page, your ONLY priority is to deal with it. This usually means clicking a "Log in", "Accept", or "Close" button. **If you are stuck in a modal you don't understand, use the \`press_escape\` action.**
2.  **RULE #2: LOGIN IF NECESSARY.** If the goal requires being logged in and you are not, your next priority is to log in.
3.  **RULE #3: EXECUTE THE GOAL.** Once the page is clear and you are logged in (if needed), proceed with the actions to achieve the \`originalGoal\`.
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
*   **\`finish\`**: \`{"thought": "...", "action": "finish", "summary": "..."}\`
*   **\`scroll\`**: \`{"thought": "...", "action": "scroll", "direction": "down|up"}\`
*   **\`wait\`**: \`{"thought": "...", "action": "wait", "reason": "..."}\`
`;

    let historyLog = "No history yet.";
    if (previousActions.length > 0) {
        historyLog = previousActions.map((action, index) => `${index + 1}. ${JSON.stringify(action)}`).join('\n');
    }

    const userPrompt = `
## Original Goal
"${originalGoal}"

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

**Your Task:** Following the CORE LOGIC & RULES, look at the screenshot and elements. Decide the single best next action to achieve the original goal. Output a single, valid JSON object that strictly follows the schema.`;

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

module.exports = { decideNextAction, summarizeText, composePost };