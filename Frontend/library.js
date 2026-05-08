/**
 * Reproductor web (reproductor.html). Pestañas en la cabecera (Álbumes /
 * Artistas / Géneros / Listas), drawer acordeón inline, color dinámico
 * extraído de la portada, descripción del artista debajo del reproductor
 * (Wikipedia / Last.fm), y CRUD básico de playlists.
 */
(function () {
    if (!window.NoBreak || !window.NoBreak.isLoggedIn()) {
        window.location.href = "menu.html";
        return;
    }

    const $ = (id) => document.getElementById(id);

    // ---------------- State -------------------------------------------------
    document.documentElement.setAttribute("data-theme",
        localStorage.getItem("tema-preferido") || "dark");
    let currentTab = "albums";
    let library = { albums: [], artists: [] };
    let genres = null;
    let playlists = null;
    let lastQuery = "";
    let allCards = [];
    let currentDrawer = null;
    let currentDrawerKey = null;
    let currentAlbum = null;
    let queue = [];
    let queueIndex = 0;
    let lastArtistInfoQuery = null;
    const audio = $("audio");

    // ---------------- Boot --------------------------------------------------
    document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));
    $('btn-toggle-tema')?.addEventListener('click', toggleTheme);
    $('btn-logout')?.addEventListener('click', async () => {
        await window.NoBreak.logout();
        window.location.href = "menu.html";
    });
    $('ai-toggle')?.addEventListener('click', () => $('artist-strip').classList.toggle('expanded'));
    setupSearch();
    setupAudioControls();
    refreshLibrary();

    function toggleTheme() {
        const next = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        localStorage.setItem("tema-preferido", next);
    }

    // ---------------- Library load -----------------------------------------
    async function refreshLibrary() {
        try {
            library = await window.NoBreak.getLibrary();
            renderCurrentTab();
        } catch (err) {
            renderError("No se pudo conectar al servidor: " + err.message);
        }
    }

    function setupSearch() {
        const input = $("search");
        let timer = null;
        input?.addEventListener("input", () => {
            clearTimeout(timer);
            timer = setTimeout(() => {
                lastQuery = (input.value || "").toLowerCase().trim();
                renderCurrentTab();
            }, 150);
        });
    }

    function filtered(items, fields) {
        if (!lastQuery) return items;
        return items.filter(it => fields.some(f => (it[f] || '').toString().toLowerCase().includes(lastQuery)));
    }

    // ---------------- Tabs --------------------------------------------------
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

    function renderAlbumsTab() {
        renderAlbumGrid(filtered(library.albums || [], ['titulo', 'artista']));
    }

    function renderArtistsTab() {
        const grid = $('album-grid');
        grid.innerHTML = '';
        allCards = [];
        const artists = filtered(library.artists || [], ['nombre']);
        if (!artists.length) { grid.innerHTML = '<p class="sin-resultados">Sin artistas</p>'; return; }
        for (const a of artists) {
            const card = simpleCard({
                cover: a.coverUrl, title: a.nombre, initials: initials(a.nombre),
                meta: `${a.albumCount} ${a.albumCount === 1 ? 'álbum' : 'álbumes'} · ${a.trackCount} pistas`,
            });
            card.addEventListener('click', () => openArtist(a));
            grid.appendChild(card);
        }
    }

    async function renderGenresTab() {
        const grid = $('album-grid');
        grid.innerHTML = '<p class="sin-resultados">Cargando…</p>';
        try {
            if (!genres) genres = await window.NoBreak.getGenres();
            const list = filtered(genres, ['nombre']);
            grid.innerHTML = '';
            if (!list.length) { grid.innerHTML = '<p class="sin-resultados">Sin géneros etiquetados</p>'; return; }
            for (const g of list) {
                const card = simpleCard({
                    cover: g.coverUrl, title: g.nombre, initials: initials(g.nombre),
                    meta: `${g.albumCount} ${g.albumCount === 1 ? 'álbum' : 'álbumes'} · ${g.trackCount} pistas`,
                });
                card.addEventListener('click', () => openGenre(g));
                grid.appendChild(card);
            }
        } catch (e) {
            grid.innerHTML = `<p class="sin-resultados">Error: ${escapeHtml(e.message)}</p>`;
        }
    }

    async function renderPlaylistsTab() {
        const grid = $('album-grid');
        grid.innerHTML = '<p class="sin-resultados">Cargando…</p>';
        try {
            playlists = await window.NoBreak.getPlaylists();
            const list = filtered(playlists, ['name']);
            grid.innerHTML = '';

            const newCard = document.createElement('div');
            newCard.className = 'album-card playlist-new';
            newCard.innerHTML = `
                <div class="album-cover" style="display:flex;align-items:center;justify-content:center;">+</div>
                <div class="album-title">Nueva playlist</div>
                <div class="album-meta">Crear una lista nueva</div>
            `;
            newCard.addEventListener('click', () => createPlaylistFlow());
            grid.appendChild(newCard);

            for (const pl of list) {
                const card = simpleCard({
                    cover: null, title: pl.name, initials: '♪',
                    meta: `${pl.trackCount} ${pl.trackCount === 1 ? 'canción' : 'canciones'}`,
                });
                card.addEventListener('click', () => openPlaylist(pl, card));
                grid.appendChild(card);
            }
        } catch (e) {
            grid.innerHTML = `<p class="sin-resultados">Error: ${escapeHtml(e.message)}</p>`;
        }
    }

    function simpleCard({ cover, title, meta, initials }) {
        const card = document.createElement('div');
        card.className = 'album-card';
        const url = cover ? window.NoBreak.coverUrl(cover) : null;
        card.innerHTML = `
            <div class="album-cover" style="${url ? `background-image:url('${url}')` : ''}">
                ${url ? '' : `<span class="cover-fallback">${escapeHtml(initials || '')}</span>`}
            </div>
            <div class="album-title">${escapeHtml(title || '')}</div>
            <div class="album-meta">${escapeHtml(meta || '')}</div>
        `;
        return card;
    }

    // ---------------- Album grid -------------------------------------------
    function renderAlbumGrid(albums) {
        closeDrawer();
        const grid = $("album-grid");
        grid.innerHTML = "";
        allCards = [];
        if (!albums.length) { grid.innerHTML = '<p class="sin-resultados">Sin resultados</p>'; return; }
        for (const a of albums) {
            const card = buildAlbumCard(a);
            grid.appendChild(card);
            allCards.push(card);
        }
    }

    function buildAlbumCard(album) {
        const card = document.createElement("div");
        card.className = "album-card";
        card.dataset.albumId = album.id;
        const cover = window.NoBreak.coverUrl(album.coverUrl);
        card.innerHTML = `
            <div class="album-cover" style="background-image:url('${cover || ""}')">
                ${cover ? "" : `<span class="cover-fallback">${escapeHtml(initials(album.titulo))}</span>`}
            </div>
            <div class="album-title">${escapeHtml(album.titulo || "Desconocido")}</div>
            <div class="album-meta">${escapeHtml(album.artista || "")}${album.year ? " · " + album.year : ""} · ${album.trackCount} ${album.trackCount === 1 ? "pista" : "pistas"}</div>
        `;
        card.addEventListener("click", () => toggleAlbumDrawer(album, card));
        return card;
    }

    // ---------------- Artist / Genre filters -------------------------------
    async function openArtist(artist) {
        try {
            const data = await window.NoBreak.getAlbumsByArtist(artist.id);
            switchToFilteredAlbums(data.albums);
        } catch (e) { renderError("Error: " + e.message); }
    }
    async function openGenre(genre) {
        try {
            const data = await window.NoBreak.getAlbumsByGenre(genre.id);
            switchToFilteredAlbums(data.albums);
        } catch (e) { renderError("Error: " + e.message); }
    }
    function switchToFilteredAlbums(albums) {
        document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === 'albums'));
        currentTab = 'albums';
        $('search').value = '';
        lastQuery = '';
        renderAlbumGrid(albums);
    }

    // ---------------- Album drawer -----------------------------------------
    async function toggleAlbumDrawer(album, cardEl) {
        const key = "album:" + album.id;
        if (currentDrawerKey === key) { closeDrawer(); return; }
        closeDrawer();
        await openAlbumDrawer(album, cardEl);
    }

    async function openAlbumDrawer(album, cardEl) {
        cardEl.classList.add("active");
        let detail;
        try { detail = await window.NoBreak.getAlbum(album.id); }
        catch (err) { cardEl.classList.remove("active"); renderError("Error cargando álbum: " + err.message); return; }
        currentAlbum = detail;
        currentDrawerKey = "album:" + album.id;

        const cover = window.NoBreak.coverUrl(detail.coverUrl);
        const drawer = renderDrawer({
            cover, title: detail.titulo,
            sub: `${detail.artista || ''}${detail.year ? ' (' + detail.year + ')' : ''}`,
            actions: [{ label: 'Reproducir', primary: true, onClick: () => playFromList(detail.tracks, 0) }],
            tracks: detail.tracks, trackContext: 'album',
        });
        insertDrawerAfterRow(cardEl, drawer);
        currentDrawer = drawer;
        paintDrawerColor(drawer, cover);
        drawer.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    // ---------------- Playlist drawer --------------------------------------
    async function openPlaylist(pl, cardEl) {
        const key = "playlist:" + pl.id;
        if (currentDrawerKey === key) { closeDrawer(); return; }
        closeDrawer();

        let detail;
        try { detail = await window.NoBreak.getPlaylist(pl.id); }
        catch (err) { renderError("Error abriendo playlist: " + err.message); return; }
        currentAlbum = detail;
        currentDrawerKey = key;
        cardEl.classList.add("active");

        const firstCover = detail.tracks.find(t => t.coverUrl)?.coverUrl;
        const cover = firstCover ? window.NoBreak.coverUrl(firstCover) : null;

        const drawer = renderDrawer({
            cover, title: detail.name,
            sub: `${detail.tracks.length} ${detail.tracks.length === 1 ? 'canción' : 'canciones'}`,
            actions: [
                { label: 'Reproducir', primary: true, onClick: () => playFromList(detail.tracks, 0) },
                { label: 'Renombrar', ghost: true, onClick: () => beginRenameInline(drawer, detail.id) },
                { label: 'Eliminar', ghost: true, onClick: () => deletePlaylistFlow(detail) },
            ],
            tracks: detail.tracks, trackContext: 'playlist', playlistId: detail.id,
        });
        insertDrawerAfterRow(cardEl, drawer);
        currentDrawer = drawer;
        paintDrawerColor(drawer, cover);
        drawer.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }

    // ---------------- Drawer renderer (shared) -----------------------------
    function renderDrawer({ cover, title, sub, actions, tracks, trackContext, playlistId }) {
        const drawer = document.createElement("div");
        drawer.className = "drawer";
        drawer.innerHTML = `
            <button class="drawer-close" title="Cerrar">×</button>
            <div class="drawer-cover" style="background-image:url('${cover || ''}')">
                ${cover ? '' : `<span class="cover-fallback">${escapeHtml(initials(title))}</span>`}
            </div>
            <div class="drawer-info">
                <h3 class="drawer-title">${escapeHtml(title || "")}</h3>
                <div class="drawer-sub">${escapeHtml(sub || "")}</div>
                <div class="drawer-actions"></div>
            </div>
            <div class="drawer-tracks"></div>
        `;
        const actionsEl = drawer.querySelector('.drawer-actions');
        for (const act of actions || []) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'drawer-action' + (act.ghost ? ' ghost' : '');
            b.innerHTML = (act.primary
                ? '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor"><path d="M3 1.5v13l11-6.5z"/></svg> '
                : '') + escapeHtml(act.label);
            b.addEventListener('click', act.onClick);
            actionsEl.appendChild(b);
        }
        const tracksEl = drawer.querySelector(".drawer-tracks");
        (tracks || []).forEach((t, i) => tracksEl.appendChild(buildTrackRow(t, i, tracks, trackContext, playlistId)));
        drawer.querySelector(".drawer-close").addEventListener("click", closeDrawer);
        return drawer;
    }

    function buildTrackRow(t, i, tracks, context, playlistId) {
        const row = document.createElement("div");
        row.className = "drawer-track";
        row.dataset.trackId = t.id;
        row.innerHTML = `
            <span class="num">${String(t.trackNo ?? (i + 1)).padStart(2, "0")}</span>
            <span class="title">${escapeHtml(t.titulo || "")}${
                context === 'playlist' && t.artista ? ` <span style="opacity:0.6">— ${escapeHtml(t.artista)}</span>` : ''
            }</span>
            <button class="row-btn" title="${context === 'playlist' ? 'Quitar' : 'Añadir a lista'}">${context === 'playlist' ? '−' : '+'}</button>
            <span class="dur">${formatDuration(t.durationMs)}</span>
        `;
        row.addEventListener("click", (e) => {
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

    // ---------------- Drawer color + position ------------------------------
    async function paintDrawerColor(drawer, coverUrl) {
        applyDrawerTheme(drawer, '#1f1f1f');
        if (!coverUrl) return;
        const bg = await dominantColor(coverUrl);
        if (drawer.isConnected) applyDrawerTheme(drawer, bg || '#1f1f1f');
    }

    function applyDrawerTheme(drawer, bgColor) {
        const fg = contrastText(bgColor);
        drawer.style.setProperty("--drawer-bg", bgColor);
        drawer.style.setProperty("--drawer-fg", fg);
    }

    function closeDrawer() {
        if (currentDrawer) { currentDrawer.remove(); currentDrawer = null; }
        currentDrawerKey = null;
        currentAlbum = null;
        for (const c of allCards) c.classList.remove("active");
        document.querySelectorAll('.album-card.active').forEach(c => c.classList.remove("active"));
    }

    function insertDrawerAfterRow(cardEl, drawer) {
        const grid = $("album-grid");
        const cards = Array.from(grid.querySelectorAll(".album-card"));
        const idx = cards.indexOf(cardEl);
        if (idx < 0) { grid.appendChild(drawer); return; }
        const cs = window.getComputedStyle(grid).gridTemplateColumns;
        const cols = cs.split(/\s+/).filter(Boolean).length;
        const insertBeforeIdx = (Math.floor(idx / cols) + 1) * cols;
        if (insertBeforeIdx >= cards.length) grid.appendChild(drawer);
        else grid.insertBefore(drawer, cards[insertBeforeIdx]);
    }

    let resizeTimer = null;
    window.addEventListener("resize", () => {
        if (!currentDrawer || !currentDrawerKey) return;
        clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            const active = document.querySelector('.album-card.active');
            if (active && currentDrawer) {
                currentDrawer.remove();
                insertDrawerAfterRow(active, currentDrawer);
            }
        }, 100);
    });

    // ---------------- Playback ---------------------------------------------
    function playFromList(tracks, index) {
        if (!tracks || !tracks.length) return;
        queue = tracks.slice();
        queueIndex = index;
        playTrack(queue[index]);
    }

    function playTrack(track) {
        const url = window.NoBreak.streamUrl(track.id);
        if (!url) { renderError("Sin sesión"); return; }
        audio.src = url;
        audio.play().catch(() => { /* autoplay puede requerir gesto */ });
        $("np-title").innerText = track.titulo || "—";
        const bits = [];
        if (track.artista) bits.push(track.artista);
        if (track.album) bits.push(track.album);
        else if (currentAlbum?.titulo) bits.push(currentAlbum.titulo);
        $("np-meta").innerText = bits.join(" · ");
        const cover = track.coverUrl ? window.NoBreak.coverUrl(track.coverUrl)
                                     : window.NoBreak.coverUrl(currentAlbum?.coverUrl);
        $("np-cover").style.backgroundImage = cover ? `url('${cover}')` : "";
        if (currentDrawer) {
            currentDrawer.querySelectorAll('.drawer-track').forEach(el => {
                el.classList.toggle('playing', Number(el.dataset.trackId) === track.id);
            });
        }
        requestArtistInfo(track.artista || '');
    }

    function setupAudioControls() {
        $("btn-prev")?.addEventListener("click", () => {
            if (!queue.length) return;
            queueIndex = (queueIndex - 1 + queue.length) % queue.length;
            playTrack(queue[queueIndex]);
        });
        $("btn-next")?.addEventListener("click", () => {
            if (!queue.length) return;
            queueIndex = (queueIndex + 1) % queue.length;
            playTrack(queue[queueIndex]);
        });
        audio?.addEventListener("ended", () => {
            if (!queue.length) return;
            queueIndex = (queueIndex + 1) % queue.length;
            playTrack(queue[queueIndex]);
        });
    }

    // ---------------- Artist info strip ------------------------------------
    async function requestArtistInfo(artistName) {
        if (!artistName || artistName === lastArtistInfoQuery) return;
        lastArtistInfoQuery = artistName;
        const strip = $('artist-strip');
        strip.classList.remove('expanded');
        $('ai-name').textContent = artistName;
        $('ai-extract').textContent = 'Cargando…';
        $('ai-thumb').style.backgroundImage = '';
        $('ai-source').textContent = '';
        strip.classList.remove('oculto');
        try {
            const info = await window.NoBreak.getArtistInfo(artistName);
            if (lastArtistInfoQuery !== artistName) return;
            if (!info) throw new Error('Sin info');
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

    // ---------------- Playlists CRUD --------------------------------------
    async function createPlaylistFlow(prefilledTrackId) {
        const name = (prompt('Nombre de la nueva playlist:') || '').trim();
        if (!name) return null;
        try {
            const pl = await window.NoBreak.createPlaylist(name);
            playlists = null;
            if (prefilledTrackId) {
                await window.NoBreak.addTrackToPlaylist(pl.id, prefilledTrackId);
            }
            if (currentTab === 'playlists') renderPlaylistsTab();
            return pl;
        } catch (e) { alert('No se pudo crear: ' + e.message); return null; }
    }

    function beginRenameInline(drawer, playlistId) {
        const titleEl = drawer.querySelector('.drawer-title');
        if (!titleEl) return;
        const current = titleEl.textContent;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = current;
        input.className = 'drawer-title-input';
        titleEl.replaceWith(input);
        input.focus(); input.select();
        const finish = async (commit) => {
            const value = input.value.trim();
            const h3 = document.createElement('h3');
            h3.className = 'drawer-title';
            h3.textContent = commit && value ? value : current;
            input.replaceWith(h3);
            if (commit && value && value !== current) {
                try { await window.NoBreak.renamePlaylist(playlistId, value); playlists = null; }
                catch (e) { alert('No se pudo renombrar: ' + e.message); h3.textContent = current; }
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
            await window.NoBreak.deletePlaylist(playlist.id);
            playlists = null;
            closeDrawer();
            if (currentTab === 'playlists') renderPlaylistsTab();
        } catch (e) { alert('No se pudo borrar: ' + e.message); }
    }

    async function removeFromPlaylist(playlistId, trackId) {
        try {
            await window.NoBreak.removeTrackFromPlaylist(playlistId, trackId);
            if (currentDrawerKey === 'playlist:' + playlistId) {
                const updated = await window.NoBreak.getPlaylist(playlistId);
                currentAlbum = updated;
                const tracksEl = currentDrawer?.querySelector('.drawer-tracks');
                if (tracksEl) {
                    tracksEl.innerHTML = '';
                    updated.tracks.forEach((t, i) => tracksEl.appendChild(buildTrackRow(t, i, updated.tracks, 'playlist', playlistId)));
                }
                const subEl = currentDrawer?.querySelector('.drawer-sub');
                if (subEl) subEl.textContent = `${updated.tracks.length} ${updated.tracks.length === 1 ? 'canción' : 'canciones'}`;
            }
        } catch (e) { alert('No se pudo quitar: ' + e.message); }
    }

    // ---------------- Add-to-playlist popover ------------------------------
    async function openAddToPlaylistMenu(trackId, anchor) {
        const popover = $('add-popover');
        popover.innerHTML = '';
        let lists;
        try { lists = await window.NoBreak.getPlaylists(); }
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
                b.textContent = `${pl.name} (${pl.trackCount})`;
                b.addEventListener('click', async () => {
                    try { await window.NoBreak.addTrackToPlaylist(pl.id, trackId); playlists = null; }
                    catch (e) { alert('No se pudo añadir: ' + e.message); }
                    hidePopover();
                });
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
            await createPlaylistFlow(trackId);
        });
        popover.appendChild(create);

        const rect = anchor.getBoundingClientRect();
        popover.style.top = (rect.bottom + 4) + 'px';
        popover.style.left = Math.max(10, Math.min(rect.left, window.innerWidth - 240)) + 'px';
        popover.classList.remove('oculto');
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
        $('add-popover').classList.add('oculto');
        document.removeEventListener('click', dismissOnOutside, { capture: true });
        document.removeEventListener('keydown', dismissOnEsc);
    }

    // ---------------- Color extraction (drawer dynamic bg) -----------------
    async function dominantColor(imageUrl) {
        if (!imageUrl) return null;
        const corsUrl = imageUrl + (imageUrl.includes("?") ? "&" : "?") + "_cors=1";
        return new Promise(resolve => {
            const img = new Image();
            img.crossOrigin = "anonymous";
            img.onload = () => {
                try {
                    const W = 32, H = 32;
                    const c = document.createElement("canvas");
                    c.width = W; c.height = H;
                    const ctx = c.getContext("2d", { willReadFrequently: true });
                    ctx.drawImage(img, 0, 0, W, H);
                    const data = ctx.getImageData(0, 0, W, H).data;
                    const buckets = new Map();
                    for (let i = 0; i < data.length; i += 4) {
                        if (data[i + 3] < 128) continue;
                        const r = data[i] & 0xf0, g = data[i + 1] & 0xf0, b = data[i + 2] & 0xf0;
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
                } catch (e) { resolve(null); }
            };
            img.onerror = () => resolve(null);
            img.src = corsUrl;
        });
    }

    function contrastText(rgbCss) {
        const m = rgbCss && rgbCss.match(/\d+/g);
        if (!m) return "#ffffff";
        const [r, g, b] = m.map(Number);
        const linear = (c) => { c = c / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
        const L = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
        return L > 0.45 ? "#0a0a0a" : "#ffffff";
    }

    // ---------------- Helpers ----------------------------------------------
    function renderError(msg) {
        const grid = $("album-grid");
        if (grid) grid.innerHTML = `<p class="sin-resultados">${escapeHtml(msg)}</p>`;
    }
    function initials(s) {
        if (!s) return "";
        return s.trim().split(/\s+/).slice(0, 2).map(w => w.charAt(0).toUpperCase()).join("");
    }
    function formatDuration(ms) {
        if (ms == null) return "—";
        const s = Math.floor(ms / 1000);
        return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    }
    function escapeHtml(s) {
        return String(s ?? "")
            .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
    }
})();
