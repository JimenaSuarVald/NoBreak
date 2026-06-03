// Read-only sondeo de la tabla users — diagnóstico del bug de login.
// Ejecuta con: npx electron inspect-users.js
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = path.join(process.env.APPDATA, 'nobreak-desktop', 'NoBreak.db');
const db = new Database(dbPath, { readonly: true });
const rows = db.prepare(
  'SELECT id, username, length(pass_hash) AS hash_len, length(salt) AS salt_len, iter_count, created_at FROM users'
).all();
console.log('users:', JSON.stringify(rows, null, 2));
const cols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);
console.log('columns:', cols.join(', '));
const s = db.prepare('SELECT COUNT(*) AS n FROM sessions').get();
console.log('sessions:', s.n);
db.close();
process.exit(0);
