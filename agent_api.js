// agent_api.js

const axios = require("axios");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// +++ THIS IS THE CORRECTED FUNCTION +++
async function createPlan(userGoal, onLog = console.log) {
    const maxRetries = 2;
    let lastError = null;

    for (let i = 0; i < maxRetries; i++) {
        onLog(`🧠 Attempt ${i + 1}/${maxRetries}: Asking GPT to create a plan for: "${userGoal}"...`);
        try {
            const selfCorrectionPrompt = lastError
                ? `You failed on the last attempt. The error was: "${lastError}". Please ensure your output is a valid JSON object containing ONLY the keys "targetURL", "taskSummary", and "strategy".`
                : "";
            // We now ask for a "strategy" to guide the action agent.
            const systemPrompt = `You are a planning agent. Your job is to take a user's goal and create a plan. You must provide the best starting URL, a clear task summary, and a brief strategy. Your output MUST be a valid JSON object with "targetURL", "taskSummary", and "strategy" keys. ${selfCorrectionPrompt}`;

            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                // Upgraded to the best model for high-quality planning.
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Here is my goal: "${userGoal}". Please create a plan.` }],
                response_format: { type: "json_object" }
            }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });

            const plan = JSON.parse(response.data.choices[0].message.content);
            // Updated validation to include the new 'strategy' key.
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

// +++ THIS IS THE CORRECTED FUNCTION +++
async function decideNextBrowserAction(goal, strategy, currentURL, simplifiedHtml, previousAction, isStuck, onLog = console.log) {
    onLog(`🧠 Agent is thinking about the next action...`);
    try {
        const systemPrompt = `You are a web agent. You operate in a strict loop. Analyze the state and return a single action JSON.

# ALGORITHM & RULES
1.  **STUCK CHECK (CRITICAL):** The system has detected you are in a loop (the last action did nothing). You MUST try a DIFFERENT action. Do not repeat the previous action.
2.  **GOAL COMPLETION CHECK:** Is there text like "Your post was sent" or "Message sent"? If YES, you are DONE. Use the \`finish\` action.
3.  **STRICT LOGIN CHECK:** Is the page EXPLICITLY a login screen (asking for username/password)? If YES, use the \`wait\` action.
4.  **CONFUSION HANDLER:** If you are not on a login screen but are unsure what to do next, use the \`think\` action to pause and re-evaluate.
5.  **ACTION SELECTION:** Based on the goal, strategy, and visible elements, choose the next logical step.

# ACTION FORMAT (VALID JSON ONLY)
-   \`{"action": "type", "selector": "[data-agent-id='...']", "text": "..."}\`
-   \`{"action": "click", "selector": "[data-agent-id='...']"}\`
-   \`{"action": "think", "thought": "A brief explanation of why you are pausing to think."}\`
-   \`{"action": "wait", "reason": "Waiting for user to complete login form."}\`
-   \`{"action": "finish", "summary": "Goal is complete. [Your summary]"}\``;
        
        // The user prompt now includes the 'strategy' and the 'isStuck' flag.
        const userPrompt = `## CURRENT STATE
-   **Overall Goal:** "${goal}"
-   **Your Strategy:** "${strategy}"
-   **Current URL:** \`${currentURL}\`
-   **Previous Action:** \`${previousAction ? JSON.stringify(previousAction) : "none"}\`
-   **LOOP DETECTED:** \`${isStuck}\` (If true, you MUST try a different action)

## CURRENT PAGE ELEMENTS
\`\`\`html
${simplifiedHtml}
\`\`\`

Based on your algorithm, what is the single next action JSON?`;

        const response = await axios.post("https://api.openai.com/v1/chat/completions", {
            // Upgraded to the best small model for speed and capability.
            model: "gpt-4o-mini", 
            messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userPrompt }],
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