// SQLite layer for the NoBreak desktop app.
// Schema: users + sessions + app_settings + tracks + scan_errors.
// Single connection owned by the Electron main process.

const Database = require('better-sqlite3');

let db = null;

const SCHEMA = `
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    pass_hash TEXT NOT NULL,
    salt TEXT NOT NULL,
    iter_count INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS tracks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT UNIQUE NOT NULL,
    titulo TEXT,
    artista TEXT,
    album TEXT,
    albumartist TEXT,
    year INTEGER,
    genre TEXT,
    track_no INTEGER,
    disc_no INTEGER,
    duration_ms INTEGER,
    codec TEXT,
    cover_path TEXT,
    size_bytes INTEGER,
    mtime INTEGER,
    last_parsed INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_tracks_album ON tracks(album, albumartist);
  CREATE INDEX IF NOT EXISTS idx_tracks_artist ON tracks(artista);

  CREATE TABLE IF NOT EXISTS scan_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    path TEXT NOT NULL,
    error TEXT,
    occurred_at INTEGER
  );

  -- Cached artist descriptions fetched from Wikipedia / Last.fm.
  -- Keyed by lower-cased artist name so "Boards Of Canada" and "boards of canada"
  -- share an entry. raw_json keeps the full upstream payload for forward use.
  CREATE TABLE IF NOT EXISTS artist_info (
    artist_norm TEXT PRIMARY KEY,
    source      TEXT NOT NULL,
    name        TEXT,
    extract     TEXT,
    thumbnail   TEXT,
    url         TEXT,
    raw_json    TEXT,
    fetched_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playlists (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT UNIQUE NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS playlist_tracks (
    playlist_id INTEGER NOT NULL,
    track_id    INTEGER NOT NULL,
    position    INTEGER NOT NULL,
    added_at    INTEGER NOT NULL,
    PRIMARY KEY (playlist_id, track_id),
    FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
    FOREIGN KEY (track_id)    REFERENCES tracks(id)    ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_pltracks_playlist ON playlist_tracks(playlist_id, position);

  -- Valoración personal por usuario y álbum (0.5–5.0 en pasos de 0.5).
  -- album_key = "<album_lower>\x1f<albumartist_lower>" — independiente del id
  -- numérico (que cambia al re-escanear) para que sobreviva a borrados/recreaciones.
  CREATE TABLE IF NOT EXISTS album_ratings (
    user_id    INTEGER NOT NULL,
    album_key  TEXT NOT NULL,
    rating     REAL NOT NULL,
    rated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, album_key),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Tiempo escuchado acumulado por usuario y artista. Para "horas totales"
  -- sumar la columna ms_listened. Para "top artistas" ORDER BY ms_listened DESC.
  CREATE TABLE IF NOT EXISTS listen_stats (
    user_id        INTEGER NOT NULL,
    artist         TEXT NOT NULL,
    ms_listened    INTEGER NOT NULL DEFAULT 0,
    last_played_at INTEGER,
    PRIMARY KEY (user_id, artist),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Tiempo + reproducciones por canción para "canciones más escuchadas".
  CREATE TABLE IF NOT EXISTS track_listens (
    user_id        INTEGER NOT NULL,
    track_id       INTEGER NOT NULL,
    ms_listened    INTEGER NOT NULL DEFAULT 0,
    play_count     INTEGER NOT NULL DEFAULT 0,
    last_played_at INTEGER,
    PRIMARY KEY (user_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_track_listens_user ON track_listens(user_id, ms_listened DESC);

  -- Amigos: cada lado guarda su propia fila (relación dirigida pero la usamos
  -- de forma simétrica creando ambas al añadir).
  CREATE TABLE IF NOT EXISTS friends (
    user_id    INTEGER NOT NULL,
    friend_id  INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, friend_id),
    FOREIGN KEY (user_id)   REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (friend_id) REFERENCES users(id) ON DELETE CASCADE
  );

  -- Cache de respuestas de MusicBrainz para álbumes. Una entrada por
  -- (album_lower, artist_lower) — los tags y la descripción no cambian
  -- mucho, así que aceptamos servir cache de hasta 30 días.
  CREATE TABLE IF NOT EXISTS mb_album_cache (
    album_key      TEXT PRIMARY KEY,    -- "<album_lower>\x1f<artist_lower>"
    mbid           TEXT,                -- release-group id de MB
    title          TEXT,
    artist         TEXT,
    first_release  TEXT,                -- yyyy-mm-dd, MIN(release.date) del grupo
    label          TEXT,                -- nombre de la discográfica principal
    description    TEXT,                -- wiki/disambiguation/annotation si la hay
    tags_json      TEXT NOT NULL,       -- JSON [{name, count}, ...] ordenado por count desc
    fetched_at     INTEGER NOT NULL
  );

  -- Igual pero para artistas. Key = nombre en minúsculas (split-aware).
  CREATE TABLE IF NOT EXISTS mb_artist_cache (
    artist_key     TEXT PRIMARY KEY,    -- artista en minúsculas
    mbid           TEXT,
    name           TEXT,
    tags_json      TEXT NOT NULL,
    fetched_at     INTEGER NOT NULL
  );

  -- Portada personalizada por género (sin id propio: el género es virtual
  -- y se identifica por su nombre normalizado).
  CREATE TABLE IF NOT EXISTS genre_covers (
    name_key      TEXT PRIMARY KEY,     -- nombre en minúsculas
    name          TEXT NOT NULL,        -- nombre tal cual lo vio el usuario
    cover_path    TEXT NOT NULL,
    updated_at    INTEGER NOT NULL
  );

  -- Cola de scrobbles pendientes cuando track.scrobble falla (típicamente
  -- por falta de red). Cada fila es un único scrobble; al recuperar
  -- conectividad se vacían en orden cronológico y se borran al éxito.
  CREATE TABLE IF NOT EXISTS lastfm_scrobble_queue (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL,
    artist        TEXT NOT NULL,
    track         TEXT NOT NULL,
    album         TEXT,
    started_at    INTEGER NOT NULL,     -- timestamp UNIX en ms
    duration_ms   INTEGER,
    attempts      INTEGER NOT NULL DEFAULT 0,
    enqueued_at   INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_scrobble_queue_user ON lastfm_scrobble_queue(user_id, started_at);

  -- Valoración por canción y usuario (0.5–5.0 en pasos de 0.5). La
   -- valoración de un álbum se DERIVA como AVG(track_ratings) — el usuario
   -- ya no rate álbumes a mano, solo canciones, y el álbum hereda la media.
   -- album_ratings sigue existiendo pero deja de leerse desde la app.
  CREATE TABLE IF NOT EXISTS track_ratings (
    user_id    INTEGER NOT NULL,
    track_id   INTEGER NOT NULL,
    rating     REAL NOT NULL,
    rated_at   INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id)  ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_track_ratings_user ON track_ratings(user_id);

  -- Canciones favoritas por usuario. Cada like es una fila individual.
  -- Comparte schema con playlist_tracks pero conceptualmente independiente:
  -- "Me Gusta" es una playlist virtual gestionada por la app, no por el
  -- usuario (no se puede renombrar/borrar). liked_at sirve de orden.
  CREATE TABLE IF NOT EXISTS liked_tracks (
    user_id   INTEGER NOT NULL,
    track_id  INTEGER NOT NULL,
    liked_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, track_id),
    FOREIGN KEY (user_id) REFERENCES users(id)  ON DELETE CASCADE,
    FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_liked_user ON liked_tracks(user_id, liked_at DESC);
`;

