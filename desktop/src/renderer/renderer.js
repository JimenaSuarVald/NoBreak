// Renderer logic. Sandboxed BrowserWindow with window.api exposed by preload.js.
// Auth + library data go over HTTP (same path the website uses); native ops
// (folder picker, settings) go over IPC.

const $ = (id) => document.getElementById(id);

// --- State -----------------------------------------------------------------
let API_BASE = 'http://127.0.0.1:8080';
let token = null;
let username = null;

let library = { albums: [], artists: [] };  // populated from /api/library
let currentTab = 'albums';                    // albums | artists | genres | playlists
let lastQuery = '';                           // current search query

let allCards = [];                  // album-card elements in render order
let currentDrawer = null;            // DOM node of the open drawer
let currentDrawerKey = null;         // unique id of what the drawer represents (album:N or playlist:N)
let currentAlbum = null;             // populated album/playlist for the open drawer
let queue = [];
let queueIndex = 0;

// Caches for tabs that need a fetch beyond /api/library.
let genres = null;
let playlistsCache = null;

// Last artist whose info we requested (debounce repeats).
let lastArtistInfoQuery = null;

// --- Boot ------------------------------------------------------------------
(async function boot() {
    applyTheme(localStorage.getItem('nobreak-theme') || 'dark');
    API_BASE = 'http://127.0.0.1:' + (await window.api.port());
    const firstRun = !(await window.api.hasUser());
    setupLoginForm(firstRun);
    setupMenuListeners();
    setupThemeToggle();
    setupTabs();
    setupArtistStrip();
})();

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('nobreak-theme', theme);
}

function setupThemeToggle() {
    $('theme-toggle')?.addEventListener('click', () => {
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(next);
    });
}

function setupTabs() {
    document.querySelectorAll('.tab').forEach(btn => {
        btn.addEventListener('click', () => switchTab(btn.dataset.tab));
    });
}

async function switchTab(tab) {
    if (currentTab === tab) return;
    currentTab = tab;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $('search').value = '';
    lastQuery = '';
    await renderCurrentTab();
}

async function renderCurrentTab() {
    closeDrawer();
    if (currentTab === 'albums') return renderAlbumsTab();
    if (currentTab === 'artists') return renderArtistsTab();
    if (currentTab === 'genres') return renderGenresTab();
    if (currentTab === 'playlists') return renderPlaylistsTab();
}

// --- Login -----------------------------------------------------------------
function setupLoginForm(firstRun) {
    $('login-title').textContent = firstRun ? 'Crear cuenta' : 'NoBreak';
    $('login-sub').textContent = firstRun
        ? 'Primer arranque: define tu usuario y contraseña.'
        : 'Inicia sesión para acceder a tu música.';
    $('login-submit').textContent = firstRun ? 'Crear cuenta' : 'Entrar';
    $('login-confirm').classList.toggle('hidden', !firstRun);
    $('login-confirm-label').classList.toggle('hidden', !firstRun);

    $('login-form').onsubmit = async (e) => {
        e.preventDefault();
        const user = $('login-user').value.trim();
        const pass = $('login-pass').value;
        const confirm = $('login-confirm').value;
        const errEl = $('login-error');
        errEl.textContent = '';

        if (!user || !pass) { errEl.textContent = 'Rellena usuario y contraseña.'; return; }
        if (firstRun) {
            if (pass.length < 6) { errEl.textContent = 'La contraseña debe tener al menos 6 caracteres.'; return; }
            if (pass !== confirm) { errEl.textContent = 'Las contraseñas no coinciden.'; return; }
        }

        const submitBtn = $('login-submit');
        submitBtn.disabled = true;
        try {
            if (firstRun) await window.api.register(user, pass);
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
            await afterLogin();
        } catch (err) {
            errEl.textContent = err.message || String(err);
        } finally {
            submitBtn.disabled = false;
        }
    };
}

async function afterLogin() {
    $('login-screen').classList.add('hidden');
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
    $('user-badge').textContent = username || '';
    setupSearch();
    refreshLibrary();
}

// --- API helpers -----------------------------------------------------------
async function apiCall(path, opts = {}) {
    const res = await fetch(API_BASE + path, {
        ...opts,
        headers: { 'Authorization': 'Bearer ' + token, ...(opts.headers || {}) },
    });
    return res;
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
        if (currentTab === 'albums') renderAlbumsTab();
        else renderCurrentTab();
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
    renderAlbumGrid(filtered(library.albums || [], ['titulo', 'artista']));
}

