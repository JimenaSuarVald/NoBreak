// Express server the website connects to. Same DB as the Electron app, same
// auth: a username/password issues a session token, all /api/* + /stream/*
// require that token (Authorization header, or ?t= for <audio>).
//
// CORS is permissive (any origin) because this binds to 127.0.0.1 only — only
// processes on the same machine can reach it.

const express = require('express');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const auth = require('./auth');
const playlists = require('./playlists');
const artistinfo = require('./artistinfo');

const PORT = 8080;
const HOST = '127.0.0.1';

let webDir = null;

function build() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Serve the Frontend/ static site if the main process found it.
  // Mounted before everything else so /menu.html, /api.js, etc. resolve
  // without going through the API guards.
  if (webDir) {
    app.use(express.static(webDir, { extensions: ['html'] }));
  }

  // CORS: bind is 127.0.0.1 only (not LAN), so we accept any origin.
  // We don't set Allow-Credentials because we authenticate via Authorization
  // header / ?t= token, not cookies — and `Allow-Credentials: true` paired
  // with `Allow-Origin: *` is rejected by browsers.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range,Content-Length,Accept-Ranges');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // ---- public ----
  app.get('/', (_, res) => res.type('text/plain').send('NoBreak vault activo'));
  app.get('/health', (_, res) => res.json({ ok: true }));

  // ---- auth ----
  app.post('/auth/login', (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Falta username o password' });
    const user = auth.verifyUser(username, password);
    if (!user) return res.status(401).json({ error: 'Credenciales inválidas' });
    const s = auth.issueSession(user.id);
    res.json({
      sessionToken: s.token,
      expiresAt: s.expiresAt,
      username: user.username,
      tokenType: 'Bearer',
    });
  });

  app.post('/auth/logout', (req, res) => {
    const t = extractToken(req);
    if (t) auth.revokeSession(t);
    res.sendStatus(204);
  });

  // ---- guard for /auth/me, /api/*, /stream/* ----
  function guard(req, res, next) {
    const token = extractToken(req);
    const userId = token ? auth.verifySession(token) : null;
    if (!userId) return res.status(401).json({ error: 'Sesión inválida o caducada' });
    req.userId = userId;
    next();
  }

  app.get('/auth/me', guard, (req, res) => {
    const u = auth.userById(req.userId);
    if (!u) return res.status(401).json({ error: 'Usuario inexistente' });
    res.json(u);
  });

  // ---- library ----
  app.get('/api/library', guard, (_req, res) => {
    res.json({
      albums: queryAlbums(),
      artists: queryArtists(),
    });
  });

  app.get('/api/albums', guard, (_req, res) => {
    res.json(queryAlbums());
  });

  app.get('/api/albums/:id', guard, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(404).json({ error: 'id inválido' });
    const album = queryAlbumById(id);
    if (!album) return res.status(404).json({ error: 'Álbum no encontrado' });
    album.tracks = queryTracksOfAlbum(album.titulo, album.albumartist);
    res.json(album);
  });

  app.get('/api/tracks', guard, (req, res) => {
    const q = (req.query.q || '').toString().toLowerCase().trim();
    let rows;
    if (q) {
      rows = db.get().prepare(`
        SELECT id, titulo, artista, album, track_no, disc_no, duration_ms, cover_path
        FROM tracks
        WHERE LOWER(titulo) LIKE ? OR LOWER(artista) LIKE ? OR LOWER(album) LIKE ?
        ORDER BY artista, album, track_no
        LIMIT 5000
      `).all(`%${q}%`, `%${q}%`, `%${q}%`);
    } else {
      rows = db.get().prepare(`
        SELECT id, titulo, artista, album, track_no, disc_no, duration_ms, cover_path
        FROM tracks ORDER BY artista, album, track_no LIMIT 5000
      `).all();
    }
    res.json(rows.map(toTrackJson));
  });

  app.get('/api/tracks/:id', guard, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(404).json({ error: 'id inválido' });
    const row = db.get().prepare(`
      SELECT id, titulo, artista, album, year, genre, track_no, disc_no,
             duration_ms, codec, cover_path
      FROM tracks WHERE id = ?
    `).get(id);
    if (!row) return res.status(404).json({ error: 'Track no encontrado' });
    res.json(toTrackJson(row));
  });

  // ---- artists / genres -------------------------------------------------
  app.get('/api/artists', guard, (_req, res) => res.json(queryArtists()));
  app.get('/api/genres',  guard, (_req, res) => res.json(queryGenres()));

  // List the albums an artist released. Used by the Artistas tab on click.
  app.get('/api/artists/:id/albums', guard, (req, res) => {
    const id = Number(req.params.id);
    const artist = db.get().prepare(`SELECT artista FROM tracks WHERE id = ?`).get(id);
    if (!artist) return res.status(404).json({ error: 'Artista no encontrado' });
    const albums = albumsByPredicate(`artista = ? OR albumartist = ?`, [artist.artista, artist.artista]);
    res.json({ artista: artist.artista, albums });
  });

  app.get('/api/genres/:id/albums', guard, (req, res) => {
    const id = Number(req.params.id);
    const g = db.get().prepare(`SELECT genre FROM tracks WHERE id = ?`).get(id);
    if (!g || !g.genre) return res.status(404).json({ error: 'Género no encontrado' });
    const albums = albumsByPredicate(`genre = ?`, [g.genre]);
    res.json({ genero: g.genre, albums });
  });

  // ---- artist info (Wikipedia / Last.fm) --------------------------------
  app.get('/api/artist-info', guard, async (req, res) => {
    const name = (req.query.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'Falta name' });
    try {
      const info = await artistinfo.getArtistInfo(name);
      if (!info) return res.status(404).json({ error: 'Sin información' });
      res.json(info);
    } catch (e) {
      console.error('[artist-info]', e);
      res.status(502).json({ error: 'No se pudo obtener la info' });
    }
  });

  // ---- playlists --------------------------------------------------------
  app.get('/api/playlists', guard, (_req, res) => {
    res.json(playlists.listPlaylists());
  });

  app.get('/api/playlists/:id', guard, (req, res) => {
    const pl = playlists.getPlaylist(Number(req.params.id));
    if (!pl) return res.status(404).json({ error: 'Playlist no encontrada' });
    res.json(pl);
  });

  app.post('/api/playlists', guard, (req, res) => {
    try {
      const pl = playlists.createPlaylist((req.body || {}).name);
      res.status(201).json(pl);
    } catch (e) { handlePlaylistError(e, res); }
  });

  app.patch('/api/playlists/:id', guard, (req, res) => {
    try {
      const pl = playlists.renamePlaylist(Number(req.params.id), (req.body || {}).name);
      if (!pl) return res.status(404).json({ error: 'Playlist no encontrada' });
      res.json(pl);
    } catch (e) { handlePlaylistError(e, res); }
  });

  app.delete('/api/playlists/:id', guard, (req, res) => {
    const ok = playlists.deletePlaylist(Number(req.params.id));
    if (!ok) return res.status(404).json({ error: 'Playlist no encontrada' });
    res.sendStatus(204);
  });

  app.post('/api/playlists/:id/tracks', guard, (req, res) => {
    try {
      const { trackId, position } = req.body || {};
      if (trackId == null) return res.status(400).json({ error: 'Falta trackId' });
      const pl = playlists.addTrack(Number(req.params.id), Number(trackId), position);
      res.status(201).json(pl);
    } catch (e) { handlePlaylistError(e, res); }
  });

  app.delete('/api/playlists/:id/tracks/:trackId', guard, (req, res) => {
    const ok = playlists.removeTrack(Number(req.params.id), Number(req.params.trackId));
    if (!ok) return res.status(404).json({ error: 'No estaba en la playlist' });
    res.sendStatus(204);
  });

  app.put('/api/playlists/:id/order', guard, (req, res) => {
    try {
      const pl = playlists.reorder(Number(req.params.id), (req.body || {}).trackIds);
      res.json(pl);
    } catch (e) { handlePlaylistError(e, res); }
  });

  // ---- cover art ----
  // Served by track id; the cover_path column holds the absolute disk path.
  app.get('/cover/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(404).end();
    const row = db.get().prepare('SELECT cover_path FROM tracks WHERE id = ?').get(id);
    if (!row || !row.cover_path || !fs.existsSync(row.cover_path)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(row.cover_path);
  });

  // ---- stream ----
  // Range-aware, handles partial content for <audio>. Auth via guard — token
  // can come from header or ?t= query (since <audio> can't send headers).
  app.get('/stream/:id', guard, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(404).end();
    const row = db.get().prepare('SELECT path FROM tracks WHERE id = ?').get(id);
    if (!row) return res.status(404).end();
    const filePath = row.path;
    if (!fs.existsSync(filePath)) return res.status(404).end();

    const stat = fs.statSync(filePath);
    const size = stat.size;
    const range = req.headers.range;
    const mime = guessMime(filePath);

    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Type', mime);

    if (!range) {
      res.setHeader('Content-Length', size);
      fs.createReadStream(filePath).pipe(res);
      return;
    }

    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m) { res.status(416).setHeader('Content-Range', `bytes */${size}`); return res.end(); }
    let start = m[1] ? parseInt(m[1], 10) : 0;
    let end   = m[2] ? parseInt(m[2], 10) : size - 1;
    if (!m[1] && m[2]) { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
    if (start >= size || end >= size || start > end) {
      res.status(416).setHeader('Content-Range', `bytes */${size}`);
      return res.end();
    }
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
    res.setHeader('Content-Length', end - start + 1);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  });

  return app;
}

