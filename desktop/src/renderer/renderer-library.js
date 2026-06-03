// renderer-library.js — login, listen tracker, Last.fm, pestanas/tabs, grids
// de albumes/artistas/generos/playlists, vistas de artista y album.

// --- Login -----------------------------------------------------------------
async function doLogin(user, pass) {
    const res = await fetch(API_BASE + '/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: user, password: pass }),
    });
    if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || 'Credenciales inválidas');
    }
    const t = await res.json();
    token = t.sessionToken;
    username = t.username;
}

function setupLoginForm() {
    $('login-form').onsubmit = async (e) => {
        e.preventDefault();
        const user = $('login-user').value.trim();
        const pass = $('login-pass').value;
        const errEl = $('login-error');
        errEl.textContent = '';
        if (!user || !pass) { errEl.textContent = 'Rellena usuario y contraseña.'; return; }
        const submitBtn = $('login-submit');
        submitBtn.disabled = true;
        try {
            await doLogin(user, pass);
            await afterLogin();
        } catch (err) {
            errEl.textContent = err.message || String(err);
        } finally {
            submitBtn.disabled = false;
        }
    };
}

// Registro: usuario + email + password (con confirmación). Tras crear, hace
// login automático y dirige a la pantalla de foto de perfil.
function setupRegisterForm() {
    $('register-form').onsubmit = async (e) => {
        e.preventDefault();
        const user    = $('reg-user').value.trim();
        const email   = $('reg-email').value.trim();
        const pass    = $('reg-pass').value;
        const confirm = $('reg-confirm').value;
        const errEl = $('register-error');
        errEl.textContent = '';

        if (!user)    { errEl.textContent = 'Falta el usuario.'; return; }
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            errEl.textContent = 'Correo no válido.'; return;
        }
        if (pass.length < 6) { errEl.textContent = 'La contraseña debe tener al menos 6 caracteres.'; return; }
        if (pass !== confirm) { errEl.textContent = 'Las contraseñas no coinciden.'; return; }

        const submitBtn = $('register-submit');
        submitBtn.disabled = true;
        try {
            await window.api.register(user, pass, email);
            await doLogin(user, pass);
            // Saltar a la pantalla de foto de perfil con la sesión activa.
            showAuthScreen('photo');
        } catch (err) {
            errEl.textContent = err.message || String(err);
        } finally {
            submitBtn.disabled = false;
        }
    };
}

// Pantalla de foto de perfil tras registro. Permite elegir un archivo, ver el
// preview y guardarlo, o saltar para entrar directamente al flujo de carpeta.
function setupPhotoScreen() {
    let pickedDataUrl = null;
    const preview = $('photo-preview');
    const input   = $('photo-input');
    const pickBtn = $('photo-pick-btn');
    const saveBtn = $('photo-save');
    const skipBtn = $('photo-skip');
    const errEl   = $('photo-error');

    pickBtn?.addEventListener('click', () => input?.click());
    input?.addEventListener('change', () => {
        errEl.textContent = '';
        const f = input.files?.[0];
        if (!f) return;
        if (f.size > 5 * 1024 * 1024) {
            errEl.textContent = 'La imagen no puede superar 5 MB.';
            return;
        }
        const reader = new FileReader();
        reader.onload = () => {
            pickedDataUrl = reader.result;
            preview.style.backgroundImage = `url('${pickedDataUrl}')`;
            preview.classList.add('has-image');
            preview.textContent = '';
            saveBtn.disabled = false;
        };
        reader.readAsDataURL(f);
    });

    saveBtn?.addEventListener('click', async () => {
        if (!pickedDataUrl) return;
        saveBtn.disabled = true;
        try {
            await window.api.saveProfilePhoto(token, pickedDataUrl);
            await afterLogin();
        } catch (err) {
            errEl.textContent = err.message || String(err);
            saveBtn.disabled = false;
        }
    });

    skipBtn?.addEventListener('click', () => { afterLogin(); });
}

async function afterLogin() {
    $('login-screen').classList.add('hidden');
    $('register-screen')?.classList.add('hidden');
    $('photo-screen')?.classList.add('hidden');
    // Pull de ajustes UI guardados en server (tema, accesibilidad, tamaño,
    // sort prefs, etc.) — vuelca a localStorage y re-aplica el tema/etc.
    if (window._nobreakSync) {
        try { await window._nobreakSync.fromServer(); } catch {}
    }
    const folder = await window.api.getFolder();
    if (!folder) {
        $('folder-screen').classList.remove('hidden');
        $('folder-pick').onclick = async () => {
            const f = await window.api.pickFolder();
            if (f) {
                $('folder-screen').classList.add('hidden');
                showApp();
            }
        };
    } else {
        showApp();
    }
}

function showApp() {
    $('app-screen').classList.remove('hidden');
    setupSearch();
    setupProfileMenu();
    setupAudioControls();
    setupListenTracker();
    setupAppearance();
    setupAlbumSize();
    setupAccessibility();
    setupLibraryRefresh();
    setupTabsBar();
    setupTabSort();
    setupQueuePanel();
    setupContextMenu();
    setupLastfm();
    setupCloud();
    setupScrobbleTracker();
    setupLikeButton();
    setupLikedModal();
    loadLikedTrackIds().catch(() => {});
    loadTabsState();
    renderTabsBar();
    activateTab(activeTabId, { force: true });
    refreshLibrary();
}

function formatHours(ms) {
    if (!isFinite(ms) || ms <= 0) return '0 h';
    const totalSec = Math.round(ms / 1000);
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    if (h <= 0) return m + ' min';
    return h + ' h ' + (m > 0 ? m + ' min' : '');
}

// --- Listen tracker ------------------------------------------------------
// Acumula ms reproducidos del track/artista actual y los manda al backend en
// lotes (cada 15 s o al pausar / cambiar de track / cerrar). Sólo cuenta
// tiempo en reproducción real (no scrubbing ni pausa). Cuando un track nuevo
// empieza marcamos `newPlay` para que el servidor incremente play_count.
let _listen = {
    artist: null,
    trackId: null,
    pendingMs: 0,
    lastTickAt: 0,
    flushTimer: null,
    pendingNewPlay: false,
};

function setupListenTracker() {
    const audio = $('audio');
    if (!audio) return;

    const tick = () => {
        if (audio.paused || audio.ended || !_listen.artist) return;
        const now = Date.now();
        if (_listen.lastTickAt) {
            const dt = now - _listen.lastTickAt;
            if (dt > 0 && dt < 2000) _listen.pendingMs += dt;
        }
        _listen.lastTickAt = now;
    };

    audio.addEventListener('timeupdate', tick);
    audio.addEventListener('play',  () => { _listen.lastTickAt = Date.now(); });
    audio.addEventListener('pause', () => { _listen.lastTickAt = 0; flushListen(); });
    audio.addEventListener('ended', () => { _listen.lastTickAt = 0; flushListen(); });
    window.addEventListener('beforeunload', () => { flushListen(true); });

    if (_listen.flushTimer) clearInterval(_listen.flushTimer);
    _listen.flushTimer = setInterval(() => flushListen(), 15000);
}

function setListenContext(track) {
    const newArtist = track?.artista || null;
    const newTrackId = track?.id || null;
    const sameTrack = _listen.trackId === newTrackId && _listen.artist === newArtist;
    if (sameTrack) return;
    flushListen();
    _listen.artist  = newArtist;
    _listen.trackId = newTrackId;
    _listen.pendingMs = 0;
    _listen.pendingNewPlay = !!newTrackId;  // marca el siguiente flush como nueva reproducción
    _listen.lastTickAt = Date.now();
}

function flushListen(sync = false) {
    const ms = Math.round(_listen.pendingMs);
    const artist = _listen.artist;
    const trackId = _listen.trackId;
    const newPlay = _listen.pendingNewPlay && ms > 0;
    _listen.pendingMs = 0;
    if (newPlay) _listen.pendingNewPlay = false;
    if (!artist || ms < 1000 || !token) return;
    const body = JSON.stringify({ artist, ms, trackId, newPlay });
    if (sync && navigator.sendBeacon) {
        const blob = new Blob([body], { type: 'application/json' });
        navigator.sendBeacon(API_BASE + '/api/listen?t=' + encodeURIComponent(token), blob);
        return;
    }
    fetch(API_BASE + '/api/listen', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body,
        keepalive: true,
    }).catch(() => {});
}

