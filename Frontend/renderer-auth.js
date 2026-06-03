// renderer-auth.js — pantallas de autenticacion: registro, foto inicial,
// toggles de contrasena, navegacion entre pantallas de auth.

// Botón ojo: alterna entre password / text en el input identificado por
// data-target. Cambia el icono entre eye-on y eye-off.
function setupPasswordToggles() {
    document.querySelectorAll('.pass-toggle').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.target;
            const input = document.getElementById(id);
            if (!input) return;
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            btn.querySelector('.eye-on')?.classList.toggle('hidden', !showing);
            btn.querySelector('.eye-off')?.classList.toggle('hidden', showing);
            const next = showing ? 'Mostrar contraseña' : 'Ocultar contraseña';
            btn.setAttribute('aria-label', next);
            btn.setAttribute('title', next);
        });
    });
}

// Muestra una de las pantallas de auth (login | register | photo) y oculta
// las demás. Las pantallas funcionales (folder, app) se gestionan aparte.
function showAuthScreen(which) {
    for (const id of ['landing-screen', 'login-screen', 'register-screen', 'photo-screen', 'folder-screen']) {
        $(id)?.classList.toggle('hidden', id !== which + '-screen');
    }
    $('app-screen')?.classList.add('hidden');
}

function setupAuthNavLinks() {
    $('link-register')?.addEventListener('click', (e) => {
        e.preventDefault();
        showAuthScreen('register');
    });
    $('link-login')?.addEventListener('click', (e) => {
        e.preventDefault();
        showAuthScreen('login');
    });
    // Landing → login (botón "Iniciar sesión" arriba a la derecha).
    $('landing-login-btn')?.addEventListener('click', () => showAuthScreen('login'));
}

function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('nobreak-theme', theme);
}


function setupThemeToggle() {
    // El toggle vive en el panel Settings; mantenemos esta función para que
    // el boot existente no rompa, y la UI del switch refleja el tema actual.
    syncThemeToggleUI();
    $('settings-tema')?.addEventListener('click', () => {
        const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        syncThemeToggleUI();
    });
}

function syncThemeToggleUI() {
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const btn = $('settings-tema');
    if (btn) btn.setAttribute('aria-pressed', isDark ? 'false' : 'true');
    const label = $('settings-tema-label');
    if (label) label.textContent = isDark ? 'Oscuro' : 'Claro';
}

// El botón redondo del header muestra la foto del usuario. Click → abre o
// enfoca la pestaña de perfil (tab dinámica con el username como label).
function setupProfileMenu() {
    const btn = $('btn-perfil');
    if (!btn) return;
    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        openOrFocusTab('profile', { name: username });
    });
    // Cargar foto inicial sin bloquear la UI.
    refreshHeaderPhoto().catch(() => {});
}

async function refreshHeaderPhoto() {
    if (!token) return;
    try {
        const me = await apiJson('/auth/me');
        applyHeaderPhoto(me.photoUrl || null);
    } catch {}
}

function applyHeaderPhoto(serverPath) {
    const btn = $('btn-perfil');
    if (!btn) return;
    if (serverPath) {
        const url = API_BASE + serverPath + '?t=' + encodeURIComponent(token) + '&v=' + Date.now();
        btn.style.backgroundImage = `url('${url}')`;
        btn.classList.add('has-photo');
    } else {
        btn.style.backgroundImage = '';
        btn.classList.remove('has-photo');
    }
}

async function doLogout() {
    try {
        await fetch(API_BASE + '/auth/logout', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + token },
        });
    } catch {}
    token = null;
    username = null;
    if (typeof clearSession === 'function') clearSession();
    closeDrawer();
    applyHeaderPhoto(null);
    $('app-screen').classList.add('hidden');
    $('folder-screen')?.classList.add('hidden');
    $('register-screen')?.classList.add('hidden');
    $('photo-screen')?.classList.add('hidden');
    $('login-screen').classList.remove('hidden');
    $('login-form').reset();
}

