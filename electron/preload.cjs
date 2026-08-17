'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// Expose a safe API to the renderer (no Node.js access in renderer)
contextBridge.exposeInMainWorld('electronAPI', {
  // File operations
  saveAs: (defaultName) => ipcRenderer.invoke('dialog:save-as', defaultName),
  openFile: () => ipcRenderer.invoke('dialog:open'),
  writeFile: (filePath, data) => ipcRenderer.invoke('file:save', { filePath, data }),
  getProjectPath: () => ipcRenderer.invoke('project:get-path'),
  setProjectPath: (fp) => ipcRenderer.invoke('project:set-path', fp),

  // Menu events (main → renderer)
  onMenuNewProject:  (cb) => ipcRenderer.on('menu:new-project', cb),
  onMenuOpenProject: (cb) => ipcRenderer.on('menu:open-project', cb),
  onMenuSaveProject: (cb) => ipcRenderer.on('menu:save-project', cb),
  onMenuExportIfc:   (cb) => ipcRenderer.on('menu:export-ifc', cb),
  onProjectOpened:   (cb) => ipcRenderer.on('project:opened', cb),
  onRequestSaveAs:   (cb) => ipcRenderer.on('project:request-save-as', cb),

  // Cleanup listeners
  removeAllListeners: (channel) => ipcRenderer.removeAllListeners(channel),

  // Is running inside Electron?
  isElectron: true,
});