function init(dbPath) {
  if (db) return db;
  db = new Database(dbPath);
  db.exec(SCHEMA);
  migrate();
  return db;
}

// Migraciones idempotentes para DBs creadas con versiones anteriores del schema.
// SQLite no falla si la columna ya existe sólo si lo comprobamos antes; usamos
// PRAGMA table_info y filtramos.
function migrate() {
  const aiCols = db.prepare(`PRAGMA table_info(artist_info)`).all().map(c => c.name);
  if (!aiCols.includes('image_large')) {
    db.exec(`ALTER TABLE artist_info ADD COLUMN image_large TEXT`);
  }
  // users: campos opcionales añadidos para registro v2 (email + foto + verif)
  // y v3 (perfil personalizable: display_name, descripción, layout de widgets,
  // HTML avanzado).
  const uCols = db.prepare(`PRAGMA table_info(users)`).all().map(c => c.name);
  if (!uCols.includes('email'))            db.exec(`ALTER TABLE users ADD COLUMN email TEXT`);
  if (!uCols.includes('photo_path'))       db.exec(`ALTER TABLE users ADD COLUMN photo_path TEXT`);
  if (!uCols.includes('email_verified'))   db.exec(`ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0`);
  if (!uCols.includes('display_name'))       db.exec(`ALTER TABLE users ADD COLUMN display_name TEXT`);
  if (!uCols.includes('description'))        db.exec(`ALTER TABLE users ADD COLUMN description TEXT`);
  if (!uCols.includes('profile_widgets'))    db.exec(`ALTER TABLE users ADD COLUMN profile_widgets TEXT`);
  if (!uCols.includes('profile_html'))       db.exec(`ALTER TABLE users ADD COLUMN profile_html TEXT`);
  if (!uCols.includes('advanced_mode'))      db.exec(`ALTER TABLE users ADD COLUMN advanced_mode INTEGER NOT NULL DEFAULT 0`);
  if (!uCols.includes('profile_background')) db.exec(`ALTER TABLE users ADD COLUMN profile_background TEXT`);
  if (!uCols.includes('profile_frame'))      db.exec(`ALTER TABLE users ADD COLUMN profile_frame TEXT`);
  // Last.fm scrobbling: clave de sesión por usuario + nombre del usuario en Last.fm.
  if (!uCols.includes('lastfm_session_key')) db.exec(`ALTER TABLE users ADD COLUMN lastfm_session_key TEXT`);
  if (!uCols.includes('lastfm_username'))    db.exec(`ALTER TABLE users ADD COLUMN lastfm_username TEXT`);
  // Settings de UI sincronizados entre desktop y web. JSON serializado con
  // todas las claves localStorage 'nobreak-*' (tema, accesibilidad, tamaño
  // de tarjetas, etc.). El renderer escribe vía PATCH /auth/me y al iniciar
  // sesión hace pull para hidratar localStorage.
  if (!uCols.includes('ui_settings'))        db.exec(`ALTER TABLE users ADD COLUMN ui_settings TEXT`);

  // Portada personalizada para playlists.
  const pCols = db.prepare(`PRAGMA table_info(playlists)`).all().map(c => c.name);
  if (!pCols.includes('cover_path')) db.exec(`ALTER TABLE playlists ADD COLUMN cover_path TEXT`);
}

