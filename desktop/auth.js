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

function createUser(username, password) {
  const norm = normalizeUsername(username);
  if (!norm) throw new Error('username vacío');
  if (!password || password.length < 6) {
    throw new Error('La contraseña debe tener al menos 6 caracteres');
  }
  const { hash, salt, iter } = hashPassword(password);
  const info = db.get().prepare(
    `INSERT INTO users (username, pass_hash, salt, iter_count, created_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(norm, hash, salt, iter, Date.now());
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

function userById(id) {
  const row = db.get().prepare('SELECT id, username FROM users WHERE id = ?').get(id);
  return row || null;
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
  hasAnyUser, createUser, verifyUser, userById,
  issueSession, verifySession, revokeSession,
};
