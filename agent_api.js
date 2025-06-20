// agent_api.js

const axios = require("axios");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

async function createPlan(userGoal, onLog = console.log) {
    const maxRetries = 2;
    let lastError = null;

    for (let i = 0; i < maxRetries; i++) {
        onLog(`🧠 Attempt ${i + 1}/${maxRetries}: Creating a granular plan for: "${userGoal}"...`);
        try {
            const selfCorrectionPrompt = lastError
                ? `You failed on the last attempt. The error was: "${lastError}". Please review the instructions and ensure your output is a single, valid JSON object with the required keys.`
                : "";
            
            const systemPrompt = `You are a planning agent. Your task is to analyze a user's goal and generate a plan in a specific JSON format.

# CORE TASK
1.  **Identify the main subject or 'searchTerm'** from the user's goal (e.g., a website, brand, or topic).
2.  **Create a granular, step-by-step plan.** Each step must be a single, clear, atomic action.
3.  Summarize the user's ultimate goal into a short 'taskSummary'.
4.  Analyze if the goal is a recurring task.

# HOW TO START A TASK (VERY IMPORTANT)
-   **If the goal requires a web search to find a website, your plan MUST start with these specific steps:**
    1.  Navigate to "https://www.google.com".
    2.  Type the 'searchTerm' into the search bar.
    3.  Click the "Google Search" button.
    4.  Click the most relevant search result link to navigate to the target website.
-   **If the goal provides a direct URL**, the first step should be to navigate to that URL.

# RESPONSE FORMAT
Your output MUST be a single, valid JSON object with the keys: "searchTerm", "taskSummary", "plan", "isRecurring", "schedule", "cron", and "targetURL".

# KEY-SPECIFIC RULES
-   **"plan"**: MUST be an array of objects, where each object has a single key "step" with a string value.
-   **"searchTerm"**: The primary keyword(s) to search for. If no search is needed, this can be the name of the website.
-   **"targetURL"**: The initial URL the browser should navigate to. For a web search, this MUST be "https://www.google.com". For direct navigation, it's the URL from the user's goal.
-   **"cron" / "schedule"**: Must be empty strings ("") if "isRecurring" is false. Use standard 5-field cron syntax if true.

# EXAMPLE (for a goal requiring a search)
// User Goal: "Find the latest news on the 'AI' subreddit"
{
  "searchTerm": "reddit AI",
  "taskSummary": "Find the latest news on the 'AI' subreddit",
  "plan": [
    { "step": "Navigate to https://www.google.com" },
    { "step": "Type 'reddit AI' into the search bar." },
    { "step": "Click the 'Google Search' button." },
    { "step": "Click the link for the 'r/artificial' subreddit in the search results." },
    { "step": "Sort the posts by 'New' to find the latest news." }
  ],
  "isRecurring": false,
  "schedule": "",
  "cron": "",
  "targetURL": "https://www.google.com"
}

${selfCorrectionPrompt}`;

            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Here is my goal: "${userGoal}". Please create a plan.` }],
                response_format: { type: "json_object" }
            }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });

            const plan = JSON.parse(response.data.choices[0].message.content);
            const requiredKeys = ["searchTerm", "taskSummary", "plan", "isRecurring", "schedule", "cron", "targetURL"]; // Added targetURL
            for (const key of requiredKeys) {
                if (plan[key] === undefined) {
                     throw new Error(`Invalid plan schema: The generated JSON is missing the required key '${key}'.`);
                }
            }
            if (!Array.isArray(plan.plan) || plan.plan.some(p => typeof p.step !== 'string')) {
                 throw new Error(`Invalid plan schema: 'plan' must be an array of objects with a 'step' string.`);
            }
            if (typeof plan.isRecurring !== 'boolean') {
                 throw new Error(`Invalid plan schema: 'isRecurring' must be a boolean.`);
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

async function decideNextBrowserAction(goal, fullPlan, currentSubTask, currentURL, pageStructure, screenshotBase64, credentials, actionHistory = [], onLog = console.log) {
    onLog(`🧠 Agent is thinking about the next action (using Structure & Vision)...`);
    try {
        const systemPrompt = `You are an expert web agent. Your task is to achieve a sub-task by examining a webpage.

# CORE LOGIC & RULES
1.  **COOKIE CONSENT:** If you see a cookie consent banner, your absolute first priority is to click the button to accept it.
2.  **LOGIN:** If the task requires a login and you see a login form BUT you have NO credentials, you MUST use the \`request_credentials\` action. Do not try to guess credentials.
3.  **REASONING:** After handling cookies and logins, write your step-by-step reasoning in the "thought" field.
4.  **ACTION:** Choose **one** action from the list.
5.  **SUB-TASK COMPLETION:** If the Current Sub-Task is complete, you MUST use the \`finish_step\` action.
6.  **SELECTOR HIERARCHY:** ALWAYS prefer \`testid\` if available.

# AVAILABLE ACTIONS (JSON FORMAT ONLY)

*   **\`click\` / \`type\`**: To interact with an element.
    -   \`{"thought": "...", "action": "click", "selector": {"testid": "login-button"}}\`

*   **\`request_credentials\`**: Use this when you need to log in but have no credentials.
    -   \`{"thought": "The task is to post a comment, which requires an account. I am on the login page and have no credentials.", "action": "request_credentials", "reason": "Login required to post a comment."}\`

*   **\`finish_step\`**: Use this when the Current Sub-Task is complete.
    -   \`{"thought": "I have successfully typed in the username. The next step is the password.", "action": "finish_step"}\`

*   **\`wait\`**: Use this ONLY for HUMAN intervention you cannot solve (e.g., CAPTCHA).
    -   \`{"thought": "I am blocked by a CAPTCHA.", "action": "wait", "reason": "Waiting for user to solve CAPTCHA."}\`

*   **\`finish\`**: When the **Overall Goal** is successfully completed.
    -   \`{"thought": "I've clicked the final post button and can see the post. The entire task is complete.", "action": "finish", "summary": "Successfully posted the update."}\`

*   **\`replan\`**: If the current plan is failing or you are on an error page.
    -   \`{"thought": "This is a 404 page. The plan is blocked.", "action": "replan", "reason": "Landed on a 404 page."}\`
`;

        let historyLog = "No history yet.";
        if (actionHistory && actionHistory.length > 0) {
            historyLog = actionHistory.map((action, index) => `${index + 1}. ${JSON.stringify(action)}`).join('\n');
        }

        const userPrompt = `## FULL PLAN (Your current step is marked with -->)
${fullPlan}

## CURRENT STATE
-   **Overall Goal:** "${goal}"
-   **Current Sub-Task:** "${currentSubTask}"
-   **Current URL:** \`${currentURL}\`
-   **Credentials Found:** ${credentials ? `Yes (username: ${credentials.username})` : 'No'}

## RECENT ACTION HISTORY
${historyLog}

## PAGE STRUCTURE
\`\`\`json
${pageStructure}
\`\`\`

**Your Task:** Analyze the screenshot and page structure. Provide your next action as a single JSON object.
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