function renderArtistsTab() {
    const grid = $('main-grid');
    grid.innerHTML = '';
    allCards = [];
    const artists = filtered(library.artists || [], ['nombre']);
    if (!artists.length) {
        grid.innerHTML = '<div class="empty-state">Sin artistas todavía.</div>';
        return;
    }
    for (const a of artists) {
        const card = simpleCard({
            cover: a.coverUrl,
            title: a.nombre,
            meta: `${a.albumCount} ${a.albumCount === 1 ? 'álbum' : 'álbumes'} · ${a.trackCount} pistas`,
            initials: initials(a.nombre),
        });
        card.addEventListener('click', () => openArtist(a));
        grid.appendChild(card);
    }
}

async function renderGenresTab() {
    const grid = $('main-grid');
    grid.innerHTML = '<div class="empty-state">Cargando géneros…</div>';
    try {
        if (!genres) genres = await apiJson('/api/genres');
        const list = filtered(genres, ['nombre']);
        grid.innerHTML = '';
        if (!list.length) {
            grid.innerHTML = '<div class="empty-state">No hay géneros etiquetados en tu biblioteca.</div>';
            return;
        }
        for (const g of list) {
            const card = simpleCard({
                cover: g.coverUrl,
                title: g.nombre,
                meta: `${g.albumCount} ${g.albumCount === 1 ? 'álbum' : 'álbumes'} · ${g.trackCount} pistas`,
                initials: initials(g.nombre),
            });
            card.addEventListener('click', () => openGenre(g));
            grid.appendChild(card);
        }
    } catch (e) {
        grid.innerHTML = `<div class="empty-state">Error: ${escapeHtml(e.message)}</div>`;
    }
}

async function renderPlaylistsTab() {
    const grid = $('main-grid');
    grid.innerHTML = '<div class="empty-state">Cargando listas…</div>';
    try {
        playlistsCache = await apiJson('/api/playlists');
        const list = filtered(playlistsCache, ['name']);
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

        for (const pl of list) {
            const card = simpleCard({
                cover: null,  // playlists don't carry a cover yet
                title: pl.name,
                meta: `${pl.trackCount} ${pl.trackCount === 1 ? 'canción' : 'canciones'}`,
                initials: '♪',
            });
            card.addEventListener('click', () => openPlaylist(pl, card));
            grid.appendChild(card);
        }
    } catch (e) {
        grid.innerHTML = `<div class="empty-state">Error: ${escapeHtml(e.message)}</div>`;
    }
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

function buildAlbumCard(album) {
    const card = document.createElement('div');
    card.className = 'album-card';
    card.dataset.albumId = album.id;
    const cover = album.coverUrl ? coverUrlFor(album.coverUrl) : null;
    card.innerHTML = `
        <div class="album-cover" ${cover ? `style="background-image:url('${cover}')"` : ''}>
            ${cover ? '' : `<span class="cover-fallback">${escapeHtml(initials(album.titulo))}</span>`}
        </div>
        <div class="album-title">${escapeHtml(album.titulo || 'Desconocido')}</div>
        <div class="album-meta">${escapeHtml(album.artista || '')}${album.year ? ' · ' + album.year : ''} · ${album.trackCount} ${album.trackCount === 1 ? 'pista' : 'pistas'}</div>
    `;
    card.addEventListener('click', () => toggleAlbumDrawer(album, card));
    return card;
}

// --- Artist / Genre views (filter Albums tab) ------------------------------
async function openArtist(artist) {
    try {
        const data = await apiJson('/api/artists/' + artist.id + '/albums');
        switchToFilteredAlbums(data.albums);
        $('status-bar').textContent = `Artista: ${data.artista} · ${data.albums.length} álbumes`;
    } catch (e) {
        $('status-bar').textContent = 'Error: ' + e.message;
    }
}

async function openGenre(genre) {
    try {
        const data = await apiJson('/api/genres/' + genre.id + '/albums');
        switchToFilteredAlbums(data.albums);
        $('status-bar').textContent = `Género: ${data.genero} · ${data.albums.length} álbumes`;
    } catch (e) {
        $('status-bar').textContent = 'Error: ' + e.message;
    }
}

function switchToFilteredAlbums(albums) {
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'albums'));
    currentTab = 'albums';
    $('search').value = '';
    lastQuery = '';
    renderAlbumGrid(albums);
}