// Pestaña pública de perfil. Lee /api/users/:username y pinta:
// - hero con foto / username / fecha
// - descripción
// - widgets en grid según profile_widgets (o el layout por defecto)
// - si advancedMode está activo y hay HTML, en su lugar pintamos ese HTML
//   dentro de un iframe sandboxed.
// - si eres el dueño aparece el botón "Editar perfil" que abre la pestaña
//   "Perfil" (editProfile).
async function renderProfileView(profileUsername) {
    const view = $('profile-view');
    if (!view) return;
    view.innerHTML = '<div class="empty-state">Cargando perfil…</div>';
    let p;
    try {
        p = await apiJson('/api/users/' + encodeURIComponent(profileUsername));
    } catch (e) {
        view.innerHTML = `<div class="empty-state">Error: ${escapeHtml(e.message)}</div>`;
        return;
    }
    view.innerHTML = '';
    applyProfileBackground(view, p.backgroundUrl);
    // Wrapper interno: lo usamos para que el velo abarque toda la altura del
    // contenido (en vez de sólo el viewport visible).
    const inner = document.createElement('div');
    inner.className = 'pv-inner';
    applyProfileStyle(view, inner, p.profileWidgets?.style);
    applyProfileVeil(inner, p.profileWidgets?.veil);
    inner.appendChild(buildProfileHero(p));
    if (p.advancedMode && p.profileHtml) {
        inner.appendChild(buildAdvancedFrame(p.profileHtml));
    } else {
        inner.appendChild(buildWidgetGrid(p));
    }
    view.appendChild(inner);
    // Trae las imágenes de los artistas tras inyectar el DOM (no bloquea).
    lazyLoadArtistImages().catch(() => {});
    // Rellena el widget "Me Gusta" del grid en paralelo (si está en el layout).
    populateLikedWidget(profileUsername).catch(() => {});
}

// Modal con toda la lista de Me Gusta del usuario cuyo perfil se está viendo.
// Se abre desde el botón → del widget liked-songs o desde el botón "Ver las N"
// que aparece como pie del propio widget.
async function openLikedModal(profileUsername) {
    const modal = $('liked-modal');
    if (!modal) return;
    $('liked-modal-title').textContent = 'Me Gusta de ' + profileUsername;
    $('liked-modal-body').innerHTML = '<div class="muted small">Cargando…</div>';
    modal.classList.remove('hidden');
    try {
        const r = await apiJson('/api/users/' + encodeURIComponent(profileUsername) + '/liked');
        if (!r || !r.tracks?.length) {
            $('liked-modal-body').innerHTML = '<div class="muted">Sin canciones favoritas.</div>';
            return;
        }
        $('liked-modal-body').innerHTML = '<ul class="pv-track-list">' + r.tracks.map((t, i) => `
            <li>
                <span class="pv-track-rank">${i + 1}</span>
                <div class="pv-track-meta">
                    <div class="pv-track-title">${escapeHtml(t.titulo || '')}</div>
                    <div class="pv-track-sub muted small">${escapeHtml(t.artista || '')}${t.album ? ' · ' + escapeHtml(t.album) : ''}</div>
                </div>
                <span class="pv-track-time muted small">${escapeHtml(formatDuration(t.durationMs))}</span>
            </li>
        `).join('') + '</ul>';
    } catch (e) {
        $('liked-modal-body').innerHTML = `<div class="muted small">Error: ${escapeHtml(e.message)}</div>`;
    }
}

function closeLikedModal() {
    $('liked-modal')?.classList.add('hidden');
}

// Cablea cierres (botón ×, click fuera, tecla Escape) y delega los clicks
// sobre cualquier elemento con data-liked-modal-for="<username>".
function setupLikedModal() {
    $('liked-modal-close')?.addEventListener('click', closeLikedModal);
    $('liked-modal')?.addEventListener('click', (e) => {
        if (e.target.id === 'liked-modal') closeLikedModal();
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && !$('liked-modal')?.classList.contains('hidden')) {
            closeLikedModal();
        }
    });
    document.addEventListener('click', (e) => {
        const trigger = e.target.closest('[data-liked-modal-for]');
        if (trigger) {
            e.preventDefault();
            openLikedModal(trigger.dataset.likedModalFor);
        }
    });
}

