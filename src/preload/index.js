const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('savvy', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (settings) => ipcRenderer.invoke('set-settings', settings),
  captureScreen: () => ipcRenderer.invoke('capture-screen'),
  getWindowSources: () => ipcRenderer.invoke('get-window-sources'),
  captureWindow: (windowId) => ipcRenderer.invoke('capture-window', windowId),
  closeOverlay: () => ipcRenderer.send('close-overlay'),
  setOverlaySize: (size) => ipcRenderer.invoke('set-overlay-size', size),
  getOverlayPosition: () => ipcRenderer.invoke('get-overlay-position'),
  setOverlayPosition: (pos) => ipcRenderer.invoke('set-overlay-position', pos),
  clearBubbleMode: () => ipcRenderer.invoke('clear-bubble-mode'),
  moveOverlayToCorner: () => ipcRenderer.invoke('move-overlay-to-corner'),
});
