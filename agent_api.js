// agent_api.js

const axios = require("axios");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// ... (createPlan function remains unchanged) ...
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
2.  Summarize the user's ultimate goal.
3.  Outline a brief strategy to start the task.

# RESPONSE FORMAT
Your output MUST be a single, valid JSON object. Do not include any text before or after the JSON.
The JSON object must contain these exact keys: "searchTerm", "taskSummary", and "strategy".

# JSON STRUCTURE EXAMPLE:
{
  "searchTerm": "Twitter",
  "taskSummary": "Post a tweet about a new product",
  "strategy": "Search for the main website, find the login button, and then proceed to the compose tweet page."
}

# EXAMPLES OF LOGIC:
- User Goal: "Post a tweet about our new product." -> "searchTerm": "Twitter"
- User Goal: "Find the latest news on BBC." -> "searchTerm": "BBC News"
- User Goal: "Order a book from Amazon." -> "searchTerm": "Amazon"

${selfCorrectionPrompt}`;

            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Here is my goal: "${userGoal}". Please create a plan.` }],
                response_format: { type: "json_object" }
            }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });

            const plan = JSON.parse(response.data.choices[0].message.content);
            if (!plan.searchTerm || typeof plan.searchTerm !== 'string' || !plan.taskSummary || typeof plan.taskSummary !== 'string' || !plan.strategy || typeof plan.strategy !== 'string') {
                throw new Error("Invalid plan schema: The generated JSON is missing or has invalid 'searchTerm', 'taskSummary', or 'strategy' keys.");
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


// +++ THIS FUNCTION IS CORRECTED TO HANDLE WAITING AND STOPPABLE STATES +++
async function decideNextBrowserAction(goal, strategy, currentURL, simplifiedHtml, screenshotBase64, previousAction, isStuck, actionHistory = [], onLog = console.log) {
    onLog(`🧠 Agent is thinking about the next action (with vision & memory)...`);
    try {
        // +++ FIX: Added a new "Element-Action Guide" to help the AI choose the correct action for an element type. +++
        const systemPrompt = `You are an expert web agent. Your primary tool is vision. You analyze a screenshot and a simplified list of HTML elements to decide the next action.

# CORE LOGIC (Follow in Order):
1.  **GOAL COMPLETION CHECK:** Analyze the screenshot for signs of success (e.g., "Post successful," "Message sent"). If complete, you MUST use \`finish\`.
2.  **RE-PLANNING CHECK:** Is the page an error (e.g., 404), or is the strategy impossible from here? If so, you MUST use \`replan\`.
3.  **MANUAL INTERVENTION HANDLER:** Is the agent blocked by a login/signup form or a CAPTCHA that it cannot solve? If so, you MUST use \`wait\` to pause for the user.
4.  **PAGE LOAD / UNCERTAINTY HANDLER:** If the page seems to be loading, an element isn't visible yet, or you are simply unsure, you MUST use \`think\`. This allows the agent to re-evaluate in the next step without stopping. Do NOT use \`wait\` for this.
5.  **ACTION SELECTION:** Based on visual evidence and the element type, choose the next logical action.

# ELEMENT-ACTION GUIDE
-   **Use \`type\` for:** \`<input>\`, \`<textarea>\` (or elements with \`role="textbox"\`). You cannot \`click\` these.
-   **Use \`click\` for:** \`<button>\`, \`<a>\`, \`<div>\` (or elements with \`role="button"\`, \`role="link"\`, etc.).

# ACTION FORMAT (VALID JSON ONLY)
**IMPORTANT**: For "click" and "type", the "selector" value MUST be the string from the \`data-agent-id\` attribute ONLY.
-   \`{"action": "replan", "reason": "Explain why the old plan failed."}\`
-   \`{"action": "click", "selector": "the-actual-id-from-the-html-list"}\`
-   \`{"action": "click", "x": <number>, "y": <number>, "reason": "Clicked element not in HTML."}\`
-   \`{"action": "type", "selector": "the-id-of-the-input-element", "text": "..."}\`
-   \`{"action": "wait", "reason": "Waiting for user to solve login/signup or CAPTCHA."}\` (Use this sparingly!)
-   \`{"action": "think", "thought": "The page is loading, I will wait and re-evaluate."}\` (Use this if you are not sure or the page isn't ready)
-   \`{"action": "finish", "summary": "Goal is complete. [Your summary]"}\``;

        let historyLog = "No history yet.";
        if (actionHistory && actionHistory.length > 0) {
            historyLog = actionHistory.map((action, index) => `${index + 1}. ${JSON.stringify(action)}`).join('\n');
        }

        const userPrompt = `## CURRENT STATE
-   **Overall Goal:** "${goal}"
-   **Current Strategy:** "${strategy}"
-   **Current URL:** \`${currentURL}\`
-   **LOOP DETECTED:** \`${isStuck}\` (If true, you MUST try a new action)

## RECENT ACTION HISTORY
${historyLog}

## INTERACTIVE ELEMENTS LIST (May be incomplete)
\`\`\`html
${simplifiedHtml}
\`\`\`

**Your Task:** Analyze the screenshot. Based on your core logic and the element-action guide, decide the single next JSON action. If the page is still loading or you are unsure, use 'think'.`;

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
                                detail: "high"
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