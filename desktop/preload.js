// Bridge between the sandboxed renderer and the main process. Exposes a
// minimal API on window.api — nothing else of Node/Electron leaks.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Account creation (only allowed when DB has zero users — first-run flow).
  hasUser:    () => ipcRenderer.invoke('auth:hasUser'),
  register:   (username, password) => ipcRenderer.invoke('auth:register', username, password),

  // Folder + library control. Login/library-data fetches go over HTTP
  // (same path as the browser frontend), so they don't appear here.
  getFolder:   () => ipcRenderer.invoke('library:getFolder'),
  pickFolder:  () => ipcRenderer.invoke('library:pickFolder'),
  rescan:      () => ipcRenderer.invoke('library:rescan'),

  // Where the embedded HTTP server is listening.
  port: () => ipcRenderer.invoke('app:port'),

  // Subscribe to events from main: scan progress, folder change, logout from menu.
  on: (channel, handler) => {
    const allowed = new Set([
      'scan:start', 'scan:progress', 'scan:done', 'scan:error',
      'library:folder-changed', 'auth:logged-out',
    ]);
    if (!allowed.has(channel)) return () => {};
    const wrapper = (_e, payload) => handler(payload);
    ipcRenderer.on(channel, wrapper);
    return () => ipcRenderer.removeListener(channel, wrapper);
  },
});