// --- helpers ---

function extractToken(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    const t = h.substring(7).trim();
    if (t) return t;
  }
  if (req.query && req.query.t) return String(req.query.t);
  return null;
}

function queryAlbums() {
  // Aggregated from tracks. Album identity = (album, albumartist OR artista).
  return db.get().prepare(`
    SELECT
      MIN(id) AS id,
      album AS titulo,
      COALESCE(albumartist, artista) AS artista,
      COALESCE(albumartist, artista) AS albumartist,
      MIN(year) AS year,
      MIN(cover_path) AS cover_path,
      COUNT(*) AS trackCount
    FROM tracks
    WHERE album IS NOT NULL AND album <> ''
    GROUP BY album, COALESCE(albumartist, artista)
    ORDER BY artista, year, album
  `).all().map(a => ({
    id: a.id,
    titulo: a.titulo,
    artista: a.artista,
    albumartist: a.albumartist,
    year: a.year,
    trackCount: a.trackCount,
    coverUrl: a.cover_path ? `/cover/${a.id}` : null,
  }));
}

function queryAlbumById(id) {
  // The "id" of an album in our flat schema is the MIN(track.id) used as the
  // album's stable handle. So look up the track and re-aggregate that group.
  const track = db.get().prepare(
    'SELECT album, albumartist, artista, year, cover_path FROM tracks WHERE id = ?'
  ).get(id);
  if (!track || !track.album) return null;
  const albumArtist = track.albumartist || track.artista;
  return {
    id,
    titulo: track.album,
    artista: albumArtist,
    albumartist: albumArtist,
    year: track.year,
    trackCount: db.get().prepare(
      `SELECT COUNT(*) AS n FROM tracks
       WHERE album = ? AND COALESCE(albumartist, artista) = ?`
    ).get(track.album, albumArtist).n,
    coverUrl: track.cover_path ? `/cover/${id}` : null,
  };
}