// --- Last.fm scrobbling ----------------------------------------------------
// Acumula tiempo real escuchado del track actual. Cuando supera el umbral
// (mitad de duración o 4 min, lo que llegue antes) lo manda al backend, que
// lo reenvía a Last.fm con su sesión. Tracks de < 30 s no se scrobblean.

let _scrobble = {
    track: null,         // referencia al track actual (snapshot)
    startedAt: 0,        // timestamp (ms) cuando arrancó la reproducción
    listenedMs: 0,       // acumulado real escuchado
    lastTickAt: 0,
    scrobbled: false,    // sólo una vez por track
};

function setupScrobbleTracker() {
    const audio = $('audio');
    if (!audio) return;
    audio.addEventListener('timeupdate', () => {
        if (audio.paused || audio.ended || !_scrobble.track) return;
        const now = Date.now();
        if (_scrobble.lastTickAt) {
            const dt = now - _scrobble.lastTickAt;
            if (dt > 0 && dt < 2000) _scrobble.listenedMs += dt;
        }
        _scrobble.lastTickAt = now;
        maybeScrobble();
    });
    audio.addEventListener('play',  () => { _scrobble.lastTickAt = Date.now(); });
    audio.addEventListener('pause', () => { _scrobble.lastTickAt = 0; });
    audio.addEventListener('ended', () => { _scrobble.lastTickAt = 0; maybeScrobble(); });
}

function startScrobbleForTrack(track) {
    if (_scrobble.track) maybeScrobble();  // intenta scrobblear el anterior antes de reemplazar
    _scrobble = {
        track,
        startedAt: Date.now(),
        listenedMs: 0,
        lastTickAt: 0,
        scrobbled: false,
    };
    if (!token || !track?.titulo || !track?.artista) return;
    // "Now playing" inmediato — informativo, no cuenta como scrobble.
    fetch(API_BASE + '/api/lastfm/now-playing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
            artist: track.artista, track: track.titulo, album: track.album,
            durationMs: track.durationMs,
        }),
        keepalive: true,
    }).catch(() => {});
}

function maybeScrobble() {
    const s = _scrobble;
    if (!s.track || s.scrobbled || !token) return;
    const dur = Number(s.track.durationMs) || 0;
    if (dur < 30000) return;
    const threshold = Math.min(dur / 2, 4 * 60 * 1000);
    if (s.listenedMs < threshold) return;
    s.scrobbled = true;
    fetch(API_BASE + '/api/lastfm/scrobble', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({
            artist: s.track.artista, track: s.track.titulo, album: s.track.album,
            startedAt: s.startedAt, durationMs: s.track.durationMs,
        }),
        keepalive: true,
    }).catch(() => {});
}

// --- NoBreak Cloud UI (Ajustes) -------------------------------------------
// Sección "NoBreak Cloud" en Ajustes: muestra estado del vínculo con el Worker
// central, permite reclamar un código de 6 dígitos, y desvincular.
// En web (sin window.api.cloudStatus) la sección queda en estado informativo
// — el web-shim devuelve { linked:false, cloudUrl:... } y los botones llevan
// al usuario a la página de pairing del cloud.

function setupCloud() {
    const form = $('settings-cloud-form');
    if (!form) return;  // por si esta build no tiene la sección
    form.addEventListener('submit', (e) => { e.preventDefault(); pairCloud(); });
    $('settings-cloud-unlink')?.addEventListener('click', unlinkCloud);
    $('settings-cloud-open')?.addEventListener('click', openCloudPairPage);
    $('settings-cloud-tunnel-form')?.addEventListener('submit', (e) => { e.preventDefault(); saveTunnelUrl(); });

    // Sólo dígitos en el input del código.
    $('settings-cloud-code')?.addEventListener('input', (e) => {
        const cleaned = e.target.value.replace(/\D+/g, '').slice(0, 6);
        if (cleaned !== e.target.value) e.target.value = cleaned;
        const err = $('settings-cloud-error');
        if (err) { err.textContent = ''; err.classList.add('hidden'); }
    });

    refreshCloudUi().catch(() => {});
}

async function refreshCloudUi() {
    const statusEl = $('settings-cloud-status');
    const form     = $('settings-cloud-form');
    const unlinkBtn = $('settings-cloud-unlink');
    const openBtn  = $('settings-cloud-open');
    if (!statusEl || !form) return;

    if (!window.api?.cloudStatus) {
        statusEl.textContent = 'No disponible en esta build.';
        form.classList.add('hidden');
        unlinkBtn?.classList.add('hidden');
        openBtn?.classList.add('hidden');
        return;
    }

    let s;
    try { s = await window.api.cloudStatus(); }
    catch (e) {
        statusEl.textContent = 'No se pudo consultar el estado del cloud: ' + e.message;
        return;
    }

    if (s.linked) {
        const who = s.username ? `como ${s.username}` : '';
        const lbl = s.label ? ` · ${s.label}` : '';
        statusEl.textContent = `Vinculado ${who}${lbl}.`;
        form.classList.add('hidden');
        unlinkBtn?.classList.remove('hidden');
        openBtn?.classList.remove('hidden');
    } else {
        statusEl.textContent = 'No vinculado. Genera un código en la web del cloud y pégalo aquí.';
        form.classList.remove('hidden');
        unlinkBtn?.classList.add('hidden');
        openBtn?.classList.remove('hidden');
    }

    // Tunnel URL — sincroniza input y estado del heartbeat.
    const tunnelInput  = $('settings-cloud-tunnel');
    const tunnelStatus = $('settings-cloud-tunnel-status');
    if (tunnelInput && tunnelInput !== document.activeElement) {
        tunnelInput.value = s.tunnelUrl || '';
    }
    if (tunnelStatus) {
        if (!s.linked) {
            tunnelStatus.textContent = 'Vincula primero el .exe; la URL se publica al Worker cuando hay vínculo.';
        } else if (window.api?.cloudRelayDiagnostics) {
            try {
                const d = await window.api.cloudRelayDiagnostics();
                if (d.lastOk) {
                    const sec = Math.floor((Date.now() - d.lastOk) / 1000);
                    tunnelStatus.textContent = `Último heartbeat OK hace ${sec}s. Cada ${Math.floor((d.intervalMs||60000)/1000)}s.`;
                } else if (d.lastError) {
                    tunnelStatus.textContent = `Último heartbeat falló: ${d.lastError.message}`;
                } else {
                    tunnelStatus.textContent = 'Heartbeat aún no ha corrido.';
                }
            } catch { tunnelStatus.textContent = 'Heartbeat: sin diagnóstico.'; }
        } else {
            tunnelStatus.textContent = 'Pega la URL del tunnel cloudflared (https://…trycloudflare.com).';
        }
    }
}

async function saveTunnelUrl() {
    const input = $('settings-cloud-tunnel');
    const errEl = $('settings-cloud-tunnel-error');
    const btn   = $('settings-cloud-tunnel-save');
    const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };
    if (errEl) { errEl.textContent = ''; errEl.classList.add('hidden'); }
    if (!window.api?.cloudSetTunnelUrl) { showErr('No disponible en esta build.'); return; }
    btn.disabled = true;
    try {
        const r = await window.api.cloudSetTunnelUrl(input?.value || '');
        if (!r?.ok) { showErr(r?.error || 'No se pudo guardar.'); return; }
        await refreshCloudUi();
    } finally {
        btn.disabled = false;
    }
}

