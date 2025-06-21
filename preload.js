// preload.js
const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object.
contextBridge.exposeInMainWorld('electronAPI', {
  // --- Credentials ---
  saveCredentials: (data) => ipcRenderer.invoke('save-credentials', data),
  onShowCredentialsModal: (callback) => ipcRenderer.on('show-credentials-modal', (_event, value) => callback(value)),
  credentialsSubmitted: (data) => ipcRenderer.send('credentials-submitted', data),

  // --- Human Intervention ---
  onShowHumanInputModal: (callback) => ipcRenderer.on('show-human-input-modal', (_event, value) => callback(value)),
  humanInputProvided: (data) => ipcRenderer.send('human-input-provided', data)
});