// --- Album drawer ----------------------------------------------------------
async function toggleAlbumDrawer(album, cardEl) {
    const key = 'album:' + album.id;
    if (currentDrawerKey === key) { closeDrawer(); return; }
    closeDrawer();
    await openAlbumDrawer(album, cardEl);
}

async function openAlbumDrawer(album, cardEl) {
    cardEl.classList.add('active');
    let detail;
    try { detail = await apiJson('/api/albums/' + album.id); }
    catch (err) {
        cardEl.classList.remove('active');
        $('status-bar').textContent = 'Error abriendo álbum: ' + err.message;
        return;
    }
    currentAlbum = detail;
    currentDrawerKey = 'album:' + album.id;

    const cover = coverUrlFor(detail.coverUrl);
    const drawer = renderDrawer({
        cover, title: detail.titulo,
        sub: `${detail.artista || ''}${detail.year ? ' (' + detail.year + ')' : ''}`,
        actions: [{ label: 'Reproducir', icon: 'play', primary: true, onClick: () => playFromList(detail.tracks, 0) }],
        tracks: detail.tracks,
        trackContext: 'album',
    });
    insertDrawerAfterRow(cardEl, drawer);
    currentDrawer = drawer;
    paintDrawerColor(drawer, cover);
    drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// --- Playlist drawer -------------------------------------------------------
async function openPlaylist(pl, cardEl) {
    const key = 'playlist:' + pl.id;
    if (currentDrawerKey === key) { closeDrawer(); return; }
    closeDrawer();

    let detail;
    try { detail = await apiJson('/api/playlists/' + pl.id); }
    catch (err) {
        $('status-bar').textContent = 'Error abriendo playlist: ' + err.message;
        return;
    }
    currentAlbum = detail;
    currentDrawerKey = key;
    cardEl.classList.add('active');

    // Use the first track's cover as the playlist visual, when available.
    const firstCover = detail.tracks.find(t => t.coverUrl)?.coverUrl;
    const cover = firstCover ? coverUrlFor(firstCover) : null;

    const drawer = renderDrawer({
        cover,
        title: detail.name,
        sub: `${detail.tracks.length} ${detail.tracks.length === 1 ? 'canción' : 'canciones'}`,
        editableTitle: (newName) => renamePlaylist(detail.id, newName),
        actions: [
            { label: 'Reproducir', icon: 'play', primary: true,
              onClick: () => playFromList(detail.tracks, 0) },
            { label: 'Renombrar', icon: 'edit', ghost: true,
              onClick: () => beginRenameInline(drawer) },
            { label: 'Eliminar', icon: 'trash', ghost: true,
              onClick: () => deletePlaylistFlow(detail) },
        ],
        tracks: detail.tracks,
        trackContext: 'playlist',
        playlistId: detail.id,
    });
    insertDrawerAfterRow(cardEl, drawer);
    currentDrawer = drawer;
    paintDrawerColor(drawer, cover);
    drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// --- Generic drawer renderer (works for albums + playlists) ---------------
function renderDrawer({ cover, title, sub, actions, tracks, trackContext, playlistId, editableTitle }) {
    const drawer = document.createElement('div');
    drawer.className = 'drawer';
    drawer.innerHTML = `
        <button class="drawer-close" title="Cerrar" aria-label="Cerrar">×</button>
        <div class="drawer-cover" ${cover ? `style="background-image:url('${cover}')"` : ''}>
            ${cover ? '' : escapeHtml(initials(title))}
        </div>
        <div class="drawer-info">
            <h3 class="drawer-title">${escapeHtml(title || '')}</h3>
            <div class="drawer-sub">${escapeHtml(sub || '')}</div>
            <div class="drawer-actions"></div>
        </div>
        <div class="drawer-tracks"></div>
    `;
    const actionsEl = drawer.querySelector('.drawer-actions');
    for (const act of actions || []) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'drawer-action' + (act.ghost ? ' ghost' : '');
        b.innerHTML = (act.icon === 'play'
            ? '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M3 1.5v13l11-6.5z"/></svg> '
            : '') + escapeHtml(act.label);
        b.addEventListener('click', act.onClick);
        actionsEl.appendChild(b);
    }
    if (editableTitle) {
        drawer._editableTitle = editableTitle;
    }
    const tracksEl = drawer.querySelector('.drawer-tracks');
    (tracks || []).forEach((t, i) => tracksEl.appendChild(buildTrackRow(t, i, tracks, trackContext, playlistId)));
    drawer.querySelector('.drawer-close').addEventListener('click', closeDrawer);
    paintDrawerColor(drawer, '#1f1f1f');  // neutral until dominantColor returns
    return drawer;
}

function buildTrackRow(t, i, tracks, context, playlistId) {
    const row = document.createElement('div');
    row.className = 'drawer-track';
    row.dataset.trackId = t.id;
    row.innerHTML = `
        <span class="num">${String(t.trackNo ?? (i + 1)).padStart(2, '0')}</span>
        <span class="title">${escapeHtml(t.titulo || '')}${
            context === 'playlist' && t.artista ? ` <span style="opacity:0.6">— ${escapeHtml(t.artista)}</span>` : ''
        }</span>
        <button class="row-btn" title="${context === 'playlist' ? 'Quitar de la lista' : 'Añadir a lista'}">
            ${context === 'playlist' ? '−' : '+'}
        </button>
        <span class="dur">${formatDuration(t.durationMs)}</span>
    `;
    row.addEventListener('click', (e) => {
        if (e.target.classList.contains('row-btn')) return;
        playFromList(tracks, i);
    });
    row.querySelector('.row-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        if (context === 'playlist') removeFromPlaylist(playlistId, t.id);
        else openAddToPlaylistMenu(t.id, e.currentTarget);
    });
    return row;
}