function queryTracksOfAlbum(album, albumArtist) {
  return db.get().prepare(`
    SELECT id, titulo, artista, album, track_no, disc_no, duration_ms, cover_path
    FROM tracks
    WHERE album = ? AND COALESCE(albumartist, artista) = ?
    ORDER BY COALESCE(disc_no, 1), COALESCE(track_no, 9999), titulo
  `).all(album, albumArtist).map(toTrackJson);
}

function queryArtists() {
  // MIN(id) doubles as a stable handle for the artist; /cover/<id> serves
  // one of their tracks' covers, which is what the Artists grid wants.
  return db.get().prepare(`
    SELECT
      MIN(id) AS id,
      artista AS nombre,
      COUNT(*) AS trackCount,
      COUNT(DISTINCT album) AS albumCount,
      MIN(cover_path) AS cover_path
    FROM tracks
    WHERE artista IS NOT NULL AND artista <> ''
    GROUP BY artista
    ORDER BY artista
  `).all().map(a => ({
    id: a.id,
    nombre: a.nombre,
    trackCount: a.trackCount,
    albumCount: a.albumCount,
    coverUrl: a.cover_path ? `/cover/${a.id}` : null,
  }));
}

function queryGenres() {
  return db.get().prepare(`
    SELECT
      MIN(id) AS id,
      genre AS nombre,
      COUNT(*) AS trackCount,
      COUNT(DISTINCT album) AS albumCount,
      MIN(cover_path) AS cover_path
    FROM tracks
    WHERE genre IS NOT NULL AND genre <> ''
    GROUP BY genre
    ORDER BY genre
  `).all().map(g => ({
    id: g.id,
    nombre: g.nombre,
    trackCount: g.trackCount,
    albumCount: g.albumCount,
    coverUrl: g.cover_path ? `/cover/${g.id}` : null,
  }));
}