function get() {
  if (!db) throw new Error('DB not initialised — call init(path) first');
  return db;
}

function close() {
  if (db) { db.close(); db = null; }
}

// --- app_settings helpers ---------------------------------------------------

function getSetting(key) {
  const row = get().prepare('SELECT value FROM app_settings WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  get().prepare(
    `INSERT INTO app_settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

const KEY_LIBRARY_FOLDER = 'library_folder';

function getLibraryFolder() { return getSetting(KEY_LIBRARY_FOLDER); }
function setLibraryFolder(p) { setSetting(KEY_LIBRARY_FOLDER, p); }

// --- album rating helpers ---------------------------------------------------

const RATING_SEP = '\x1f';

function albumKey(album, albumartist) {
  return (album || '').trim().toLowerCase() + RATING_SEP + (albumartist || '').trim().toLowerCase();
}

function getAlbumRating(userId, key) {
  const row = get().prepare(
    'SELECT rating FROM album_ratings WHERE user_id = ? AND album_key = ?'
  ).get(userId, key);
  return row ? row.rating : null;
}

function setAlbumRating(userId, key, rating) {
  if (rating == null) {
    get().prepare(
      'DELETE FROM album_ratings WHERE user_id = ? AND album_key = ?'
    ).run(userId, key);
    return null;
  }
  const v = Math.round(Number(rating) * 2) / 2;
  if (!(v >= 0.5 && v <= 5)) throw new Error('Rating fuera de rango (0.5–5)');
  get().prepare(`
    INSERT INTO album_ratings (user_id, album_key, rating, rated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, album_key) DO UPDATE SET
      rating = excluded.rating,
      rated_at = excluded.rated_at
  `).run(userId, key, v, Date.now());
  return v;
}

function getAllAlbumRatings(userId) {
  const rows = get().prepare(
    'SELECT album_key, rating FROM album_ratings WHERE user_id = ?'
  ).all(userId);
  const map = new Map();
  for (const r of rows) map.set(r.album_key, r.rating);
  return map;
}

// --- listen_stats helpers ---------------------------------------------------

function addListenedMs(userId, artist, ms) {
  const a = (artist || '').trim();
  if (!a || !ms || ms <= 0) return;
  get().prepare(`
    INSERT INTO listen_stats (user_id, artist, ms_listened, last_played_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, artist) DO UPDATE SET
      ms_listened = ms_listened + excluded.ms_listened,
      last_played_at = excluded.last_played_at
  `).run(userId, a, Math.round(ms), Date.now());
}

function getListenStatsForUser(userId, limit = 100) {
  return get().prepare(`
    SELECT artist, ms_listened, last_played_at
    FROM listen_stats
    WHERE user_id = ?
    ORDER BY ms_listened DESC
    LIMIT ?
  `).all(userId, limit);
}

function getTotalListenedMs(userId) {
  const r = get().prepare(
    'SELECT COALESCE(SUM(ms_listened), 0) AS total FROM listen_stats WHERE user_id = ?'
  ).get(userId);
  return r ? r.total : 0;
}

// --- track_listens helpers --------------------------------------------------

function addTrackListen(userId, trackId, ms, plays = 0) {
  if (!Number.isFinite(trackId) || ms < 0) return;
  get().prepare(`
    INSERT INTO track_listens (user_id, track_id, ms_listened, play_count, last_played_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(user_id, track_id) DO UPDATE SET
      ms_listened = ms_listened + excluded.ms_listened,
      play_count  = play_count  + excluded.play_count,
      last_played_at = excluded.last_played_at
  `).run(userId, trackId, Math.round(ms), plays, Date.now());
}

function getTopTracks(userId, limit = 10) {
  return get().prepare(`
    SELECT tl.track_id AS id, tl.ms_listened, tl.play_count, tl.last_played_at,
           t.titulo, t.artista, t.album, t.cover_path, t.duration_ms
    FROM track_listens tl
    JOIN tracks t ON t.id = tl.track_id
    WHERE tl.user_id = ?
    ORDER BY tl.ms_listened DESC
    LIMIT ?
  `).all(userId, limit);
}

// --- friends helpers --------------------------------------------------------

function addFriend(userId, friendId) {
  if (userId === friendId) throw new Error('No puedes añadirte a ti mismo');
  const stmt = get().prepare(
    `INSERT OR IGNORE INTO friends (user_id, friend_id, created_at) VALUES (?, ?, ?)`
  );
  // Bidireccional: añadimos las dos filas en una transacción.
  const t = get().transaction(() => {
    stmt.run(userId, friendId, Date.now());
    stmt.run(friendId, userId, Date.now());
  });
  t();
}

function removeFriend(userId, friendId) {
  const stmt = get().prepare(
    'DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)'
  );
  stmt.run(userId, friendId, friendId, userId);
}

// --- Last.fm per-user auth --------------------------------------------------

function setLastfmAuth(userId, sessionKey, username) {
  get().prepare(
    `UPDATE users SET lastfm_session_key = ?, lastfm_username = ? WHERE id = ?`
  ).run(sessionKey, username, userId);
}

function clearLastfmAuth(userId) {
  get().prepare(
    `UPDATE users SET lastfm_session_key = NULL, lastfm_username = NULL WHERE id = ?`
  ).run(userId);
}

function getLastfmAuth(userId) {
  return get().prepare(
    `SELECT lastfm_session_key AS session_key, lastfm_username AS username FROM users WHERE id = ?`
  ).get(userId) || null;
}

// --- MusicBrainz cache -----------------------------------------------------

function mbAlbumKey(album, artist) {
  return (album || '').trim().toLowerCase() + RATING_SEP + (artist || '').trim().toLowerCase();
}

function getMbAlbumCache(album, artist) {
  return get().prepare(
    `SELECT album_key, mbid, title, artist, first_release, label, description, tags_json, fetched_at
       FROM mb_album_cache WHERE album_key = ?`
  ).get(mbAlbumKey(album, artist)) || null;
}

function setMbAlbumCache(album, artist, payload) {
  get().prepare(`
    INSERT INTO mb_album_cache
      (album_key, mbid, title, artist, first_release, label, description, tags_json, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(album_key) DO UPDATE SET
      mbid          = excluded.mbid,
      title         = excluded.title,
      artist        = excluded.artist,
      first_release = excluded.first_release,
      label         = excluded.label,
      description   = excluded.description,
      tags_json     = excluded.tags_json,
      fetched_at    = excluded.fetched_at
  `).run(
    mbAlbumKey(album, artist),
    payload.mbid || null,
    payload.title || album || null,
    payload.artist || artist || null,
    payload.first_release || null,
    payload.label || null,
    payload.description || null,
    JSON.stringify(payload.tags || []),
    Date.now()
  );
}

function getMbArtistCache(artistName) {
  const k = (artistName || '').trim().toLowerCase();
  if (!k) return null;
  return get().prepare(
    `SELECT artist_key, mbid, name, tags_json, fetched_at FROM mb_artist_cache WHERE artist_key = ?`
  ).get(k) || null;
}

function setMbArtistCache(artistName, payload) {
  const k = (artistName || '').trim().toLowerCase();
  if (!k) return;
  get().prepare(`
    INSERT INTO mb_artist_cache (artist_key, mbid, name, tags_json, fetched_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(artist_key) DO UPDATE SET
      mbid       = excluded.mbid,
      name       = excluded.name,
      tags_json  = excluded.tags_json,
      fetched_at = excluded.fetched_at
  `).run(k, payload.mbid || null, payload.name || artistName, JSON.stringify(payload.tags || []), Date.now());
}

// Devuelve sólo los tags cacheados, parseando el JSON. Sirve para pintar
// pills sin tener que reconsultar MusicBrainz desde el renderer.
function getAllMbAlbumTags() {
  const rows = get().prepare(`SELECT album_key, tags_json FROM mb_album_cache`).all();
  return rows.map(r => ({ album_key: r.album_key, tags: safeParseArray(r.tags_json) }));
}

function getAllMbArtistTags() {
  const rows = get().prepare(`SELECT artist_key, tags_json FROM mb_artist_cache`).all();
  return rows.map(r => ({ artist_key: r.artist_key, tags: safeParseArray(r.tags_json) }));
}

// --- Portada de playlists --------------------------------------------------
function setPlaylistCover(playlistId, path) {
  get().prepare(`UPDATE playlists SET cover_path = ?, updated_at = ? WHERE id = ?`)
    .run(path || null, Date.now(), playlistId);
}
function getPlaylistCover(playlistId) {
  const r = get().prepare(`SELECT cover_path FROM playlists WHERE id = ?`).get(playlistId);
  return r?.cover_path || null;
}

// --- Portada de género (virtual) -------------------------------------------
function setGenreCover(name, path) {
  const k = (name || '').toLowerCase().trim();
  if (!k) return;
  if (!path) {
    get().prepare(`DELETE FROM genre_covers WHERE name_key = ?`).run(k);
    return;
  }
  get().prepare(`
    INSERT INTO genre_covers (name_key, name, cover_path, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(name_key) DO UPDATE SET
      name = excluded.name,
      cover_path = excluded.cover_path,
      updated_at = excluded.updated_at
  `).run(k, name, path, Date.now());
}
function getGenreCover(name) {
  const k = (name || '').toLowerCase().trim();
  if (!k) return null;
  const r = get().prepare(`SELECT cover_path FROM genre_covers WHERE name_key = ?`).get(k);
  return r?.cover_path || null;
}
function getAllGenreCovers() {
  return get().prepare(`SELECT name_key, name, cover_path FROM genre_covers`).all();
}

// --- Cola de scrobbles offline --------------------------------------------
function enqueueScrobble(userId, item) {
  get().prepare(`
    INSERT INTO lastfm_scrobble_queue
      (user_id, artist, track, album, started_at, duration_ms, attempts, enqueued_at)
    VALUES (?, ?, ?, ?, ?, ?, 0, ?)
  `).run(userId,
    String(item.artist), String(item.track),
    item.album || null,
    Number(item.startedAt) || Date.now(),
    Number(item.durationMs) || null,
    Date.now()
  );
}
function getQueuedScrobbles(userId, limit = 50) {
  return get().prepare(`
    SELECT id, artist, track, album, started_at, duration_ms, attempts
    FROM lastfm_scrobble_queue WHERE user_id = ?
    ORDER BY started_at LIMIT ?
  `).all(userId, limit);
}
function removeQueuedScrobble(id) {
  get().prepare(`DELETE FROM lastfm_scrobble_queue WHERE id = ?`).run(id);
}
function bumpQueuedScrobbleAttempts(id) {
  get().prepare(`UPDATE lastfm_scrobble_queue SET attempts = attempts + 1 WHERE id = ?`).run(id);
}
function countQueuedScrobbles(userId) {
  return get().prepare(`SELECT COUNT(*) AS n FROM lastfm_scrobble_queue WHERE user_id = ?`).get(userId).n;
}
function listUsersWithQueuedScrobbles() {
  return get().prepare(`SELECT DISTINCT user_id FROM lastfm_scrobble_queue`).all().map(r => r.user_id);
}

// --- Valoración por canción (track_ratings) ------------------------------

function setTrackRating(userId, trackId, rating) {
  if (rating == null) return clearTrackRating(userId, trackId);
  const v = Math.round(Number(rating) * 2) / 2;
  if (!(v >= 0.5 && v <= 5)) throw new Error('Rating fuera de rango (0.5–5)');
  get().prepare(`
    INSERT INTO track_ratings (user_id, track_id, rating, rated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id, track_id) DO UPDATE SET
      rating   = excluded.rating,
      rated_at = excluded.rated_at
  `).run(userId, trackId, v, Date.now());
  return v;
}
function clearTrackRating(userId, trackId) {
  get().prepare(
    'DELETE FROM track_ratings WHERE user_id = ? AND track_id = ?'
  ).run(userId, trackId);
  return null;
}
function getTrackRating(userId, trackId) {
  const r = get().prepare(
    'SELECT rating FROM track_ratings WHERE user_id = ? AND track_id = ?'
  ).get(userId, trackId);
  return r ? r.rating : null;
}
// Devuelve Map<trackId, rating> para todos los tracks valorados del usuario.
// Usado por queryTracksOfAlbum para incluir el rating en cada track del JSON.
function getAllTrackRatings(userId) {
  const rows = get().prepare(
    'SELECT track_id, rating FROM track_ratings WHERE user_id = ?'
  ).all(userId);
  const map = new Map();
  for (const r of rows) map.set(r.track_id, r.rating);
  return map;
}
// Map<albumKey, {avg, count}> con la media de ratings de los tracks de cada
// álbum del usuario. albumKey = "<album_lower>\x1f<artist_lower>" — mismo
// formato que db.albumKey() para que ambas funciones casen.
function getAlbumAvgRatings(userId) {
  const rows = get().prepare(`
    SELECT
      LOWER(t.album) AS album_lc,
      LOWER(COALESCE(t.albumartist, t.artista)) AS artist_lc,
      AVG(tr.rating) AS avg,
      COUNT(tr.rating) AS cnt
    FROM tracks t
    JOIN track_ratings tr ON tr.track_id = t.id AND tr.user_id = ?
    WHERE t.album IS NOT NULL AND t.album <> ''
    GROUP BY LOWER(t.album), LOWER(COALESCE(t.albumartist, t.artista))
  `).all(userId);
  const map = new Map();
  for (const r of rows) {
    map.set(r.album_lc + RATING_SEP + r.artist_lc, {
      avg: r.avg,
      count: r.cnt,
    });
  }
  return map;
}

// --- Me Gusta (liked_tracks) ---------------------------------------------

function likeTrack(userId, trackId) {
  get().prepare(
    `INSERT OR IGNORE INTO liked_tracks (user_id, track_id, liked_at)
     VALUES (?, ?, ?)`
  ).run(userId, trackId, Date.now());
}
function unlikeTrack(userId, trackId) {
  get().prepare(
    `DELETE FROM liked_tracks WHERE user_id = ? AND track_id = ?`
  ).run(userId, trackId);
}
function isTrackLiked(userId, trackId) {
  const r = get().prepare(
    `SELECT 1 FROM liked_tracks WHERE user_id = ? AND track_id = ?`
  ).get(userId, trackId);
  return !!r;
}
function getLikedTrackIdsForUser(userId) {
  return get().prepare(
    `SELECT track_id FROM liked_tracks WHERE user_id = ? ORDER BY liked_at DESC`
  ).all(userId).map(r => r.track_id);
}
function countLikedTracksForUser(userId) {
  return get().prepare(
    `SELECT COUNT(*) AS n FROM liked_tracks WHERE user_id = ?`
  ).get(userId).n;
}
// Tracks completos para pintar el drawer "Me Gusta" o el widget del perfil.
function getLikedTracksForUser(userId, limit = 1000) {
  return get().prepare(`
    SELECT t.id, t.titulo, t.artista, t.album, t.albumartist, t.year, t.genre,
           t.duration_ms, t.cover_path, l.liked_at
    FROM liked_tracks l
    JOIN tracks t ON t.id = l.track_id
    WHERE l.user_id = ?
    ORDER BY l.liked_at DESC
    LIMIT ?
  `).all(userId, limit);
}

function safeParseArray(json) {
  if (!json) return [];
  try { const v = JSON.parse(json); return Array.isArray(v) ? v : []; }
  catch { return []; }
}

function listFriends(userId) {
  return get().prepare(`
    SELECT u.id, u.username, u.display_name, u.photo_path, f.created_at
    FROM friends f
    JOIN users u ON u.id = f.friend_id
    WHERE f.user_id = ?
    ORDER BY u.username
  `).all(userId);
}

module.exports = {
  init, get, close,
  getSetting, setSetting,
  getLibraryFolder, setLibraryFolder,
  albumKey, getAlbumRating, setAlbumRating, getAllAlbumRatings,
  addListenedMs, getListenStatsForUser, getTotalListenedMs,
  addTrackListen, getTopTracks,
  setLastfmAuth, clearLastfmAuth, getLastfmAuth,
  getMbAlbumCache, setMbAlbumCache, getMbArtistCache, setMbArtistCache,
  getAllMbAlbumTags, getAllMbArtistTags, mbAlbumKey,
  setPlaylistCover, getPlaylistCover,
  setGenreCover, getGenreCover, getAllGenreCovers,
  enqueueScrobble, getQueuedScrobbles, removeQueuedScrobble,
  bumpQueuedScrobbleAttempts, countQueuedScrobbles, listUsersWithQueuedScrobbles,
  addFriend, removeFriend, listFriends,
  likeTrack, unlikeTrack, isTrackLiked, getLikedTrackIdsForUser,
  countLikedTracksForUser, getLikedTracksForUser,
  setTrackRating, clearTrackRating, getTrackRating,
  getAllTrackRatings, getAlbumAvgRatings,
};