// --- Drawer color + position ----------------------------------------------
async function paintDrawerColor(drawer, coverUrl) {
    if (!coverUrl) {
        applyDrawerTheme(drawer, '#1f1f1f');
        return;
    }
    const bg = await dominantColor(coverUrl);
    if (drawer.isConnected) applyDrawerTheme(drawer, bg || '#1f1f1f');
}

function applyDrawerTheme(drawer, bgColor) {
    const fg = contrastText(bgColor);
    drawer.style.setProperty('--drawer-bg', bgColor);
    drawer.style.setProperty('--drawer-fg', fg);
}

function closeDrawer() {
    if (currentDrawer) { currentDrawer.remove(); currentDrawer = null; }
    currentDrawerKey = null;
    currentAlbum = null;
    for (const c of allCards) c.classList.remove('active');
    document.querySelectorAll('.album-card.active').forEach(c => c.classList.remove('active'));
}

function insertDrawerAfterRow(cardEl, drawer) {
    const grid = $('main-grid');
    const cards = Array.from(grid.querySelectorAll('.album-card'));
    const idx = cards.indexOf(cardEl);
    if (idx < 0) { grid.appendChild(drawer); return; }
    const cs = window.getComputedStyle(grid).gridTemplateColumns;
    const cols = cs.split(/\s+/).filter(Boolean).length;
    const insertBeforeIdx = (Math.floor(idx / cols) + 1) * cols;
    if (insertBeforeIdx >= cards.length) grid.appendChild(drawer);
    else grid.insertBefore(drawer, cards[insertBeforeIdx]);
}

let resizeTimer = null;
window.addEventListener('resize', () => {
    if (!currentDrawer || !currentDrawerKey) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
        const grid = $('main-grid');
        const cards = Array.from(grid.querySelectorAll('.album-card.active'));
        if (cards[0] && currentDrawer) {
            currentDrawer.remove();
            insertDrawerAfterRow(cards[0], currentDrawer);
        }
    }, 100);
});

// --- Playback --------------------------------------------------------------
function playFromList(tracks, index) {
    if (!tracks || !tracks.length) return;
    queue = tracks.slice();
    queueIndex = index;
    playTrack(queue[index]);
}

