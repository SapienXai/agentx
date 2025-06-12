// preload.js

// The preload script is no longer used for exposing Node.js APIs to the renderer.
// Communication is now handled via standard web APIs (HTTP Fetch and WebSockets)
// served by the Express server in main.js.
// We keep this file to maintain the principle of contextIsolation.

const { contextBridge } = require('electron');

// You could expose non-sensitive, desktop-only helpers here if needed in the future.
contextBridge.exposeInMainWorld('electron', {
  // Example: isDesktop: true
});