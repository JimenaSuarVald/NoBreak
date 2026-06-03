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

        // NoBreak Cloud: en web no hay machine_token local, así que reporta
        // siempre "no vinculado" y devuelve la URL del Worker para que la UI
        // ofrezca abrir la página de pairing. El pairing real solo puede
        // ocurrir desde la app de escritorio porque necesita un device_id
        // persistido y un endpoint Node para guardar el token de forma segura.
        cloudStatus: async () => ({
            linked: false,
            cloudUrl: 'https://nobreak-cloud.jimenasuarezvaldesss.workers.dev',
        }),
        cloudPair: async () => ({
            ok: false,
            error: 'El pairing solo es desde NoBreak.exe. En la web abre la página del cloud y genera un código allí.',
        }),
        cloudUnlink: async () => ({ linked: false }),
        cloudSetTunnelUrl: async () => ({
            ok: false,
            error: 'La URL del tunnel solo se configura desde NoBreak.exe.',
        }),
        cloudRelayDiagnostics: async () => ({ running: false, lastOk: null, lastError: null }),

        // Zoom: emula webFrame.setZoomFactor de Electron sin descuadrar el
        // layout. document.body.style.zoom escala el render pero el viewport
        // no se ajusta, así que el #app-screen (100vh) se sale por debajo.
        //
        // Truco: transform: scale(f) al body + width/height = (100/f)vw/vh.
        // El body en CSS pasa a ser (100/f)% del viewport y, al aplicar el
        // scale(f), visualmente vuelve a llenar exactamente el viewport.
        // Sus hijos calculan tamaños en CSS pixels del body (más pequeños)
        // y se rinden al tamaño visual correcto. #app-screen usa 100% para
        // seguir al body (no 100vh).
        //
        // origin 0 0 (top-left) para que el zoom expanda hacia abajo/derecha.
        // html background se pinta donde body no llega (zoom > 1 → body
        // ocupa (100/f)% del viewport — el resto lo cubre el html).
        setZoomFactor: (factor) => {
            const f = Math.max(0.5, Math.min(3, Number(factor) || 1));
            // Limpieza de la versión anterior por si quedó style.zoom en
            // .app-content o #profile-view de un Frontend cacheado.
            for (const sel of ['.app-content', '#profile-view']) {
                const el = document.querySelector(sel);
                if (el && el.style.zoom) el.style.zoom = '';
            }
            if (document.body.style.zoom) document.body.style.zoom = '';
            const b = document.body;
            if (Math.abs(f - 1) < 0.001) {
                b.style.transform = '';
                b.style.transformOrigin = '';
                b.style.width = '';
                b.style.height = '';
            } else {
                b.style.transformOrigin = '0 0';
                b.style.transform = 'scale(' + f + ')';
                b.style.width = (100 / f) + 'vw';
                b.style.height = (100 / f) + 'vh';
            }
            return f;
        },
        getZoomFactor: () => {
            const m = (document.body.style.transform || '').match(/scale\(([\d.]+)\)/);
            return m ? parseFloat(m[1]) : 1;
        },
    };
})();
