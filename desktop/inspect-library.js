// Diagnóstico: ¿cuántos álbumes hay en la biblioteca?
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = path.join(process.env.APPDATA, 'nobreak-desktop', 'NoBreak.db');
const db = new Database(dbPath, { readonly: true });
const albums = db.prepare(`
  SELECT
    MIN(id) AS id,
    album AS titulo,
    COALESCE(albumartist, artista) AS artista,
    COUNT(*) AS trackCount
  FROM tracks
  WHERE album IS NOT NULL AND album <> ''
  GROUP BY LOWER(album), LOWER(COALESCE(albumartist, artista))
  ORDER BY artista, album
`).all();
console.log('total álbumes:', albums.length);
for (const a of albums) {
  console.log(`  [${a.id}] "${a.titulo}" — ${a.artista} (${a.trackCount} pistas)`);
}
db.close();
