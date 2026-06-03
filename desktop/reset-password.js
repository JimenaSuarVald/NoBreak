// Restablecer contraseña de un usuario directamente en la BD.
// Uso (con Electron como Node):
//   ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron reset-password.js <username> <newPassword>
//
// Pensado para emergencias (el usuario olvidó su contraseña). El hashing
// usa el mismo PBKDF2 que auth.js para que el resto del flujo de login
// funcione sin tocar nada más.

const path = require('path');
const crypto = require('crypto');
const Database = require('better-sqlite3');

const ITERATIONS = 200_000;
const KEYLEN = 32;

const username = (process.argv[2] || '').trim().toLowerCase();
const password = process.argv[3] || '';
if (!username || password.length < 6) {
  console.error('Uso: <username> <newPassword> (mínimo 6 caracteres)');
  process.exit(2);
}

const dbPath = path.join(process.env.APPDATA, 'nobreak-desktop', 'NoBreak.db');
const db = new Database(dbPath);

const row = db.prepare('SELECT id, username FROM users WHERE username = ?').get(username);
if (!row) {
  console.error('Usuario no encontrado:', username);
  process.exit(3);
}

const salt = crypto.randomBytes(16);
const hash = crypto.pbkdf2Sync(password, salt, ITERATIONS, KEYLEN, 'sha256');

db.prepare(
  'UPDATE users SET pass_hash = ?, salt = ?, iter_count = ? WHERE id = ?'
).run(hash.toString('base64'), salt.toString('base64'), ITERATIONS, row.id);

// También invalida todas las sesiones activas de este usuario para forzar
// un login limpio.
const sessionsDel = db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.id);
console.log('contraseña actualizada para "' + row.username + '" (id=' + row.id + '), sesiones eliminadas:', sessionsDel.changes);
db.close();