function albumsByPredicate(where, params) {
  return db.get().prepare(`
    SELECT
      MIN(id) AS id,
      album AS titulo,
      COALESCE(albumartist, artista) AS artista,
      MIN(year) AS year,
      MIN(cover_path) AS cover_path,
      COUNT(*) AS trackCount
    FROM tracks
    WHERE (${where}) AND album IS NOT NULL AND album <> ''
    GROUP BY album, COALESCE(albumartist, artista)
    ORDER BY year, album
  `).all(...params).map(a => ({
    id: a.id,
    titulo: a.titulo,
    artista: a.artista,
    albumartist: a.artista,
    year: a.year,
    trackCount: a.trackCount,
    coverUrl: a.cover_path ? `/cover/${a.id}` : null,
  }));
}

function handlePlaylistError(e, res) {
  if (e instanceof playlists.ValidationError) return res.status(400).json({ error: e.message });
  if (e instanceof playlists.NotFoundError)   return res.status(404).json({ error: e.message });
  if (/UNIQUE constraint/i.test(e.message))   return res.status(409).json({ error: 'Ese nombre ya existe' });
  console.error('[playlists]', e);
  res.status(500).json({ error: 'Error interno' });
}

function toTrackJson(r) {
  return {
    id: r.id,
    titulo: r.titulo,
    artista: r.artista,
    album: r.album,
    year: r.year,
    genre: r.genre,
    trackNo: r.track_no,
    discNo: r.disc_no,
    durationMs: r.duration_ms,
    codec: r.codec,
    coverUrl: r.cover_path ? `/cover/${r.id}` : null,
  };
}

function guessMime(file) {
  const e = path.extname(file).toLowerCase();
  if (e === '.mp3') return 'audio/mpeg';
  if (e === '.flac') return 'audio/flac';
  if (e === '.m4a' || e === '.aac') return 'audio/mp4';
  if (e === '.ogg') return 'audio/ogg';
  if (e === '.opus') return 'audio/opus';
  if (e === '.wav') return 'audio/wav';
  return 'application/octet-stream';
}

let server = null;

function start(opts = {}) {
  if (server) return;
  webDir = opts.webDir || null;
  const app = build();
  server = app.listen(PORT, HOST, () => {
    const where = webDir ? `con sitio web en /` : `(API solo)`;
    console.log(`NoBreak HTTP server escuchando en http://${HOST}:${PORT} ${where}`);
  });
}

function stop() {
  if (!server) return;
  server.close();
  server = null;
}

module.exports = { start, stop, PORT, HOST };
