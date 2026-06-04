// renderer-playback.js — drawers (album + playlist), motor de reproduccion,
// cola lateral y todo lo asociado al audio.

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
    // Marca cada track con el albumId para que el filtro de "no repetir
    // álbum" en appendRandomAlbum funcione desde el primer ciclo.
    for (const t of (detail.tracks || [])) t._albumId = detail.id;
    currentAlbum = detail;
    currentDrawerKey = 'album:' + album.id;

    const cover = coverUrlFor(detail.coverUrl);
    const subHtml = renderArtistMetaHtml(detail.artista)
        + (detail.year ? ` (${detail.year})` : '');
    const albumPlayCtx = { kind: 'album', albumId: detail.id, artistName: detail.albumartist || detail.artista };
    const drawer = renderDrawer({
        cover, title: detail.titulo,
        subHtml,
        actions: [{ label: 'Reproducir', icon: 'play', primary: true,
                    onClick: () => playFromList(detail.tracks, 0, { lockFirst: false, context: albumPlayCtx }) }],
        tracks: detail.tracks,
        trackContext: 'album',
        playContext: albumPlayCtx,
        ratingConfig: {
            value: detail.rating || 0,
            onChange: (newRating) => putAlbumRating(detail.id, newRating),
        },
    });
    drawer.addEventListener('click', (e) => {
        const artistEl = e.target.closest('.meta-artist');
        if (artistEl) { e.stopPropagation(); jumpToArtist(artistEl.dataset.artist); return; }
        // Click sobre la portada del drawer: saltamos a la vista detallada
        // del álbum (mismo destino que el segundo click en la card).
        const coverEl = e.target.closest('.drawer-cover');
        if (coverEl) {
            e.stopPropagation();
            openOrFocusTab('album', { albumId: detail.id, title: detail.titulo });
        }
    });
    // Indicar visualmente que la portada del drawer es clicable.
    const dCover = drawer.querySelector('.drawer-cover');
    if (dCover) {
        dCover.classList.add('clickable');
        dCover.setAttribute('title', 'Ver página del álbum');
    }
    insertDrawerAfterRow(cardEl, drawer);
    currentDrawer = drawer;
    paintDrawerColor(drawer, cover);
    drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

    // Top-3 tags MB en la cabecera del drawer. Async para no bloquear.
    fetchAndRenderAlbumDrawerTags(detail.id, drawer).catch(() => {});
}

