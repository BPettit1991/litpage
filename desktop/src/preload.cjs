// The bridge exists only on the setup page that ships with the app. Litpage itself (local or remote) runs as a
// plain web page with no access to the shell; main.mjs checks the sender again on every call.
const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('litpageDesktop', {
    state: () => ipcRenderer.invoke('setup:state'),
    choose: (choice) => ipcRenderer.invoke('setup:choose', choice),
  });
}
