# BrowserX AI Agent

<p align="center">
  <img src="./logo.png" alt="BrowserX AI Agent Logo" width="150"/>
</p>

<p align="center">
  <strong>An autonomous AI agent that understands natural language, creates a plan, and executes tasks in a web browser.</strong>
</p>

<p align="center">
  <a href="#key-features">Key Features</a> •
  <a href="#how-it-works">How It Works</a> •
  <a href="#tech-stack">Tech Stack</a> •
  <a href="#getting-started">Getting Started</a> •
  <a href="#usage-guide">Usage Guide</a>
</p>

---


*The BrowserX interface, showing the Home, Agent, History, and Connect screens accessible from both desktop and a mobile device.*

## Overview

BrowserX is a sophisticated AI agent built with Electron and Puppeteer that can operate a web browser to achieve high-level goals specified by a user. You can simply state a task like "post 'Hello World' to my new blog on hashnode.com," and BrowserX will use GPT-4o to create a step-by-step plan, which it then executes autonomously.

The entire process is managed through a clean, modern user interface that runs on your desktop but can also be **controlled from your phone** or any other device on your local network.

## Key Features

-   🧠 **Natural Language Understanding**: Leverages OpenAI's GPT-4o to interpret your goals and create a robust, multi-step execution plan.
-   🤖 **Autonomous Browser Execution**: Uses Puppeteer to run a real Chrome browser, navigating pages, typing text, and clicking elements to complete its tasks.
-   📱 **Full Remote Control**: An integrated web server allows you to control the agent from your phone or any other device on the same network.
-   💨 **QR Code Connection**: Simply scan a QR code with your phone to instantly connect to the agent's control panel.
-   👀 **Live Status & History**: Watch the agent's every move in a real-time status log and review all past tasks in the history tab.
-   🛑 **User in the Loop**: You approve the plan before it runs, and a prominent "Stop Agent" button lets you halt execution at any time.
-   ⚡️ **Efficient Operation**: Blocks unnecessary resources like images and trackers to speed up page loads and reduce noise for the AI.

## How It Works

The agent operates on a sophisticated loop that combines high-level planning with real-time decision-making.

1.  **Goal Input**: The user provides a high-level goal in the UI (e.g., "find the top 3 trending AI articles on Hacker News").
2.  **Plan Generation**: The goal is sent to the backend, which calls the **`createPlan`** function. This function uses **GPT-4o** to generate a JSON object containing a `targetURL`, a `taskSummary`, and a high-level `strategy`.
3.  **User Approval**: The generated plan is displayed in the UI for user confirmation.
4.  **Autonomous Execution**: Once approved, the **`runAutonomousAgent`** function is triggered. This starts a Puppeteer-controlled Chrome browser.
5.  **The Action Loop**: The agent enters a loop for each step:
    a. It looks at the current page and simplifies the HTML to include only interactive elements (`<a>`, `<button>`, `<input>`, etc.).
    b. It sends the simplified HTML, the original goal, the strategy, its previous action, and its current URL to the **`decideNextBrowserAction`** function. This function uses the faster **GPT-4o-mini** to decide the single next action (e.g., `type`, `click`, `finish`).
    c. The action is executed by Puppeteer.
    d. The process repeats until the agent determines the task is complete (`"action": "finish"`), is stopped by the user, or hits an error.
6.  **Live Feedback**: Throughout the process, status updates are broadcast via WebSockets to all connected clients (desktop, phones, etc.).

## Tech Stack

-   **Desktop App**: [Electron](https://www.electronjs.org/)
-   **Browser Automation**: [Puppeteer](https://pptr.dev/)
-   **AI Models**: [OpenAI API](https://openai.com/) (GPT-4o for planning, GPT-4o-mini for actions)
-   **Backend Server**: [Node.js](https://nodejs.org/) & [Express.js](https://expressjs.com/)
-   **Real-time Communication**: [WebSockets](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) (`ws` library)
-   **Frontend UI**: HTML, [Bootstrap 5](https://getbootstrap.com/), JavaScript
-   **QR Code Generation**: `qrcode` library

## Getting Started

Follow these steps to get the BrowserX Agent running on your local machine.

### Prerequisites

-   [Node.js](https://nodejs.org/en/download/) (v18 or later)
-   [npm](https://www.npmjs.com/get-npm) (usually included with Node.js)
-   A full installation of [Google Chrome](https://www.google.com/chrome/) (not Chromium) for Puppeteer to control.

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/browserx-ai-agent.git
    cd browserx-ai-agent
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Set up your environment variables:**
    Create a file named `.env` in the root of the project directory. This file will hold your OpenAI API key.

    ```ini
    # .env
    OPENAI_API_KEY="sk-YourSecretOpenAIApiKeyHere"
    ```
    *Replace the placeholder with your actual OpenAI API key.*
    If this variable is missing, the application will log an error and exit on startup.

4.  **Run the application:**
    ```bash
    npm start
    ```

## Usage Guide

Once the application is running, you can interact with it using the four tabs in the bottom navigation bar.

#### 1. 🏠 Home

This is where you start. Enter a high-level goal into the text area and click **"Create Plan"**.

#### 2. 🤖 Agent

-   **Plan Review**: After you create a plan, this screen will show you the AI-generated `Target URL`, `Task Summary`, and `Strategy`. You can either **Confirm & Run Task** or **Cancel**.
-   **Live View**: Once confirmed, this screen shows the live status log of the agent's actions.
-   **Stop Agent**: A large red **"Stop Agent"** button appears while the agent is running. Click this at any time to immediately terminate the current task.

#### 3. 📜 History

This tab shows a list of all tasks you have run, along with their status: `Completed`, `Failed`, or `Stopped`.

#### 4. 📱 Connect

-   To control the agent from your phone, navigate to this tab on your desktop.
-   Open the camera app on your phone and scan the QR code.
-   This will open the web interface in your phone's browser, giving you full control.
-   **Note:** Your phone must be connected to the same Wi-Fi network as your computer.

## Future Improvements

-   [ ] **Enhanced Error Recovery**: Improve the agent's ability to recover from unexpected errors or popups.
-   [ ] **Long-term Memory**: Implement a vector database (e.g., Pinecone) to give the agent memory of past tasks.
-   [ ] **More Complex Actions**: Add data extraction and summarization capabilities.
-   [ ] **Security**: Add an optional password protection layer for the web interface.

## Contributing

Contributions are welcome! If you have an idea for a new feature or have found a bug, please open an issue or submit a pull request.

---

MIT License