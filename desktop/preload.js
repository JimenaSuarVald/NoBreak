// Bridge between the sandboxed renderer and the main process. Exposes a
// minimal API on window.api — nothing else of Node/Electron leaks.

const { contextBridge, ipcRenderer, webFrame } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // Account creation (only allowed when DB has zero users — first-run flow).
  hasUser:    () => ipcRenderer.invoke('auth:hasUser'),
  register:   (username, password, email) => ipcRenderer.invoke('auth:register', username, password, email),

  // Profile photo (post-registro). dataUrl es "data:image/<mime>;base64,..."
  // El main lo decodifica, guarda en userData/photos/, y persiste la ruta.
  saveProfilePhoto: (sessionToken, dataUrl) =>
    ipcRenderer.invoke('profile:savePhoto', sessionToken, dataUrl),

  // Fondo del perfil (banner/wallpaper). dataUrl=null limpia el fondo.
  saveProfileBackground: (sessionToken, dataUrl) =>
    ipcRenderer.invoke('profile:saveBackground', sessionToken, dataUrl),

  // Marco PNG superpuesto a la foto. Mismo patrón que background.
  saveProfileFrame: (sessionToken, dataUrl) =>
    ipcRenderer.invoke('profile:saveFrame', sessionToken, dataUrl),

  // Folder + library control. Login/library-data fetches go over HTTP
  // (same path as the browser frontend), so they don't appear here.
  getFolder:    () => ipcRenderer.invoke('library:getFolder'),
  pickFolder:   () => ipcRenderer.invoke('library:pickFolder'),
  rescan:       () => ipcRenderer.invoke('library:rescan'),
  refreshTags:  () => ipcRenderer.invoke('library:refreshTags'),

  // Portada custom de una playlist. dataUrl=null para limpiar.
  savePlaylistCover: (sessionToken, playlistId, dataUrl) =>
    ipcRenderer.invoke('playlist:saveCover', sessionToken, playlistId, dataUrl),

  // Portada custom de un género (identificado por su nombre tal cual).
  saveGenreCover: (sessionToken, genreName, dataUrl) =>
    ipcRenderer.invoke('genre:saveCover', sessionToken, genreName, dataUrl),

  // Where the embedded HTTP server is listening.
  port: () => ipcRenderer.invoke('app:port'),

  // --- NoBreak Cloud (hito B fase 2) -----------------------------------
  // cloudStatus() devuelve { linked: bool, username?, label?, pairedAt?, cloudUrl }.
  // cloudPair(code, label) intenta reclamar; resuelve { ok, status? | error? }.
  // cloudUnlink() borra el token local (mantiene device_id).
  // NUNCA viaja el machine_token al renderer.
  cloudStatus: () => ipcRenderer.invoke('cloud:status'),
  cloudPair:   (code, label) => ipcRenderer.invoke('cloud:pair', code, label),
  cloudUnlink: () => ipcRenderer.invoke('cloud:unlink'),
  cloudSetTunnelUrl: (url) => ipcRenderer.invoke('cloud:setTunnelUrl', url),
  cloudRelayDiagnostics: () => ipcRenderer.invoke('cloud:relayDiagnostics'),

  // Abrir una URL en el navegador por defecto (para el flujo OAuth de Last.fm).
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),

  // Zoom del renderer (estilo Ctrl+/− de Chrome). El factor escala el
  // contenido SIN dejar huecos en el layout — el viewport se ajusta a la
  // ventana automáticamente. Lo usa Accesibilidad para el "tamaño de texto".
  setZoomFactor: (factor) => {
    const f = Math.max(0.5, Math.min(3, Number(factor) || 1));
    webFrame.setZoomFactor(f);
    return f;
  },
  getZoomFactor: () => webFrame.getZoomFactor(),

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
