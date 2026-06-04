// Walks a folder recursively, parses audio metadata with music-metadata, and
// upserts each track into the DB. Saves embedded cover art to a cache dir.
// "Unchanged" = same path + size + mtime as the existing row.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

// music-metadata is ESM-only since v8. We're on v7.x for CommonJS friendliness.
const mm = require('music-metadata');

const AUDIO_EXTS = new Set(['.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.wav']);

function isAudio(file) {
  return AUDIO_EXTS.has(path.extname(file).toLowerCase());
}

async function* walk(root) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); }
    catch { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile() && isAudio(full)) yield full;
    }
  }
}

/**
 * Scan {@code root} recursively. Calls progress(message) periodically.
 * Returns { scanned, skipped, errors, total }.
 */
async function scan(root, coverDir, progress) {
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('Carpeta no accesible: ' + root);
  }
  await fs.promises.mkdir(coverDir, { recursive: true });

  // First pass: collect all audio files (cheap, gives us a total for progress).
  const files = [];
  for await (const f of walk(root)) files.push(f);
  if (progress) progress(`Encontrados ${files.length} archivos`);

  const conn = db.get();
  const upsert = conn.prepare(`
    INSERT INTO tracks (
      path, titulo, artista, album, albumartist, year, genre,
      track_no, disc_no, duration_ms, codec, cover_path,
      size_bytes, mtime, last_parsed
    ) VALUES (
      @path, @titulo, @artista, @album, @albumartist, @year, @genre,
      @track_no, @disc_no, @duration_ms, @codec, @cover_path,
      @size_bytes, @mtime, @last_parsed
    )
    ON CONFLICT(path) DO UPDATE SET
      titulo=excluded.titulo,
      artista=excluded.artista,
      album=excluded.album,
      albumartist=excluded.albumartist,
      year=excluded.year,
      genre=excluded.genre,
      track_no=excluded.track_no,
      disc_no=excluded.disc_no,
      duration_ms=excluded.duration_ms,
      codec=excluded.codec,
      cover_path=excluded.cover_path,
      size_bytes=excluded.size_bytes,
      mtime=excluded.mtime,
      last_parsed=excluded.last_parsed
  `);
  const lookup = conn.prepare('SELECT size_bytes, mtime FROM tracks WHERE path = ?');
  const recordError = conn.prepare(
    'INSERT INTO scan_errors (path, error, occurred_at) VALUES (?, ?, ?)'
  );

  let scanned = 0, skipped = 0, errors = 0;
  const seenPaths = new Set(files);

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (progress && i % 25 === 0) progress(`Escaneando ${i + 1} / ${files.length}…`);
    try {
      const stat = await fs.promises.stat(f);
      const existing = lookup.get(f);
      if (existing && existing.size_bytes === stat.size && existing.mtime === stat.mtimeMs) {
        skipped++;
        continue;
      }

      const meta = await mm.parseFile(f, { duration: true, skipCovers: false });
      const common = meta.common || {};
      const fmt = meta.format || {};
      const cover = (common.picture && common.picture[0]) || null;
      const coverPath = cover ? saveCover(cover, coverDir) : null;

      upsert.run({
        path: f,
        titulo: common.title || path.basename(f, path.extname(f)),
        artista: common.artist || (Array.isArray(common.artists) ? common.artists.join(', ') : null),
        album: common.album || null,
        albumartist: common.albumartist || null,
        year: common.year || null,
        genre: Array.isArray(common.genre) ? common.genre.join(', ') : (common.genre || null),
        track_no: (common.track && common.track.no) || null,
        disc_no: (common.disk && common.disk.no) || null,
        duration_ms: fmt.duration ? Math.round(fmt.duration * 1000) : null,
        codec: fmt.codec || null,
        cover_path: coverPath,
        size_bytes: stat.size,
        mtime: stat.mtimeMs,
        last_parsed: Date.now(),
      });
      scanned++;
    } catch (e) {
      errors++;
      try { recordError.run(f, e.message || String(e), Date.now()); } catch {}
    }
  }

  // Borra de la BD las pistas que ya no están en la carpeta seleccionada.
  // Sin esto, al apuntar la biblioteca a una carpeta con menos música los
  // álbumes antiguos seguirían apareciendo. FKs a liked_tracks / playlist_tracks
  // / track_ratings tienen ON DELETE CASCADE.
  let removed = 0;
  const existingPaths = conn.prepare('SELECT path FROM tracks').all().map((r) => r.path);
  const toRemove = existingPaths.filter((p) => !seenPaths.has(p));
  if (toRemove.length) {
    const del = conn.prepare('DELETE FROM tracks WHERE path = ?');
    const tx = conn.transaction((paths) => { for (const p of paths) del.run(p); });
    tx(toRemove);
    removed = toRemove.length;
  }

  if (progress) progress(`Escaneo terminado: ${scanned} nuevos · ${skipped} sin cambios · ${removed} eliminados · ${errors} errores`);
  return { scanned, skipped, removed, errors, total: files.length };
}

/** Saves a cover Buffer to {coverDir}/{sha1}.{ext} and returns the absolute path. */
function saveCover(picture, coverDir) {
  const buf = Buffer.isBuffer(picture.data) ? picture.data : Buffer.from(picture.data);
  const hash = crypto.createHash('sha1').update(buf).digest('hex');
  const ext = mimeToExt(picture.format);
  const file = path.join(coverDir, `${hash}.${ext}`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, buf);
  return file;
}

function mimeToExt(mime) {
  if (!mime) return 'jpg';
  const m = mime.toLowerCase();
  if (m.includes('png')) return 'png';
  if (m.includes('webp')) return 'webp';
  return 'jpg';
}

module.exports = { scan };