// Rellena el cuerpo del widget liked-songs con las primeras 6 canciones del
// usuario. Sólo dispara una llamada — el modal "Ver todas" repite el fetch
// para obtener la lista completa al abrirse.
async function populateLikedWidget(profileUsername) {
    const widget = document.querySelector('.pv-w-liked-songs .pv-widget-body');
    if (!widget) return;
    try {
        const r = await apiJson('/api/users/' + encodeURIComponent(profileUsername) + '/liked');
        if (!r || !Array.isArray(r.tracks) || r.tracks.length === 0) {
            widget.innerHTML = '<div class="muted small">Sin canciones favoritas aún.</div>';
            return;
        }
        const PREVIEW = 6;
        const items = r.tracks.slice(0, PREVIEW).map((t, i) => `
            <li>
                <span class="pv-track-rank">${i + 1}</span>
                <div class="pv-track-meta">
                    <div class="pv-track-title">${escapeHtml(t.titulo || '')}</div>
                    <div class="pv-track-sub muted small">${escapeHtml(t.artista || '')}</div>
                </div>
            </li>
        `).join('');
        const more = r.count > PREVIEW
            ? `<button type="button" class="pv-widget-more" data-liked-modal-for="${escapeHtml(profileUsername)}">Ver las ${r.count}</button>`
            : '';
        widget.innerHTML = '<ul class="pv-track-list">' + items + '</ul>' + more;
    } catch (e) {
        widget.innerHTML = `<div class="muted small">No se pudo cargar: ${escapeHtml(e.message)}</div>`;
    }
}

// Aplica el fondo del usuario (cover, fixed) o lo limpia. Activa la clase
// `has-bg` para que el CSS añada un velo legible sobre la imagen.
function applyProfileBackground(view, bgServerPath) {
    if (bgServerPath) {
        const url = API_BASE + bgServerPath + '?t=' + encodeURIComponent(token) + '&v=' + Date.now();
        view.style.backgroundImage = `url('${url}')`;
        view.classList.add('has-bg');
    } else {
        view.style.backgroundImage = '';
        view.classList.remove('has-bg');
    }
}

// Velo independiente del ancho de las ventanas pero con la misma mecánica:
// ancho en píxeles capado al 100% del viewport (`min(<px>, 100%)` en CSS),
// así al estrechar la app el velo se topa con el borde a la vez que las
// ventanas y no aparece descuadrado.
const VEIL_WIDTH_MIN_PX = 200;
const VEIL_WIDTH_MAX_PX = 1920;
const VEIL_WIDTH_DEFAULT_PX = 1200;
const DEFAULT_VEIL = {
    color: '#000000',
    opacity: 0.65,
    width: VEIL_WIDTH_DEFAULT_PX,
    borderColor: '#000000',
    borderOpacity: 0,
    borderWidth: 0,
};
function applyProfileVeil(inner, veil) {
    const v = { ...DEFAULT_VEIL, ...(veil || {}) };
    const fillOpacity   = Math.max(0, Math.min(1, Number(v.opacity)));
    const fillColor     = /^#[0-9a-f]{3,8}$/i.test(v.color) ? v.color : DEFAULT_VEIL.color;
    const borderColor   = /^#[0-9a-f]{3,8}$/i.test(v.borderColor) ? v.borderColor : DEFAULT_VEIL.borderColor;
    const borderOpacity = Math.max(0, Math.min(1, Number(v.borderOpacity ?? 0)));
    const borderWidth   = Math.max(0, Math.min(20, Number(v.borderWidth ?? 0)));
    // Compatibilidad con valores antiguos en % (0..100): los mapeamos al
    // default en píxeles. Cualquier valor >100 lo tratamos como px directo.
    let widthPx = Number(v.width);
    if (!isFinite(widthPx) || widthPx <= 100) widthPx = VEIL_WIDTH_DEFAULT_PX;
    widthPx = Math.max(VEIL_WIDTH_MIN_PX, Math.min(VEIL_WIDTH_MAX_PX, widthPx));
    inner.style.setProperty('--veil-fill',         hexWithAlpha(fillColor, fillOpacity));
    inner.style.setProperty('--veil-border-color', hexWithAlpha(borderColor, borderOpacity));
    inner.style.setProperty('--veil-border-width', borderWidth + 'px');
    inner.style.setProperty('--veil-width', widthPx + 'px');
}

