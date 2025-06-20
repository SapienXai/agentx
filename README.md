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
  <a href="#usage-guide">Usage Guide</a> •
  <a href="#running-tests">Running Tests</a>
</p>

---


*The BrowserX interface, showing the Home, Agent, History, and Connect screens accessible from both desktop and a mobile device.*

## Overview

BrowserX is a sophisticated AI agent built with Electron and Playwright that can operate a web browser to achieve high-level goals specified by a user. You can simply state a task like "post 'Hello World' to my new blog on hashnode.com," and BrowserX will use GPT-4o to create a step-by-step plan, which it then executes autonomously.

The entire process is managed through a clean, modern user interface that runs on your desktop but can also be **controlled from your phone** or any other device on your local network.

## Key Features

-   🧠 **Natural Language Understanding**: Leverages OpenAI's GPT-4o to interpret your goals and create a robust, multi-step execution plan.
-   🤖 **Autonomous Browser Execution**: Uses Playwright to run a real Chrome browser, navigating pages, typing text, and clicking elements to complete its tasks.
-   📱 **Full Remote Control**: An integrated web server allows you to control the agent from your phone or any other device on the same network.
-   💨 **QR Code Connection**: Simply scan a QR code with your phone to instantly connect to the agent's control panel.
-   👀 **Live Status & History**: Watch the agent's every move in a real-time status log and review all past tasks in the history tab.
-   🛑 **User in the Loop**: You approve the plan before it runs, and a prominent "Stop Agent" button lets you halt execution at any time.
-   ⚡️ **Human-like Operation**: Launches the browser with your real screen dimensions and uses a persistent session to avoid bot detection.

## How It Works

The agent operates on a sophisticated loop that combines high-level planning with real-time decision-making.

1.  **Goal Input**: The user provides a high-level goal in the UI (e.g., "find the top 3 trending AI articles on Hacker News").
2.  **Plan Generation**: The goal is sent to the backend, which calls the **`createPlan`** function. This function uses **GPT-4o** to generate a JSON object containing a `searchTerm`, a `taskSummary`, and a granular, step-by-step **`plan`**. The `searchTerm` is used to construct a `targetURL` (e.g., a Google search) that the agent will open first.
3.  **User Approval**: The generated plan, including all steps, is displayed in the UI for user confirmation.
4.  **Autonomous Execution**: Once approved, the **`runAutonomousAgent`** function is triggered. This starts a Playwright-controlled Chrome browser.
5.  **The Action Loop**: The agent enters a loop, executing each step from its plan:
    a. It examines the current page's content and a screenshot.
    b. It sends this visual and structural data, along with its overall goal and current sub-task, to the **`decideNextBrowserAction`** function. This function uses **GPT-4o** to decide the single next action (e.g., `type`, `click`, `finish_step`).
    c. The action is executed by Playwright.
    d. The process repeats for each step until the plan is complete (`"action": "finish"`), is stopped by the user, or hits an error.
6.  **Live Feedback**: Throughout the process, status updates are broadcast via WebSockets to all connected clients (desktop, phones, etc.).

## Tech Stack

-   **Desktop App**: [Electron](https://www.electronjs.org/)
-   **Browser Automation**: [Playwright](https://playwright.dev/)
-   **AI Models**: [OpenAI API](https://openai.com/) (GPT-4o for planning and actions)
-   **Backend Server**: [Node.js](https://nodejs.org/) & [Express.js](https://expressjs.com/)
-   **Real-time Communication**: [WebSockets](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) (`ws` library)
-   **Frontend UI**: HTML, CSS, JavaScript
-   **QR Code Generation**: `qrcode` library

## Getting Started

Follow these steps to get the BrowserX Agent running on your local machine.

### Prerequisites

-   [Node.js](https://nodejs.org/en/download/) (v18 or later)
-   [npm](https://www.npmjs.com/get-npm) (usually included with Node.js)

### Installation

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-username/browserx-ai-agent.git
    cd browserx-ai-agent
    ```

2.  **Install dependencies:**
    This command also triggers Playwright to download the necessary browser binaries.
    ```bash
    npm install
    ```

3.  **Set up your environment variables:**
    Create a file named `.env` in the root of the project directory. This file holds your OpenAI API key.

    ```ini
    # .env
    OPENAI_API_KEY="sk-YourSecretOpenAIApiKeyHere"

    # Optionally override the default port (3000)
    # PORT=8080
    ```

    *Replace the placeholder with your actual OpenAI API key.* If this variable is missing, the application will log an error and exit on startup.

4.  **Run the application:**
    ```bash
    npm start
    ```

## Usage Guide

Once the application is running, you can interact with it using the UI.

#### 1. 🏠 Create a Task

This is where you start. Enter a high-level goal into the text area and click **"Create & Run Agent"**.

#### 2. ✅ Review the Plan

-   **Plan Review**: After you create a task, it will appear in the "Tasks" list with a "Pending" status. Expand the task to see the AI-generated `Task Summary`, `Initial URL`, and the step-by-step `Plan`. You can either **Confirm & Run** or **Cancel**.
-   **Live View**: Once confirmed, the task status will change to "Queued" and then "Running". You can see the live status log of the agent's actions within the expanded task view.
-   **Stop Agent**: A **"Stop Agent"** button appears while the agent is running. Click this at any time to immediately terminate the current task.

#### 3. 🗂️ Manage Tasks

-   **Queue**: The "Queue" tab shows all tasks that are currently running or waiting to run.
-   **Scheduled**: The "Scheduled" tab shows tasks that are set to run on a recurring basis.
-   **Archive**: The "Archive" tab holds all your completed, stopped, or failed tasks.

#### 4. 📱 Connect a Mobile Device

-   To control the agent from your phone, click the QR code icon in the header.
-   Open the camera app on your phone and scan the QR code.
-   This will open the web interface in your phone's browser, giving you full control.
-   **Note:** Your phone must be connected to the same Wi-Fi network as your computer.

Future Improvements
Enhanced Error Recovery: Improve the agent's ability to recover from unexpected errors or popups.
Long-term Memory: Implement a vector database (e.g., Pinecone) to give the agent memory of past tasks.
More Complex Actions: Add data extraction and summarization capabilities.
Security: Add an optional password protection layer for the web interface.
Contributing
Contributions are welcome! If you have an idea for a new feature or have found a bug, please open an issue or submit a pull request.
License
This project is released under the MIT License.