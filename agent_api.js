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
5.  Analyze if the goal inherently requires user authentication ('requiresLogin').

# HOW TO START A TASK (VERY IMPORTANT)
-   **DIRECT URL FIRST:** If the user's goal mentions a common, well-known website (e.g., "post on Medium", "search on Amazon", "login to Twitter"), your **first priority** is to attempt direct navigation. Construct the URL yourself (e.g., "https://www.medium.com", "https://www.amazon.com"). The first step should be to navigate to that URL.
-   **GOOGLE SEARCH AS FALLBACK:** Only if the website is obscure, ambiguous, or you need to find a specific page (like "the career page for OpenAI"), should your plan start with a Google search. If you use Google, the plan MUST start with:
    1.  Navigate to "https://www.google.com".
    2.  Type the 'searchTerm' into the search bar.
    3.  Click the "Google Search" button.
    4.  Click the most relevant search result link.

# RESPONSE FORMAT
Your output MUST be a single, valid JSON object with the keys: "searchTerm", "taskSummary", "plan", "isRecurring", "schedule", "cron", "targetURL", and "requiresLogin".

# KEY-SPECIFIC RULES
-   **"plan"**: MUST be an array of objects, where each object has a single key "step" with a string value.
-   **"searchTerm"**: The primary subject. For direct navigation, this is the site name (e.g., "Medium"). For search, it's the search query.
-   **"targetURL"**: The initial URL. For direct navigation, this MUST be the guessed URL (e.g., "https://www.medium.com"). For a web search, this MUST be "https://www.google.com".
-   **"cron" / "schedule"**: Must be empty strings ("") if "isRecurring" is false.
-   **"requiresLogin"**: A boolean (true/false).

# EXAMPLE (for a goal with a direct URL)
// User Goal: "Post 'Hello World' on my Medium blog"
{
  "searchTerm": "Medium",
  "taskSummary": "Post 'Hello World' on Medium",
  "plan": [
    { "step": "Navigate to https://www.medium.com" },
    { "step": "Click the 'Sign in' button." },
    { "step": "Enter username and password to log in." },
    { "step": "Click the 'Write' button to start a new story." },
    { "step": "Enter 'AI agents taking our jobs' as the title." },
    { "step": "Write the main content of the blog post in the story editor." },
    { "step": "Click the 'Publish' button." },
    { "step": "Confirm the publication." }
  ],
  "isRecurring": false,
  "schedule": "",
  "cron": "",
  "targetURL": "https://www.medium.com",
  "requiresLogin": true
}

${selfCorrectionPrompt}`;

            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Here is my goal: "${userGoal}". Please create a plan.` }],
                response_format: { type: "json_object" }
            }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });

            const plan = JSON.parse(response.data.choices[0].message.content);
            const requiredKeys = ["searchTerm", "taskSummary", "plan", "isRecurring", "schedule", "cron", "targetURL", "requiresLogin"];
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
            if (typeof plan.requiresLogin !== 'boolean') {
                 throw new Error(`Invalid plan schema: 'requiresLogin' must be a boolean.`);
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
7.  **STUCK?** If the plan is not working or you are on an error page (404, etc.), you MUST use the \`replan\` action. Do not get stuck in a loop.

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

*   **\`replan\`**: If the current plan is failing, you're on an error page, or you are stuck in a loop.
    -   \`{"thought": "This is a 404 page. The plan is blocked.", "action": "replan", "reason": "Landed on a 404 page."}\`
`;

        let historyLog = "No history yet.";
        if (actionHistory && actionHistory.length > 0) {
            historyLog = actionHistory.map((index, action) => `${index + 1}. ${JSON.stringify(action)}`).join('\n');
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