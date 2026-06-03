// renderer-main.js — IIFE de boot. Debe cargarse el ULTIMO, despues de todos
// los renderer-*.js, para que tenga visibles las funciones de setup que llama.

// --- Boot ------------------------------------------------------------------
(async function boot() {
    // Aplica preset + colores personalizados antes de pintar nada — evita
    // un flash de tema. La UI de los pickers se cablea en showApp.
    applyThemePreset(getThemePreset());
    applyAlbumSizePx(getAlbumSizePx());
    applyAccessibility(getAccessibility());
    // En Electron las APIs se llaman a 127.0.0.1:<port-IPC>. En web (la app
    // se sirve por el mismo HTTP server) usamos el origin actual para que
    // funcione tanto si se accede como 127.0.0.1 como si se accede por la IP
    // de la máquina desde otro ordenador.
    const isWeb = window.location.protocol === 'http:' || window.location.protocol === 'https:';
    API_BASE = isWeb
        ? window.location.origin
        : ('http://127.0.0.1:' + (await window.api.port()));
    setupPasswordToggles();
    setupLoginForm();
    setupRegisterForm();
    setupPhotoScreen();
    setupAuthNavLinks();
    setupMenuListeners();

    // Restaurar sesión persistida (clave para uso remoto: refresh del
    // navegador no debe sacar al usuario). Si el token sigue siendo válido
    // contra /auth/me saltamos directamente a la app; si el server lo
    // rechaza caemos al flujo normal de login.
    const saved = (typeof loadSession === 'function') ? loadSession() : null;
    if (saved && saved.token) {
        token = saved.token;
        username = saved.username || null;
        try {
            const r = await fetch(API_BASE + '/auth/me', {
                headers: { Authorization: 'Bearer ' + token },
            });
            if (r.ok) {
                await afterLogin();
                return;
            }
        } catch {}
        // token caducado/inválido — limpiamos y mostramos login.
        token = null;
        username = null;
        if (typeof clearSession === 'function') clearSession();
    }

    // No logueado → landing. Desde la landing, el botón "Iniciar sesión" de
    // arriba a la derecha lleva al login. firstRun ya no fuerza register —
    // el usuario decide desde la landing si registrarse (vía login → enlace
    // "Crear cuenta") o descargar la app primero.
    showAuthScreen('landing');
})();
