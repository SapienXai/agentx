// agent_api.js

const axios = require("axios");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// The createPlan function is removed. We now have a single, stateful decision-making function.

async function decideNextAction(
    originalGoal,
    previousActions, // A history of what the agent has already done
    currentURL,
    pageStructure, // The JSON of labeled elements
    screenshotBase64,
    credentials,
    onLog = console.log
) {
    onLog(`🧠 Agent is thinking... What is the next best step for the goal: "${originalGoal}"`);
    
    const systemPrompt = `You are an expert web agent. Your mission is to achieve a user's goal by navigating and interacting with web pages.

# CONTEXT
You are given the user's overall goal, a history of your previous actions, an annotated screenshot of the current page with red labels (e.g., "bx-1") on all interactive elements, and a JSON object describing those elements.

# CORE LOGIC & RULES
1.  **STAY FOCUSED ON THE GOAL:** Your primary directive is to make progress toward the \`originalGoal\`.
2.  **ANALYZE THE SCREENSHOT:** The annotated screenshot is your ground truth. Decide your next action based on what you see.
3.  **USE \`bx_id\`:** You MUST use the \`bx_id\` from the screenshot and JSON to click or type. Do not invent selectors.
4.  **COMMON PATTERNS:**
    *   **Search:** To search, first \`type\` into a search bar, then \`press_enter\` or \`click\` a search button.
    *   **Login:** If you see a login form and have credentials, \`type\` the username, \`type\` the password, then \`click\` the login button.
    *   **Navigation:** If the goal is "Go to X", and you are not on X, the first action should be a \`navigate\` action.
5.  **FINISHING:** When you believe the user's original goal has been fully achieved, you MUST use the \`finish\` action.

# AVAILABLE ACTIONS (JSON FORMAT ONLY)

*   **\`navigate\`**: To go to a specific URL. Use this as your FIRST action if you're not on the right site.
    -   \`{"thought": "The goal is to search on Google, but I'm on DuckDuckGo. I need to navigate to Google first.", "action": "navigate", "url": "https://www.google.com"}\`

*   **\`click\`**: To click a labeled element.
    -   \`{"thought": "The 'Sign In' button is labeled bx-5. I will click it.", "action": "click", "bx_id": "bx-5"}\`

*   **\`type\`**: To type into a labeled text field.
    -   \`{"thought": "The search bar is bx-12. I will type the query.", "action": "type", "bx_id": "bx-12", "text": "latest AI news"}\`

*   **\`press_enter\`**: To simulate pressing the Enter/Return key.
    -   \`{"thought": "I have typed the search query. Now I will press Enter to submit.", "action": "press_enter"}\`
    
*   **\`scroll\`**: To scroll the page down to see more content.
    -   \`{"thought": "I need to find the 'Contact Us' link, which is likely in the footer. I will scroll down.", "action": "scroll", "direction": "down"}\`

*   **\`finish\`**: Use this ONLY when the original goal is fully complete.
    -   \`{"thought": "I have found the email address and scraped it. The user's goal is complete.", "action": "finish", "summary": "Found email: contact@coincollect.org"}\`

*   **\`wait\`**: For CAPTCHAs.
    -   \`{"thought": "I am blocked by a CAPTCHA.", "action": "wait", "reason": "Waiting for user to solve CAPTCHA."}\`
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

## Previous Actions
${historyLog}

## Page Elements (from screenshot)
\`\`\`json
${pageStructure}
\`\`\`

**Your Task:** Look at the screenshot, the elements, and the history. Decide the single best next action to achieve the original goal. Output a single JSON object with your action.`;

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
            model: "gpt-4o",
            messages: messages,
            max_tokens: 500,
            response_format: { type: "json_object" }
        }, { headers: { "Authorization": `Bearer ${OPENAI_API_KEY}` } });

        const command = JSON.parse(response.data.choices[0].message.content);
        return command;

    } catch (error) {
        onLog(`🚨 An error occurred while deciding next action: ${error.response ? JSON.stringify(error.response.data) : error.message}`);
        // In case of a catastrophic failure, return a wait command to avoid a crash
        return {
            "thought": `A critical API error occurred: ${error.message}. I will wait for a moment before retrying.`,
            "action": "wait",
            "reason": "API call failed."
        }
    }
}

// createPlan is no longer needed, so we don't export it.
module.exports = { decideNextAction };