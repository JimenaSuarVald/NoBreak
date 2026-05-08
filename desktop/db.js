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
`;

function init(dbPath) {
  if (db) return db;
  db = new Database(dbPath);
  db.exec(SCHEMA);
  return db;
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

module.exports = {
  init, get, close,
  getSetting, setSetting,
  getLibraryFolder, setLibraryFolder,
};
