const Database = require('better-sqlite3');
const path = require('path');
const db = new Database(path.join(process.env.APPDATA, 'nobreak-desktop', 'NoBreak.db'), { readonly: true });

console.log('--- app_settings ---');
for (const r of db.prepare('SELECT key, length(value) AS len FROM app_settings').all()) {
  console.log('  ' + r.key + ' (len=' + r.len + ')');
}

console.log('--- users / lastfm ---');
for (const u of db.prepare('SELECT id, username, lastfm_session_key IS NOT NULL AS has_lf, lastfm_username FROM users').all()) {
  console.log('  user', u.id, u.username, 'has_lf_session=', !!u.has_lf, 'lf_user=', u.lastfm_username);
}

console.log('--- artists con tracks sin cover ---');
const rows = db.prepare(`
  SELECT artista,
         COUNT(*) AS n,
         SUM(CASE WHEN cover_path IS NULL THEN 1 ELSE 0 END) AS noCovers,
         MIN(CASE WHEN cover_path IS NOT NULL THEN id END) AS coverTrackId,
         MIN(id) AS minId
  FROM tracks WHERE artista IS NOT NULL AND artista <> ''
  GROUP BY artista
`).all();
const broken = rows.filter(a => a.noCovers > 0 && a.n - a.noCovers > 0 && a.coverTrackId !== a.minId);
console.log('artistas con cover real pero el cover URL apunta a track sin cover:', broken.length, '/', rows.length);
for (const a of broken.slice(0, 10)) console.log('  -', a.artista, '| minId=', a.minId, '(no cover) | coverTrackId=', a.coverTrackId);

const noneAtAll = rows.filter(a => a.n - a.noCovers === 0);
console.log('artistas SIN ningún track con cover:', noneAtAll.length);
for (const a of noneAtAll.slice(0, 5)) console.log('  -', a.artista);
