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
    // Primera vez sin usuarios → arranca en la pantalla de registro.
    const firstRun = !(await window.api.hasUser());
    if (firstRun) showAuthScreen('register');
    else           showAuthScreen('login');
})();
