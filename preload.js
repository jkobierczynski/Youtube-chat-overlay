'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('overlay', {
  getConfig: () => ipcRenderer.invoke('get-config'),
  onChatMessages: (cb) => ipcRenderer.on('chat-messages', (_e, messages) => cb(messages)),
  onStatus: (cb) => ipcRenderer.on('status', (_e, text) => cb(text)),
  onMoveMode: (cb) => ipcRenderer.on('move-mode', (_e, enabled) => cb(enabled)),
  onDisplayMode: (cb) => ipcRenderer.on('display-mode', (_e, settings) => cb(settings)),
});