async function pairCloud() {
    const codeEl  = $('settings-cloud-code');
    const labelEl = $('settings-cloud-label');
    const errEl   = $('settings-cloud-error');
    const btn     = $('settings-cloud-pair');
    const showErr = (msg) => { if (errEl) { errEl.textContent = msg; errEl.classList.remove('hidden'); } };

    const code = (codeEl?.value || '').trim();
    if (!/^\d{6}$/.test(code)) { showErr('El código debe ser 6 dígitos.'); return; }

    btn.disabled = true;
    try {
        const r = await window.api.cloudPair(code, labelEl?.value || '');
        if (!r?.ok) { showErr(r?.error || 'Error desconocido al vincular.'); return; }
        if (codeEl)  codeEl.value = '';
        if (labelEl) labelEl.value = '';
        if (errEl)   { errEl.textContent = ''; errEl.classList.add('hidden'); }
        await refreshCloudUi();
    } finally {
        btn.disabled = false;
    }
}

async function unlinkCloud() {
    if (!confirm('¿Desvincular esta instalación de NoBreak Cloud? El token se borra del PC.')) return;
    try { await window.api.cloudUnlink(); } catch {}
    await refreshCloudUi();
}

async function openCloudPairPage() {
    // Necesitamos saber a qué URL llamar; cloudStatus la incluye.
    try {
        const s = await window.api.cloudStatus();
        const url = s?.cloudUrl;
        if (!url) return;
        if (window.api?.openExternal) window.api.openExternal(url);
        else window.open(url, '_blank', 'noopener');
    } catch {}
}

// --- Last.fm UI (Ajustes) -------------------------------------------------

function setupLastfm() {
    $('settings-lastfm-form')?.addEventListener('submit', (e) => { e.preventDefault(); loginLastfm(); });
    $('settings-lastfm-disconnect')?.addEventListener('click', disconnectLastfm);
    $('settings-lastfm-flush')?.addEventListener('click', flushLastfmQueue);
    // Limpia el mensaje de error en cuanto el usuario empieza a corregir.
    for (const id of ['settings-lastfm-user', 'settings-lastfm-pass']) {
        $(id)?.addEventListener('input', () => {
            const err = $('settings-lastfm-error');
            if (err) { err.textContent = ''; err.classList.add('hidden'); }
        });
    }
    document.querySelectorAll('[data-extlink]').forEach(el => {
        el.addEventListener('click', (e) => {
            e.preventDefault();
            const url = el.getAttribute('data-extlink');
            if (url && window.api?.openExternal) window.api.openExternal(url);
        });
    });
    refreshLastfmUi();
}

async function refreshLastfmUi() {
    const statusEl    = $('settings-lastfm-status');
    const form        = $('settings-lastfm-form');
    const disconnect  = $('settings-lastfm-disconnect');
    const flushBtn    = $('settings-lastfm-flush');
    if (!statusEl || !form) return;
    if (!token) {
        statusEl.textContent = 'Inicia sesión en NoBreak para configurar Last.fm.';
        form.classList.add('hidden');
        disconnect.classList.add('hidden');
        flushBtn.classList.add('hidden');
        return;
    }
    let s;
    try { s = await apiJson('/api/lastfm/status'); }
    catch { statusEl.textContent = 'No se pudo consultar el estado.'; return; }

    if (!s.hasConfig) {
        // Sin claves de app no podemos firmar peticiones a Last.fm. El usuario
        // final no puede arreglarlo desde la UI — el instalador tiene que
        // poner LASTFM_API_KEY y LASTFM_SHARED_SECRET en desktop/.env.
        statusEl.textContent = 'Last.fm no está configurado en esta instalación. Pide a quien te haya pasado la app que añada LASTFM_API_KEY y LASTFM_SHARED_SECRET en desktop/.env.';
        form.classList.add('hidden');
        const btn = $('settings-lastfm-login');
        if (btn) { btn.disabled = true; }
        disconnect.classList.add('hidden');
        flushBtn.classList.add('hidden');
        return;
    }
    const btn = $('settings-lastfm-login');
    if (btn) { btn.disabled = false; btn.title = ''; }

    if (s.connected) {
        let label = 'Conectado como ' + (s.username || '(desconocido)') + '.';
        try {
            const q = await apiJson('/api/lastfm/queue');
            if (q?.pending > 0) label += ' Hay ' + q.pending + ' scrobbles pendientes en cola.';
            flushBtn.classList.toggle('hidden', !(q?.pending > 0));
        } catch { flushBtn.classList.add('hidden'); }
        statusEl.textContent = label;
        form.classList.add('hidden');
        disconnect.classList.remove('hidden');
    } else {
        statusEl.textContent = 'No conectado. Introduce tu usuario y contraseña de Last.fm.';
        form.classList.remove('hidden');
        disconnect.classList.add('hidden');
        flushBtn.classList.add('hidden');
    }
}

async function loginLastfm() {
    const userEl = $('settings-lastfm-user');
    const passEl = $('settings-lastfm-pass');
    const errEl  = $('settings-lastfm-error');
    const showErr = (msg) => {
        if (!errEl) return;
        errEl.textContent = msg;
        errEl.classList.remove('hidden');
    };
    const clearErr = () => {
        if (!errEl) return;
        errEl.textContent = '';
        errEl.classList.add('hidden');
    };
    const username = userEl.value.trim();
    const password = passEl.value;
    clearErr();
    if (!username || !password) {
        showErr('Introduce usuario y contraseña.');
        (username ? passEl : userEl).focus();
        return;
    }
    const submitBtn = $('settings-lastfm-login');
    submitBtn.disabled = true;
    try {
        const r = await apiJson('/api/lastfm/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password }),
        });
        // Limpieza inmediata: la password no debe quedar en el DOM.
        passEl.value = '';
        userEl.value = '';
        $('status-bar').textContent = 'Last.fm conectado: ' + (r.username || username);
        refreshLastfmUi();
    } catch (e) {
        showErr(e.message || 'No se pudo iniciar sesión.');
        // Re-foco al campo de contraseña para seguir escribiendo sin
        // tener que volver a hacer click.
        passEl.focus();
        passEl.select();
    }
    finally { submitBtn.disabled = false; }
}

async function disconnectLastfm() {
    if (!confirm('¿Desconectar de Last.fm?')) return;
    try {
        await apiCall('/api/lastfm/disconnect', { method: 'POST' });
        $('status-bar').textContent = 'Desconectado de Last.fm.';
        refreshLastfmUi();
    } catch (e) { alert('Error: ' + e.message); }
}

async function flushLastfmQueue() {
    try {
        const r = await apiJson('/api/lastfm/flush', { method: 'POST' });
        $('status-bar').textContent = `Cola Last.fm: ${r.sent} enviados, ${r.remaining} pendientes.`;
        refreshLastfmUi();
    } catch (e) { alert('Error: ' + e.message); }
}

// --- Tab sort (orden por tipo de pestaña) --------------------------------
// Cada pestaña musical define sus propias opciones y comparadores. El criterio
// elegido por el usuario se persiste por tipo en localStorage.
const cmpStr = (a, b) => String(a || '').localeCompare(String(b || ''), undefined, { sensitivity: 'base' });

const SORT_CONFIGS = {
    albums: {
        options: [
            { value: 'az',         label: 'A → Z' },
            { value: 'za',         label: 'Z → A' },
            { value: 'yearAsc',    label: 'Fecha  (más antiguo primero)' },
            { value: 'yearDesc',   label: 'Fecha  (más nuevo primero)' },
            { value: 'ratingDesc', label: 'Rating  (alto a bajo)' },
            { value: 'ratingAsc',  label: 'Rating  (bajo a alto)' },
        ],
        cmps: {
            az:         (a, b) => cmpStr(a.titulo, b.titulo),
            za:         (a, b) => cmpStr(b.titulo, a.titulo),
            yearAsc:    (a, b) => (a.year || 9999) - (b.year || 9999) || cmpStr(a.titulo, b.titulo),
            yearDesc:   (a, b) => (b.year || 0)    - (a.year || 0)    || cmpStr(a.titulo, b.titulo),
            ratingDesc: (a, b) => (b.rating || 0)  - (a.rating || 0)  || cmpStr(a.titulo, b.titulo),
            ratingAsc:  (a, b) => (a.rating || 0)  - (b.rating || 0)  || cmpStr(a.titulo, b.titulo),
        },
    },
    artists: {
        options: [
            { value: 'az', label: 'A → Z' },
            { value: 'za', label: 'Z → A' },
        ],
        cmps: {
            az: (a, b) => cmpStr(a.nombre, b.nombre),
            za: (a, b) => cmpStr(b.nombre, a.nombre),
        },
    },
    genres: {
        options: [
            { value: 'az', label: 'A → Z' },
            { value: 'za', label: 'Z → A' },
        ],
        cmps: {
            az: (a, b) => cmpStr(a.nombre, b.nombre),
            za: (a, b) => cmpStr(b.nombre, a.nombre),
        },
    },
    playlists: {
        options: [
            { value: 'az', label: 'A → Z' },
            { value: 'za', label: 'Z → A' },
        ],
        cmps: {
            az: (a, b) => cmpStr(a.name, b.name),
            za: (a, b) => cmpStr(b.name, a.name),
        },
    },
};

