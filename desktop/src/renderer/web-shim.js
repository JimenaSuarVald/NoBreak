// web-shim.js — Polyfill de window.api cuando este HTML se sirve via HTTP en
// un navegador normal (no en Electron). En Electron el preload.js ya define
// window.api con los bridges IPC, así que este shim detecta su existencia y
// se queda como no-op para no pisar nada.
//
// Lo que cubrimos:
//   - port()              → puerto del location (la URL actual del navegador)
//   - hasUser()           → asume true (la UI muestra login; si no hay usuarios
//                           el usuario puede ir a register)
//   - register()          → POST /auth/register
//   - openExternal(url)   → window.open(url, '_blank')
//   - on(channel, fn)     → no-op (devuelve función vacía para unsubscribe)
//   - setZoomFactor(f)    → document.body.style.zoom = f
//   - getZoomFactor()     → parseFloat(document.body.style.zoom) || 1
//
// Lo que NO cubrimos (features solo de desktop — los botones aparecerán
// pero al pulsarlos verás un alert explicando que no están disponibles):
//   - getFolder / pickFolder / rescan / refreshTags  → flujo de biblioteca
//   - saveProfilePhoto / saveProfileBackground / saveProfileFrame  → uploads
//   - savePlaylistCover / saveGenreCover  → uploads
(function () {
    if (window.api) return;  // estamos en Electron, no toques nada

    const desktopOnly = (label) => () => {
        alert('Esta acción solo está disponible en la app de escritorio:\n\n' + label);
    };

    window.api = {
        port: async () => window.location.port || (window.location.protocol === 'https:' ? '443' : '80'),
        hasUser: async () => true,

        register: async (username, password, email) => {
            const r = await fetch('/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password, email }),
            });
            if (!r.ok) {
                let msg = 'No se pudo registrar';
                try { msg = (await r.json()).error || msg; } catch {}
                throw new Error(msg);
            }
            return await r.json();
        },

        // Subida de imágenes: en web no hay IPC, hay que reimplementar con
        // multipart si se quiere soportar. Por ahora deshabilitado.
        saveProfilePhoto:       desktopOnly('Cambiar foto de perfil'),
        saveProfileBackground:  desktopOnly('Cambiar fondo del perfil'),
        saveProfileFrame:       desktopOnly('Cambiar marco del perfil'),
        savePlaylistCover:      desktopOnly('Subir portada de playlist'),
        saveGenreCover:         desktopOnly('Subir portada de género'),

        // Gestión local de biblioteca: solo desktop. getFolder devuelve un
        // placeholder truthy para que afterLogin() en renderer-library.js
        // salte directo a showApp() en lugar de pintar la pantalla de
        // "elige carpeta" — en web la biblioteca ya existe en la DB del
        // servidor y se carga vía /api/library, no hay carpeta local que
        // escanear desde el navegador.
        getFolder:    async () => '__remote__',
        pickFolder:   desktopOnly('Elegir carpeta de música'),
        rescan:       desktopOnly('Re-escanear biblioteca'),
        refreshTags:  desktopOnly('Refrescar tags'),

        // Eventos del proceso principal: en web no hay procesos. No-op
        // que devuelve una función vacía como "unsubscribe".
        on: (_channel, _handler) => () => {},

        // Abrir URL externa: en web es simplemente otra pestaña.
        openExternal: async (url) => { window.open(url, '_blank', 'noopener'); },

        // Zoom: en navegador NO hay equivalente real al webFrame.setZoomFactor
        // de Electron. document.body.style.zoom funciona en Chromium/Edge pero
        // puede dejar layout raro a tamaños extremos. Para zoom serio el
        // usuario tiene Ctrl + / Ctrl − del navegador.
        setZoomFactor: (factor) => {
            const f = Math.max(0.5, Math.min(3, Number(factor) || 1));
            document.body.style.zoom = String(f);
            return f;
        },
        getZoomFactor: () => parseFloat(document.body.style.zoom) || 1,
    };
})();
