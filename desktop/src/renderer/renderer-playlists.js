// renderer-playlists.js — CRUD de playlists, popover anadir a playlist,
// menu contextual del click derecho, subida de portadas, listeners del menu
// del proceso principal, extraccion de color de portadas, widget de estrellas.

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
        if (currentTabType() === 'playlists') renderPlaylistsTab();
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
        if (currentTabType() === 'playlists') {
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
        if (currentTabType() === 'playlists') renderPlaylistsTab();
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
                const refreshCtx = { kind: 'playlist', playlistId };
                updated.tracks.forEach((t, i) => tracksEl.appendChild(
                    buildTrackRow(t, i, updated.tracks, 'playlist', playlistId, refreshCtx)));
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

// --- Menú contextual (click derecho) --------------------------------------
// Un único menú reutilizable; el target decide qué opciones se muestran.
function setupContextMenu() {
    document.addEventListener('contextmenu', (e) => {
        const trackRow = e.target.closest('.drawer-track');
        if (trackRow && trackRow._track) {
            e.preventDefault();
            openContextMenu(e.clientX, e.clientY, [
                { label: 'Añadir a la cola',
                  onClick: () => addTrackToQueue(trackRow._track) },
            ]);
            return;
        }
        const card = e.target.closest('.album-card');
        if (card && card._playlist) {
            // Tarjeta de playlist — replica las acciones del drawer pero
            // accesibles directamente sin tener que abrirlo.
            e.preventDefault();
            const pl = card._playlist;
            openContextMenu(e.clientX, e.clientY, [
                { label: 'Reproducir',
                  onClick: () => playPlaylistById(pl.id) },
                { label: 'Renombrar',
                  onClick: () => promptRenamePlaylist(pl) },
                { label: 'Cambiar portada',
                  onClick: () => pickAndUploadPlaylistCover(pl.id, null) },
                { label: 'Eliminar',
                  onClick: () => deletePlaylistFlow(pl) },
            ]);
            return;
        }
        if (card && card._album) {
            e.preventDefault();
            openContextMenu(e.clientX, e.clientY, [
                { label: 'Añadir a la cola',
                  onClick: () => addAlbumToQueue(card._album) },
                { label: 'Ver más',
                  onClick: () => openOrFocusTab('album', {
                      albumId: card._album.id, title: card._album.titulo,
                  }) },
            ]);
        }
    });
}

// Reproduce todas las pistas de una playlist desde la primera. Pide /api/
// playlists/:id porque las tarjetas del grid sólo traen metadatos (sin la
// lista de tracks).
async function playPlaylistById(id) {
    try {
        const detail = await apiJson('/api/playlists/' + id);
        if (!detail.tracks || !detail.tracks.length) {
            $('status-bar').textContent = 'La playlist está vacía.';
            return;
        }
        const ctx = { kind: 'playlist', playlistId: id };
        playFromList(detail.tracks, 0, { lockFirst: false, context: ctx });
    } catch (e) {
        alert('No se pudo reproducir la playlist: ' + e.message);
    }
}

// Prompt simple para renombrar desde el menú contextual (sin abrir drawer).
function promptRenamePlaylist(pl) {
    const next = prompt('Nuevo nombre de la playlist:', pl.name || '');
    if (next == null) return;                  // canceló
    const trimmed = next.trim();
    if (!trimmed || trimmed === pl.name) return;
    renamePlaylist(pl.id, trimmed);
}

function openContextMenu(x, y, items) {
    const menu = $('context-menu');
    if (!menu) return;
    menu.innerHTML = '';
    for (const it of items) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'popover-item';
        b.textContent = it.label;
        b.addEventListener('click', () => {
            hideContextMenu();
            try { it.onClick(); } catch (err) { console.error(err); }
        });
        menu.appendChild(b);
    }
    // Pintamos primero para medir, luego ajustamos si se sale del viewport.
    menu.style.top = y + 'px';
    menu.style.left = x + 'px';
    menu.classList.remove('hidden');
    const rect = menu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 6;
    const maxY = window.innerHeight - rect.height - 6;
    menu.style.left = Math.max(6, Math.min(x, maxX)) + 'px';
    menu.style.top  = Math.max(6, Math.min(y, maxY)) + 'px';

    setTimeout(() => {
        document.addEventListener('click', dismissContextOnOutside, { capture: true });
        document.addEventListener('contextmenu', dismissContextOnOutside, { capture: true });
        document.addEventListener('keydown', dismissContextOnEsc);
        window.addEventListener('blur', hideContextMenu);
    }, 0);
}
function dismissContextOnOutside(e) {
    const menu = $('context-menu');
    if (!menu.contains(e.target)) hideContextMenu();
}
function dismissContextOnEsc(e) { if (e.key === 'Escape') hideContextMenu(); }
function hideContextMenu() {
    $('context-menu')?.classList.add('hidden');
    document.removeEventListener('click', dismissContextOnOutside, { capture: true });
    document.removeEventListener('contextmenu', dismissContextOnOutside, { capture: true });
    document.removeEventListener('keydown', dismissContextOnEsc);
    window.removeEventListener('blur', hideContextMenu);
}

