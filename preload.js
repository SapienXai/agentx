// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object.
contextBridge.exposeInMainWorld('electronAPI', {
  // Renderer to Main (and wait for a response)
  saveCredentials: (data) => ipcRenderer.invoke('save-credentials', data),

  // Main to Renderer
  onShowCredentialsModal: (callback) => ipcRenderer.on('show-credentials-modal', (_event, value) => callback(value)),
  
  // Renderer to Main (fire-and-forget, after user submits)
  credentialsSubmitted: (data) => ipcRenderer.send('credentials-submitted', data)
});