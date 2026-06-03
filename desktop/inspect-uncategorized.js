// Diagnóstico: lista los álbumes que acaban en "Sin clasificar" y por qué.
// Reproduce la lógica de buildMasterGenres pero imprime el origen del tag
// (MB álbum, ID3 álbum, MB artista, ID3 artista, o nada).
const path = require('path');
const Database = require('better-sqlite3');
const dbPath = path.join(process.env.APPDATA, 'nobreak-desktop', 'NoBreak.db');
const db = new Database(dbPath, { readonly: true });

const RATING_SEP = '\x1f';
const mbKey = (a, ar) => (a||'').trim().toLowerCase() + RATING_SEP + (ar||'').trim().toLowerCase();
const split = s => (s||'').split(/\s*&\s*|\s*;\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+vs\.?\s+/i)
                          .map(x => x.trim()).filter(Boolean);

const albumTagsMb = new Map();
for (const r of db.prepare('SELECT album_key, tags_json FROM mb_album_cache').all()) {
  try { const t = JSON.parse(r.tags_json); albumTagsMb.set(r.album_key, t); }
  catch {}
}
const artistTagsMb = new Map();
for (const r of db.prepare('SELECT artist_key, tags_json FROM mb_artist_cache').all()) {
  try { const t = JSON.parse(r.tags_json); artistTagsMb.set(r.artist_key, t); }
  catch {}
}

// ID3 maps
const id3Album = new Map();
const id3Artist = new Map();
for (const r of db.prepare("SELECT album, COALESCE(albumartist, artista) AS aa, artista, genre FROM tracks WHERE genre IS NOT NULL AND genre <> ''").all()) {
  if (r.album && r.aa) {
    const k = mbKey(r.album, r.aa);
    const m = id3Album.get(k) || new Map(); id3Album.set(k, m);
    m.set(r.genre, (m.get(r.genre) || 0) + 1);
  }
  if (r.artista) for (const c of split(r.artista)) {
    const k = c.toLowerCase().trim(); if (!k) continue;
    const m = id3Artist.get(k) || new Map(); id3Artist.set(k, m);
    m.set(r.genre, (m.get(r.genre) || 0) + 1);
  }
}
const topOf = m => { let b=null, n=-1; for (const [g, c] of m) if (c > n) { b=g; n=c; } return b; };

const albums = db.prepare(`
  SELECT MIN(id) AS id, album AS titulo, COALESCE(albumartist, artista) AS aa
  FROM tracks WHERE album IS NOT NULL AND album <> ''
  GROUP BY LOWER(album), LOWER(COALESCE(albumartist, artista))
  ORDER BY titulo
`).all();

let mbAlbumYes = 0, mbAlbumCachedNoTags = 0, mbAlbumNoCache = 0;
let unclassified = 0;
const unTaxa = [];

for (const a of albums) {
  const k = mbKey(a.titulo, a.aa);
  const mbTags = albumTagsMb.get(k);
  let origin = null;
  let tag = null;
  if (mbTags && mbTags.length) { tag = mbTags[0].name; origin = 'mb-album'; mbAlbumYes++; }
  else {
    if (mbTags) mbAlbumCachedNoTags++; else mbAlbumNoCache++;
    const id3T = id3Album.get(k);
    if (id3T) { tag = topOf(id3T); if (tag) origin = 'id3-album'; }
    if (!tag) {
      for (const comp of split(a.aa)) {
        const ck = comp.toLowerCase().trim();
        const mb = artistTagsMb.get(ck);
        if (mb && mb.length) { tag = mb[0].name; origin = 'mb-artist'; break; }
        const id3a = id3Artist.get(ck);
        if (id3a) { const t = topOf(id3a); if (t) { tag = t; origin = 'id3-artist'; break; } }
      }
    }
  }
  if (!tag) { unclassified++; unTaxa.push({ titulo: a.titulo, aa: a.aa, mbCachedEmpty: !!mbTags }); }
}

console.log('total albums:', albums.length);
console.log('mb album-cache hit (with tags):', mbAlbumYes);
console.log('mb album-cache hit (empty tags):', mbAlbumCachedNoTags);
console.log('mb album-cache MISS (no entry):', mbAlbumNoCache);
console.log('unclassified after all fallbacks:', unclassified);
console.log('---');
for (const a of unTaxa) {
  console.log(`  [mbEmpty=${a.mbCachedEmpty}] "${a.titulo}" — ${a.aa}`);
}
db.close();