function addTrackToQueue(track) {
    if (!track) return;
    if (!queue.length) {
        // Cola vacía: lo añadimos y arrancamos.
        queue = [track];
        queueIndex = 0;
        playTrack(queue[0]);
        renderQueuePanel();
        $('status-bar').textContent = `"${track.titulo}" en reproducción.`;
        return;
    }
    queue.push(track);
    renderQueuePanel();
    $('status-bar').textContent = `"${track.titulo}" añadido a la cola.`;
}

// --- Cambio de portada (playlists / géneros) ------------------------------
// Abre un selector de archivo; al elegir una imagen, la convierte en
// data-url, la manda al main process y refresca la UI.
function pickAndUploadPlaylistCover(playlistId, drawer) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            const dataUrl = await fileToDataUrl(file);
            const r = await window.api.savePlaylistCover(token, playlistId, dataUrl);
            $('status-bar').textContent = 'Portada actualizada.';
            // Refresca el drawer.
            if (drawer && drawer.isConnected) {
                const cur = playlistsCache?.find(p => p.id === playlistId);
                if (cur) cur.coverUrl = r.coverUrl;
                closeDrawer();
                renderPlaylistsTab();
            } else {
                renderPlaylistsTab();
            }
        } catch (e) { alert('No se pudo subir: ' + e.message); }
        document.body.removeChild(input);
    });
    document.body.appendChild(input);
    input.click();
}

async function clearPlaylistCover(playlistId, drawer) {
    if (!confirm('¿Quitar la portada personalizada?')) return;
    try {
        await window.api.savePlaylistCover(token, playlistId, null);
        $('status-bar').textContent = 'Portada eliminada.';
        closeDrawer();
        playlistsCache = null;
        renderPlaylistsTab();
    } catch (e) { alert('No se pudo eliminar: ' + e.message); }
}

function pickAndUploadGenreCover(genreName) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.style.display = 'none';
    input.addEventListener('change', async () => {
        const file = input.files?.[0];
        if (!file) return;
        try {
            const dataUrl = await fileToDataUrl(file);
            await window.api.saveGenreCover(token, genreName, dataUrl);
            $('status-bar').textContent = 'Portada del género actualizada.';
            closeDrawer();
            renderGenresTab();
        } catch (e) { alert('No se pudo subir: ' + e.message); }
        document.body.removeChild(input);
    });
    document.body.appendChild(input);
    input.click();
}

async function clearGenreCover(genreName) {
    if (!confirm('¿Quitar la portada personalizada?')) return;
    try {
        await window.api.saveGenreCover(token, genreName, null);
        $('status-bar').textContent = 'Portada eliminada.';
        closeDrawer();
        renderGenresTab();
    } catch (e) { alert('No se pudo eliminar: ' + e.message); }
}

function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('No se pudo leer el archivo'));
        r.readAsDataURL(file);
    });
}