// Catálogo de fuentes. Las claves son las que guardamos en la BD.
const FONT_STACKS = {
    system:      `'Segoe UI', Tahoma, Geneva, Verdana, sans-serif`,
    serif:       `Georgia, 'Times New Roman', serif`,
    mono:        `Consolas, 'Courier New', monospace`,
    display:     `Impact, 'Bebas Neue', 'Arial Black', sans-serif`,
    handwriting: `'Brush Script MT', 'Comic Sans MS', cursive`,
};
const FONT_LABELS = {
    system: 'Estándar', serif: 'Serif clásica', mono: 'Monoespaciada',
    display: 'Display (impacto)', handwriting: 'Manuscrita',
};

const PHOTO_SHAPES   = ['circle', 'square', 'rounded', 'oval', 'star'];
const PHOTO_POSITIONS = ['top', 'bottom', 'left', 'right'];

// El ancho de las ventanas se guarda en píxeles (600 a 1920) para que el
// usuario pueda decidir si quiere widgets cómodos en filas largas (1920) o
// un perfil más estrecho. El hero y los widgets comparten este max-width.
const WINDOW_WIDTH_MIN_PX = 600;
const WINDOW_WIDTH_MAX_PX = 1920;
const WINDOW_WIDTH_DEFAULT_PX = 1200;

const WINDOW_SHAPES = ['square', 'rounded', 'extra-rounded', 'pill'];
const WINDOW_SHAPE_RADIUS = {
    'square': '0',
    'rounded': '14px',
    'extra-rounded': '26px',
    'pill': '999px',
};

const DEFAULT_STYLE = {
    photoShape:    'circle',
    photoPosition: 'top',
    nameColor:     '',
    emailColor:    '',
    subtitleColor: '',
    headerFrame:   false,
    windowBg:      '',
    windowTitleColor: '',
    windowTextColor:  '',
    windowMutedColor: '',          // texto secundario dentro de las ventanas
    windowOpacity:    1,            // 0..1, alpha del fondo de las ventanas
    windowShape:      'rounded',    // square | rounded | extra-rounded | pill
    windowBorderWidth: 1,           // px (0..6)
    windowBorderColor: '',          // color del borde — '' = color de tema
    font:          'system',
    windowMaxWidth: WINDOW_WIDTH_DEFAULT_PX,
    // Posición / escala del marco PNG superpuesto a la foto.
    frameX: 0,                       // % del lado de la caja
    frameY: 0,
    frameScale: 1,                   // 0.5..2
};

// Convierte un hex a rgba con alfa indicado. Si el hex no es válido, devuelve
// "transparent". Acepta forma corta (#rgb) y larga (#rrggbb).
function hexWithAlpha(hex, alpha) {
    if (typeof hex !== 'string') return 'transparent';
    const a = Math.max(0, Math.min(1, Number(alpha)));
    let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(hex);
    let r, g, b;
    if (m) {
        r = parseInt(m[1] + m[1], 16);
        g = parseInt(m[2] + m[2], 16);
        b = parseInt(m[3] + m[3], 16);
    } else {
        m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
        if (!m) return 'transparent';
        r = parseInt(m[1], 16); g = parseInt(m[2], 16); b = parseInt(m[3], 16);
    }
    return `rgba(${r}, ${g}, ${b}, ${a})`;
}