let tabSorts = {};
try { tabSorts = JSON.parse(localStorage.getItem('nobreak-tab-sorts') || '{}'); } catch {}
function getSortKey(type) {
    const cfg = SORT_CONFIGS[type];
    if (!cfg) return null;
    const stored = tabSorts[type];
    return cfg.cmps[stored] ? stored : cfg.options[0].value;
}
function setSortKey(type, value) {
    tabSorts[type] = value;
    localStorage.setItem('nobreak-tab-sorts', JSON.stringify(tabSorts));
}
function applySort(items, type) {
    const cfg = SORT_CONFIGS[type];
    if (!cfg) return items;
    const cmp = cfg.cmps[getSortKey(type)];
    return cmp ? items.slice().sort(cmp) : items;
}

// El selector nativo <select> en Windows ignora padding/line-height en sus
// <option>, así que usamos un dropdown propio (botón + popover) que sí
// respeta el espaciado.
function setupTabSort() {
    const btn = $('album-sort');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = $('album-sort-menu');
        if (menu.classList.contains('hidden')) openSortMenu();
        else closeSortMenu();
    });
}

function openSortMenu() {
    const btn = $('album-sort');
    const menu = $('album-sort-menu');
    if (!btn || !menu || !menu.children.length) return;
    menu.classList.remove('hidden');
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    menu.style.top = (r.bottom + 6) + 'px';
    menu.style.left = r.left + 'px';
    menu.style.minWidth = r.width + 'px';
    setTimeout(() => {
        document.addEventListener('click', dismissSortOnOutside, { capture: true });
        document.addEventListener('keydown', dismissSortOnEsc);
    }, 0);
}

function closeSortMenu() {
    const btn = $('album-sort');
    const menu = $('album-sort-menu');
    if (!menu) return;
    menu.classList.add('hidden');
    btn?.setAttribute('aria-expanded', 'false');
    document.removeEventListener('click', dismissSortOnOutside, { capture: true });
    document.removeEventListener('keydown', dismissSortOnEsc);
}

function dismissSortOnOutside(e) {
    const menu = $('album-sort-menu');
    const btn = $('album-sort');
    if (menu && !menu.contains(e.target) && btn && !btn.contains(e.target)) closeSortMenu();
}
function dismissSortOnEsc(e) { if (e.key === 'Escape') closeSortMenu(); }

// Repuebla el menú con las opciones del tipo de pestaña activo, sincroniza la
// etiqueta del botón y muestra u oculta la barra. Se llama desde showAreaForType.
function syncToolbarFor(type) {
    const cfg = SORT_CONFIGS[type];
    const tb = $('album-toolbar');
    const btn = $('album-sort');
    const menu = $('album-sort-menu');
    const labelEl = $('album-sort-label');
    if (!tb || !btn || !menu || !labelEl) return;
    closeSortMenu();
    if (!cfg) {
        tb.classList.add('album-toolbar--off');
        return;
    }
    tb.classList.remove('album-toolbar--off');
    const current = getSortKey(type);
    const currentOpt = cfg.options.find(o => o.value === current) || cfg.options[0];
    labelEl.textContent = currentOpt.label;
    if (btn.dataset.tabType !== type) {
        menu.innerHTML = '';
        for (const opt of cfg.options) {
            const item = document.createElement('button');
            item.type = 'button';
            item.className = 'album-sort-item';
            item.dataset.value = opt.value;
            item.textContent = opt.label;
            item.addEventListener('click', () => {
                setSortKey(type, opt.value);
                labelEl.textContent = opt.label;
                menu.querySelectorAll('.album-sort-item').forEach(i =>
                    i.classList.toggle('selected', i.dataset.value === opt.value));
                closeSortMenu();
                renderCurrentTab();
            });
            menu.appendChild(item);
        }
        btn.dataset.tabType = type;
    }
    menu.querySelectorAll('.album-sort-item').forEach(i =>
        i.classList.toggle('selected', i.dataset.value === current));
}

// --- API helpers -----------------------------------------------------------
async function apiCall(path, opts = {}) {
    const res = await fetch(API_BASE + path, {
        ...opts,
        headers: { 'Authorization': 'Bearer ' + token, ...(opts.headers || {}) },
    });
    return res;
}

// Logging temporal: manda objetos al backend para que aparezcan en su
// stdout (visible desde el archivo de log del proceso main). Usar para
// diagnóstico, no dejar en producción.
function dbg(tag, obj = {}) {
    try {
        fetch(API_BASE + '/api/_debug', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
            body: JSON.stringify({ tag, ...obj }),
            keepalive: true,
        }).catch(() => {});
    } catch {}
}

async function apiJson(path, opts) {
    const r = await apiCall(path, opts);
    if (!r.ok) {
        let msg = 'HTTP ' + r.status;
        try { const j = await r.json(); if (j.error) msg = j.error; } catch {}
        throw new Error(msg);
    }
    return r.json();
}

function coverUrlFor(serverPath) {
    if (!serverPath) return null;
    return API_BASE + serverPath + '?t=' + encodeURIComponent(token);
}

// --- Library load + search -------------------------------------------------
async function refreshLibrary() {
    try {
        library = await apiJson('/api/library');
        renderCurrentTab();
        // Si la pestaña activa es un artista y la foto se quedó en blanco
        // porque la biblioteca aún no estaba cargada, reaplica el fallback
        // ahora que sí tenemos library.albums.
        if (currentTabType() === 'artist') {
            const name = activeTab()?.data?.name;
            if (name) {
                const photo = $('av-photo');
                const empty = photo?.classList.contains('av-photo-empty');
                if (empty) applyArtistFallbackImage(name);
            }
        }
    } catch (e) {
        $('main-grid').innerHTML =
            `<div class="empty-state">No se pudo cargar la biblioteca: ${escapeHtml(e.message)}</div>`;
    }
}

function setupSearch() {
    const input = $('search');
    let timer = null;
    input.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => {
            lastQuery = input.value.toLowerCase().trim();
            renderCurrentTab();
        }, 150);
    });
}

function filtered(items, fields) {
    if (!lastQuery) return items;
    return items.filter(it => fields.some(f => (it[f] || '').toString().toLowerCase().includes(lastQuery)));
}

// --- Tabs ------------------------------------------------------------------
function renderAlbumsTab() {
    const albs = applySort(filtered(library.albums || [], ['titulo', 'artista']), 'albums');
    renderAlbumGrid(albs);
}

function renderArtistsTab() {
    const grid = $('main-grid');
    grid.innerHTML = '';
    allCards = [];
    const artists = applySort(filtered(library.artists || [], ['nombre']), 'artists');
    if (!artists.length) {
        grid.innerHTML = '<div class="empty-state">Sin artistas todavía.</div>';
        return;
    }
    for (const a of artists) {
        // cover: null intencional — no queremos que las tarjetas arranquen con
        // la portada del primer álbum del artista (eso no es su foto). El
        // estado inicial son las iniciales; lazyLoadArtistTabImages las pisa
        // con la foto real cuando Wikipedia/TheAudioDB devuelve una.
        const card = simpleCard({
            cover: null,
            title: a.nombre,
            meta: `${a.albumCount} ${a.albumCount === 1 ? 'álbum' : 'álbumes'} · ${a.trackCount} pistas`,
            initials: initials(a.nombre),
        });
        card.dataset.artistId = a.id;
        card.dataset.artistName = a.nombre || '';
        card.addEventListener('click', () => openArtist(a, card));
        grid.appendChild(card);
        allCards.push(card);
    }
    // Carga perezosa de la foto real del artista (Last.fm → Wikipedia →
    // Wikidata → Fanart.tv → Wikipedia pageimages, vía /api/artist-info).
    // Pisa la portada del álbum sólo si llega una foto del artista propiamente
    // dicha — si no, se conserva la portada/iniciales actuales.
    lazyLoadArtistTabImages().catch(() => {});
}