function playTrack(track) {
    const audio = $('audio');
    audio.src = API_BASE + '/stream/' + track.id + '?t=' + encodeURIComponent(token);
    audio.play().catch(() => { /* autoplay may need a user gesture */ });
    $('np-title').textContent = track.titulo || '—';
    const bits = [];
    if (track.artista) bits.push(track.artista);
    if (track.album) bits.push(track.album);
    else if (currentAlbum?.titulo) bits.push(currentAlbum.titulo);
    $('np-meta').textContent = bits.join(' · ');
    const cover = track.coverUrl ? coverUrlFor(track.coverUrl)
                : (currentAlbum?.coverUrl ? coverUrlFor(currentAlbum.coverUrl) : '');
    $('np-cover').style.backgroundImage = cover ? `url('${cover}')` : '';
    if (currentDrawer) {
        currentDrawer.querySelectorAll('.drawer-track').forEach(el => {
            el.classList.toggle('playing', Number(el.dataset.trackId) === track.id);
        });
    }
    requestArtistInfo(track.artista || '');
}

document.addEventListener('DOMContentLoaded', () => {
    $('audio')?.addEventListener('ended', () => {
        if (!queue.length) return;
        queueIndex = (queueIndex + 1) % queue.length;
        playTrack(queue[queueIndex]);
    });
});

// --- Artist info strip -----------------------------------------------------
function setupArtistStrip() {
    $('ai-toggle')?.addEventListener('click', () => {
        $('artist-strip').classList.toggle('expanded');
    });
}

async function requestArtistInfo(artistName) {
    if (!artistName || artistName === lastArtistInfoQuery) return;
    lastArtistInfoQuery = artistName;
    const strip = $('artist-strip');
    strip.classList.remove('expanded');
    $('ai-name').textContent = artistName;
    $('ai-extract').textContent = 'Cargando…';
    $('ai-thumb').style.backgroundImage = '';
    $('ai-source').textContent = '';
    strip.classList.remove('hidden');

    try {
        const info = await apiJson('/api/artist-info?name=' + encodeURIComponent(artistName));
        if (lastArtistInfoQuery !== artistName) return;  // a newer track took over
        $('ai-name').textContent = info.name || artistName;
        $('ai-extract').textContent = info.extract || 'Sin descripción.';
        $('ai-source').textContent = info.source ? `vía ${info.source}` : '';
        $('ai-thumb').style.backgroundImage = info.thumbnail ? `url('${info.thumbnail}')` : '';
        $('ai-link-wp').href = info.links?.wikipedia || '#';
        $('ai-link-lf').href = info.links?.lastfm || '#';
        $('ai-link-rym').href = info.links?.rym || '#';
    } catch (e) {
        if (lastArtistInfoQuery !== artistName) return;
        $('ai-extract').textContent = 'Sin información disponible.';
        $('ai-source').textContent = '';
        $('ai-link-wp').href = 'https://en.wikipedia.org/wiki/Special:Search?search=' + encodeURIComponent(artistName);
        $('ai-link-lf').href = 'https://www.last.fm/music/' + encodeURIComponent(artistName.replace(/ /g, '+'));
        $('ai-link-rym').href = 'https://rateyourmusic.com/search?searchterm=' + encodeURIComponent(artistName) + '&searchtype=a';
    }
}

// --- Playlists CRUD --------------------------------------------------------
async function createPlaylistFlow(prefilledTrackId) {
    const name = (prompt('Nombre de la nueva playlist:') || '').trim();
    if (!name) return null;
    try {
        const pl = await apiJson('/api/playlists', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name }),
        });
        playlistsCache = null;
        if (prefilledTrackId) {
            await apiJson('/api/playlists/' + pl.id + '/tracks', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ trackId: prefilledTrackId }),
            });
        }
        if (currentTab === 'playlists') renderPlaylistsTab();
        return pl;
    } catch (e) {
        alert('No se pudo crear la playlist: ' + e.message);
        return null;
    }
}

async function renamePlaylist(id, newName) {
    const trimmed = (newName || '').trim();
    if (!trimmed) return;
    try {
        await apiJson('/api/playlists/' + id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: trimmed }),
        });
        playlistsCache = null;
        if (currentTab === 'playlists') {
            // re-render preserving the current drawer state when possible
            renderPlaylistsTab();
        }
    } catch (e) {
        alert('No se pudo renombrar: ' + e.message);
    }
}

