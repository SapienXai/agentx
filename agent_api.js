// agent_api.js

const axios = require("axios");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// createPlan function remains unchanged...
async function createPlan(userGoal, onLog = console.log) {
    const maxRetries = 2;
    let lastError = null;

    for (let i = 0; i < maxRetries; i++) {
        onLog(`🧠 Attempt ${i + 1}/${maxRetries}: Identifying primary search keyword for: "${userGoal}"...`);
        try {
            const selfCorrectionPrompt = lastError
                ? `You failed on the last attempt. The error was: "${lastError}". Please review the instructions and ensure your output is a single, valid JSON object with the required keys.`
                : "";
            
            const systemPrompt = `You are a planning agent. Your task is to analyze a user's goal and generate a plan in a specific JSON format.

# CORE TASK
1.  Identify the main website, brand, or company to search for.
2.  Summarize the user's ultimate goal into a short task summary.
3.  Outline a brief, high-level strategy to start the task.
4.  **Analyze if the goal is a recurring task**. Look for keywords like "every day", "each week", "every 15 minutes", etc.
    - If it IS recurring, set "isRecurring" to true and provide both a human-readable schedule and a standard cron string.
    - If it is a one-time task, set "isRecurring" to false.

# RESPONSE FORMAT
Your output MUST be a single, valid JSON object. Do not include any text before or after the JSON.
The JSON object must contain these exact keys: "searchTerm", "taskSummary", "strategy", "isRecurring", "schedule", and "cron".

# CRON FORMAT
- Use standard 5-field cron syntax: (minute hour day-of-month month day-of-week).
- If the task is not recurring, "schedule" and "cron" MUST be empty strings ("").
- If you cannot determine a valid cron schedule from the user's request, assume it is not a recurring task.


# JSON STRUCTURE EXAMPLE:
{
  "searchTerm": "Twitter",
  "taskSummary": "Post a tweet about a new product",
  "strategy": "Search for the main website, find the login button, and then proceed to the compose tweet page.",
  "isRecurring": false,
  "schedule": "",
  "cron": ""
}

# EXAMPLES OF LOGIC:
- User Goal: "Post a tweet about our new product." -> "searchTerm": "Twitter"
- User Goal: "Find the latest news on BBC." -> "searchTerm": "BBC News"
- User Goal: "Order a book from Amazon." -> "searchTerm": "Amazon"
- User Goal: "Send a marketing email every Friday at 10 AM" -> "isRecurring": true, "schedule": "Every Friday at 10:00 AM", "cron": "0 10 * * 5"
- User Goal: "Check the stock price every 15 minutes" -> "isRecurring": true, "schedule": "Every 15 minutes", "cron": "*/15 * * * *"

${selfCorrectionPrompt}`;

            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Here is my goal: "${userGoal}". Please create a plan.` }],
                response_format: { type: "json_object" }
            }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });

            const plan = JSON.parse(response.data.choices[0].message.content);
            const requiredKeys = ["searchTerm", "taskSummary", "strategy", "isRecurring", "schedule", "cron"];
            for (const key of requiredKeys) {
                if (plan[key] === undefined) {
                     throw new Error(`Invalid plan schema: The generated JSON is missing the required key '${key}'.`);
                }
            }
            if (typeof plan.isRecurring !== 'boolean') {
                 throw new Error(`Invalid plan schema: 'isRecurring' must be a boolean.`);
            }
            
            plan.targetURL = `https://www.google.com/search?q=${encodeURIComponent(plan.searchTerm)}`;
            
            return plan;
        } catch (error) {
            lastError = error.message;
            onLog(`⚠️ Attempt ${i + 1} failed. Error: ${lastError}`);
            if (i < maxRetries - 1) { onLog(`Retrying...`); }
        }
    }
    throw new Error(`AI failed to generate a valid plan after ${maxRetries} attempts. Last error: ${lastError}`);
}

