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
1.  Identify the main website, brand, or company to search for.
2.  Summarize the user's ultimate goal into a short task summary.
3.  **Create a granular, step-by-step plan to achieve the goal.** Each step should be a single, clear, atomic action (e.g., 'click a button', 'type in a field'). Avoid ambiguous steps.
4.  Analyze if the goal is a recurring task.

# RESPONSE FORMAT
Your output MUST be a single, valid JSON object.
The JSON object must contain: "searchTerm", "taskSummary", "plan", "isRecurring", "schedule", and "cron".
The "plan" key MUST be an array of objects, where each object has a single key "step" with a string value.

# CRON FORMAT
- Use standard 5-field cron syntax.
- If the task is not recurring, "schedule" and "cron" MUST be empty strings ("").

# JSON STRUCTURE EXAMPLE (GOOD, GRANULAR PLAN):
{
  "searchTerm": "Twitter",
  "taskSummary": "Post a tweet about a new product",
  "plan": [
    { "step": "Navigate to the main page and sign in if necessary." },
    { "step": "Click the 'Post' or 'Tweet' button to open the composer modal." },
    { "step": "Type the new product announcement into the main text area." },
    { "step": "Click the final 'Post' or 'Tweet' button to publish the content." }
  ],
  "isRecurring": false,
  "schedule": "",
  "cron": ""
}

# EXAMPLE OF A BAD, AMBIGUOUS PLAN (DO NOT DO THIS):
// { "plan": [{ "step": "Find the 'Compose Tweet' or 'Post' button and click it." }] }
// This is bad because "click it" is ambiguous. It could be the button to open the composer or the button to submit the post. Be specific.

${selfCorrectionPrompt}`;

            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Here is my goal: "${userGoal}". Please create a plan.` }],
                response_format: { type: "json_object" }
            }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });

            const plan = JSON.parse(response.data.choices[0].message.content);
            const requiredKeys = ["searchTerm", "taskSummary", "plan", "isRecurring", "schedule", "cron"];
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

async function decideNextBrowserAction(goal, fullPlan, currentSubTask, currentURL, pageStructure, screenshotBase64, credentials, actionHistory = [], onLog = console.log) {
    onLog(`🧠 Agent is thinking about the next action (using Structure & Vision)...`);
    try {
        const systemPrompt = `You are an expert web agent. Your task is to achieve a sub-task which is part of a larger plan by examining a screenshot and a structured representation of the webpage.

# CORE LOGIC & RULES
1.  **REASONING:** First, in the "thought" field, write down your step-by-step reasoning. Look at the **Full Plan** to understand the context of the **Current Sub-Task**.
2.  **ACTION:** Based on your reasoning, choose **one** action to perform from the list below.
3.  **SUB-TASK COMPLETION:** If you believe you have successfully completed the Current Sub-Task, you MUST use the \`finish_step\` action. This will move you to the next step in the plan.
4.  **SELECTOR HIERARCHY:** ALWAYS prefer \`testid\` if available.

# AVAILABLE ACTIONS (JSON FORMAT ONLY)

*   **\`click\` / \`type\`**: To interact with an element.
    -   \`{"thought": "...", "action": "click", "selector": {"testid": "SideNav_NewTweet_Button"}}\`

*   **\`finish_step\`**: Use this when the **Current Sub-Task** is complete.
    -   \`{"thought": "I have successfully clicked the button to open the composer, which completes this sub-task. The next step is to type the content.", "action": "finish_step"}\`

*   **\`think\`**: Use this if the page is visibly loading or an element you need isn't there yet.
    -   \`{"thought": "I've just navigated. I will think for a moment to let the page stabilize.", "action": "think"}\`

*   **\`wait\`**: Use this ONLY for HUMAN intervention (CAPTCHA, login without credentials).
    -   \`{"thought": "I am blocked by a CAPTCHA which I cannot solve.", "action": "wait", "reason": "Waiting for user to solve CAPTCHA."}\`

*   **\`finish\`**: When the **Overall Goal** has been successfully completed (i.e., the last step of the plan is done).
    -   \`{"thought": "I've clicked the final post button and can see a success message. The entire task is complete.", "action": "finish", "summary": "Successfully posted the update."}\`

*   **\`replan\`**: If the current plan is failing or you are on an error page.
    -   \`{"thought": "This is a 404 page. The current plan is blocked.", "action": "replan", "reason": "Landed on a 404 page."}\`
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