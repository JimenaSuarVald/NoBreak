// renderer-sync.js — sincronización de ajustes de UI entre desktop y web.
//
// Cómo funciona:
//   1. Intercepta localStorage.setItem para claves 'nobreak-*': cualquier
//      cambio dispara un PATCH /auth/me debounced 500 ms con el snapshot
//      completo de todos los nobreak-* en localStorage.
//   2. Tras login (afterLogin en renderer-library.js llama a
//      window._nobreakSync.fromServer) hace pull de /auth/me, vuelca el
//      uiSettings remoto a localStorage y re-aplica tema, tamaño de tarjetas
//      y accesibilidad para que el primer paint del usuario logueado refleje
//      sus settings.
//
// La interceptación ocurre lo antes posible (este archivo carga después de
// state, así que cualquier setItem posterior pasa por aquí). Las llamadas
// dentro de fromServer() están protegidas con un flag para no rebotar (push
// no se dispara cuando estamos pintando desde el servidor).

(function () {
    const origSetItem = Storage.prototype.setItem;
    let suppressPush = false;
    let pushTimer = null;

    Storage.prototype.setItem = function (k, v) {
        origSetItem.call(this, k, v);
        if (this === window.localStorage
            && !suppressPush
            && typeof k === 'string'
            && k.startsWith('nobreak-')) {
            schedulePush();
        }
    };

    function schedulePush() {
        if (pushTimer) clearTimeout(pushTimer);
        pushTimer = setTimeout(() => { pushTimer = null; pushSettings(); }, 500);
    }

    function snapshot() {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i);
            if (k && k.startsWith('nobreak-')) out[k] = localStorage.getItem(k);
        }
        return out;
    }

    async function pushSettings() {
        // Sin token = sin sesión, no tiene sentido empujar.
        if (typeof token === 'undefined' || !token) return;
        try {
            // Reutilizamos apiCall si está disponible; si no, fetch directo.
            const body = JSON.stringify({ uiSettings: snapshot() });
            if (typeof apiCall === 'function') {
                await apiCall('/auth/me', {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                });
            } else {
                await fetch((typeof API_BASE !== 'undefined' ? API_BASE : '') + '/auth/me', {
                    method: 'PATCH',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: 'Bearer ' + token,
                    },
                    body,
                });
            }
        } catch (e) {
            console.warn('[sync] push uiSettings falló:', e?.message);
        }
    }

    async function fromServer() {
        if (typeof token === 'undefined' || !token) return;
        try {
            const me = typeof apiJson === 'function'
                ? await apiJson('/auth/me')
                : await (await fetch((typeof API_BASE !== 'undefined' ? API_BASE : '') + '/auth/me', {
                    headers: { Authorization: 'Bearer ' + token },
                })).json();
            const remote = me && me.uiSettings;
            if (!remote || typeof remote !== 'object') return;

            suppressPush = true;
            try {
                for (const [k, v] of Object.entries(remote)) {
                    if (typeof k !== 'string' || !k.startsWith('nobreak-')) continue;
                    if (v == null) continue;
                    origSetItem.call(localStorage, k, String(v));
                }
            } finally { suppressPush = false; }

            // Re-aplica los settings que se leen de localStorage para que el
            // primer paint refleje los valores remotos.
            try { if (typeof applyThemePreset === 'function')  applyThemePreset(getThemePreset()); } catch {}
            try { if (typeof applyAlbumSizePx === 'function')  applyAlbumSizePx(getAlbumSizePx()); } catch {}
            try { if (typeof applyAccessibility === 'function') applyAccessibility(getAccessibility()); } catch {}
        } catch (e) {
            console.warn('[sync] pull uiSettings falló:', e?.message);
        }
    }

    window._nobreakSync = { fromServer, pushSettings };
})();
