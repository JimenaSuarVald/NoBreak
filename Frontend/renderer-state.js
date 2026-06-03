// renderer-state.js — global state + DOM helpers + bottom-of-file utilities.
// Must be the FIRST renderer-*.js loaded so its let/const bindings exist when
// the other scripts execute (in non-module scripts, top-level let/const are
// visible across scripts but NOT on window).

// Renderer logic. Sandboxed BrowserWindow with window.api exposed by preload.js.
// Auth + library data go over HTTP (same path the website uses); native ops
// (folder picker, settings) go over IPC.

const $ = (id) => document.getElementById(id);

// --- State -----------------------------------------------------------------
let API_BASE = 'http://127.0.0.1:8080';
let token = null;
let username = null;

let library = { albums: [], artists: [] };  // populated from /api/library
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

// Set de IDs (Number) de tracks que el usuario ha marcado como "Me Gusta".
// Se carga en showApp() (vía loadLikedTrackIds) y se actualiza en cada
// toggle. El renderer lo consulta para pintar el corazón relleno/abierto.
let likedTrackIds = new Set();

// Objeto track que está sonando ahora mismo. Se setea en playTrack y lo lee
// refreshFooterRating para pintar el rating de la canción en el footer.
let currentPlayingTrack = null;

// Tabs Chrome-like (data-driven, drag/close/+, persiste en localStorage).
const TAB_TYPES = {
    albums:    { label: 'Álbumes',  closeable: true },
    artists:   { label: 'Artistas', closeable: true },
    genres:    { label: 'Géneros',  closeable: true },
    playlists: { label: 'Listas',   closeable: true },
    settings:  { label: 'Ajustes',  closeable: true, icon: 'settings' },
};
let tabs = [];
let activeTabId = null;
let tabSeq = 0;



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

// Separa una cadena de artista capturando también el separador, para poder
// reconstruir el texto visible respetando si era "A & B" o "A feat. B".
// Mismo set de separadores que el backend (ver webserver.js).
const ARTIST_SPLIT_RE = /(\s*&\s*|\s*;\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+vs\.?\s+)/i;
function splitArtistParts(str) {
    if (!str) return [];
    const raw = String(str).split(ARTIST_SPLIT_RE);  // [name, sep, name, sep, ...]
    const out = [];
    for (let i = 0; i < raw.length; i += 2) {
        const name = (raw[i] || '').trim();
        if (!name) continue;
        out.push({ name, sep: raw[i + 1] || null });
    }
    if (out.length) out[out.length - 1].sep = null;
    return out;
}

// HTML para el bloque "artista" de un álbum: cada componente como un .meta-artist
// clickable, separados por el separador original (& / feat. / etc).
function renderArtistMetaHtml(str) {
    const parts = splitArtistParts(str);
    if (!parts.length) return '';
    return parts.map(p => {
        const span = `<span class="meta-artist" data-artist="${escapeHtml(p.name)}">${escapeHtml(p.name)}</span>`;
        return span + (p.sep ? escapeHtml(p.sep) : '');
    }).join('');
}