async function addAlbumToQueue(album) {
    if (!album) return;
    let detail;
    try { detail = await apiJson('/api/albums/' + album.id); }
    catch (e) { alert('No se pudo cargar el álbum: ' + e.message); return; }
    const tracks = detail?.tracks || [];
    if (!tracks.length) return;
    for (const t of tracks) t._albumId = detail.id;
    if (!queue.length) {
        queue = tracks.slice();
        queueIndex = 0;
        playTrack(queue[0]);
        renderQueuePanel();
        $('status-bar').textContent = `Reproduciendo "${detail.titulo}".`;
        return;
    }
    queue.push(...tracks);
    renderQueuePanel();
    $('status-bar').textContent = `"${detail.titulo}" añadido a la cola (${tracks.length} pistas).`;
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
        allTracksCache = null;
        refreshLibrary();
    });
    window.api.on('scan:error', (msg) => {
        $('status-bar').textContent = 'Error de escaneo: ' + (msg || '');
    });
    window.api.on('library:folder-changed', () => {
        $('status-bar').textContent = 'Carpeta cambiada, escaneando…';
    });
    window.api.on('auth:logged-out', () => doLogout());

    // Botón "Cerrar sesión" del panel de Ajustes (primer item del panel).
    // Funciona también en la web — doLogout llama al endpoint /auth/logout
    // del servidor (vía API_BASE) y limpia el estado del renderer.
    document.getElementById('settings-logout')?.addEventListener('click', () => doLogout());
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

