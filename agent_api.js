// agent_api.js

const axios = require("axios");

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// +++ THIS FUNCTION IS MODIFIED TO SEARCH FOR A BRAND/KEYWORD LIKE A HUMAN +++
async function createPlan(userGoal, onLog = console.log) {
    const maxRetries = 2;
    let lastError = null;

    for (let i = 0; i < maxRetries; i++) {
        onLog(`🧠 Attempt ${i + 1}/${maxRetries}: Identifying primary search keyword for: "${userGoal}"...`);
        try {
            const selfCorrectionPrompt = lastError
                ? `You failed on the last attempt. The error was: "${lastError}". Please ensure your output is a valid JSON object containing ONLY the keys "searchTerm", "taskSummary", and "strategy".`
                : "";
            const systemPrompt = `You are a planning agent that mimics human behavior. Your first step is to identify the main website or brand to search for.
Given a user's goal, extract the single most relevant search keyword. This is usually a brand name, company, or website.

# EXAMPLES:
- User Goal: "Post a tweet about our new product." -> searchTerm: "Twitter"
- User Goal: "Find the latest news on BBC." -> searchTerm: "BBC News"
- User Goal: "Order a book from Amazon." -> searchTerm: "Amazon"

Your output MUST be a valid JSON object with "searchTerm", "taskSummary", and "strategy" keys. The 'strategy' should briefly describe how to identify the correct link from the search results and the next step. ${selfCorrectionPrompt}`;

            const response = await axios.post("https://api.openai.com/v1/chat/completions", {
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: systemPrompt }, { role: "user", content: `Here is my goal: "${userGoal}". Please create a plan.` }],
                response_format: { type: "json_object" }
            }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });

            const plan = JSON.parse(response.data.choices[0].message.content);
            // Validate the new schema with 'searchTerm'
            if (!plan.searchTerm || typeof plan.searchTerm !== 'string' || !plan.taskSummary || typeof plan.taskSummary !== 'string' || !plan.strategy || typeof plan.strategy !== 'string') {
                throw new Error("Invalid plan schema: The generated JSON is missing or has invalid 'searchTerm', 'taskSummary', or 'strategy' keys.");
            }
            
            // The executor will navigate to a search engine with the generated keyword.
            // This simulates a user typing into the browser's search bar.
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

// +++ This function is unchanged but is perfectly suited to handle the search results page +++
async function decideNextBrowserAction(goal, strategy, currentURL, simplifiedHtml, screenshotBase64, previousAction, isStuck, actionHistory = [], onLog = console.log) {
    onLog(`🧠 Agent is thinking about the next action (with vision & memory)...`);
    try {
        const systemPrompt = `You are an expert web agent. Your primary tool is vision. You analyze a screenshot and a simplified list of HTML elements to decide the next action.

# CORE LOGIC (Follow in Order):
1.  **GOAL COMPLETION CHECK:** Analyze the screenshot for signs of success (e.g., "Post successful," "Message sent"). If complete, you MUST use \`finish\`.
2.  **RE-PLANNING CHECK (CRITICAL):** Is the page an error (e.g., 404 Not Found), or is the initial strategy clearly impossible from the current page? For example, if your strategy is "Click the blog post button" but you are on a login page. If so, you MUST use the \`replan\` action to ask for a new strategy.
3.  **LOGIN/SIGNUP HANDLER:** If you see a login/signup form, you MUST use \`wait\`. Do not try to type credentials.
4.  **ACTION SELECTION:** Based on the visual evidence, choose the next logical action.
    -   If an element is in the HTML list, prefer clicking it with a \`selector\`.
    -   If an element is visible but NOT in the HTML list, you MUST use coordinates \`x\` and \`y\` as a fallback.

# ACTION FORMAT (VALID JSON ONLY)
-   \`{"action": "replan", "reason": "A brief but clear explanation of why the old plan failed."}\`
-   \`{"action": "click", "selector": "[data-agent-id='...']"}\` (Primary Method)
-   \`{"action": "click", "x": <number>, "y": <number>, "reason": "Clicked on element not in HTML list."}\` (Fallback Method)
-   \`{"action": "type", "selector": "[data-agent-id='...']", "text": "..."}\`
-   \`{"action": "wait", "reason": "Waiting for user to complete login/signup."}\`
-   \`{"action": "think", "thought": "Briefly explain your reasoning if you are unsure."}\`
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

**Your Task:** Analyze the screenshot. Based on your core logic, decide the single next JSON action. If the current strategy is failing, use 'replan'.`;

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