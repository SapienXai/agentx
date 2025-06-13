// agent_api.js

const axios = require("axios");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// +++ THIS FUNCTION IS UNCHANGED +++
async function createPlan(userGoal, onLog = console.log) {
    const maxRetries = 2;
    let lastError = null;

    for (let i = 0; i < maxRetries; i++) {
        onLog(`🧠 Attempt ${i + 1}/${maxRetries}: Asking GPT to create a plan for: "${userGoal}"...`);
        try {
            const selfCorrectionPrompt = lastError
                ? `You failed on the last attempt. The error was: "${lastError}". Please ensure your output is a valid JSON object containing ONLY the keys "targetURL", "taskSummary", and "strategy".`
                : "";
            const systemPrompt = `You are a planning agent. Your job is to take a user's goal and create a plan. You must provide the best starting URL, a clear task summary, and a brief strategy. Your output MUST be a valid JSON object with "targetURL", "taskSummary", and "strategy" keys. ${selfCorrectionPrompt}`;

            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Here is my goal: "${userGoal}". Please create a plan.` }],
                response_format: { type: "json_object" }
            }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });

            const plan = JSON.parse(response.data.choices[0].message.content);
            if (!plan.targetURL || typeof plan.targetURL !== 'string' || !plan.taskSummary || typeof plan.taskSummary !== 'string' || !plan.strategy || typeof plan.strategy !== 'string') {
                throw new Error("Invalid plan schema: The generated JSON is missing or has invalid 'targetURL', 'taskSummary', or 'strategy' keys.");
            }
            return plan;
        } catch (error) {
            lastError = error.message;
            onLog(`⚠️ Attempt ${i + 1} failed. Error: ${lastError}`);
            if (i < maxRetries - 1) { onLog(`Retrying...`); }
        }
    }
    throw new Error(`AI failed to generate a valid plan after ${maxRetries} attempts. Last error: ${lastError}`);
}

// +++ THIS IS THE CORRECTED FUNCTION WITH A STRICT LOGIN HANDLER +++
async function decideNextBrowserAction(goal, strategy, currentURL, simplifiedHtml, screenshotBase64, previousAction, isStuck, onLog = console.log) {
    onLog(`🧠 Agent is thinking about the next action (with vision)...`);
    try {
        const systemPrompt = `You are a web agent with vision. You follow a strict algorithm to decide your next action.

# AGENT ALGORITHM & RULES (Follow in order)
1.  **GOAL COMPLETION CHECK:** First, analyze the screenshot. Is the goal already complete? (e.g., text like "Post successful," "Message sent," or "Welcome back!"). If YES, you MUST use the \`finish\` action.

2.  **LOGIN/SIGNUP HANDLER (CRITICAL):** Second, check if the page is a login or signup form.
    -   If the screenshot shows input fields for "email," "username," or "password," you MUST use the \`wait\` action to pause for the user.
    -   Your reason for waiting should be "Waiting for user to complete login/signup."
    -   **DO NOT** attempt to \`type\` in email or password fields. You do not have credentials.

3.  **STUCK CHECK:** If the system reports \`LOOP DETECTED: true\`, your previous action had no effect. You MUST try a DIFFERENT action. Do not repeat the last one.

4.  **ACTION SELECTION:** If none of the above rules apply, analyze the screenshot and the HTML element list to determine the best next step to achieve your goal. Choose from \`click\`, \`type\`, or \`think\`.

# ACTION FORMAT (VALID JSON ONLY)
-   \`{"action": "type", "selector": "[data-agent-id='...']", "text": "..."}\` (Use for any input field EXCEPT login/password)
-   \`{"action": "click", "selector": "[data-agent-id='...']"}\`
-   \`{"action": "wait", "reason": "Waiting for user to complete login/signup."}\`
-   \`{"action": "think", "thought": "I am unsure what to do next, I will pause to re-evaluate."}\`
-   \`{"action": "finish", "summary": "Goal is complete. [Your summary]"}\``;

        const userPrompt = `## CURRENT STATE
-   **Overall Goal:** "${goal}"
-   **Your Strategy:** "${strategy}"
-   **Current URL:** \`${currentURL}\`
-   **Previous Action:** \`${previousAction ? JSON.stringify(previousAction) : "none"}\`
-   **LOOP DETECTED:** \`${isStuck}\` (If true, you MUST try a different action)

## CURRENT PAGE INTERACTIVE ELEMENTS
\`\`\`html
${simplifiedHtml}
\`\`\`

Based on your analysis of the screenshot and the strict algorithm, what is the single next action JSON?`;

        const response = await axios.post("https://api.openai.com/v1/chat/completions", {
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: systemPrompt },
                {
                    role: "user",
                    content: [
                        { type: "text", text: userPrompt },
                        {
                            type: "image_url",
                            image_url: {
                                url: `data:image/jpeg;base64,${screenshotBase64}`,
                                detail: "low"
                            }
                        }
                    ]
                }
            ],
            response_format: { type: "json_object" }
        }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });

        const command = JSON.parse(response.data.choices[0].message.content);
        return command;
    } catch(error) {
        onLog(`🚨 An error occurred while deciding next action: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
        throw error;
    }
}


module.exports = { createPlan, decideNextBrowserAction };