async function fetchAndRenderAlbumDrawerTags(albumId, drawer) {
    if (!drawer || !drawer.isConnected) return;
    let info;
    try { info = await apiJson('/api/mb/album/' + albumId); }
    catch { return; }
    if (!drawer.isConnected) return;
    const tags = (info?.tags || []).slice(0, 3);
    if (!tags.length) return;
    const infoEl = drawer.querySelector('.drawer-info');
    if (!infoEl) return;
    // Si ya existe (re-render), lo reemplazamos.
    let strip = drawer.querySelector('.drawer-top-tags');
    if (!strip) {
        strip = document.createElement('div');
        strip.className = 'drawer-top-tags';
        const sub = infoEl.querySelector('.drawer-sub');
        if (sub && sub.nextSibling) infoEl.insertBefore(strip, sub.nextSibling);
        else infoEl.appendChild(strip);
    }
    strip.innerHTML = tags.map(t =>
        `<span class="tag-pill tag-pill-sm" title="${escapeHtml(t.name)} · ${t.count} votos">${escapeHtml(t.name)}</span>`
    ).join('');
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

    // Portada: si hay custom, úsala. Si no, usamos sampleCovers (deduplicadas
    // por álbum) para el collage.
    const cover = detail.coverUrl ? coverUrlFor(detail.coverUrl) : null;
    const collagePaths = detail.sampleCovers || [];

    const playlistCtx = { kind: 'playlist', playlistId: detail.id };
    const drawer = renderDrawer({
        cover,
        title: detail.name,
        sub: `${detail.tracks.length} ${detail.tracks.length === 1 ? 'canción' : 'canciones'}`,
        editableTitle: (newName) => renamePlaylist(detail.id, newName),
        actions: [
            { label: 'Reproducir', icon: 'play', primary: true,
              onClick: () => playFromList(detail.tracks, 0, { lockFirst: false, context: playlistCtx }) },
            { label: 'Renombrar', icon: 'edit', ghost: true,
              onClick: () => beginRenameInline(drawer) },
            { label: 'Cambiar portada', icon: 'edit', ghost: true,
              onClick: () => pickAndUploadPlaylistCover(detail.id, drawer) },
            ...(detail.coverUrl ? [{ label: 'Quitar portada', ghost: true,
              onClick: () => clearPlaylistCover(detail.id, drawer) }] : []),
            { label: 'Eliminar', icon: 'trash', ghost: true,
              onClick: () => deletePlaylistFlow(detail) },
        ],
        tracks: detail.tracks,
        trackContext: 'playlist',
        playlistId: detail.id,
        playContext: playlistCtx,
        collageFallbackPaths: cover ? null : collagePaths,
    });
    insertDrawerAfterRow(cardEl, drawer);
    currentDrawer = drawer;
    paintDrawerColor(drawer, cover);
    drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// --- Playlist virtual "Me Gusta" ------------------------------------------
// Idéntica al drawer de una playlist real, pero los tracks vienen de
// /api/me/liked y no se puede renombrar/borrar/cambiar portada.

async function openLikedSongs(cardEl) {
    const key = 'liked';
    if (currentDrawerKey === key) { closeDrawer(); return; }
    closeDrawer();
    let detail;
    try { detail = await apiJson('/api/me/liked'); }
    catch (err) {
        $('status-bar').textContent = 'Error abriendo Me Gusta: ' + err.message;
        return;
    }
    currentAlbum = { ...detail, name: 'Tus Me Gusta' };
    currentDrawerKey = key;
    cardEl.classList.add('active');

    const ctx = { kind: 'liked' };
    const drawer = renderDrawer({
        cover: null,
        title: 'Tus Me Gusta',
        sub: `${detail.tracks.length} ${detail.tracks.length === 1 ? 'canción' : 'canciones'}`,
        actions: [
            { label: 'Reproducir', icon: 'play', primary: true,
              onClick: () => detail.tracks.length && playFromList(detail.tracks, 0, { lockFirst: false, context: ctx }) },
        ],
        tracks: detail.tracks,
        trackContext: 'liked',
        playContext: ctx,
        collageFallbackPaths: detail.sampleCovers || [],
    });
    drawer.classList.add('drawer-liked');
    insertDrawerAfterRow(cardEl, drawer);
    currentDrawer = drawer;
    drawer.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Recarga el drawer "Me Gusta" si está abierto (tras un toggle desde el
// botón corazón del now-playing). Lo llamamos desde toggleLikeCurrent.
async function refreshLikedDrawer() {
    if (currentDrawerKey !== 'liked' || !currentDrawer) return;
    const cardEl = document.querySelector('.album-card.liked-card.active') || document.querySelector('.album-card.liked-card');
    if (!cardEl) return;
    // Cierra y vuelve a abrir conservando el card de origen.
    closeDrawer();
    await openLikedSongs(cardEl);
}

// --- Generic drawer renderer (works for albums + playlists) ---------------
function renderDrawer({ cover, title, sub, subHtml, actions, tracks, trackContext, playlistId, editableTitle, ratingConfig, playContext, collageFallbackPaths }) {
    const drawer = document.createElement('div');
    drawer.className = 'drawer';
    const subFinal = subHtml ?? escapeHtml(sub || '');
    // Si no hay portada custom pero sí una lista de paths para collage,
    // pintamos un mini-collage en el área de la portada.
    let coverHtml;
    if (cover) {
        coverHtml = '';
    } else if (collageFallbackPaths && collageFallbackPaths.length) {
        coverHtml = collageCoverHtml(collageFallbackPaths);
    } else {
        coverHtml = escapeHtml(initials(title));
    }
    drawer.innerHTML = `
        <button class="drawer-close" title="Cerrar" aria-label="Cerrar">×</button>
        <div class="drawer-cover" ${cover ? `style="background-image:url('${cover}')"` : ''}>
            ${coverHtml}
        </div>
        <div class="drawer-info">
            <h3 class="drawer-title">${escapeHtml(title || '')}</h3>
            <div class="drawer-sub">${subFinal}</div>
            <div class="drawer-actions"></div>
        </div>
        <div class="drawer-tracks"></div>
    `;
    const actionsEl = drawer.querySelector('.drawer-actions');

    // Rating del álbum (solo display, no editable). El valor es la media de
    // las valoraciones por canción del usuario — el usuario rate canciones
    // individuales en cada fila de tracks, no el álbum entero.
    if (ratingConfig) {
        const ratingDiv = document.createElement('div');
        ratingDiv.className = 'drawer-rating';
        const stars = buildStars({
            value: ratingConfig.value,
            editable: false,
            variant: 'large',
        });
        ratingDiv.appendChild(stars);
        drawer.querySelector('.drawer-info').insertBefore(ratingDiv, actionsEl);
    }

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
    (tracks || []).forEach((t, i) => tracksEl.appendChild(buildTrackRow(t, i, tracks, trackContext, playlistId, playContext)));
    drawer.querySelector('.drawer-close').addEventListener('click', closeDrawer);
    paintDrawerColor(drawer, '#1f1f1f');  // neutral until dominantColor returns
    return drawer;
}

function buildTrackRow(t, i, tracks, context, playlistId, playContext) {
    const row = document.createElement('div');
    row.className = 'drawer-track';
    row.dataset.trackId = t.id;
    row._track = t;  // referencia directa para el menú contextual
    const liked = likedTrackIds.has(t.id);
    // Estructura: num | title | estrellas | corazón | + / − | duración
    row.innerHTML = `
        <span class="num">${String(t.trackNo ?? (i + 1)).padStart(2, '0')}</span>
        <span class="title">${escapeHtml(t.titulo || '')}${
            context === 'playlist' && t.artista ? ` <span style="opacity:0.6">— ${escapeHtml(t.artista)}</span>` : ''
        }</span>
        <span class="row-rating-slot"></span>
        <button class="row-like" aria-pressed="${liked ? 'true' : 'false'}" title="${liked ? 'Quitar de Me Gusta' : 'Me gusta'}" aria-label="Me gusta">
            <svg class="like-outline ${liked ? 'hidden' : ''}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
            <svg class="like-filled ${liked ? '' : 'hidden'}" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/>
            </svg>
        </button>
        <button class="row-btn" title="${context === 'playlist' ? 'Quitar de la lista' : 'Añadir a lista'}">
            ${context === 'playlist' ? '−' : '+'}
        </button>
        <span class="dur">${formatDuration(t.durationMs)}</span>
    `;
    // Insertamos el widget de estrellas en el placeholder. Usa buildStars
    // (definido en renderer-playlists.js) con onChange que dispara la API.
    const ratingSlot = row.querySelector('.row-rating-slot');
    const starWidget = buildStars({
        value: t.rating || 0,
        editable: true,
        variant: 'tiny',
        onChange: (v) => putTrackRating(t.id, v),
    });
    starWidget.classList.add('row-rating');
    // Si el slot quedó en un nodo distinto al esperado, igualmente lo reemplazamos.
    if (ratingSlot) ratingSlot.replaceWith(starWidget);
    row.addEventListener('click', (e) => {
        if (e.target.closest('.row-btn') || e.target.closest('.row-like') || e.target.closest('.row-rating')) return;
        // Click en canción → lockFirst: la pulsada arranca sí o sí.
        playFromList(tracks, i, { lockFirst: true, context: playContext || null });
    });
    row.querySelector('.row-like').addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLikeForTrack(t.id);
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
let shuffleOn = false;

// Qué disparó la cola actual: condiciona qué se reproduce al final.
//   kind: 'album'  → al terminar, siguiente álbum del artista (o aleatorio si shuffle)
//   kind: 'artist' → al terminar, se para (la discografía ya se reprodujo entera)
//   kind: 'playlist' → al terminar, se para
let currentPlayContext = null;

// playFromList(tracks, index, opts)
//   opts.lockFirst (default true): el track en `index` arranca la cola sí o sí.
//     true  = el usuario clicó una canción concreta: queremos que esa suene
//             primero; con shuffle, el resto va mezclado detrás.
//     false = el usuario clicó "Reproducir" sobre un álbum/playlist/artista.
//             Aquí la regla depende del contexto:
//               - album: shuffle NO afecta dentro del álbum (queda en orden).
//               - artist/playlist: con shuffle ON se mezcla todo.
//   opts.context: se guarda en currentPlayContext para que fillQueueForMode
//     pueda decidir qué viene después.
// Tamaño objetivo de la cola cuando shuffle está activo y umbral para
// recargar. La regla del usuario: 200 canciones aleatorias por delante; en
// cuanto queden 100 por sonar, añadir otras 100.
const SHUFFLE_QUEUE_TARGET = 200;
const SHUFFLE_TOPUP_THRESHOLD = 100;
const SHUFFLE_TOPUP_BATCH = 100;

function playFromList(tracks, index, opts = {}) {
    if (!tracks || !tracks.length) return;
    const lockFirst = opts.lockFirst !== false;
    currentPlayContext = opts.context || null;

    const i = Math.max(0, Math.min(tracks.length - 1, Number(index) || 0));

    if (shuffleOn) {
        // Shuffle activo: la cola pasa a ser una lista aleatoria de toda la
        // biblioteca. Si el usuario clicó una canción concreta (lockFirst),
        // esa va al frente; si pulsó "Reproducir" sobre un álbum/artista/
        // playlist, el primer track es también aleatorio. Mientras llega la
        // biblioteca, arrancamos con lo que tenemos para no introducir un
        // pequeño retraso de audio.
        const seed = lockFirst ? tracks[i] : tracks[i];
        queue = [seed];
        queueIndex = 0;
        playTrack(queue[queueIndex]);
        renderQueuePanel();
        buildShuffleQueue(seed).catch(() => {});
        return;
    }

    queue = tracks.slice();
    queueIndex = i;
    playTrack(queue[queueIndex]);
    renderQueuePanel();
    // Si el modo es "Siguiente álbum del artista", precargamos el resto de
    // la discografía en orden alfabético (mismo flujo que al togglear el
    // dropdown). Sólo para contexto de álbum.
    if (queueMode === 'next-album' && currentPlayContext?.kind === 'album') {
        preQueueArtistDiscography().catch(() => {});
    }
}

// Construye una cola aleatoria de tamaño SHUFFLE_QUEUE_TARGET sacada de
// toda la biblioteca, con la canción `seed` al frente (o aleatoria pura si
// no hay seed). Se llama al pulsar play con shuffle activo y al togglear
// shuffle a ON mientras hay reproducción en curso.
async function buildShuffleQueue(seed = null) {
    const all = await ensureAllTracks();
    if (!all.length) { dbg('buildShuffleQueue: empty library'); return; }
    const pool = all.slice();
    shuffleInPlace(pool);
    const seedId = seed?.id;
    const filtered = seedId ? pool.filter(t => t.id !== seedId) : pool;
    const head = seed ? [seed] : [];
    const taken = head.concat(filtered.slice(0, SHUFFLE_QUEUE_TARGET - head.length));
    queue = taken;
    queueIndex = 0;
    dbg('buildShuffleQueue', { built: queue.length });
    renderQueuePanel();
}

// Top-up: cuando quedan ≤ SHUFFLE_TOPUP_THRESHOLD canciones por sonar,
// añade SHUFFLE_TOPUP_BATCH más, evitando repetir lo que ya está en la cola.
async function ensureShuffleQueueTopup() {
    if (!shuffleOn) return;
    const remaining = queue.length - queueIndex - 1;
    if (remaining > SHUFFLE_TOPUP_THRESHOLD) return;
    const all = await ensureAllTracks();
    if (!all.length) return;
    const inQueue = new Set(queue.map(t => t.id));
    let candidates = all.filter(t => !inQueue.has(t.id));
    // Si la biblioteca es más pequeña que la cola, recicla aceptando
    // duplicados — peor eso que silencio.
    if (candidates.length < SHUFFLE_TOPUP_BATCH) candidates = all.slice();
    shuffleInPlace(candidates);
    queue.push(...candidates.slice(0, SHUFFLE_TOPUP_BATCH));
    dbg('topup', { added: SHUFFLE_TOPUP_BATCH, queueLen: queue.length });
    renderQueuePanel();
}

function playTrack(track) {
    currentPlayingTrack = track || null;
    const audio = $('audio');
    // <audio src> no acepta headers, hostId va como ?h= (multi-host fase 4).
    let streamUrl = API_BASE + '/stream/' + track.id + '?t=' + encodeURIComponent(token);
    if (window.NB_HOST_ID) streamUrl += '&h=' + encodeURIComponent(window.NB_HOST_ID);
    audio.src = streamUrl;
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
    // Footer rating: localiza el álbum del track en library.albums y refresca.
    const matchedAlbum = findAlbumByTrack(track);
    currentPlayingAlbumId = matchedAlbum ? matchedAlbum.id : null;
    refreshFooterRating();
    // Tracker de tiempo escuchado: cambia el contexto (track + artista).
    setListenContext(track);
    // Tracker de scrobble: arranca el timing del track recién puesto. Si el
    // anterior cumplía el umbral, se scrobblea aquí mismo.
    startScrobbleForTrack(track);
    // Re-pinta la cola para mover el indicador "playing".
    renderQueuePanel();
    // Refresca el estado del botón corazón al track actual.
    refreshLikeButton(track.id);
    // Top-up de la cola aleatoria cuando se acerca al final.
    if (shuffleOn) ensureShuffleQueueTopup().catch(() => {});
}

// --- Me Gusta -------------------------------------------------------------
// likedTrackIds vive en renderer-state.js. Aquí está la maquinaria que
// (a) trae el Set inicial al login, (b) pinta el botón, (c) maneja el toggle
// con actualización optimista + revert si la API rechaza.

let currentLikeTrackId = null;     // track id que el corazón representa ahora

async function loadLikedTrackIds() {
    try {
        const r = await apiJson('/api/me/liked-ids');
        likedTrackIds = new Set((r?.ids || []).map(Number).filter(Number.isFinite));
        refreshLikeButton(currentLikeTrackId);
    } catch (e) {
        console.warn('[liked] no se pudo cargar liked-ids:', e?.message);
    }
}

function refreshLikeButton(trackId) {
    currentLikeTrackId = Number.isFinite(Number(trackId)) ? Number(trackId) : null;
    const btn = $('btn-like');
    const addBtn = $('btn-np-add');
    if (addBtn) addBtn.disabled = currentLikeTrackId == null;
    if (!btn) return;
    if (currentLikeTrackId == null) {
        btn.setAttribute('aria-pressed', 'false');
        btn.disabled = true;
        $('icon-like-outline')?.classList.remove('hidden');
        $('icon-like-filled')?.classList.add('hidden');
        return;
    }
    btn.disabled = false;
    const liked = likedTrackIds.has(currentLikeTrackId);
    btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
    btn.title = liked ? 'Quitar de Me Gusta' : 'Añadir a Me Gusta';
    $('icon-like-outline')?.classList.toggle('hidden', liked);
    $('icon-like-filled')?.classList.toggle('hidden', !liked);
}

// Toggle del like sobre un track id concreto. Lo usa tanto el corazón del
// now-playing (sobre currentLikeTrackId) como los corazones de cada
// .drawer-track del drawer. Actualización optimista en todos los lugares
// visuales relevantes y revert si la API falla.
async function toggleLikeForTrack(id) {
    id = Number(id);
    if (!Number.isFinite(id)) return;
    const wasLiked = likedTrackIds.has(id);
    if (wasLiked) likedTrackIds.delete(id); else likedTrackIds.add(id);
    if (currentLikeTrackId === id) refreshLikeButton(id);
    refreshRowLikeButtons(id, !wasLiked);
    refreshLikedCardCount();
    try {
        const r = await apiCall('/api/tracks/' + id + '/like', {
            method: wasLiked ? 'DELETE' : 'POST',
        });
        if (!r.ok && r.status !== 204) throw new Error('HTTP ' + r.status);
        // Si está abierto el drawer de Me Gusta, hay que refrescar contenido
        // (las filas del drawer SÍ cambian de lista). Para los demás drawers
        // basta con el toggle visual del corazón en su sitio.
        if (currentDrawerKey === 'liked' && typeof refreshLikedDrawer === 'function') {
            refreshLikedDrawer().catch(() => {});
        }
    } catch (e) {
        // Revert local + visual.
        if (wasLiked) likedTrackIds.add(id); else likedTrackIds.delete(id);
        if (currentLikeTrackId === id) refreshLikeButton(id);
        refreshRowLikeButtons(id, wasLiked);
        refreshLikedCardCount();
        console.warn('[liked] toggle failed:', e?.message);
    }
}

// Sincroniza visualmente el corazón en CUALQUIER .drawer-track del DOM que
// represente al trackId dado — pueden ser varios si el track está en varias
// playlists abiertas al mismo tiempo (caso edge).
function refreshRowLikeButtons(trackId, liked) {
    document.querySelectorAll(`.drawer-track[data-track-id="${trackId}"] .row-like`).forEach(btn => {
        btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
        btn.title = liked ? 'Quitar de Me Gusta' : 'Me gusta';
        btn.querySelector('.like-outline')?.classList.toggle('hidden', liked);
        btn.querySelector('.like-filled')?.classList.toggle('hidden', !liked);
    });
}

// Actualiza el meta-contador "N canciones" del card "Tus Me Gusta" en la
// pestaña Listas si está pintado.
function refreshLikedCardCount() {
    const meta = document.querySelector('.album-card.liked-card .album-meta');
    if (!meta) return;
    const n = likedTrackIds.size;
    meta.textContent = `${n} ${n === 1 ? 'canción' : 'canciones'}`;
}

function setupLikeButton() {
    $('btn-like')?.addEventListener('click', () => {
        if (currentLikeTrackId != null) toggleLikeForTrack(currentLikeTrackId);
    });
    // Botón "+" del now-playing: añade la canción actual a una playlist
    // mediante el popover existente, anclado al propio botón.
    $('btn-np-add')?.addEventListener('click', (e) => {
        if (currentLikeTrackId == null) return;
        openAddToPlaylistMenu(currentLikeTrackId, e.currentTarget);
    });
    refreshLikeButton(null);
}

function setupAudioControls() {
    const audio = $('audio');
    if (!audio) return;

    $('btn-prev')?.addEventListener('click', () => {
        if (!queue.length) return;
        queueIndex = (queueIndex - 1 + queue.length) % queue.length;
        playTrack(queue[queueIndex]);
    });
    $('btn-next')?.addEventListener('click', async () => {
        if (!queue.length) return;
        // Si estamos en el último track de la cola, NO envolvemos al
        // principio: aplicamos el mismo flujo que cuando el track acaba
        // de forma natural (fillQueueForMode → shuffle ⇒ álbum aleatorio).
        if (queueIndex >= queue.length - 1) {
            dbg('btn-next at end', { queueIndex, queueLen: queue.length });
            await fillQueueForMode();
            return;
        }
        queueIndex++;
        playTrack(queue[queueIndex]);
    });
    $('btn-play')?.addEventListener('click', () => {
        if (!audio.src) return;
        if (audio.paused) audio.play().catch(() => {});
        else audio.pause();
    });
    $('btn-back10')?.addEventListener('click', () => {
        if (!audio.src || !isFinite(audio.duration)) return;
        audio.currentTime = Math.max(0, audio.currentTime - 10);
    });
    $('btn-fwd10')?.addEventListener('click', () => {
        if (!audio.src || !isFinite(audio.duration)) return;
        audio.currentTime = Math.min(audio.duration, audio.currentTime + 10);
    });

    const reflectPlayState = () => {
        const playing = !audio.paused && !audio.ended && audio.src;
        $('icon-play')?.classList.toggle('hidden', playing);
        $('icon-pause')?.classList.toggle('hidden', !playing);
        $('btn-play')?.setAttribute('title', playing ? 'Pausa' : 'Reproducir');
    };
    audio.addEventListener('play', reflectPlayState);
    audio.addEventListener('pause', reflectPlayState);
    audio.addEventListener('ended', reflectPlayState);

    const seek = $('np-seek');
    let seeking = false;
    const updateSeekFill = () => {
        if (!seek) return;
        const pct = (Number(seek.value) / Number(seek.max)) * 100;
        seek.style.setProperty('--p', pct + '%');
    };
    seek?.addEventListener('input', () => { seeking = true; updateSeekFill(); });
    seek?.addEventListener('change', () => {
        if (!isFinite(audio.duration)) { seeking = false; return; }
        audio.currentTime = (Number(seek.value) / 1000) * audio.duration;
        seeking = false;
    });
    audio.addEventListener('timeupdate', () => {
        if (!isFinite(audio.duration)) return;
        if (!seeking && seek) {
            seek.value = String(Math.round((audio.currentTime / audio.duration) * 1000));
            updateSeekFill();
        }
        const cur = $('np-time-cur'); if (cur) cur.textContent = formatSec(audio.currentTime);
    });
    audio.addEventListener('loadedmetadata', () => {
        const tot = $('np-time-tot'); if (tot) tot.textContent = formatSec(audio.duration);
    });

    const vol = $('np-vol');
    let lastNonZeroVol = 100;

    // Aplica un volumen, refleja el slider y persiste. Es la única vía de
    // cambiar el volumen — no se usa audio.muted (la "mute" se modela como
    // "vol = 0" para que la barra baje visualmente al silenciar).
    const setVol = (v, opts = {}) => {
        v = Math.max(0, Math.min(100, Number(v) || 0));
        audio.volume = v / 100;
        audio.muted = false;
        if (vol) vol.value = String(v);
        if (v > 0) lastNonZeroVol = v;
        if (opts.persist !== false) localStorage.setItem('nobreak-vol', String(v));
        updateMuteIcon();
    };

    const updateMuteIcon = () => {
        const off = audio.volume === 0 || audio.muted;
        $('icon-vol-on')?.classList.toggle('hidden', off);
        $('icon-vol-off')?.classList.toggle('hidden', !off);
        $('btn-mute')?.classList.toggle('muted', off);
        $('btn-mute')?.setAttribute('title', off ? 'Quitar silencio' : 'Silenciar');
        $('btn-mute')?.setAttribute('aria-label', off ? 'Quitar silencio' : 'Silenciar');
    };

    const savedVol = Number(localStorage.getItem('nobreak-vol'));
    if (isFinite(savedVol) && savedVol >= 0 && savedVol <= 100) {
        setVol(savedVol, { persist: false });
    } else {
        updateMuteIcon();
    }

    vol?.addEventListener('input', () => setVol(vol.value));

    // Click en el icono: alterna entre 0 y el último volumen audible. La barra
    // baja a 0 visualmente al silenciar y vuelve a su sitio al desmutear.
    $('btn-mute')?.addEventListener('click', () => {
        if (audio.volume === 0) {
            setVol(lastNonZeroVol > 0 ? lastNonZeroVol : 50);
        } else {
            setVol(0);
        }
    });

    audio.addEventListener('volumechange', updateMuteIcon);

    // Botón "aleatorio". Cuando está activo, las próximas listas que se
    // pongan en marcha (álbumes, playlists) se mezclarán en playFromList.
    shuffleOn = localStorage.getItem('nobreak-shuffle') === '1';
    const updateShuffleBtn = () => {
        const btn = $('btn-shuffle');
        if (!btn) return;
        btn.classList.toggle('active', shuffleOn);
        btn.setAttribute('aria-pressed', shuffleOn ? 'true' : 'false');
        btn.setAttribute('title', shuffleOn ? 'Aleatorio activado' : 'Aleatorio desactivado');
    };
    updateShuffleBtn();
    $('btn-shuffle')?.addEventListener('click', () => {
        shuffleOn = !shuffleOn;
        localStorage.setItem('nobreak-shuffle', shuffleOn ? '1' : '0');
        updateShuffleBtn();
        // Al activar shuffle: la regla del usuario es "cola aleatoria de 200
        // canciones". Mantenemos el track actual al frente y reconstruimos
        // el resto a partir de la biblioteca.
        if (shuffleOn) {
            const current = queue[queueIndex];
            if (current) buildShuffleQueue(current).catch(() => {});
            else         buildShuffleQueue(null).catch(() => {});
        }
    });

    audio.addEventListener('ended', async () => {
        dbg('audio ended', { queueLen: queue.length, queueIndex, shuffleOn, queueMode });
        if (!queue.length) return;

        // Modo "repeat-album": cuando termina la última pista del álbum
        // que está sonando, volvemos a su primera pista (no saltamos al
        // siguiente álbum aunque la cola siga teniendo).
        if (!shuffleOn && queueMode === 'repeat-album') {
            const curAlbumId = queue[queueIndex]?._albumId;
            const next = queue[queueIndex + 1];
            const isLastOfAlbum = !next || next._albumId !== curAlbumId;
            if (isLastOfAlbum && curAlbumId != null) {
                const firstIdx = queue.findIndex(t => t._albumId === curAlbumId);
                if (firstIdx >= 0) {
                    queueIndex = firstIdx;
                    playTrack(queue[queueIndex]);
                    return;
                }
            }
        }

        if (queueIndex < queue.length - 1) {
            queueIndex++;
            playTrack(queue[queueIndex]);
            return;
        }
        // Final de la cola: aplicamos el modo elegido por el usuario.
        await fillQueueForMode();
    });
}

// --- Cola de reproducción (panel lateral) -------------------------------
let queueMode = 'next-album';
let queuePanelOpen = false;
let allTracksCache = null;     // cache plano de /api/tracks para artist/random

const QUEUE_MODES = new Set(['stop', 'next-album', 'repeat-album']);

function setupQueuePanel() {
    queueMode = localStorage.getItem('nobreak-queue-mode') || 'next-album';
    if (!QUEUE_MODES.has(queueMode)) queueMode = 'next-album';
    queuePanelOpen = localStorage.getItem('nobreak-queue-open') === '1';
    const sel = $('queue-mode');
    if (sel) {
        sel.value = queueMode;
        sel.addEventListener('change', () => {
            queueMode = sel.value;
            localStorage.setItem('nobreak-queue-mode', queueMode);
            dbg('queueMode change', { queueMode, shuffleOn, kind: currentPlayContext?.kind });
            applyQueueModeChange();
        });
    }
    $('btn-queue')?.addEventListener('click', () => toggleQueuePanel());
    $('queue-close')?.addEventListener('click', () => toggleQueuePanel(false));
    $('queue-clear')?.addEventListener('click', () => clearQueue());

    // Estado "anclada" desde Ajustes.
    const pinnedStored = localStorage.getItem('nobreak-queue-pinned') === '1';
    if (pinnedStored) $('app-screen')?.classList.add('queue-pinned');
    syncQueuePinnedToggle();
    $('settings-queue-pinned')?.addEventListener('click', () => {
        const isPinned = $('app-screen')?.classList.contains('queue-pinned');
        setQueuePinned(!isPinned);
    });

    applyQueuePanelOpen();
    setupQueueResize();
    renderQueuePanel();
}

// Redimensionado del panel mediante un handle vertical en su borde izquierdo.
// El ancho se guarda en la CSS var --queue-width y se persiste en localStorage.
// Constrained a [240, min(800, viewport*0.6)] — por debajo se pierde el listado
// y por encima invade el contenido principal.
function setupQueueResize() {
    const panel = $('queue-panel');
    if (!panel) return;
    if (!panel.querySelector('.queue-resize-handle')) {
        const handle = document.createElement('div');
        handle.className = 'queue-resize-handle';
        handle.id = 'queue-resize-handle';
        handle.setAttribute('role', 'separator');
        handle.setAttribute('aria-orientation', 'vertical');
        handle.title = 'Arrastra para redimensionar la cola';
        panel.insertBefore(handle, panel.firstChild);
    }

    const stored = Number(localStorage.getItem('nobreak-queue-width-px'));
    applyQueueWidth(Number.isFinite(stored) && stored > 0 ? stored : 340);

    const handle = $('queue-resize-handle');
    handle?.addEventListener('mousedown', (e) => {
        e.preventDefault();
        panel.classList.add('resizing');
        const prevSelect = document.body.style.userSelect;
        const prevCursor = document.body.style.cursor;
        document.body.style.userSelect = 'none';
        document.body.style.cursor = 'ew-resize';

        const onMove = (ev) => {
            // El panel está pegado al borde derecho del viewport. Ancho =
            // distancia entre el ratón y ese borde.
            const w = window.innerWidth - ev.clientX;
            applyQueueWidth(w);
        };
        const onUp = () => {
            panel.classList.remove('resizing');
            document.body.style.userSelect = prevSelect;
            document.body.style.cursor = prevCursor;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            const cur = parseInt(panel.style.getPropertyValue('--queue-width'), 10) || 340;
            localStorage.setItem('nobreak-queue-width-px', String(cur));
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    });
}

function applyQueueWidth(px) {
    const panel = $('queue-panel');
    if (!panel) return;
    // Mínimo bajo a propósito: el título y el subtítulo envuelven a varias
    // líneas en vez de cortarse con ellipsis, así que un panel muy estrecho
    // sigue siendo legible. Por debajo de 120 px el handle (8 px) y la
    // sombra ocupan casi todo, así que paramos ahí.
    const min = 120;
    const max = Math.min(800, Math.floor(window.innerWidth * 0.6));
    const w = Math.max(min, Math.min(max, Math.round(Number(px) || 0)));
    panel.style.setProperty('--queue-width', w + 'px');
}

function toggleQueuePanel(force) {
    queuePanelOpen = typeof force === 'boolean' ? force : !queuePanelOpen;
    localStorage.setItem('nobreak-queue-open', queuePanelOpen ? '1' : '0');
    applyQueuePanelOpen();
}

function applyQueuePanelOpen() {
    const panel = $('queue-panel');
    const btn = $('btn-queue');
    if (!panel) return;
    const pinned = $('app-screen')?.classList.contains('queue-pinned');
    const visible = pinned || queuePanelOpen;
    panel.classList.toggle('open', visible);
    panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
    btn?.setAttribute('aria-expanded', visible ? 'true' : 'false');
}

// Anclar/desanclar la cola (toggle desde Ajustes). Persiste en localStorage.
function setQueuePinned(pinned) {
    const screen = $('app-screen');
    if (!screen) return;
    screen.classList.toggle('queue-pinned', !!pinned);
    localStorage.setItem('nobreak-queue-pinned', pinned ? '1' : '0');
    applyQueuePanelOpen();
    syncQueuePinnedToggle();
}
function syncQueuePinnedToggle() {
    const pinned = $('app-screen')?.classList.contains('queue-pinned');
    const btn = $('settings-queue-pinned');
    if (btn) {
        btn.setAttribute('aria-pressed', pinned ? 'true' : 'false');
        const label = $('settings-queue-pinned-label');
        if (label) label.textContent = pinned ? 'On' : 'Off';
    }
}

// Vacía la cola: para la reproducción, limpia el reproductor y borra el
// contexto. No toca el modo de cola ni las preferencias.
function clearQueue() {
    const audio = $('audio');
    if (audio) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
    }
    queue = [];
    queueIndex = 0;
    currentPlayContext = null;
    currentAlbum = null;
    currentPlayingAlbumId = null;
    $('np-title').textContent = 'Selecciona una canción';
    $('np-meta').textContent = '';
    $('np-cover').style.backgroundImage = '';
    if (currentDrawer) {
        currentDrawer.querySelectorAll('.drawer-track.playing')
            .forEach(el => el.classList.remove('playing'));
    }
    refreshFooterRating();
    renderQueuePanel();
    $('status-bar').textContent = 'Cola vaciada.';
}

function renderQueuePanel() {
    const list = $('queue-list');
    if (!list) return;
    list.innerHTML = '';
    if (!queue.length) {
        list.innerHTML = '<li class="queue-empty">Aún no hay canciones en la cola. Reproduce un álbum o playlist para empezar.</li>';
        return;
    }
    // Etiqueta para "Reproduciendo ahora"
    const nowLabel = document.createElement('li');
    nowLabel.className = 'queue-section-label';
    nowLabel.textContent = 'Reproduciendo ahora';
    list.appendChild(nowLabel);
    list.appendChild(buildQueueItem(queue[queueIndex], queueIndex, true));
    // Y la sección "Siguientes"
    if (queueIndex < queue.length - 1) {
        const nextLabel = document.createElement('li');
        nextLabel.className = 'queue-section-label';
        nextLabel.textContent = 'Siguientes';
        list.appendChild(nextLabel);
        for (let i = queueIndex + 1; i < queue.length; i++) {
            list.appendChild(buildQueueItem(queue[i], i, false));
        }
    }
}

function buildQueueItem(track, idx, playing) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'queue-item' + (playing ? ' playing' : '');
    const cover = track.coverUrl ? coverUrlFor(track.coverUrl) : null;
    btn.innerHTML = `
        <span class="queue-item-num">${idx + 1}</span>
        <span class="queue-item-cover" ${cover ? `style="background-image:url('${cover}')"` : ''}></span>
        <span class="queue-item-meta">
            <span class="queue-item-title">${escapeHtml(track.titulo || '')}</span>
            <span class="queue-item-sub">${escapeHtml(track.artista || '')}${track.album ? ' · ' + escapeHtml(track.album) : ''}</span>
        </span>
        <span class="queue-item-dur">${escapeHtml(formatDuration(track.durationMs))}</span>
    `;
    btn.addEventListener('click', () => {
        queueIndex = idx;
        playTrack(queue[idx]);
        renderQueuePanel();
    });
    li.appendChild(btn);
    return li;
}

async function ensureAllTracks() {
    if (allTracksCache) return allTracksCache;
    try {
        allTracksCache = await apiJson('/api/tracks');
    } catch {
        allTracksCache = [];
    }
    return allTracksCache;
}

// Llamada cuando el último track de la cola termina. El "modo" decide qué
// hacer: detenerse, repetir el álbum, seguir con el mismo artista, o tirar
// de la biblioteca aleatoriamente.
async function fillQueueForMode() {
    if (!queue.length) return;
    const kind = currentPlayContext?.kind;
    dbg('fillQueueForMode', { shuffleOn, kind, queueMode, queueLen: queue.length, queueIndex,
        currentAlbumId: currentPlayContext?.albumId,
        libraryAlbumCount: (library.albums || []).length });

    // Shuffle ON: si por algún motivo (biblioteca pequeña) hemos llegado al
    // final de la cola, recargamos con un batch nuevo. Lo normal es que el
    // top-up proactivo (en playTrack) lo evite.
    if (shuffleOn) {
        await ensureShuffleQueueTopup();
        // Si después del top-up sigue habiendo más cola, avanza.
        if (queueIndex < queue.length - 1) {
            queueIndex++;
            playTrack(queue[queueIndex]);
        }
        return;
    }

    // Sin shuffle: aplica el queueMode elegido por el usuario.
    // - stop: silencio.
    // - repeat-album: el handler de `audio.ended` reinicia el álbum cuando
    //   detecta el último track del álbum actual; aquí no hay nada que hacer.
    // - next-album: la cola ya está pre-cargada con toda la discografía en
    //   orden alfabético, así que el final de la cola es realmente "fin".
    return;
}

// Modo 'next-album': cuando se acaba el álbum, busca el siguiente álbum del
// mismo artista (en el orden devuelto por /api/artists/:id/albums) y lo
// añade a la cola. Devuelve false si no hay álbum siguiente.
// Devuelve los album.id ya presentes en la cola actual. Los tracks añadidos
// por playFromList/continueWithNextAlbum/appendRandomAlbum llevan _albumId,
// pero el primer track del primer álbum puede no llevarlo (si arrancó antes
// de marcarlo); tiramos del currentPlayContext.albumId como respaldo.
function albumIdsInQueue() {
    const ids = new Set();
    for (const t of queue) {
        if (t._albumId) ids.add(t._albumId);
    }
    if (currentPlayContext?.albumId) ids.add(currentPlayContext.albumId);
    return ids;
}

// Carga toda la discografía del artista del contexto actual y la añade a
// la cola en orden alfabético (excluyendo álbumes que ya estén dentro).
// Se usa al activar el modo "Siguiente álbum del artista" para que las
// pistas siguientes aparezcan inmediatamente en el panel "Siguientes".
async function preQueueArtistDiscography() {
    const ctx = currentPlayContext;
    if (!ctx || ctx.kind !== 'album') return;
    const rawName = ctx.artistName;
    if (!rawName) return;

    // Para colaboraciones ("A & B"), el nombre completo no existe como
    // artista en la biblioteca (los hemos splitado). Probamos primero el
    // nombre tal cual y, si no aparece, cada componente por orden.
    const candidates = [rawName, ...splitArtistParts(rawName).map(p => p.name)];
    let target = null;
    for (const name of candidates) {
        target = (library.artists || []).find(a =>
            (a.nombre || '').toLowerCase() === name.toLowerCase());
        if (target) break;
    }
    if (!target) { dbg('preQueueArtistDiscography: artista no en biblioteca', { rawName, tried: candidates }); return; }
    const artistName = target.nombre;

    let data;
    try {
        data = await apiJson('/api/artists/' + target.id + '/albums'
            + '?name=' + encodeURIComponent(target.nombre || artistName));
    } catch (e) { dbg('preQueueArtistDiscography fetch failed', { err: e.message }); return; }

    const albums = (data?.albums || []).slice();
    albums.sort((a, b) => (a.titulo || '').localeCompare(b.titulo || '',
        undefined, { sensitivity: 'base' }));

    const inQueue = new Set();
    for (const t of queue) if (t._albumId) inQueue.add(t._albumId);
    if (ctx.albumId) inQueue.add(ctx.albumId);

    const toAdd = albums.filter(a => !inQueue.has(a.id));
    if (!toAdd.length) return;

    dbg('preQueueArtistDiscography', { artist: artistName, candidates: toAdd.length });
    // Lanzamos las peticiones en paralelo (son locales y baratas).
    const details = await Promise.all(toAdd.map(a =>
        apiJson('/api/albums/' + a.id).catch(() => null)));
    for (let i = 0; i < details.length; i++) {
        const d = details[i];
        if (!d?.tracks?.length) continue;
        for (const t of d.tracks) t._albumId = toAdd[i].id;
        queue.push(...d.tracks);
    }
    renderQueuePanel();
}

// Aplica el modo de cola elegido al estado actual:
// - stop / repeat-album: recorta la cola al álbum que suena ahora (limpia
//   álbumes pre-cargados que sobren).
// - next-album: pre-carga la discografía del artista en orden alfabético.
//   Funciona también desde el contexto "artist" (Reproducir del artista),
//   asumiendo el álbum que toca ahora como referencia.
async function applyQueueModeChange() {
    if (!queue.length || shuffleOn) return;
    if (queueMode === 'stop' || queueMode === 'repeat-album') {
        trimQueueToCurrentAlbum();
        return;
    }
    if (queueMode === 'next-album') {
        // Determina el álbum de la pista actual. Si no tenía _albumId,
        // lo buscamos en library.albums por (titulo, albumartist).
        const cur = queue[queueIndex];
        if (!cur) return;
        let albumId = cur._albumId;
        if (albumId == null) {
            const k = (cur.album || '').toLowerCase().trim();
            const ar = (cur.artista || '').toLowerCase().trim();
            const match = (library.albums || []).find(a =>
                (a.titulo || '').toLowerCase().trim() === k &&
                (a.albumartist || a.artista || '').toLowerCase().trim() === ar);
            if (match) albumId = match.id;
        }
        // Ajustamos el contexto para que preQueue lo lea correctamente.
        const artistName = currentPlayContext?.artistName
            || cur.artista
            || '';
        currentPlayContext = {
            kind: 'album',
            albumId: albumId || null,
            artistName,
        };
        // Primero recorta para tener un punto limpio, luego pre-carga el resto.
        trimQueueToCurrentAlbum();
        preQueueArtistDiscography().catch(() => {});
        return;
    }
}

// Clave para identificar "el mismo álbum" de un track, robusta a tracks
// sin _albumId (los que vienen del play-artista o de búsqueda).
function albumKeyForTrack(t) {
    if (!t) return null;
    if (t._albumId != null) return 'id:' + t._albumId;
    return 'kv:' + (t.album || '').toLowerCase().trim()
              + '\x1f' + (t.artista || '').toLowerCase().trim();
}

// Recorta la cola dejando sólo las pistas del álbum que está sonando ahora.
// Lo usan los modos 'stop' y 'repeat-album': si la cola se había pre-llenado
// con toda la discografía (modo next-album), al cambiar de modo el usuario
// no quiere ver el resto colgando del panel "Siguientes".
function trimQueueToCurrentAlbum() {
    const cur = queue[queueIndex];
    if (!cur) return;
    const targetKey = albumKeyForTrack(cur);
    if (!targetKey) return;
    const filtered = queue.filter(t => albumKeyForTrack(t) === targetKey);
    const newIdx = filtered.indexOf(cur);
    if (newIdx < 0) return;
    queue = filtered;
    queueIndex = newIdx;
    dbg('trimQueueToCurrentAlbum', { newLen: queue.length, newIdx });
    renderQueuePanel();
}

function shuffleInPlace(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

// Reordena al azar los tracks que aún no han sonado (queueIndex+1 hasta el
// final). El track que se está reproduciendo queda donde está.
function reshuffleUpcoming() {
    if (queue.length - queueIndex <= 2) return;
    const head = queue.slice(0, queueIndex + 1);
    const tail = queue.slice(queueIndex + 1);
    shuffleInPlace(tail);
    queue = head.concat(tail);
    renderQueuePanel();
}

function formatSec(s) {
    if (!isFinite(s) || s < 0) return '0:00';
    const t = Math.floor(s);
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
}