// Recorre las tarjetas de la pestaña Artistas y trae la foto desde
// /api/artist-info. Secuencial para no martillear las APIs externas en
// bibliotecas grandes (las cache hits son ~ms; los misses respetan el
// throttle de MusicBrainz a 1 req/s).
async function lazyLoadArtistTabImages() {
    const cards = document.querySelectorAll('#main-grid .album-card[data-artist-name]');
    for (const el of cards) {
        if (el.dataset.artistImgLoaded === '1') continue;
        el.dataset.artistImgLoaded = '1';
        const name = el.dataset.artistName;
        if (!name) continue;
        // Si el usuario cambia de pestaña a mitad, paramos: las cards de la
        // pestaña Artistas dejan de estar en el DOM.
        if (currentTabType() !== 'artists') return;
        try {
            const info = await apiJson('/api/artist-info?name=' + encodeURIComponent(name));
            const url = info?.thumbnail || info?.imageLarge;
            if (!url) continue;
            const cover = el.querySelector('.album-cover');
            if (!cover) continue;
            cover.style.backgroundImage = `url('${url}')`;
            cover.textContent = '';
        } catch { /* sin foto disponible — dejamos la portada/iniciales */ }
    }
}

// Filtro persistente para la pestaña Géneros. Valores: 'album'|'artist'|'song'.
function getGenreFilter() {
    const v = localStorage.getItem('nobreak-genre-filter');
    return ['album', 'artist', 'song'].includes(v) ? v : 'album';
}
function setGenreFilter(v) { localStorage.setItem('nobreak-genre-filter', v); }

async function renderGenresTab() {
    closeDrawer();
    const grid = $('main-grid');
    const filter = getGenreFilter();
    grid.innerHTML = `
        <div class="genres-toolbar">
            <label class="genres-filter-label">Agrupar por:</label>
            <select id="genres-filter" class="genres-filter-select">
                <option value="album"  ${filter === 'album'  ? 'selected' : ''}>Álbum</option>
                <option value="artist" ${filter === 'artist' ? 'selected' : ''}>Artista</option>
                <option value="song"   ${filter === 'song'   ? 'selected' : ''}>Canción</option>
            </select>
            <div class="genres-toolbar-hint" id="genres-hint"></div>
        </div>
        <div class="genres-grid" id="genres-grid"><div class="empty-state">Cargando géneros…</div></div>
    `;

    $('genres-filter').addEventListener('change', (e) => {
        setGenreFilter(e.target.value);
        genres = null;   // invalida cache: la lista depende del filtro
        renderGenresTab();
    });

    // Cache de /api/genres-master: si el filtro coincide reutilizamos. Así
    // el buscador no dispara una petición en cada keystroke.
    let data;
    if (genres && genres._filter === filter) {
        data = genres;
    } else {
        try { data = await apiJson('/api/genres-master?by=' + encodeURIComponent(filter)); }
        catch (e) {
            $('genres-grid').innerHTML = `<div class="empty-state">Error: ${escapeHtml(e.message)}</div>`;
            return;
        }
        data._filter = filter;
        genres = data;
    }

    const allList = data.genres || [];
    const hintEl = $('genres-hint');
    if (!allList.length) {
        $('genres-grid').innerHTML =
            '<div class="empty-state">Aún no hay géneros maestros calculados. Abre algunos álbumes o artistas y volverá a aparecer aquí.</div>';
        hintEl.textContent = '';
        return;
    }
    // Aplica el buscador global por nombre de género.
    const list = filtered(allList, ['name']);
    if (!list.length) {
        $('genres-grid').innerHTML =
            `<div class="empty-state">Sin coincidencias para "${escapeHtml(lastQuery)}".</div>`;
        hintEl.textContent = allList.length + ' géneros (filtrados: 0)';
        return;
    }
    hintEl.textContent = lastQuery
        ? `${list.length} de ${allList.length} géneros`
        : `${allList.length} géneros · datos de MusicBrainz`;

    const gridEl = $('genres-grid');
    gridEl.innerHTML = '';
    allCards = [];
    for (const g of list) {
        const card = document.createElement('div');
        card.className = 'album-card genre-card';
        let coverInner;
        if (g.coverUrl) {
            const url = coverUrlFor(g.coverUrl);
            coverInner = `<div class="album-cover" style="background-image:url('${url}')"></div>`;
        } else {
            // sampleCovers ya viene deduplicado por álbum desde el backend.
            const collage = collageCoverHtml(g.sampleCovers || []);
            coverInner = `<div class="album-cover genre-cover">${
                collage || `<span class="cover-fallback">${escapeHtml(initials(g.name))}</span>`
            }</div>`;
        }
        card.innerHTML = `
            ${coverInner}
            <div class="album-title">${escapeHtml(g.name)}</div>
            <div class="album-meta">${g.count} ${labelForFilter(filter, g.count)}</div>
        `;
        card.addEventListener('click', () => openMasterGenre(g, filter, card));
        gridEl.appendChild(card);
        allCards.push(card);
    }
}

function labelForFilter(f, n) {
    if (f === 'album')  return n === 1 ? 'álbum'  : 'álbumes';
    if (f === 'artist') return n === 1 ? 'artista': 'artistas';
    return n === 1 ? 'canción' : 'canciones';
}