// Aplica la configuración de estilo a la vista (CSS vars + dataset). Las
// vars se ponen en .profile-view para que cascade a los hijos.
function applyProfileStyle(view, inner, style) {
    const s = { ...DEFAULT_STYLE, ...(style || {}) };
    // Fuente única para todo el perfil. Aceptamos también las claves antiguas
    // (headerFont/windowFont) por compatibilidad con perfiles ya guardados.
    const fontKey = (FONT_STACKS[s.font] && s.font)
                  || (FONT_STACKS[s.headerFont] && s.headerFont)
                  || (FONT_STACKS[s.windowFont] && s.windowFont)
                  || 'system';
    view.style.setProperty('--profile-font', FONT_STACKS[fontKey]);
    // Colores (sólo si parecen un hex válido).
    const isHex = (c) => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c);
    const setOrClear = (varName, val) => {
        if (isHex(val)) view.style.setProperty(varName, val);
        else            view.style.removeProperty(varName);
    };
    setOrClear('--name-color',          s.nameColor);
    setOrClear('--email-color',         s.emailColor);
    setOrClear('--subtitle-color',      s.subtitleColor);
    setOrClear('--window-title-color',  s.windowTitleColor);
    setOrClear('--window-text-color',   s.windowTextColor);
    setOrClear('--window-muted-color',  s.windowMutedColor);
    setOrClear('--window-border-color', s.windowBorderColor);

    // Fondo de las ventanas combinando color + opacidad. Si la opacidad es 1
    // y el usuario no ha elegido color, dejamos el fallback del tema.
    const opacity = Math.max(0, Math.min(1, Number(s.windowOpacity ?? 1)));
    if (isHex(s.windowBg) || opacity < 1) {
        const baseBg = isHex(s.windowBg) ? s.windowBg : '#181818';
        view.style.setProperty('--window-bg', hexWithAlpha(baseBg, opacity));
    } else {
        view.style.removeProperty('--window-bg');
    }
    // Forma y grosor del borde de las ventanas.
    const shape = WINDOW_SHAPES.includes(s.windowShape) ? s.windowShape : 'rounded';
    view.style.setProperty('--window-radius', WINDOW_SHAPE_RADIUS[shape]);
    const bw = Math.max(0, Math.min(6, Number(s.windowBorderWidth ?? 1)));
    view.style.setProperty('--window-border-width', bw + 'px');
    // Ancho máximo en píxeles (compatible con valores antiguos en %).
    let widthPx = Number(s.windowMaxWidth) || WINDOW_WIDTH_DEFAULT_PX;
    if (widthPx <= 100) widthPx = WINDOW_WIDTH_DEFAULT_PX;  // legacy: %
    widthPx = Math.max(WINDOW_WIDTH_MIN_PX, Math.min(WINDOW_WIDTH_MAX_PX, widthPx));
    view.style.setProperty('--window-max-width', widthPx + 'px');
    view._windowMaxWidthPx = widthPx;  // para que applyProfileVeil pueda leerlo
    // Foto + header (datasets).
    view.dataset.photoShape    = PHOTO_SHAPES.includes(s.photoShape) ? s.photoShape : 'circle';
    view.dataset.photoPosition = PHOTO_POSITIONS.includes(s.photoPosition) ? s.photoPosition : 'top';
    view.dataset.headerFrame   = s.headerFrame ? '1' : '0';
    // Posición/escala del marco PNG.
    const fx = Math.max(-50, Math.min(50, Number(s.frameX ?? 0)));
    const fy = Math.max(-50, Math.min(50, Number(s.frameY ?? 0)));
    const fs_ = Math.max(0.5, Math.min(2, Number(s.frameScale ?? 1)));
    view.style.setProperty('--frame-x', fx + '%');
    view.style.setProperty('--frame-y', fy + '%');
    view.style.setProperty('--frame-scale', String(fs_));
}

