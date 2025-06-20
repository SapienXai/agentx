// agent_api.js

const axios = require("axios");
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

// +++ NEW HELPER FUNCTION FOR SUMMARIZATION +++
async function summarizeText(textToSummarize, userGoal, onLog = console.log) {
    onLog(`🧠 Summarizing text for goal: "${userGoal}"`);
    const systemPrompt = `You are a text summarization assistant. A user has provided a large block of text scraped from a website. Your task is to summarize it concisely, focusing ONLY on the information relevant to the user's original goal.`;

    const userMessage = `Original Goal: "${userGoal}"\n\nText to Summarize:\n---\n${textToSummarize}`;

    try {
         const response = await axios.post("https://api.openai.com/v1/chat/completions", {
            model: "gpt-4o-mini", // A cheaper model is fine for summarization
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: userMessage }
            ],
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
    onLog = console.log
) {
    onLog(`🧠 Agent is thinking... What is the next best step for the goal: "${originalGoal}"`);
    
    const systemPrompt = `You are an expert web agent. Your mission is to achieve a user's goal by navigating and interacting with web pages.

# CONTEXT
You are given the user's goal, a history of your actions, an annotated screenshot of the current page, and a JSON object describing labeled elements. You may also receive the result of your last action (e.g., scraped text), which may be truncated.

# CORE LOGIC & RULES
1.  **GOAL-FOCUSED:** Always choose the action that gets you closer to the \`originalGoal\`.
2.  **CHECK ELEMENT TAGS:** Before you act, check the element's \`tag\` in the JSON.
    *   **ONLY \`type\` into \`<input>\` or \`<textarea>\` elements.**
    *   Do NOT try to \`type\` into a \`<button>\` or \`<a>\` tag.
3.  **USE \`bx_id\`:** You MUST use the \`bx_id\` from the screenshot and JSON to click, type or scrape.
4.  **DEALING WITH LARGE TEXT:**
    *   If you need to understand a large article to find specific information, first \`scrape_text\` on the main content area.
    *   Then, use the \`summarize\` action on the same element to get a concise summary focused on the goal.
    *   Finally, use the summary to \`finish\` the task.
5.  **FINISHING:** After you have found the information requested in the goal, you MUST use the \`finish\` action.

# AVAILABLE ACTIONS (JSON FORMAT ONLY)

*   **\`navigate\`**: To go to a specific URL.
    -   \`{"thought": "I need to start at Google.", "action": "navigate", "url": "https://www.google.com"}\`

*   **\`click\`**: To click a labeled element.
    -   \`{"thought": "The search icon is labeled bx-10. I will click it to reveal the search bar.", "action": "click", "bx_id": "bx-10"}\`

*   **\`type\`**: To type into a labeled text field. **Confirm it's an input/textarea first.**
    -   \`{"thought": "The element bx-6 is an input field. I will type 'COLLECT' into it.", "action": "type", "bx_id": "bx-6", "text": "COLLECT"}\`

*   **\`press_enter\`**: To simulate pressing the Enter/Return key.
    -   \`{"thought": "I have typed the search query. Now I will press Enter to submit.", "action": "press_enter"}\`
    
*   **\`scrape_text\`**: To extract the full text from a single, large element (like an article body).
    -   \`{"thought": "The main article content is labeled bx-55. I will scrape its text.", "action": "scrape_text", "bx_id": "bx-55"}\`

*   **\`summarize\`**: To process a large block of text you have just scraped. Use this on the same element you just scraped.
    -   \`{"thought": "I have scraped the article text from bx-55. Now I will summarize it to find the key historical facts.", "action": "summarize", "bx_id": "bx-55"}\`

*   **\`finish\`**: Use this ONLY when the original goal is fully complete.
    -   \`{"thought": "I have the summary of the history of Turkey. The goal is complete.", "action": "finish", "summary": "The history of Turkey involves the Ottoman Empire, its dissolution after WWI, and the establishment of the modern republic under Atatürk in 1923."}\`

*   **\`scroll\`**: To scroll the page down to see more content.
    -   \`{"thought": "I can't see the price, so I will scroll down.", "action": "scroll", "direction": "down"}\`

*   **\`wait\`**: For CAPTCHAs or to let the page load.
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

## Last Action Result (may be truncated)
\`\`\`
${lastActionResult || "N/A"}
\`\`\`

## Page Elements (from screenshot)
\`\`\`json
${pageStructure}
\`\`\`

**Your Task:** Look at the screenshot, the elements, and the results. Decide the single best next action to achieve the original goal. Ensure you check the element's HTML tag in the JSON before trying to type. Output a single JSON object with your action.`;

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

module.exports = { decideNextAction, summarizeText }; // Export the new function