function openMasterGenre(genre, filter, cardEl) {
    const key = 'master-genre:' + filter + ':' + genre.name.toLowerCase();
    if (currentDrawerKey === key) { closeDrawer(); return; }
    closeDrawer();
    cardEl?.classList.add('active');
    currentDrawerKey = key;

    const drawer = document.createElement('div');
    drawer.className = 'drawer drawer-artist';
    drawer.innerHTML = `
        <button class="drawer-close" title="Cerrar" aria-label="Cerrar">×</button>
        <div class="drawer-artist-header">
            <div class="drawer-artist-info">
                <h3 class="drawer-title">${escapeHtml(genre.name)}</h3>
                <div class="drawer-sub">${genre.count} ${labelForFilter(filter, genre.count)}</div>
            </div>
            <div class="genre-cover-actions">
                <button class="drawer-action ghost" data-action="change-cover">Cambiar portada</button>
                ${genre.coverUrl ? '<button class="drawer-action ghost" data-action="clear-cover">Quitar portada</button>' : ''}
            </div>
        </div>
        <div class="drawer-artist-grid" id="master-genre-grid"></div>
    `;
    drawer.querySelector('.drawer-close').addEventListener('click', closeDrawer);
    drawer.querySelector('[data-action="change-cover"]')?.addEventListener('click',
        () => pickAndUploadGenreCover(genre.name));
    drawer.querySelector('[data-action="clear-cover"]')?.addEventListener('click',
        () => clearGenreCover(genre.name));
    insertDrawerAfterRow(cardEl, drawer);
    currentDrawer = drawer;

    const gridEl = drawer.querySelector('#master-genre-grid');
    for (const item of (genre.items || [])) {
        if (filter === 'album') {
            const card = buildAlbumCard(item, () => jumpToAlbum(item));
            gridEl.appendChild(card);
        } else if (filter === 'artist') {
            const card = simpleCard({
                cover: item.coverUrl, title: item.nombre,
                meta: (item.trackCount || 0) + ' pistas',
                initials: initials(item.nombre),
            });
            card.addEventListener('click', () => jumpToArtist(item.nombre));
            gridEl.appendChild(card);
        } else {
            // song
            const card = document.createElement('div');
            card.className = 'album-card master-genre-song';
            const cover = item.coverUrl ? coverUrlFor(item.coverUrl) : null;
            card.innerHTML = `
                <div class="album-cover" ${cover ? `style="background-image:url('${cover}')"` : ''}>
                    ${cover ? '' : `<span class="cover-fallback">${escapeHtml(initials(item.titulo))}</span>`}
                </div>
                <div class="album-title">${escapeHtml(item.titulo || '')}</div>
                <div class="album-meta">${escapeHtml(item.artista || '')}${item.album ? ' · ' + escapeHtml(item.album) : ''}</div>
            `;
            card.addEventListener('click', () => {
                playFromList([item], 0, { lockFirst: true, context: null });
            });
            gridEl.appendChild(card);
        }
    }
    drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function renderPlaylistsTab() {
    const grid = $('main-grid');
    grid.innerHTML = '<div class="empty-state">Cargando listas…</div>';
    try {
        playlistsCache = await apiJson('/api/playlists');
        const list = applySort(filtered(playlistsCache, ['name']), 'playlists');
        grid.innerHTML = '';

        // "Nueva playlist" tile always first.
        const newCard = document.createElement('div');
        newCard.className = 'album-card playlist-new';
        newCard.innerHTML = `
            <div class="album-cover">+</div>
            <div class="album-title">Nueva playlist</div>
            <div class="album-meta">Crear una nueva lista</div>
        `;
        newCard.addEventListener('click', createPlaylistFlow);
        grid.appendChild(newCard);

        // Playlist virtual "Tus Me Gusta" — siempre presente, segunda en el
        // orden. Cuenta los IDs ya cargados en el Set; las portadas las trae
        // el endpoint /api/me/liked al abrir el drawer.
        const likedCard = document.createElement('div');
        likedCard.className = 'album-card liked-card';
        likedCard.innerHTML = `
            <div class="album-cover liked-cover">
                <svg viewBox="0 0 24 24" fill="currentColor" width="42" height="42" aria-hidden="true">
                    <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
                </svg>
            </div>
            <div class="album-title">Tus Me Gusta</div>
            <div class="album-meta">${likedTrackIds.size} ${likedTrackIds.size === 1 ? 'canción' : 'canciones'}</div>
        `;
        likedCard.addEventListener('click', () => openLikedSongs(likedCard));
        grid.appendChild(likedCard);

        for (const pl of list) {
            const card = document.createElement('div');
            card.className = 'album-card';
            let coverInner;
            if (pl.coverUrl) {
                const url = coverUrlFor(pl.coverUrl);
                coverInner = `<div class="album-cover" style="background-image:url('${url}')"></div>`;
            } else {
                const collage = collageCoverHtml(pl.sampleCovers);
                coverInner = `<div class="album-cover">${collage || '<span class="cover-fallback">♪</span>'}</div>`;
            }
            card.innerHTML = `
                ${coverInner}
                <div class="album-title">${escapeHtml(pl.name)}</div>
                <div class="album-meta">${pl.trackCount} ${pl.trackCount === 1 ? 'canción' : 'canciones'}</div>
            `;
            // Marca la tarjeta como playlist para que el menú contextual la
            // reconozca y pueda ofrecer Reproducir / Renombrar / Cambiar
            // portada / Eliminar sin tener que abrir el drawer.
            card._playlist = pl;
            card.addEventListener('click', () => openPlaylist(pl, card));
            grid.appendChild(card);
        }
    } catch (e) {
        grid.innerHTML = `<div class="empty-state">Error: ${escapeHtml(e.message)}</div>`;
    }
}

// Genera HTML para la portada de una tarjeta cuando no hay portada custom.
// Pinta hasta `max` celdas con las miniaturas (rutas servidor) que se pasen
// como `coverPaths`. Devuelve cadena vacía si no hay nada.
//
// Rejilla SIEMPRE cuadrada: 1x1, 2x2 o 3x3 (sin 2x1 ni rectángulos). Cuando
// hay menos miniaturas que celdas (p. ej. 2 portadas en un 2x2) se rellena
// con celdas vacías para conservar la forma cuadrada.
function collageCoverHtml(coverPaths, max = 9) {
    const list = [];
    const seen = new Set();
    for (const p of (coverPaths || [])) {
        if (!p || seen.has(p)) continue;
        seen.add(p);
        list.push(coverUrlFor(p));
        if (list.length >= max) break;
    }
    if (!list.length) return '';
    const n = list.length;
    // Lado del cuadrado: 1, 2 o 3 según cuántas portadas haya disponibles.
    const k = n >= 5 ? 3 : (n >= 2 ? 2 : 1);
    const cells = [];
    for (let i = 0; i < k * k; i++) {
        const u = list[i];
        cells.push(u
            ? `<span style="background-image:url('${u}')"></span>`
            : `<span class="cover-cell-empty"></span>`);
    }
    return `<div class="cover-collage" style="--collage-n:${k}">${cells.join('')}</div>`;
}

function simpleCard({ cover, title, meta, initials }) {
    const card = document.createElement('div');
    card.className = 'album-card';
    const url = cover ? coverUrlFor(cover) : null;
    card.innerHTML = `
        <div class="album-cover" ${url ? `style="background-image:url('${url}')"` : ''}>
            ${url ? '' : escapeHtml(initials || '')}
        </div>
        <div class="album-title">${escapeHtml(title || '')}</div>
        <div class="album-meta">${escapeHtml(meta || '')}</div>
    `;
    return card;
}

// --- Albums grid -----------------------------------------------------------
function renderAlbumGrid(albums) {
    closeDrawer();
    const grid = $('main-grid');
    grid.innerHTML = '';
    allCards = [];
    if (!albums || !albums.length) {
        grid.innerHTML = '<div class="empty-state">Sin resultados.</div>';
        return;
    }
    for (const album of albums) {
        const card = buildAlbumCard(album);
        grid.appendChild(card);
        allCards.push(card);
    }
}

function buildAlbumCard(album, onClick) {
    const card = document.createElement('div');
    card.className = 'album-card';
    card.dataset.albumId = album.id;
    card._album = album;  // referencia directa para el menú contextual
    const cover = album.coverUrl ? coverUrlFor(album.coverUrl) : null;
    const artistHtml = renderArtistMetaHtml(album.artista);
    card.innerHTML = `
        <div class="album-cover" ${cover ? `style="background-image:url('${cover}')"` : ''}>
            ${cover ? '' : `<span class="cover-fallback">${escapeHtml(initials(album.titulo))}</span>`}
        </div>
        <div class="album-title">${escapeHtml(album.titulo || 'Desconocido')}</div>
        <div class="album-meta">${artistHtml}${album.year ? ' · ' + album.year : ''} · ${album.trackCount} ${album.trackCount === 1 ? 'pista' : 'pistas'}</div>
    `;
    card.addEventListener('click', (e) => {
        const artistEl = e.target.closest('.meta-artist');
        if (artistEl) {
            e.stopPropagation();
            jumpToArtist(artistEl.dataset.artist);
            return;
        }
        // Click sobre la portada: si el drawer de este álbum NO está abierto,
        // lo abrimos (vista rápida del tracklist). Si YA está abierto, el
        // segundo click salta a la vista detallada. Click en título/meta:
        // comportamiento por defecto (drawer de tracklist) u onClick custom.
        const coverEl = e.target.closest('.album-cover');
        if (coverEl) {
            e.stopPropagation();
            if (currentDrawerKey === 'album:' + album.id) {
                openOrFocusTab('album', { albumId: album.id, title: album.titulo });
            } else {
                (onClick || (() => toggleAlbumDrawer(album, card)))();
            }
            return;
        }
        (onClick || (() => toggleAlbumDrawer(album, card)))();
    });
    return card;
}

// --- Artist / Genre views: drawer inline con sus álbumes -------------------
async function openArtist(artist, cardEl) {
    const key = 'artist:' + artist.id;
    if (currentDrawerKey === key) { closeDrawer(); return; }
    closeDrawer();
    let data;
    try {
        const q = artist.nombre ? '?name=' + encodeURIComponent(artist.nombre) : '';
        data = await apiJson('/api/artists/' + artist.id + '/albums' + q);
    }
    catch (e) { $('status-bar').textContent = 'Error: ' + e.message; return; }
    currentDrawerKey = key;
    cardEl?.classList.add('active');
    $('status-bar').textContent = `Artista: ${data.artista} · ${data.albums.length} álbumes`;
    const drawer = renderArtistDrawer({
        artistName: data.artista || artist.nombre || '',
        albums: data.albums || [],
    });
    if (cardEl) insertDrawerAfterRow(cardEl, drawer);
    else $('main-grid').appendChild(drawer);
    currentDrawer = drawer;
    drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function openGenre(genre, cardEl) {
    const key = 'genre:' + genre.id;
    if (currentDrawerKey === key) { closeDrawer(); return; }
    closeDrawer();
    let data;
    try { data = await apiJson('/api/genres/' + genre.id + '/albums'); }
    catch (e) { $('status-bar').textContent = 'Error: ' + e.message; return; }
    currentDrawerKey = key;
    cardEl?.classList.add('active');
    $('status-bar').textContent = `Género: ${data.genero} · ${data.albums.length} álbumes`;
    const drawer = renderArtistDrawer({
        artistName: data.genero || genre.nombre || '',
        albums: data.albums || [],
    });
    if (cardEl) insertDrawerAfterRow(cardEl, drawer);
    else $('main-grid').appendChild(drawer);
    currentDrawer = drawer;
    drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderArtistDrawer({ artistName, albums }) {
    const drawer = document.createElement('div');
    drawer.className = 'drawer drawer-artist';
    drawer.innerHTML = `
        <button class="drawer-close" title="Cerrar" aria-label="Cerrar">×</button>
        <div class="drawer-artist-header">
            <div class="drawer-artist-info">
                <h3 class="drawer-title">${escapeHtml(artistName)}</h3>
                <div class="drawer-sub">${albums.length} ${albums.length === 1 ? 'álbum' : 'álbumes'}</div>
            </div>
            <button class="drawer-action drawer-artist-play" type="button" title="Reproducir discografía">
                <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M3 1.5v13l11-6.5z"/></svg>
                Reproducir
            </button>
        </div>
        <div class="drawer-artist-grid"></div>
    `;
    const gridEl = drawer.querySelector('.drawer-artist-grid');
    for (const a of albums) {
        const card = buildAlbumCard(a, () => jumpToAlbum(a));
        gridEl.appendChild(card);
    }
    drawer.querySelector('.drawer-close').addEventListener('click', closeDrawer);
    drawer.querySelector('.drawer-artist-play')?.addEventListener('click', () => playArtist(artistName));
    return drawer;
}

// Reproduce toda la discografía del artista.
// Sin shuffle: tracks en orden de álbum (año/álbum/disco/track).
// Con shuffle: todos los tracks mezclados.
// El contexto 'artist' hace que al terminar la cola simplemente se pare.
async function playArtist(artistName) {
    if (!artistName) return;
    const target = (library.artists || []).find(a =>
        (a.nombre || '').toLowerCase() === artistName.toLowerCase());
    if (!target) { $('status-bar').textContent = 'Artista no encontrado en la biblioteca'; return; }
    let data;
    try {
        data = await apiJson('/api/artists/' + target.id + '/tracks'
            + '?name=' + encodeURIComponent(target.nombre || artistName));
    } catch (e) {
        $('status-bar').textContent = 'Error: ' + e.message;
        return;
    }
    const tracks = data?.tracks || [];
    if (!tracks.length) { $('status-bar').textContent = 'Este artista no tiene canciones.'; return; }
    // Etiqueta cada track con el id de su álbum mirando library.albums por
    // (titulo, albumartist). Robusto a colaboraciones porque también probamos
    // sólo por título cuando el artista difiere.
    const byKey = new Map();
    const byTitle = new Map();
    for (const a of (library.albums || [])) {
        const title = (a.titulo || '').toLowerCase().trim();
        const aa = (a.albumartist || a.artista || '').toLowerCase().trim();
        byKey.set(title + '\x1f' + aa, a.id);
        if (!byTitle.has(title)) byTitle.set(title, a.id);
    }
    for (const t of tracks) {
        const title = (t.album || '').toLowerCase().trim();
        const aa = (t.artista || '').toLowerCase().trim();
        const id = byKey.get(title + '\x1f' + aa) ?? byTitle.get(title);
        if (id != null) t._albumId = id;
    }
    playFromList(tracks, 0, {
        lockFirst: false,
        context: { kind: 'artist', artistName: data.artista || target.nombre || artistName },
    });
}

async function jumpToAlbum(album) {
    closeDrawer();
    const albumsTab = tabs.find(t => t.type === 'albums') || openOrFocusTab('albums');
    if (activeTabId !== albumsTab.id) activateTab(albumsTab.id);
    await Promise.resolve();
    const card = $('main-grid').querySelector(`.album-card[data-album-id="${album.id}"]`);
    if (card) await openAlbumDrawer(album, card);
}

// Click en .meta-artist (nombres clicables): abre la tab Artist View
// dedicada a ese artista en lugar de saltar al listado general.
async function jumpToArtist(artistName) {
    if (!artistName) return;
    openOrFocusTab('artist', { name: artistName });
}

// --- Artist View (single artist) -----------------------------------------
// Banner con imagen grande del artista + foto + descripción + álbumes.
async function fetchAndRenderArtistTags(artistName) {
    const target = $('av-tags');
    if (!target) return;
    let info;
    try { info = await apiJson('/api/mb/artist?name=' + encodeURIComponent(artistName)); }
    catch { target.innerHTML = ''; return; }
    if (currentTabType() !== 'artist') return;  // user navigated away
    const tags = (info?.tags || []).slice(0, 10);
    if (!tags.length) { target.innerHTML = ''; return; }
    target.innerHTML = tags.map(t =>
        `<span class="tag-pill" title="${escapeHtml(t.name)} · ${t.count} votos">${escapeHtml(t.name)}</span>`
    ).join('');
}

// Fallback de foto del artista cuando Wikipedia/TheAudioDB no devuelven
// imagen: SIEMPRE iniciales sobre gradiente (.av-photo-empty + data-initials),
// nunca portadas de álbum — una portada no es la foto del artista.
function applyArtistFallbackImage(artistName) {
    const bg    = $('av-bg');
    const photo = $('av-photo');
    if (!bg || !photo) return;
    bg.style.backgroundImage    = '';
    photo.style.backgroundImage = '';
    photo.classList.add('av-photo-empty');
    photo.setAttribute('data-initials', initials(artistName) || '?');
}

async function renderArtistView(artistName) {
    const view = $('artist-view');
    if (!view || !artistName) return;
    view.innerHTML = `
        <div class="av-hero">
            <div class="av-hero-bg" id="av-bg"></div>
            <div class="av-hero-fade"></div>
            <div class="av-hero-content">
                <div class="av-photo" id="av-photo" aria-hidden="true"></div>
                <div>
                    <div class="av-eyebrow">Artista</div>
                    <h1 class="av-name">${escapeHtml(artistName)}</h1>
                    <div class="av-source" id="av-source"></div>
                </div>
            </div>
        </div>
        <div class="av-body">
            <p class="av-extract" id="av-extract">Cargando descripción…</p>
            <div class="av-tags" id="av-tags"></div>
            <div class="av-links" id="av-links"></div>
            <h2 class="av-section-title">Álbumes en tu biblioteca</h2>
            <div class="av-albums" id="av-albums"></div>
        </div>
    `;

    // Tags MusicBrainz (chips). Llamada paralela, no bloquea descripción.
    fetchAndRenderArtistTags(artistName).catch(() => {});

    // Aplicamos un fallback inmediato (portada de un álbum suyo + iniciales)
    // para que NUNCA aparezca un hueco vacío. Lo de Wikipedia/Last.fm se
    // pisa después si llega algo mejor.
    applyArtistFallbackImage(artistName);

    try {
        // disambiguate=1 → el backend resuelve internamente colisiones de
        // nombre usando los tags locales del usuario (géneros ID3 +
        // mb_album_cache). Siempre devuelve UNA sola descripción.
        const info = await apiJson('/api/artist-info?disambiguate=1&name=' + encodeURIComponent(artistName));
        if (currentTabType() !== 'artist') return;
        applyArtistInfoToView(info, artistName);
    } catch {
        $('av-extract').textContent = 'No se pudo obtener la descripción de este artista.';
    }

    try {
        const target = (library.artists || []).find(a =>
            (a.nombre || '').toLowerCase() === artistName.toLowerCase());
        const av = $('av-albums');
        if (!target) {
            av.innerHTML = '<div class="empty-state">No tienes este artista en tu biblioteca.</div>';
            return;
        }
        const data = await apiJson('/api/artists/' + target.id + '/albums'
            + '?name=' + encodeURIComponent(target.nombre || artistName));
        av.innerHTML = '';
        for (const a of (data.albums || [])) {
            const card = buildAlbumCard(a, () => jumpToAlbum(a));
            av.appendChild(card);
        }
        if (!data.albums?.length) {
            av.innerHTML = '<div class="empty-state">No hay álbumes registrados.</div>';
        }
    } catch (e) {
        $('av-albums').innerHTML = `<div class="empty-state">Error: ${escapeHtml(e.message)}</div>`;
    }
}

// Aplica una respuesta normal de /api/artist-info al DOM de la vista. Sale
// del flujo principal de renderArtistView para poder reutilizarlo cuando el
// usuario elige un artista en el picker de desambiguación.
function applyArtistInfoToView(info, artistName) {
    if (!info) return;
    if (info.imageLarge) {
        $('av-bg').style.backgroundImage = `url('${info.imageLarge}')`;
    }
    if (info.thumbnail) {
        // Importante: limpiar la marca de "foto vacía" o el ::before
        // con las iniciales se quedaría pintado por encima del thumbnail.
        const ph = $('av-photo');
        ph.style.backgroundImage = `url('${info.thumbnail}')`;
        ph.classList.remove('av-photo-empty');
        ph.removeAttribute('data-initials');
    }
    // Si la foto sigue sin venir, reaplicamos el fallback local.
    if (!info.imageLarge && !info.thumbnail) applyArtistFallbackImage(artistName);
    const ex = $('av-extract');
    if (ex) ex.textContent = info.extract || 'Sin descripción disponible.';
    const src = $('av-source');
    if (src) src.textContent = info.source ? `vía ${info.source}` : '';
    const links = $('av-links');
    if (!links) return;
    links.innerHTML = '';
    const linkEntries = [
        ['Wikipedia',     info.links?.wikipedia],
        ['Last.fm',       info.links?.lastfm],
        ['RateYourMusic', info.links?.rym],
    ];
    for (const [label, href] of linkEntries) {
        if (!href) continue;
        const a = document.createElement('a');
        a.href = href; a.target = '_blank'; a.rel = 'noopener';
        a.className = 'av-link';
        a.textContent = label;
        links.appendChild(a);
    }
}

// --- Vista detallada de álbum (full screen) -------------------------------
async function renderAlbumView(albumId) {
    const view = $('album-view');
    if (!view || !albumId) return;
    view.innerHTML = '<div class="empty-state">Cargando álbum…</div>';

    // 1) Local: ficha + tracklist desde nuestra BD.
    let detail;
    try { detail = await apiJson('/api/albums/' + albumId); }
    catch (e) {
        view.innerHTML = `<div class="empty-state">Error: ${escapeHtml(e.message)}</div>`;
        return;
    }
    if (currentTabType() !== 'album') return;
    for (const t of (detail.tracks || [])) t._albumId = detail.id;
    const cover = coverUrlFor(detail.coverUrl);
    const albumPlayCtx = { kind: 'album', albumId: detail.id, artistName: detail.albumartist || detail.artista };

    view.innerHTML = `
        <div class="alv-hero">
            <div class="alv-hero-bg" id="alv-bg"></div>
            <div class="alv-hero-fade"></div>
            <div class="alv-hero-content">
                <div class="alv-cover" id="alv-cover" ${cover ? `style="background-image:url('${cover}')"` : ''}></div>
                <div class="alv-headline">
                    <div class="alv-eyebrow">Álbum</div>
                    <h1 class="alv-title">${escapeHtml(detail.titulo || '')}</h1>
                    <div class="alv-by" id="alv-by"></div>
                    <div class="alv-meta-line" id="alv-meta-line">${detail.year ? detail.year : ''}</div>
                    <div class="alv-actions">
                        <button id="alv-play" class="drawer-action" type="button">
                            <svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M3 1.5v13l11-6.5z"/></svg>
                            Reproducir
                        </button>
                    </div>
                </div>
            </div>
        </div>
        <div class="alv-body">
            <div class="alv-tags" id="alv-tags"></div>
            <p class="alv-description" id="alv-desc"></p>
            <div class="alv-facts" id="alv-facts"></div>
            <h2 class="alv-section-title">Canciones</h2>
            <div class="alv-tracks" id="alv-tracks"></div>
        </div>
    `;

    // Artista (chips clicables, igual que en el drawer).
    $('alv-by').innerHTML = renderArtistMetaHtml(detail.artista);
    $('alv-by').addEventListener('click', (e) => {
        const a = e.target.closest('.meta-artist');
        if (a) { e.stopPropagation(); jumpToArtist(a.dataset.artist); }
    });

    $('alv-play').addEventListener('click', () => {
        playFromList(detail.tracks, 0, { lockFirst: false, context: albumPlayCtx });
    });

    // Tracklist (reusa buildTrackRow).
    const tEl = $('alv-tracks');
    (detail.tracks || []).forEach((t, i) => {
        tEl.appendChild(buildTrackRow(t, i, detail.tracks, 'album', null, albumPlayCtx));
    });

    // 2) Enriquecemos con MusicBrainz (asíncrono, no bloquea).
    fetchAndRenderAlbumViewExtras(detail).catch(() => {});
}

async function fetchAndRenderAlbumViewExtras(detail) {
    let info;
    try { info = await apiJson('/api/mb/album/' + detail.id); }
    catch { return; }
    if (currentTabType() !== 'album') return;

    // Tags completos
    const tagsEl = $('alv-tags');
    const tags = (info?.tags || []);
    if (tagsEl && tags.length) {
        tagsEl.innerHTML = tags.map(t =>
            `<span class="tag-pill" title="${t.count} votos">${escapeHtml(t.name)}</span>`
        ).join('');
    }

    // Descripción
    const descEl = $('alv-desc');
    if (descEl) {
        descEl.textContent = info?.description
            || 'Sin descripción disponible en MusicBrainz.';
    }

    // Datos: fecha de lanzamiento (de MB si la tenemos, sino la nuestra),
    // discográfica, MBID, info generalizada.
    const factsEl = $('alv-facts');
    if (factsEl) {
        const rows = [
            ['Lanzamiento', info?.first_release || (detail.year ? String(detail.year) : null)],
            ['Discográfica', info?.label || null],
            ['Pistas',      String(detail.trackCount || (detail.tracks?.length || 0))],
            ['MusicBrainz', info?.mbid
                ? `<a href="#" data-extlink="https://musicbrainz.org/release-group/${encodeURIComponent(info.mbid)}">${escapeHtml(info.mbid)}</a>`
                : null],
        ];
        factsEl.innerHTML = rows.filter(([_, v]) => v != null && v !== '').map(([k, v]) =>
            `<div class="alv-fact"><span class="alv-fact-k">${escapeHtml(k)}</span><span class="alv-fact-v">${v}</span></div>`
        ).join('');
        // Wire external link
        factsEl.querySelectorAll('[data-extlink]').forEach(el => {
            el.addEventListener('click', (e) => {
                e.preventDefault();
                if (window.api?.openExternal) window.api.openExternal(el.getAttribute('data-extlink'));
            });
        });
    }

    // Fondo del hero: si tenemos cover, lo dejamos; si no, intentamos
    // usar el thumbnail/imageLarge del artista para no dejarlo vacío.
    const bgEl = $('alv-bg');
    const coverUrl = detail.coverUrl ? coverUrlFor(detail.coverUrl) : null;
    if (bgEl && coverUrl) bgEl.style.backgroundImage = `url('${coverUrl}')`;
}