function beginRenameInline(drawer) {
    const titleEl = drawer.querySelector('.drawer-title');
    if (!titleEl) return;
    const current = titleEl.textContent;
    const input = document.createElement('input');
    input.type = 'text';
    input.value = current;
    input.className = 'drawer-title-input';
    titleEl.replaceWith(input);
    input.focus();
    input.select();
    const finish = (commit) => {
        const value = input.value.trim();
        const h3 = document.createElement('h3');
        h3.className = 'drawer-title';
        h3.textContent = commit && value ? value : current;
        input.replaceWith(h3);
        if (commit && value && value !== current && drawer._editableTitle) {
            drawer._editableTitle(value);
        }
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') finish(true);
        else if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
}

async function deletePlaylistFlow(playlist) {
    if (!confirm(`¿Borrar la playlist "${playlist.name}"? Las canciones no se borran del disco.`)) return;
    try {
        const r = await apiCall('/api/playlists/' + playlist.id, { method: 'DELETE' });
        if (!r.ok && r.status !== 204) throw new Error('HTTP ' + r.status);
        playlistsCache = null;
        closeDrawer();
        if (currentTab === 'playlists') renderPlaylistsTab();
    } catch (e) { alert('No se pudo borrar: ' + e.message); }
}

async function removeFromPlaylist(playlistId, trackId) {
    try {
        const r = await apiCall('/api/playlists/' + playlistId + '/tracks/' + trackId, { method: 'DELETE' });
        if (!r.ok && r.status !== 204) throw new Error('HTTP ' + r.status);
        // Refresh the open playlist drawer if it's the one we modified.
        if (currentDrawerKey === 'playlist:' + playlistId) {
            const updated = await apiJson('/api/playlists/' + playlistId);
            currentAlbum = updated;
            const tracksEl = currentDrawer?.querySelector('.drawer-tracks');
            if (tracksEl) {
                tracksEl.innerHTML = '';
                updated.tracks.forEach((t, i) => tracksEl.appendChild(
                    buildTrackRow(t, i, updated.tracks, 'playlist', playlistId)));
            }
            const subEl = currentDrawer?.querySelector('.drawer-sub');
            if (subEl) subEl.textContent = `${updated.tracks.length} ${updated.tracks.length === 1 ? 'canción' : 'canciones'}`;
        }
    } catch (e) { alert('No se pudo quitar: ' + e.message); }
}

// --- Add-to-playlist popover ----------------------------------------------
async function openAddToPlaylistMenu(trackId, anchor) {
    const popover = $('add-popover');
    popover.innerHTML = '';
    let lists;
    try { lists = await apiJson('/api/playlists'); }
    catch (e) { alert('Error: ' + e.message); return; }

    if (!lists.length) {
        const empty = document.createElement('div');
        empty.className = 'popover-empty';
        empty.textContent = 'Aún no tienes listas.';
        popover.appendChild(empty);
    } else {
        for (const pl of lists) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'popover-item';
            b.textContent = pl.name + ' (' + pl.trackCount + ')';
            b.addEventListener('click', () => addTrackToPlaylist(pl.id, trackId, popover));
            popover.appendChild(b);
        }
    }
    const div = document.createElement('div');
    div.className = 'popover-divider';
    popover.appendChild(div);
    const create = document.createElement('button');
    create.type = 'button';
    create.className = 'popover-item create';
    create.textContent = '+ Crear playlist…';
    create.addEventListener('click', async () => {
        hidePopover();
        const pl = await createPlaylistFlow(trackId);
        if (pl) $('status-bar').textContent = `Añadido a "${pl.name}"`;
    });
    popover.appendChild(create);

    // Position next to the anchor button.
    const rect = anchor.getBoundingClientRect();
    popover.style.top  = (rect.bottom + 4) + 'px';
    popover.style.left = Math.max(10, Math.min(rect.left, window.innerWidth - 240)) + 'px';
    popover.classList.remove('hidden');

    // Click outside or Esc to dismiss.
    setTimeout(() => {
        document.addEventListener('click', dismissOnOutside, { capture: true });
        document.addEventListener('keydown', dismissOnEsc);
    }, 0);
}

function dismissOnOutside(e) {
    const popover = $('add-popover');
    if (!popover.contains(e.target)) hidePopover();
}
function dismissOnEsc(e) { if (e.key === 'Escape') hidePopover(); }
function hidePopover() {
    $('add-popover').classList.add('hidden');
    document.removeEventListener('click', dismissOnOutside, { capture: true });
    document.removeEventListener('keydown', dismissOnEsc);
}

async function addTrackToPlaylist(playlistId, trackId, popover) {
    try {
        await apiJson('/api/playlists/' + playlistId + '/tracks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ trackId }),
        });
        playlistsCache = null;
        $('status-bar').textContent = 'Añadido a la playlist.';
    } catch (e) {
        alert('No se pudo añadir: ' + e.message);
    } finally {
        hidePopover();
    }
}

