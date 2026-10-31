const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('launcher', {
  getState: () => ipcRenderer.invoke('launcher:get-state'),
  start: () => ipcRenderer.invoke('launcher:start'),
  stop: () => ipcRenderer.invoke('launcher:stop'),
  open: () => ipcRenderer.invoke('launcher:open'),
  openData: () => ipcRenderer.invoke('launcher:open-data'),
  onState: (callback) => {
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on('launcher:state', handler);
    return () => ipcRenderer.removeListener('launcher:state', handler);
  },
});
