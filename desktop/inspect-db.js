const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const dbPath = path.join(process.env.APPDATA, 'nobreak-desktop', 'NoBreak.db');
const db = new Database(dbPath, { readonly: true });

console.log('users:    ', db.prepare('SELECT COUNT(*) AS n FROM users').get().n);
console.log('settings: ', db.prepare('SELECT * FROM app_settings').all());
console.log('tracks:   ', db.prepare('SELECT COUNT(*) AS n FROM tracks').get().n);
console.log('cover_path stats:');
console.log('  null:    ', db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE cover_path IS NULL`).get().n);
console.log('  set:     ', db.prepare(`SELECT COUNT(*) AS n FROM tracks WHERE cover_path IS NOT NULL`).get().n);

const samples = db.prepare(`SELECT id, titulo, cover_path FROM tracks WHERE cover_path IS NOT NULL LIMIT 3`).all();
samples.forEach(s => {
    console.log(`  track ${s.id} "${s.titulo}":`);
    console.log(`    path: ${s.cover_path}`);
    console.log(`    exists on disk? ${fs.existsSync(s.cover_path)}`);
});

const t73 = db.prepare(`SELECT id, titulo, cover_path FROM tracks WHERE id = 73`).get();
console.log('track 73:', t73);
if (t73 && t73.cover_path) console.log('  exists?', fs.existsSync(t73.cover_path));