async function decideNextBrowserAction(goal, strategy, currentURL, pageStructure, screenshotBase64, credentials, actionHistory = [], onLog = console.log) {
    onLog(`🧠 Agent is thinking about the next action (using Structure & Vision)...`);
    try {
        // +++ NEW, STRICTER PROMPT +++
        const systemPrompt = `You are an expert web agent. Your task is to achieve a goal by examining a screenshot and a structured representation of the webpage.

# CORE LOGIC & RULES
1.  **REASONING:** First, in the "thought" field, write down your step-by-step reasoning.
2.  **ACTION:** Based on your reasoning, choose **one** action to perform from the list below.
3.  **POST-LOGIN BEHAVIOR:** After logging in, you will be on a main page (like a social media feed). Do NOT use \`wait\` for dynamic content like posts to load. Instead, use \`think\` if you are unsure, or proceed with the next step of your task (e.g., find the 'Compose' button).
4.  **SELECTOR HIERARCHY:** ALWAYS prefer \`testid\` if available. It is the most stable identifier. If not, use \`role\` and \`name\`.

# AVAILABLE ACTIONS (JSON FORMAT ONLY)

*   **\`click\` / \`type\`**: To interact with an element.
    -   (With testid): \`{"thought": "...", "action": "click", "selector": {"testid": "tweetButtonInline"}}\`
    -   (With role/name): \`{"thought": "...", "action": "click", "selector": {"role": "button", "name": "Log In"}}\`

*   **\`think\`**: Use this if the page is visibly loading (e.g., a full-page white screen), an element you need isn't there yet, OR you are on a dynamic feed and are waiting for content. **This is your default 'wait' for page content.**
    -   \`{"thought": "I've just logged in. The main feed is loading posts. I will think for a moment to let it stabilize before looking for the compose button.", "action": "think"}\`

*   **\`wait\`**: Use this ONLY for situations that require HUMAN intervention (like a CAPTCHA or a login form you lack credentials for). **DO NOT use this for normal page loading.**
    -   \`{"thought": "I am blocked by a CAPTCHA which I cannot solve.", "action": "wait", "reason": "Waiting for user to solve CAPTCHA."}\`
    -   \`{"thought": "I see a login form, but have no credentials.", "action": "wait", "reason": "Waiting for user to log in."}\`

*   **\`finish\`**: When the user's goal has been successfully completed.
    -   \`{"thought": "The confirmation 'Posted successfully' is visible. Task complete.", "action": "finish", "summary": "Successfully posted the update."}\`

*   **\`replan\`**: If the current strategy is failing, you are on an error page (404), or you are on the wrong website entirely.
    -   \`{"thought": "This is a 404 page. The plan is blocked.", "action": "replan", "reason": "Landed on a 404 page."}\`

# LOGIN RULES
- **IF** you see a login form and credentials **ARE** available, use them. If you are already logged in (e.g., you see a profile picture instead of a 'Log In' button), do NOT try to log in again.
- **IF** you see a login form and credentials **ARE NOT** available, you **MUST** use the \`wait\` action.
`;

        let historyLog = "No history yet.";
        if (actionHistory && actionHistory.length > 0) {
            historyLog = actionHistory.map((action, index) => `${index + 1}. ${JSON.stringify(action)}`).join('\n');
        }

        const userPrompt = `## CURRENT STATE
-   **Overall Goal:** "${goal}"
-   **Current Strategy:** "${strategy}"
-   **Current URL:** \`${currentURL}\`
-   **Credentials Found for this site:** ${credentials ? `Yes (username: ${credentials.username})` : 'No'}

## RECENT ACTION HISTORY
${historyLog}

## PAGE STRUCTURE (Accessibility Tree & Test IDs)
\`\`\`json
${pageStructure}
\`\`\`

**Your Task:** Analyze the screenshot and page structure. Prioritize using a \`testid\` for your selector. Provide your next action as a single JSON object.
${credentials ? `\n## CREDENTIALS TO USE\n- username: "${credentials.username}"\n- password: "${credentials.password}"` : ''}
`;
        
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

        const response = await axios.post("https://api.openai.com/v1/chat/completions", {
            model: "gpt-4o",
            messages: messages,
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