function buildProfileHero(p) {
    const view = $('profile-view');
    const hero = document.createElement('div');
    const photoShape   = view?.dataset.photoShape    || 'circle';
    const photoPosition = view?.dataset.photoPosition || 'top';
    const headerFrame  = view?.dataset.headerFrame === '1';
    hero.className = 'pv-hero' + (headerFrame ? ' pv-hero-framed' : '');
    hero.dataset.photoShape    = photoShape;
    hero.dataset.photoPosition = photoPosition;
    const photoStyle = p.photoUrl
        ? `style="background-image:url('${API_BASE + p.photoUrl}?t=${encodeURIComponent(token)}&v=${Date.now()}')"`
        : '';
    const photoFallback = p.photoUrl ? '' : escapeHtml(initials(p.displayName || p.username) || '·');
    // PNG superpuesto a la foto (marco).
    const frameHtml = p.frameUrl
        ? `<img class="pv-photo-frame" src="${API_BASE + p.frameUrl}?t=${encodeURIComponent(token)}&v=${Date.now()}" alt="">`
        : '';
    const ownerBadgeHtml = p.isOwner
        ? `<button class="pv-edit-btn" id="pv-edit-btn" type="button">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M12 20h9"/>
                  <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z"/>
              </svg>
              Editar perfil
           </button>`
        : '';
    const emailLine = p.isOwner && p.email
        ? `<div class="pv-email">${escapeHtml(p.email)} ${p.emailVerified
            ? '<span class="badge-ok">✓ verificado</span>'
            : '<span class="badge-unverified">sin verificar</span>'}</div>`
        : '';
    hero.innerHTML = `
        <div class="pv-photo" ${photoStyle}>${photoFallback}${frameHtml}</div>
        <div class="pv-meta">
            <div class="pv-eyebrow">Perfil de <strong>@${escapeHtml(p.username)}</strong></div>
            <h1 class="pv-name">${escapeHtml(p.displayName || p.username)}</h1>
            ${emailLine}
            <div class="pv-created muted small">
                Cuenta creada el ${escapeHtml(p.createdAt ? new Date(p.createdAt).toLocaleDateString() : '—')}
            </div>
        </div>
        <div class="pv-hero-actions">
            ${ownerBadgeHtml}
        </div>
    `;
    hero.querySelector('#pv-edit-btn')?.addEventListener('click', () => {
        openOrFocusTab('editProfile');
    });
    return hero;
}

// El layout por defecto si el usuario no ha personalizado nada.
const DEFAULT_PROFILE_WIDGETS = [
    { type: 'description',   size: 'full' },
    { type: 'top-artists',   size: 'medium' },
    { type: 'top-tracks',    size: 'medium' },
    { type: 'liked-songs',   size: 'medium' },
    { type: 'total-hours',   size: 'small' },
    { type: 'album-count',   size: 'small' },
    { type: 'top-albums',    size: 'large' },
    { type: 'friends',       size: 'medium' },
];

const WIDGET_CATALOG = {
    'description':       { label: 'Descripción', defaultSize: 'full' },
    'top-artists':       { label: 'Artistas favoritos', defaultSize: 'medium' },
    'top-tracks':        { label: 'Canciones más escuchadas', defaultSize: 'medium' },
    'top-albums':        { label: 'Álbumes favoritos', defaultSize: 'large' },
    'total-hours':       { label: 'Horas totales escuchadas', defaultSize: 'small' },
    'album-count':       { label: 'Álbumes en biblioteca', defaultSize: 'small' },
    'friends':           { label: 'Amigos', defaultSize: 'medium' },
    'anticipated-album': { label: 'Álbum más anticipado', defaultSize: 'medium' },
    'liked-songs':       { label: 'Me Gusta', defaultSize: 'medium' },
};
const WIDGET_SIZES = ['small', 'medium', 'large', 'full'];

function getWidgetLayout(p) {
    const stored = p?.profileWidgets;
    if (stored && Array.isArray(stored.widgets)) return stored.widgets;
    return DEFAULT_PROFILE_WIDGETS.slice();
}

function buildWidgetGrid(p) {
    const wrap = document.createElement('div');
    wrap.className = 'pv-body';
    const grid = document.createElement('div');
    grid.className = 'pv-widgets';
    const layout = getWidgetLayout(p);
    for (const w of layout) {
        const node = renderWidget(w, p);
        if (node) grid.appendChild(node);
    }
    if (!grid.children.length) {
        grid.innerHTML = '<div class="empty-state">Este perfil no tiene secciones visibles.</div>';
    }
    wrap.appendChild(grid);
    return wrap;
}

