// Password hashing (PBKDF2-SHA256, JDK-style) + user repo + session store.
// All synchronous — runs in Electron main process so blocking is fine for these
// short operations.

const crypto = require('crypto');
const db = require('./db');

const ITERATIONS = 200_000;
const KEYLEN = 32;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 días

// --- password ---------------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, 'sha256');
  return {
    hash: hash.toString('base64'),
    salt: salt.toString('base64'),
    iter: ITERATIONS,
  };
}

function verifyPassword(password, hashB64, saltB64, iter) {
  const salt = Buffer.from(saltB64, 'base64');
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.pbkdf2Sync(password, salt, iter, expected.length, 'sha256');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// --- users ------------------------------------------------------------------

function normalizeUsername(u) {
  return (u || '').trim().toLowerCase();
}

function hasAnyUser() {
  return db.get().prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
}

function createUser(username, password, opts = {}) {
  const norm = normalizeUsername(username);
  if (!norm) throw new Error('username vacío');
  if (!password || password.length < 6) {
    throw new Error('La contraseña debe tener al menos 6 caracteres');
  }
  const email = (opts.email || '').trim() || null;
  const { hash, salt, iter } = hashPassword(password);
  const info = db.get().prepare(
    `INSERT INTO users (username, pass_hash, salt, iter_count, created_at, email)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(norm, hash, salt, iter, Date.now(), email);
  return { id: info.lastInsertRowid, username: norm };
}

function verifyUser(username, password) {
  const norm = normalizeUsername(username);
  const row = db.get().prepare(
    'SELECT id, username, pass_hash, salt, iter_count FROM users WHERE username = ?'
  ).get(norm);
  if (!row) return null;
  const ok = verifyPassword(password, row.pass_hash, row.salt, row.iter_count);
  return ok ? { id: row.id, username: row.username } : null;
}

const PROFILE_FIELDS = `
  id, username, email, photo_path, email_verified, created_at,
  display_name, description, profile_widgets, profile_html, advanced_mode,
  profile_background, profile_frame
`;

function userById(id) {
  const row = db.get().prepare(
    `SELECT ${PROFILE_FIELDS} FROM users WHERE id = ?`
  ).get(id);
  return row || null;
}

function userByUsername(username) {
  const norm = normalizeUsername(username);
  const row = db.get().prepare(
    `SELECT ${PROFILE_FIELDS} FROM users WHERE username = ?`
  ).get(norm);
  return row || null;
}

function setProfilePhoto(userId, photoPath) {
  db.get().prepare('UPDATE users SET photo_path = ? WHERE id = ?').run(photoPath || null, userId);
}

function setProfileBackground(userId, bgPath) {
  db.get().prepare('UPDATE users SET profile_background = ? WHERE id = ?').run(bgPath || null, userId);
}

function setProfileFrame(userId, framePath) {
  db.get().prepare('UPDATE users SET profile_frame = ? WHERE id = ?').run(framePath || null, userId);
}

// Aplica un parche parcial a la fila del usuario. Sólo se aceptan los campos
// listados (whitelist). Devuelve el row completo actualizado.
const PATCHABLE = new Set([
  'display_name', 'email', 'description',
  'profile_widgets', 'profile_html', 'advanced_mode',
  'ui_settings',
]);
function patchUser(userId, patch) {
  const sets = [];
  const args = [];
  for (const [k, v] of Object.entries(patch || {})) {
    if (!PATCHABLE.has(k)) continue;
    sets.push(`${k} = ?`);
    args.push(v == null ? null : (typeof v === 'boolean' ? (v ? 1 : 0) : v));
  }
  if (!sets.length) return userById(userId);
  args.push(userId);
  db.get().prepare(`UPDATE users SET ${sets.join(', ')} WHERE id = ?`).run(...args);
  return userById(userId);
}

// --- sessions ---------------------------------------------------------------

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function issueSession(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const now = Date.now();
  const expiresAt = now + SESSION_TTL_MS;
  db.get().prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
     VALUES (?, ?, ?, ?)`
  ).run(sha256Hex(token), userId, now, expiresAt);
  return { token, expiresAt };
}

function verifySession(token) {
  if (!token) return null;
  const row = db.get().prepare(
    'SELECT user_id, expires_at FROM sessions WHERE token_hash = ?'
  ).get(sha256Hex(token));
  if (!row) return null;
  if (Date.now() >= row.expires_at) {
    db.get().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(token));
    return null;
  }
  return row.user_id;
}

function revokeSession(token) {
  if (!token) return;
  db.get().prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(token));
}

module.exports = {
  hasAnyUser, createUser, verifyUser, userById, userByUsername,
  setProfilePhoto, setProfileBackground, setProfileFrame, patchUser,
  issueSession, verifySession, revokeSession,
};