// --- Star rating widget ---------------------------------------------------
// Devuelve un <div.stars> con 5 estrellas. Si editable=true, cada estrella se
// divide en mitad-izq/mitad-der con paso 0.5; clic = nuevo valor; clic en el
// mismo valor = sin cambios (el botón "Quitar" del drawer se encarga de
// borrar). El elemento expone _setValue(v) para refrescarse desde fuera.
const STAR_PATH = 'M12 2.5l3.06 6.2 6.84.99-4.95 4.83 1.17 6.81L12 18.13 5.88 21.34 7.05 14.52 2.1 9.7l6.84-.99z';
const STAR_SVG_BG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="${STAR_PATH}"/></svg>`;
const STAR_SVG_FG = `<svg viewBox="0 0 24 24" fill="currentColor"><path d="${STAR_PATH}"/></svg>`;

function clampStar(v) {
    if (v == null || isNaN(v)) return 0;
    const n = Math.round(Number(v) * 2) / 2;
    return Math.max(0, Math.min(5, n));
}

function buildStars({ value, editable, onChange, variant }) {
    const wrap = document.createElement('div');
    wrap.className = 'stars'
        + (editable ? ' editable' : '')
        + (variant ? ' ' + variant : '');
    let displayed = clampStar(value);
    let preview = null;
    for (let i = 1; i <= 5; i++) {
        const star = document.createElement('span');
        star.className = 'star';
        star.dataset.idx = i;
        star.innerHTML =
            `<span class="star-bg">${STAR_SVG_BG}</span>` +
            `<span class="star-fg">${STAR_SVG_FG}</span>`;
        if (editable) {
            const valAt = (e) => {
                const r = star.getBoundingClientRect();
                const isHalf = (e.clientX - r.left) < r.width / 2;
                return i - (isHalf ? 0.5 : 0);
            };
            star.addEventListener('mousemove', (e) => { preview = valAt(e); render(); });
            star.addEventListener('mouseleave', () => { preview = null; render(); });
            star.addEventListener('click', (e) => {
                const v = valAt(e);
                displayed = v;
                preview = null;
                render();
                if (onChange) onChange(v);
            });
        }
        wrap.appendChild(star);
    }
    function render() {
        const v = preview != null ? preview : displayed;
        for (let i = 0; i < wrap.children.length; i++) {
            const star = wrap.children[i];
            const k = i + 1;
            const pct = v >= k ? 100 : v >= k - 0.5 ? 50 : 0;
            star.style.setProperty('--fill', pct + '%');
        }
    }
    render();
    wrap._setValue = (v) => { displayed = clampStar(v); render(); };
    wrap._getValue = () => displayed;
    return wrap;
}

// --- Album rating sync ----------------------------------------------------
let currentPlayingAlbumId = null;

// Valora una canción concreta. La valoración del álbum es la media de las
// valoraciones de sus canciones, así que tras actualizar guardamos en BD y
// recalculamos client-side el rating del álbum abierto + el del footer.
async function putTrackRating(trackId, rating) {
    try {
        if (rating == null || rating === 0) {
            const r = await apiCall('/api/tracks/' + trackId + '/rating', { method: 'DELETE' });
            if (!r.ok && r.status !== 204) throw new Error('HTTP ' + r.status);
            rating = null;
        } else {
            const j = await apiJson('/api/tracks/' + trackId + '/rating', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rating }),
            });
            rating = j.rating;
        }
        // Refleja el cambio en currentAlbum.tracks si es el álbum abierto.
        if (currentAlbum && Array.isArray(currentAlbum.tracks)) {
            const tr = currentAlbum.tracks.find(t => t.id === trackId);
            if (tr) tr.rating = rating;
        }
        // También en currentPlayingTrack para que el footer mantenga
        // el rating fresco si el track afectado es el que suena.
        if (currentPlayingTrack && currentPlayingTrack.id === trackId) {
            currentPlayingTrack.rating = rating;
        }
        // Sincroniza el widget del footer si la canción afectada es la
        // que suena ahora (la edición pudo venir de una fila del drawer).
        syncFooterRatingForTrack(trackId, rating);
        // Recalcular media del álbum y propagar a library + UI.
        recalcAlbumAverageAndSync(trackId);
    } catch (e) {
        alert('No se pudo guardar la valoración: ' + e.message);
    }
}

// Tras un rating de track, encuentra el álbum al que pertenece, calcula la
// media de las valoraciones de TODAS sus canciones (las que conozcamos en
// memoria) y propaga el nuevo valor a library.albums + footer + drawer.
function recalcAlbumAverageAndSync(trackId) {
    // Si el álbum abierto contiene este track, su lista de tracks es la
    // fuente de la media. Si no, intentamos localizar el álbum por el
    // metadata del track.
    let album = null, tracksInAlbum = null;
    if (currentAlbum && Array.isArray(currentAlbum.tracks)) {
        const t = currentAlbum.tracks.find(tt => tt.id === trackId);
        if (t) { album = currentAlbum; tracksInAlbum = currentAlbum.tracks; }
    }
    if (!album) {
        const inLib = (library.albums || []).find(a => a.id === currentPlayingAlbumId);
        if (inLib) album = inLib;
    }
    if (!tracksInAlbum) {
        // Sin lista en memoria — no podemos recalcular instantáneamente.
        // El próximo /api/library traerá la media correcta del servidor.
        return;
    }
    const rated = tracksInAlbum.map(t => t.rating).filter(r => r != null);
    const newAvg = rated.length ? Math.round((rated.reduce((s, x) => s + x, 0) / rated.length) * 2) / 2 : null;
    // Library cache.
    if (album.id != null) {
        const idx = (library.albums || []).findIndex(a => a.id === album.id);
        if (idx >= 0) {
            library.albums[idx].rating = newAvg;
            library.albums[idx].ratingCount = rated.length;
        }
    }
    if (currentAlbum && currentAlbum.id === album.id) {
        currentAlbum.rating = newAvg;
        currentAlbum.ratingCount = rated.length;
    }
    // Drawer: refresca el widget de media del álbum si está abierto.
    if (currentDrawer && currentDrawerKey === 'album:' + album.id) {
        const drawerStars = currentDrawer.querySelector('.drawer-rating .stars');
        if (drawerStars && drawerStars._setValue) drawerStars._setValue(newAvg || 0);
    }
    // Nota: el footer ya NO refleja la media del álbum — refleja el rating
    // de la canción concreta que suena. Ese widget se actualiza solo en
    // putTrackRating cuando el track afectado es el currentLikeTrackId.
}

// Sincroniza el widget del footer cuando el track afectado por una valoración
// es el que está sonando. Lo llamamos desde putTrackRating tras la API.
function syncFooterRatingForTrack(trackId, newRating) {
    if (currentLikeTrackId !== trackId) return;
    const wrap = $('np-rating');
    if (!wrap) return;
    const stars = wrap.querySelector('.stars');
    if (stars && stars._setValue) stars._setValue(newRating || 0);
}

async function putAlbumRating(albumId, rating) {
    try {
        let result;
        if (rating == null || rating === 0) {
            const r = await apiCall('/api/albums/' + albumId + '/rating', { method: 'DELETE' });
            if (!r.ok && r.status !== 204) throw new Error('HTTP ' + r.status);
            result = null;
        } else {
            const j = await apiJson('/api/albums/' + albumId + '/rating', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ rating }),
            });
            result = j.rating;
        }
        // Mantener library.albums + currentAlbum sincronizados.
        const albIdx = (library.albums || []).findIndex(a => a.id === albumId);
        if (albIdx >= 0) library.albums[albIdx].rating = result;
        if (currentAlbum && currentAlbum.id === albumId) currentAlbum.rating = result;
        // Reflejar en drawer abierto + footer si miran al mismo álbum.
        if (currentDrawer && currentDrawerKey === 'album:' + albumId) {
            const drawerStars = currentDrawer.querySelector('.drawer-rating .stars');
            if (drawerStars && drawerStars._setValue) drawerStars._setValue(result || 0);
            const clearBtn = currentDrawer.querySelector('.drawer-rating-clear');
            if (clearBtn) clearBtn.classList.toggle('hidden', !result);
        }
        if (currentPlayingAlbumId === albumId) {
            const fStars = $('np-rating')?.querySelector('.stars');
            if (fStars && fStars._setValue) fStars._setValue(result || 0);
        }
    } catch (e) {
        alert('No se pudo guardar la valoración: ' + e.message);
    }
}

function findAlbumByTrack(track) {
    if (!track) return null;
    const a  = (track.album   || '').toLowerCase().trim();
    const ar = (track.artista || '').toLowerCase().trim();
    if (!a) return null;
    return (library.albums || []).find(al => {
        const ta  = (al.titulo || '').toLowerCase().trim();
        const tar = (al.albumartist || al.artista || '').toLowerCase().trim();
        return ta === a && tar === ar;
    });
}

function refreshFooterRating() {
    const wrap = $('np-rating');
    if (!wrap) return;
    wrap.innerHTML = '';
    // Encuentra el track actual: si el drawer del álbum está abierto sus
    // tracks llevan rating actualizado en memoria. Si no, buscamos por
    // currentLikeTrackId (que se sincroniza en playTrack).
    const track = findCurrentPlayingTrack();
    if (!track) {
        wrap.classList.add('hidden');
        return;
    }
    wrap.classList.remove('hidden');
    // Editable y grande: el footer ahora valora la CANCIÓN ACTUAL. La
    // valoración del álbum sigue siendo derivada (AVG de sus canciones)
    // y se ve solo en el drawer del álbum.
    wrap.appendChild(buildStars({
        value: track.rating || 0,
        editable: true,
        variant: 'large',
        onChange: (v) => putTrackRating(track.id, v),
    }));
}

// Localiza el objeto track de la canción que está sonando ahora mismo,
// usando varias fuentes en orden:
//   1) currentAlbum.tracks si el drawer del álbum abierto contiene el track.
//   2) library lookup como último recurso (sin rating actualizado).
function findCurrentPlayingTrack() {
    // currentPlayingTrack lo setea playTrack — refleja la canción que suena
    // ahora mismo con su .rating cargado del backend.
    if (!currentPlayingTrack) return null;
    const id = currentPlayingTrack.id;
    // Si el álbum abierto contiene el track, usamos esa copia (su rating
    // está sincronizado tras putTrackRating). Si no, usamos el objeto que
    // playTrack guardó.
    if (currentAlbum && Array.isArray(currentAlbum.tracks)) {
        const t = currentAlbum.tracks.find(tt => tt.id === id);
        if (t) return t;
    }
    return currentPlayingTrack;
}