function renderWidget(spec, p) {
    const def = WIDGET_CATALOG[spec.type];
    if (!def) return null;
    const size = WIDGET_SIZES.includes(spec.size) ? spec.size : def.defaultSize;
    const card = document.createElement('section');
    card.className = `pv-widget pv-widget-${size} pv-w-${spec.type}`;
    let body = '';
    switch (spec.type) {
        case 'description':       body = renderWidgetDescription(p); break;
        case 'top-artists':       body = renderWidgetTopArtists(p); break;
        case 'top-tracks':        body = renderWidgetTopTracks(p); break;
        case 'top-albums':        body = renderWidgetTopAlbums(p); break;
        case 'total-hours':       body = renderWidgetStat('Horas escuchadas', formatHours(p.totalListenedMs)); break;
        case 'album-count':       body = renderWidgetStat('Álbumes en biblioteca', String(p.albumCount ?? 0)); break;
        case 'friends':           body = renderWidgetFriends(p); break;
        case 'anticipated-album': body = renderWidgetAnticipated(spec, p); break;
        case 'liked-songs':       body = '<div class="muted small">Cargando…</div>'; break;
    }
    // Para liked-songs añadimos un botón en la cabecera que abre el modal
    // con la lista completa. Reusa el username del perfil que se está viendo.
    const openModalBtn = spec.type === 'liked-songs'
        ? `<button class="pv-widget-open" type="button" data-liked-modal-for="${escapeHtml(p.username || '')}" title="Ver todas" aria-label="Ver todas">
               <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
                   <polyline points="9 6 15 12 9 18"/>
               </svg>
           </button>`
        : '';
    card.innerHTML = `
        <div class="pv-widget-head">
            <h3 class="pv-widget-title">${escapeHtml(def.label)}</h3>
            ${openModalBtn}
        </div>
        <div class="pv-widget-body">${body}</div>
    `;
    return card;
}

function renderWidgetDescription(p) {
    if (!p.description) return '<div class="muted">Sin descripción.</div>';
    return `<p class="pv-description">${escapeHtml(p.description)}</p>`;
}

function renderWidgetStat(label, val) {
    return `
        <div class="pv-stat-big">
            <div class="pv-stat-big-val">${escapeHtml(val)}</div>
        </div>
    `;
}

function renderWidgetTopArtists(p) {
    if (!p.topArtists?.length) return '<div class="muted">Sin escucha aún.</div>';
    // Pinta tarjetas con foto circular como las de álbumes; las imágenes se
    // cargan después de inyectar el DOM via lazyLoadArtistImages() (consulta
    // /api/artist-info que ya cachea Last.fm + Wikipedia).
    return '<div class="pv-artist-grid">' + p.topArtists.map(a => `
        <div class="pv-artist" data-artist="${escapeHtml(a.artist)}" tabindex="0" role="button">
            <div class="pv-artist-photo">${escapeHtml(initials(a.artist) || '·')}</div>
            <div class="pv-artist-name">${escapeHtml(a.artist)}</div>
            <div class="pv-artist-time muted small">${escapeHtml(formatHours(a.listenedMs))}</div>
        </div>
    `).join('') + '</div>';
}

// Recorre las tarjetas .pv-artist creadas en el render del perfil y trae la
// imagen via /api/artist-info. La marca `loaded` evita repetir si vuelve a
// dispararse en re-renders.
async function lazyLoadArtistImages() {
    const cards = document.querySelectorAll('.pv-artist[data-artist]');
    for (const el of cards) {
        if (el.dataset.loaded === '1') continue;
        el.dataset.loaded = '1';
        const name = el.dataset.artist;
        if (!name) continue;
        try {
            const info = await apiJson('/api/artist-info?name=' + encodeURIComponent(name));
            const url = info?.thumbnail || info?.imageLarge;
            const photo = el.querySelector('.pv-artist-photo');
            if (url && photo) {
                photo.style.backgroundImage = `url('${url}')`;
                photo.textContent = '';
                photo.classList.add('has-image');
            }
        } catch { /* sin foto, mantenemos las iniciales */ }
    }
}

function renderWidgetTopTracks(p) {
    if (!p.topTracks?.length) return '<div class="muted">Sin reproducciones aún.</div>';
    return '<ul class="pv-track-list">' + p.topTracks.map((t, i) => `
        <li>
            <span class="pv-track-rank">${i + 1}</span>
            <div class="pv-track-meta">
                <div class="pv-track-title">${escapeHtml(t.titulo || '')}</div>
                <div class="pv-track-sub muted small">${escapeHtml(t.artista || '')} · ${escapeHtml(t.album || '')}</div>
            </div>
            <span class="pv-track-time">${escapeHtml(formatHours(t.msListened))} · ${t.playCount}×</span>
        </li>
    `).join('') + '</ul>';
}