// --- Menu listeners (events from main process) -----------------------------
function setupMenuListeners() {
    window.api.on('scan:start', () => { $('status-bar').textContent = 'Escaneando…'; });
    window.api.on('scan:progress', (msg) => { $('status-bar').textContent = msg || ''; });
    window.api.on('scan:done', (report) => {
        if (report) {
            $('status-bar').textContent =
                `Biblioteca: ${report.scanned} nuevos · ${report.skipped} sin cambios · ${report.errors} errores`;
        }
        genres = null;  // invalidate caches that depend on tracks
        playlistsCache = null;
        refreshLibrary();
    });
    window.api.on('scan:error', (msg) => {
        $('status-bar').textContent = 'Error de escaneo: ' + (msg || '');
    });
    window.api.on('library:folder-changed', () => {
        $('status-bar').textContent = 'Carpeta cambiada, escaneando…';
    });
    window.api.on('auth:logged-out', async () => {
        try {
            await fetch(API_BASE + '/auth/logout', {
                method: 'POST',
                headers: { Authorization: 'Bearer ' + token },
            });
        } catch (_) {}
        token = null; username = null;
        closeDrawer();
        $('app-screen').classList.add('hidden');
        $('folder-screen').classList.add('hidden');
        $('login-screen').classList.remove('hidden');
        $('login-form').reset();
    });
}

// --- Color extraction (drawer dynamic background) -------------------------
async function dominantColor(imageUrl) {
    if (!imageUrl) return null;
    const corsUrl = imageUrl + (imageUrl.includes('?') ? '&' : '?') + '_cors=1';
    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => {
            try {
                const W = 32, H = 32;
                const c = document.createElement('canvas');
                c.width = W; c.height = H;
                const ctx = c.getContext('2d', { willReadFrequently: true });
                ctx.drawImage(img, 0, 0, W, H);
                const data = ctx.getImageData(0, 0, W, H).data;
                const buckets = new Map();
                for (let i = 0; i < data.length; i += 4) {
                    if (data[i + 3] < 128) continue;
                    const r = data[i] & 0xf0;
                    const g = data[i + 1] & 0xf0;
                    const b = data[i + 2] & 0xf0;
                    const k = (r << 16) | (g << 8) | b;
                    buckets.set(k, (buckets.get(k) || 0) + 1);
                }
                let bestK = -1, bestN = -1, fallbackK = -1, fallbackN = -1;
                for (const [k, n] of buckets) {
                    const r = (k >> 16) & 0xff, g = (k >> 8) & 0xff, b = k & 0xff;
                    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                    if (n > fallbackN) { fallbackN = n; fallbackK = k; }
                    if (lum < 28 || lum > 232) continue;
                    if (n > bestN) { bestN = n; bestK = k; }
                }
                const k = bestK >= 0 ? bestK : fallbackK;
                if (k < 0) return resolve(null);
                let r = (k >> 16) & 0xff, g = (k >> 8) & 0xff, b = k & 0xff;
                const MIN_LUM = 38;
                const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                if (lum < MIN_LUM) {
                    const lift = (MIN_LUM - lum) / 255 * 1.6;
                    r = Math.min(255, Math.round(r + (255 - r) * lift));
                    g = Math.min(255, Math.round(g + (255 - g) * lift));
                    b = Math.min(255, Math.round(b + (255 - b) * lift));
                }
                resolve(`rgb(${r}, ${g}, ${b})`);
            } catch (e) {
                resolve(null);
            }
        };
        img.onerror = () => resolve(null);
        img.src = corsUrl;
    });
}

function contrastText(rgbCss) {
    const m = rgbCss && rgbCss.match(/\d+/g);
    if (!m) return '#ffffff';
    const [r, g, b] = m.map(Number);
    const linear = (c) => { c = c / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
    const L = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
    return L > 0.45 ? '#0a0a0a' : '#ffffff';
}

// --- Helpers ---------------------------------------------------------------
function initials(s) {
    if (!s) return '';
    return s.trim().split(/\s+/).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join('');
}
function formatDuration(ms) {
    if (ms == null) return '—';
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function escapeHtml(s) {
    return String(s ?? '')
        .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
