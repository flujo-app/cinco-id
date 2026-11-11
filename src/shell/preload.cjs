// The only things the screen may ask the desktop shell to do.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shell', {
  setIgnoreMouse: ignore => ipcRenderer.send('ignore-mouse', Boolean(ignore)),
  onToggleListen: callback => ipcRenderer.on('toggle-listen', () => callback()),
  openFolder: which => ipcRenderer.invoke('open-folder', String(which)),
});