function renderWidgetTopAlbums(p) {
    if (!p.topAlbums?.length) return '<div class="muted">Aún no has valorado álbumes.</div>';
    return '<div class="pv-album-grid">' + p.topAlbums.map(a => {
        const cover = a.coverUrl
            ? `<div class="pv-album-cover" style="background-image:url('${API_BASE + a.coverUrl}?t=${encodeURIComponent(token)}')"></div>`
            : `<div class="pv-album-cover">${escapeHtml(initials(a.titulo))}</div>`;
        return `
            <div class="pv-album">
                ${cover}
                <div class="pv-album-title">${escapeHtml(a.titulo || '')}</div>
                <div class="pv-album-meta muted small">${escapeHtml(a.artista || '')} · ★${a.rating?.toFixed(1) ?? '—'}</div>
            </div>
        `;
    }).join('') + '</div>';
}

function renderWidgetFriends(p) {
    if (!p.friends?.length) return '<div class="muted">Aún no tienes amigos.</div>';
    return '<div class="pv-friends">' + p.friends.map(f => {
        const photo = f.photoUrl
            ? `<div class="pv-friend-photo" style="background-image:url('${API_BASE + f.photoUrl}?t=${encodeURIComponent(token)}')"></div>`
            : `<div class="pv-friend-photo">${escapeHtml(initials(f.displayName || f.username))}</div>`;
        return `
            <a class="pv-friend" data-username="${escapeHtml(f.username)}">
                ${photo}
                <div class="pv-friend-name">${escapeHtml(f.displayName || f.username)}</div>
            </a>
        `;
    }).join('') + '</div>';
}

function renderWidgetAnticipated(spec, p) {
    if (!spec.title) return '<div class="muted">Aún sin álbum anticipado.</div>';
    const note = spec.note ? `<p class="pv-anticipated-note">${escapeHtml(spec.note)}</p>` : '';
    return `
        <div class="pv-anticipated">
            <div class="pv-anticipated-title">${escapeHtml(spec.title)}</div>
            ${spec.artist ? `<div class="pv-anticipated-artist muted small">${escapeHtml(spec.artist)}</div>` : ''}
            ${note}
        </div>
    `;
}

// Renderiza el HTML personalizado del usuario en un iframe sandboxed.
// Sin allow-same-origin / allow-scripts: el HTML no puede ejecutar JS, no
// accede a la DOM ni cookies del padre. Sólo HTML+CSS estático.
function buildAdvancedFrame(html) {
    const wrap = document.createElement('div');
    wrap.className = 'pv-body';
    const iframe = document.createElement('iframe');
    iframe.className = 'pv-advanced-frame';
    iframe.setAttribute('sandbox', '');
    iframe.setAttribute('referrerpolicy', 'no-referrer');
    iframe.title = 'Perfil personalizado';
    iframe.srcdoc = `<!doctype html><meta charset="utf-8">
<style>
  body { margin:0; padding:24px; font-family: 'Segoe UI', Tahoma, sans-serif;
         background: #121212; color: #ffffff; }
  img, video { max-width: 100%; }
  a { color: #1db954; }
</style>
${html}`;
    wrap.appendChild(iframe);
    return wrap;
}

// Listener de clicks: abre la pestaña pública de un amigo o la pestaña de
// artista cuando se pulsa una tarjeta correspondiente. (Delegado en el
// document, así no hay que recablear cada render.)
document.addEventListener('click', (e) => {
    const friend = e.target.closest('.pv-friend');
    if (friend && friend.dataset.username) {
        e.preventDefault();
        openOrFocusTab('profile', { name: friend.dataset.username });
        return;
    }
    const artistCard = e.target.closest('.pv-artist[data-artist]');
    if (artistCard) {
        e.preventDefault();
        openOrFocusTab('artist', { name: artistCard.dataset.artist });
    }
});

