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
const lastfm = require('./lastfm');
const musicbrainz = require('./musicbrainz');
const cloud = require('./cloud');
const cloudRelay = require('./cloud-relay');

const PORT = 8080;
const HOST = '127.0.0.1';

let webDir = null;

function build() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  // Serve the Frontend/ static site if the main process found it.
  // Mounted before everything else so /menu.html, /api.js, etc. resolve
  // without going through the API guards. `index: 'menu.html'` makes /
  // serve the menu page since Frontend/ has no index.html.
  if (webDir) {
    app.use(express.static(webDir, { extensions: ['html'], index: 'index.html' }));
  }

  // CORS: bind is 127.0.0.1 only (not LAN), so we accept any origin.
  // We don't set Allow-Credentials because we authenticate via Authorization
  // header / ?t= token, not cookies — and `Allow-Credentials: true` paired
  // with `Allow-Origin: *` is rejected by browsers.
  app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization,Range,X-NoBreak-Tunnel-Secret,X-NoBreak-Cloud-User');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range,Content-Length,Accept-Ranges');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // Tunnel-secret guard (fase 3 hito C.2). El bind sigue siendo 127.0.0.1,
  // pero cloudflared/ngrok hacen forward al loopback. Sin esta verificación
  // cualquiera con la URL del tunnel pegaría al .exe.
  //
  // Reglas:
  //   - Si el request NO trae X-NoBreak-Tunnel-Secret → se asume local
  //     (renderer Electron, Frontend/ en el navegador del PC) y pasa. Esto
  //     mantiene compatibilidad con todo lo que ya funciona en localhost.
  //   - Si lo trae y coincide con el secret local → pasa, tratamos como
  //     request del Worker. Pendiente: opcionalmente loguear cloud user.
  //   - Si lo trae pero NO coincide → 403. Evita que alguien que adivinó la
  //     URL del tunnel envíe un secret cualquiera y se cuele.
  app.use((req, res, next) => {
    const headerSecret = req.get('X-NoBreak-Tunnel-Secret');
    if (!headerSecret) return next();
    const localSecret = cloud.getTunnelSecret && cloud.getTunnelSecret();
    if (!localSecret || headerSecret !== localSecret) {
      return res.status(403).json({ error: 'Tunnel secret inválido' });
    }
    req._fromCloudTunnel = true;
    req._cloudUser = req.get('X-NoBreak-Cloud-User') || null;
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

  // Registro de usuario por HTTP. Replica el handler IPC 'auth:register' que
  // ya tenía main.js, para que el frontend web pueda crear usuarios sin pasar
  // por Electron. Mensajes de error en español para que la UI los muestre tal cual.
  app.post('/auth/register', (req, res) => {
    const { username, password, email } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'Falta username o password' });
    }
    try {
      auth.createUser(username, password, { email });
      // Avisa al Worker para que actualice user_routes sin esperar al
      // próximo heartbeat (binding cuenta↔servidor "instantáneo").
      cloudRelay.kick?.();
      res.status(201).json({ ok: true });
    } catch (e) {
      if (/UNIQUE constraint/i.test(e.message)) {
        return res.status(409).json({ error: 'Ese usuario ya existe. Elige otro o inicia sesión.' });
      }
      console.error('[auth/register]', e);
      res.status(500).json({ error: e.message || 'No se pudo crear el usuario' });
    }
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
    res.json(serializeMe(u));
  });

  // PATCH parcial del perfil del propio usuario. Acepta cualquier subconjunto
  // de display_name, email, description, profile_widgets (objeto serializado),
  // profile_html, advanced_mode (bool).
  app.patch('/auth/me', guard, (req, res) => {
    const body = req.body || {};
    const patch = {};
    if ('displayName'    in body) patch.display_name    = stringOrNull(body.displayName, 80);
    if ('email'          in body) patch.email           = stringOrNull(body.email, 200);
    if ('description'    in body) patch.description     = stringOrNull(body.description, 0);
    if ('profileWidgets' in body) patch.profile_widgets = body.profileWidgets == null ? null : JSON.stringify(body.profileWidgets);
    if ('profileHtml'    in body) patch.profile_html    = stringOrNull(body.profileHtml, 32000);
    if ('advancedMode'   in body) patch.advanced_mode   = body.advancedMode ? 1 : 0;
    // uiSettings: objeto plano con claves localStorage 'nobreak-*'. Lo serializamos
    // a JSON. El renderer hace pull al iniciar sesión y push debounced en cada cambio.
    if ('uiSettings'     in body) patch.ui_settings     = body.uiSettings == null ? null : JSON.stringify(body.uiSettings);
    if (patch.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) {
      return res.status(400).json({ error: 'Correo no válido' });
    }
    const u = auth.patchUser(req.userId, patch);
    res.json(serializeMe(u));
  });

  // Foto de perfil (servida desde el disco). Pública dentro del host local.
  app.get('/profile-photo/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(404).end();
    const u = auth.userById(id);
    if (!u || !u.photo_path || !fs.existsSync(u.photo_path)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(u.photo_path);
  });

  // Fondo del perfil (banner/wallpaper). Misma lógica que la foto.
  app.get('/profile-bg/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(404).end();
    const u = auth.userById(id);
    if (!u || !u.profile_background || !fs.existsSync(u.profile_background)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(u.profile_background);
  });

  // Marco PNG sobre la foto.
  app.get('/profile-frame/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(404).end();
    const u = auth.userById(id);
    if (!u || !u.profile_frame || !fs.existsSync(u.profile_frame)) return res.status(404).end();
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.sendFile(u.profile_frame);
  });

  // Reporta tiempo escuchado del track actual. El renderer va acumulando ms y
  // los manda en lotes (cada ~15 s y en pause/ended/track-change). Si llega
  // trackId además del artist, también incrementamos play_count cuando el
  // cliente marca "newPlay" (al iniciar la reproducción de un track nuevo).
  app.post('/api/listen', guard, (req, res) => {
    const { artist, ms, trackId, newPlay } = req.body || {};
    const n = Number(ms);
    if (!artist || !isFinite(n) || n <= 0) {
      return res.status(400).json({ error: 'Falta artist o ms inválido' });
    }
    const cappedMs = Math.min(n, 30 * 60 * 1000);
    db.addListenedMs(req.userId, String(artist), cappedMs);
    const tid = Number(trackId);
    if (Number.isFinite(tid)) {
      db.addTrackListen(req.userId, tid, cappedMs, newPlay ? 1 : 0);
    }
    res.sendStatus(204);
  });

  // ---- Me Gusta (liked tracks) -------------------------------------------
  // Toggle de like sobre un track. El cliente actualiza optimistamente su
  // Set local y revierte si la respuesta no es 2xx.
  app.post('/api/tracks/:id/like', guard, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Track id inválido' });
    db.likeTrack(req.userId, id);
    res.sendStatus(204);
  });
  app.delete('/api/tracks/:id/like', guard, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Track id inválido' });
    db.unlikeTrack(req.userId, id);
    res.sendStatus(204);
  });
  // IDs de tracks que me gustan — devuelto al cargar la app para poblar el
  // Set y poder pintar el corazón relleno en el now-playing y donde haga falta.
  app.get('/api/me/liked-ids', guard, (req, res) => {
    res.json({ ids: db.getLikedTrackIdsForUser(req.userId) });
  });

  // ---- Track rating (per-user) ------------------------------------------
  // Una valoración por canción y por usuario. Es la fuente de verdad: la
  // "valoración de un álbum" se calcula como la media de las valoraciones
  // de sus canciones (ver queryAlbums / queryAlbumById).
  app.get('/api/tracks/:id/rating', guard, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Track id inválido' });
    res.json({ rating: db.getTrackRating(req.userId, id) });
  });
  app.put('/api/tracks/:id/rating', guard, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Track id inválido' });
    const v = Number((req.body || {}).rating);
    if (!isFinite(v) || v < 0.5 || v > 5) {
      return res.status(400).json({ error: 'Rating debe estar entre 0.5 y 5' });
    }
    try {
      const newR = db.setTrackRating(req.userId, id, v);
      res.json({ rating: newR });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });
  app.delete('/api/tracks/:id/rating', guard, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'Track id inválido' });
    db.clearTrackRating(req.userId, id);
    res.sendStatus(204);
  });
  // Detalle de los tracks que me gustan — usado por la playlist virtual "Me Gusta".
  app.get('/api/me/liked', guard, (req, res) => {
    const rows = db.getLikedTracksForUser(req.userId);
    // Portadas únicas por path (puede haber varios tracks del mismo álbum
    // entre los likes) — sirven para el collage del card "Me Gusta".
    const seenCovers = new Set();
    const sampleCovers = [];
    for (const r of rows) {
      if (!r.cover_path || seenCovers.has(r.cover_path)) continue;
      seenCovers.add(r.cover_path);
      sampleCovers.push('/cover/' + r.id);
      if (sampleCovers.length >= 9) break;
    }
    res.json({
      count: rows.length,
      tracks: rows.map(r => ({
        ...toTrackJson(r),
        albumartist: r.albumartist || null,
        likedAt: r.liked_at,
      })),
      sampleCovers,
    });
  });
  // Vista pública: los Me Gusta de otro usuario.
  app.get('/api/users/:username/liked', guard, (req, res) => {
    const u = auth.userByUsername(req.params.username);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const rows = db.getLikedTracksForUser(u.id, 200);
    res.json({
      count: rows.length,
      tracks: rows.map(r => ({
        ...toTrackJson(r),
        albumartist: r.albumartist || null,
        likedAt: r.liked_at,
      })),
    });
  });

  // Perfil público de un usuario por username — lo que ven otros (o el dueño
  // en su propia vista pública). Incluye las stats que necesitan los widgets.
  app.get('/api/users/:username', guard, (req, res) => {
    const u = auth.userByUsername(req.params.username);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    const profile = serializePublicProfile(u, req.userId);
    // Stats agregadas del dueño del perfil.
    profile.totalListenedMs = db.getTotalListenedMs(u.id);
    profile.topArtists = db.getListenStatsForUser(u.id, 5).map(t => ({
      artist: t.artist, listenedMs: t.ms_listened, lastPlayedAt: t.last_played_at,
    }));
    profile.topTracks = db.getTopTracks(u.id, 5).map(t => ({
      id: t.id, titulo: t.titulo, artista: t.artista, album: t.album,
      durationMs: t.duration_ms, msListened: t.ms_listened, playCount: t.play_count,
      coverUrl: t.cover_path ? `/cover/${t.id}` : null,
    }));
    // Top álbumes valorados por el dueño.
    const allAlbums = queryAlbums(u.id);
    profile.topAlbums = allAlbums
      .filter(a => a.rating != null)
      .sort((a, b) => (b.rating || 0) - (a.rating || 0)
                   || (a.titulo || '').localeCompare(b.titulo || ''))
      .slice(0, 6);
    profile.albumCount = db.get().prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT album, COALESCE(albumartist, artista) AS artista
         FROM tracks WHERE album IS NOT NULL AND album <> ''
         GROUP BY album, COALESCE(albumartist, artista)
       )`
    ).get().n;
    profile.friends = db.listFriends(u.id).map(f => ({
      id: f.id, username: f.username,
      displayName: f.display_name || f.username,
      photoUrl: f.photo_path ? `/profile-photo/${f.id}` : null,
    }));
    res.json(profile);
  });

  // Top canciones del propio usuario.
  app.get('/api/profile/top-tracks', guard, (req, res) => {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 10));
    res.json(db.getTopTracks(req.userId, limit).map(t => ({
      id: t.id,
      titulo: t.titulo,
      artista: t.artista,
      album: t.album,
      durationMs: t.duration_ms,
      msListened: t.ms_listened,
      playCount: t.play_count,
      coverUrl: t.cover_path ? `/cover/${t.id}` : null,
    })));
  });

  // Top álbumes valorados (los rateados por el dueño, ordenados por su rating).
  app.get('/api/profile/top-albums', guard, (req, res) => {
    const limit = Math.max(1, Math.min(50, Number(req.query.limit) || 5));
    const rated = db.getAllAlbumRatings(req.userId);
    if (!rated.size) return res.json([]);
    const allAlbums = queryAlbums(req.userId);
    const out = allAlbums
      .filter(a => a.rating != null)
      .sort((a, b) => (b.rating || 0) - (a.rating || 0)
                   || (a.titulo || '').localeCompare(b.titulo || ''))
      .slice(0, limit);
    res.json(out);
  });

  // ---- amigos -----------------------------------------------------------
  app.get('/api/friends', guard, (req, res) => {
    res.json(db.listFriends(req.userId).map(f => ({
      id: f.id,
      username: f.username,
      displayName: f.display_name || f.username,
      photoUrl: f.photo_path ? `/profile-photo/${f.id}` : null,
      since: f.created_at,
    })));
  });

  app.post('/api/friends', guard, (req, res) => {
    const target = (req.body || {}).username;
    if (!target) return res.status(400).json({ error: 'Falta username' });
    const u = auth.userByUsername(target);
    if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
    if (u.id === req.userId) return res.status(400).json({ error: 'No puedes añadirte a ti mismo' });
    try {
      db.addFriend(req.userId, u.id);
      res.status(201).json({ ok: true });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/friends/:id', guard, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(400).json({ error: 'id inválido' });
    db.removeFriend(req.userId, id);
    res.sendStatus(204);
  });

  // Stats agregadas para el menú de perfil: fecha de creación, álbumes,
  // top artistas con su tiempo, total escuchado.
  app.get('/api/profile', guard, (req, res) => {
    const u = auth.userById(req.userId);
    if (!u) return res.status(401).json({ error: 'Usuario inexistente' });
    const albumCount = db.get().prepare(
      `SELECT COUNT(*) AS n FROM (
         SELECT album, COALESCE(albumartist, artista) AS artista
         FROM tracks
         WHERE album IS NOT NULL AND album <> ''
         GROUP BY album, COALESCE(albumartist, artista)
       )`
    ).get().n;
    const totalListenedMs = db.getTotalListenedMs(req.userId);
    const topArtists = db.getListenStatsForUser(req.userId, 5);
    res.json({
      id: u.id,
      username: u.username,
      email: u.email || null,
      emailVerified: !!u.email_verified,
      createdAt: u.created_at,
      photoUrl: u.photo_path ? `/profile-photo/${u.id}` : null,
      albumCount,
      totalListenedMs,
      topArtists: topArtists.map(t => ({
        artist: t.artist,
        listenedMs: t.ms_listened,
        lastPlayedAt: t.last_played_at,
      })),
    });
  });

  // ---- library ----
  app.get('/api/library', guard, (req, res) => {
    res.json({
      albums: queryAlbums(req.userId),
      artists: queryArtists(),
    });
  });

  app.get('/api/albums', guard, (req, res) => {
    res.json(queryAlbums(req.userId));
  });

  app.get('/api/albums/:id', guard, (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id)) return res.status(404).json({ error: 'id inválido' });
    const album = queryAlbumById(id, req.userId);
    if (!album) return res.status(404).json({ error: 'Álbum no encontrado' });
    album.tracks = queryTracksOfAlbum(album.titulo, album.albumartist, req.userId);
    res.json(album);
  });

  // ---- album rating (per-user) ------------------------------------------
  app.get('/api/albums/:id/rating', guard, (req, res) => {
    const id = Number(req.params.id);
    const ref = albumRefById(id);
    if (!ref) return res.status(404).json({ error: 'Álbum no encontrado' });
    const r = db.getAlbumRating(req.userId, db.albumKey(ref.album, ref.albumartist));
    res.json({ rating: r });
  });

  app.put('/api/albums/:id/rating', guard, (req, res) => {
    const id = Number(req.params.id);
    const ref = albumRefById(id);
    if (!ref) return res.status(404).json({ error: 'Álbum no encontrado' });
    const v = Number((req.body || {}).rating);
    if (!isFinite(v) || v < 0.5 || v > 5) {
      return res.status(400).json({ error: 'Rating debe estar entre 0.5 y 5' });
    }
    try {
      const newR = db.setAlbumRating(req.userId, db.albumKey(ref.album, ref.albumartist), v);
      res.json({ rating: newR });
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/albums/:id/rating', guard, (req, res) => {
    const id = Number(req.params.id);
    const ref = albumRefById(id);
    if (!ref) return res.status(404).json({ error: 'Álbum no encontrado' });
    db.setAlbumRating(req.userId, db.albumKey(ref.album, ref.albumartist), null);
    res.sendStatus(204);
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
  // Acepta ?name=<nombre> para desambiguar cuando el id apunta a un track
  // cuyo "artista" es una colaboración ("Sunn O))) & Ulver") y, sin más
  // contexto, no sabríamos cuál de los dos artistas pidió el front.
  app.get('/api/artists/:id/albums', guard, (req, res) => {
    const id = Number(req.params.id);
    let artistName = (req.query.name || '').toString().trim();
    if (!artistName) {
      const row = db.get().prepare(`SELECT artista FROM tracks WHERE id = ?`).get(id);
      if (!row) return res.status(404).json({ error: 'Artista no encontrado' });
      const parts = splitArtists(row.artista);
      artistName = parts[0] || row.artista;
    }
    const albums = albumsForArtist(artistName, req.userId);
    res.json({ artista: artistName, albums });
  });

  // Todas las canciones del artista (split-aware), ordenadas como una
  // discografía cronológica. Lo consume el botón "Reproducir" del drawer
  // de artistas.
  app.get('/api/artists/:id/tracks', guard, (req, res) => {
    const id = Number(req.params.id);
    let artistName = (req.query.name || '').toString().trim();
    if (!artistName) {
      const row = db.get().prepare(`SELECT artista FROM tracks WHERE id = ?`).get(id);
      if (!row) return res.status(404).json({ error: 'Artista no encontrado' });
      const parts = splitArtists(row.artista);
      artistName = parts[0] || row.artista;
    }
    res.json({ artista: artistName, tracks: tracksForArtist(artistName) });
  });

  app.get('/api/genres/:id/albums', guard, (req, res) => {
    const id = Number(req.params.id);
    const g = db.get().prepare(`SELECT genre FROM tracks WHERE id = ?`).get(id);
    if (!g || !g.genre) return res.status(404).json({ error: 'Género no encontrado' });
    const albums = albumsByPredicate(`genre = ?`, [g.genre]);
    res.json({ genero: g.genre, albums });
  });

  // ---- artist info (Wikipedia / Last.fm) --------------------------------
  // Query params:
  //   name          (obligatorio) — nombre del artista tal cual lo conoce el frontend
  //   mbid          (opcional)   — fija el artista concreto tras el picker
  //   disambiguate  (opcional)   — si "1"/"true", puede responder con
  //                                {ambiguous:true, candidates:[…]} cuando MB
  //                                devuelve varios artistas con ese nombre.
  app.get('/api/artist-info', guard, async (req, res) => {
    const name = (req.query.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'Falta name' });
    const mbid = (req.query.mbid || '').toString().trim() || null;
    const disambiguateRaw = (req.query.disambiguate || '').toString().toLowerCase();
    const disambiguate = disambiguateRaw === '1' || disambiguateRaw === 'true';
    try {
      const info = await artistinfo.getArtistInfo(name, { mbid, disambiguate });
      if (!info) return res.status(404).json({ error: 'Sin información' });
      res.json(info);
    } catch (e) {
      console.error('[artist-info]', e);
      res.status(502).json({ error: 'No se pudo obtener la info' });
    }
  });

  // ---- Debug temporal ---------------------------------------------------
  app.post('/api/_debug', guard, (req, res) => {
    console.log('[renderer]', JSON.stringify(req.body || {}));
    res.sendStatus(204);
  });

  // ---- MusicBrainz ------------------------------------------------------
  // Detalle enriquecido de un álbum (tags, descripción, sello, fecha).
  // Acepta el id local del álbum (=MIN(track.id) de ese álbum); resolvemos
  // el (titulo, albumartist) y consultamos MusicBrainz con cache.
  app.get('/api/mb/album/:id', guard, async (req, res) => {
    const id = Number(req.params.id);
    const ref = albumRefById(id);
    if (!ref) return res.status(404).json({ error: 'Álbum no encontrado' });
    try {
      // Para colab "A & B", consultamos con el primer componente como
      // artista — es el que MB suele indexar como crédito principal.
      const primaryArtist = splitArtists(ref.albumartist)[0] || ref.albumartist;
      const info = await musicbrainz.lookupAlbum(ref.album, primaryArtist);
      res.json(info || { tags: [] });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Tags MB de un artista (para las "pills" en la vista de artista).
  app.get('/api/mb/artist', guard, async (req, res) => {
    const name = (req.query.name || '').toString().trim();
    if (!name) return res.status(400).json({ error: 'Falta name' });
    try {
      const info = await musicbrainz.lookupArtist(name);
      res.json(info || { tags: [] });
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  });

  // Géneros "maestros": agrupa la biblioteca por el tag más votado de
  // cada elemento (track | album | artist) según el filtro pedido.
  // Sólo usa lo que ya hay en cache — no dispara llamadas a MB en
  // caliente (eso bloquearía la respuesta varios segundos). Quien
  // quiera datos frescos abre los álbumes/artistas y se rellena la
  // cache poco a poco.
  app.get('/api/genres-master', guard, (req, res) => {
    const filter = (req.query.by || 'album').toString();
    if (!['album', 'artist', 'song'].includes(filter)) {
      return res.status(400).json({ error: 'by debe ser album|artist|song' });
    }
    res.json(buildMasterGenres(filter, req.userId));
  });

  // ---- Last.fm ----------------------------------------------------------
  // Estado de configuración + conexión del usuario actual.
  app.get('/api/lastfm/status', guard, (req, res) => {
    const a = db.getLastfmAuth(req.userId);
    res.json({
      hasConfig: !!(lastfm.getApiKey() && lastfm.getApiSecret()),
      hasKey:    !!lastfm.getApiKey(),
      hasSecret: !!lastfm.getApiSecret(),
      connected: !!a?.session_key,
      username:  a?.username || null,
    });
  });

  // Login directo con username + password de Last.fm (auth.getMobileSession).
  // Sólo la session_key se guarda en BD; la password se descarta tras la
  // llamada. La sesión de NoBreak (guard) es obligatoria para evitar que
  // un proceso local malicioso suplante credenciales.
  app.post('/api/lastfm/login', guard, async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Falta username o password' });
    try {
      const { sessionKey, username: name } = await lastfm.getMobileSession(username, password);
      if (!sessionKey) return res.status(401).json({ error: 'Last.fm rechazó las credenciales' });
      db.setLastfmAuth(req.userId, sessionKey, name);
      res.json({ username: name });
    } catch (e) {
      // Last.fm devuelve "Authentication failed: ..." en e.message; lo pasamos tal cual.
      res.status(401).json({ error: e.message });
    }
  });

  app.post('/api/lastfm/disconnect', guard, (req, res) => {
    db.clearLastfmAuth(req.userId);
    res.sendStatus(204);
  });

  // "Now playing" y "scrobble" se llaman desde el renderer cuando arranca/termina
  // un track. Nunca devolvemos error duro: si Last.fm falla, lo registramos y
  // seguimos — no queremos que afecte a la reproducción local.
  app.post('/api/lastfm/now-playing', guard, async (req, res) => {
    const { artist, track, album, durationMs } = req.body || {};
    if (!artist || !track) return res.sendStatus(204);
    const a = db.getLastfmAuth(req.userId);
    if (!a?.session_key) return res.sendStatus(204);
    try {
      await lastfm.updateNowPlaying({
        sessionKey: a.session_key, artist, track, album, durationMs: Number(durationMs) || null,
      });
    } catch (e) { console.warn('[lastfm] now-playing:', e.message); }
    res.sendStatus(204);
  });

  app.post('/api/lastfm/scrobble', guard, async (req, res) => {
    const { artist, track, album, startedAt, durationMs } = req.body || {};
    if (!artist || !track || !startedAt) return res.sendStatus(204);
    const a = db.getLastfmAuth(req.userId);
    if (!a?.session_key) return res.sendStatus(204);
    const item = {
      artist, track, album,
      startedAt: Number(startedAt),
      durationMs: Number(durationMs) || null,
    };
    try {
      await lastfm.scrobble({ sessionKey: a.session_key, ...item });
      // Llamada en caliente OK → aprovechamos para drenar lo que haya en cola.
      flushScrobbleQueueFor(req.userId).catch(() => {});
    } catch (e) {
      console.warn('[lastfm] scrobble falló — encolando offline:', e.message);
      db.enqueueScrobble(req.userId, item);
    }
    res.sendStatus(204);
  });

  // Drena manualmente la cola offline del usuario actual. Útil si quieres
  // forzar un reintento desde la UI sin esperar al flusher periódico.
  app.post('/api/lastfm/flush', guard, async (req, res) => {
    const result = await flushScrobbleQueueFor(req.userId);
    res.json(result);
  });

  app.get('/api/lastfm/queue', guard, (req, res) => {
    res.json({ pending: db.countQueuedScrobbles(req.userId) });
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

  // Portada custom de playlist y de género (sin auth: solo localhost).
  // Sin cabecera de cache para que cuando el usuario la cambia se vea ya.
  app.get('/playlist-cover/:id', (req, res) => {
    const id = Number(req.params.id);
    const p = db.getPlaylistCover(id);
    if (!p || !fs.existsSync(p)) return res.status(404).end();
    res.sendFile(p);
  });
  app.get('/genre-cover/:name', (req, res) => {
    const p = db.getGenreCover(decodeURIComponent(req.params.name));
    if (!p || !fs.existsSync(p)) return res.status(404).end();
    res.sendFile(p);
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

// Acota a string trimeado, devuelve null si queda vacío. Trunca a maxLen.
function stringOrNull(v, maxLen) {
  if (v == null) return null;
  let s = String(v).trim();
  if (!s) return null;
  if (maxLen && s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}

// Forma común para "yo": incluye email + flags privados.
function serializeMe(u) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || u.username,
    email: u.email || null,
    emailVerified: !!u.email_verified,
    description: u.description || '',
    photoUrl: u.photo_path ? `/profile-photo/${u.id}` : null,
    backgroundUrl: u.profile_background ? `/profile-bg/${u.id}` : null,
    frameUrl: u.profile_frame ? `/profile-frame/${u.id}` : null,
    profileWidgets: parseWidgetsJson(u.profile_widgets),
    profileHtml: u.profile_html || '',
    advancedMode: !!u.advanced_mode,
    uiSettings: parseJsonObject(u.ui_settings),
    createdAt: u.created_at,
  };
}

// Devuelve {} para null/JSON inválido. Igual que parseWidgetsJson pero sin la
// envoltura {widgets: [...]} — ui_settings es un mapa plano clave→valor.
function parseJsonObject(s) {
    if (!s) return {};
    try { const v = JSON.parse(s); return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}; }
    catch { return {}; }
}

// Forma para perfil público: omite email + verified si no eres tú.
function serializePublicProfile(u, viewerId) {
  const isOwner = viewerId === u.id;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name || u.username,
    description: u.description || '',
    photoUrl: u.photo_path ? `/profile-photo/${u.id}` : null,
    backgroundUrl: u.profile_background ? `/profile-bg/${u.id}` : null,
    frameUrl: u.profile_frame ? `/profile-frame/${u.id}` : null,
    profileWidgets: parseWidgetsJson(u.profile_widgets),
    profileHtml: u.profile_html || '',
    advancedMode: !!u.advanced_mode,
    createdAt: u.created_at,
    isOwner,
    // Sólo el dueño recibe email/verificación.
    email: isOwner ? (u.email || null) : null,
    emailVerified: isOwner ? !!u.email_verified : null,
  };
}

function parseWidgetsJson(raw) {
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

function extractToken(req) {
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) {
    const t = h.substring(7).trim();
    if (t) return t;
  }
  if (req.query && req.query.t) return String(req.query.t);
  return null;
}

function queryAlbums(userId) {
  // Aggregated from tracks. Album identity = (album, albumartist OR artista),
  // case-insensitive. La valoración del álbum se calcula como la media de
  // las valoraciones por canción del usuario (track_ratings); si ninguna
  // canción del álbum tiene rating la valoración del álbum es null.
  const avgRatings = userId ? db.getAlbumAvgRatings(userId) : new Map();
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
    GROUP BY LOWER(album), LOWER(COALESCE(albumartist, artista))
    ORDER BY artista, year, album
  `).all().map(a => {
    const key = db.albumKey(a.titulo, a.albumartist);
    const r = avgRatings.get(key);
    return {
      id: a.id,
      titulo: a.titulo,
      artista: a.artista,
      albumartist: a.albumartist,
      year: a.year,
      trackCount: a.trackCount,
      coverUrl: a.cover_path ? `/cover/${a.id}` : null,
      // Redondeada al medio entero más cercano (0.5–5.0) — el widget de
      // estrellas pinta medias estrellas a esa resolución.
      rating: r ? Math.round(r.avg * 2) / 2 : null,
      ratingCount: r ? r.count : 0,
    };
  });
}

function queryAlbumById(id, userId) {
  // The "id" of an album in our flat schema is the MIN(track.id) used as the
  // album's stable handle. So look up the track and re-aggregate that group.
  const track = db.get().prepare(
    'SELECT album, albumartist, artista, year, cover_path FROM tracks WHERE id = ?'
  ).get(id);
  if (!track || !track.album) return null;
  const albumArtist = track.albumartist || track.artista;
  // Rating = media de las valoraciones de las canciones del álbum para este
  // usuario. Mismo método que en queryAlbums.
  let rating = null, ratingCount = 0;
  if (userId) {
    const avgMap = db.getAlbumAvgRatings(userId);
    const r = avgMap.get(db.albumKey(track.album, albumArtist));
    if (r) { rating = Math.round(r.avg * 2) / 2; ratingCount = r.count; }
  }
  return {
    id,
    titulo: track.album,
    artista: albumArtist,
    albumartist: albumArtist,
    year: track.year,
    trackCount: db.get().prepare(
      `SELECT COUNT(*) AS n FROM tracks
       WHERE LOWER(album) = LOWER(?) AND LOWER(COALESCE(albumartist, artista)) = LOWER(?)`
    ).get(track.album, albumArtist).n,
    coverUrl: track.cover_path ? `/cover/${id}` : null,
    rating,
    ratingCount,
  };
}

// Cheap lookup used by the rating endpoints — only needs (album, albumartist)
// to compute the album_key, no aggregation.
function albumRefById(id) {
  if (!Number.isFinite(id)) return null;
  const t = db.get().prepare(
    'SELECT album, albumartist, artista FROM tracks WHERE id = ?'
  ).get(id);
  if (!t || !t.album) return null;
  return { album: t.album, albumartist: t.albumartist || t.artista };
}

function queryTracksOfAlbum(album, albumArtist, userId) {
  const ratings = userId ? db.getAllTrackRatings(userId) : new Map();
  return db.get().prepare(`
    SELECT id, titulo, artista, album, track_no, disc_no, duration_ms, cover_path
    FROM tracks
    WHERE LOWER(album) = LOWER(?) AND LOWER(COALESCE(albumartist, artista)) = LOWER(?)
    ORDER BY COALESCE(disc_no, 1), COALESCE(track_no, 9999), titulo
  `).all(album, albumArtist).map(row => {
    const json = toTrackJson(row);
    json.rating = ratings.get(row.id) ?? null;
    return json;
  });
}

// Separa una cadena de artista en componentes individuales cuando hay
// señales claras de colaboración: "&", ";", "feat./ft./featuring/vs.".
// Se mantiene conservador adrede — separadores como "," o "and" son
// demasiado comunes en nombres reales ("Earth, Wind & Fire", "Hall and
// Oates") para usarlos sin una lista curada de excepciones. Nota: el
// ampersand igualmente partirá "Earth, Wind & Fire" en dos; si esto es
// problema en tu biblioteca, re-etiqueta el campo "artista" del archivo.
function splitArtists(str) {
  if (!str) return [];
  const re = /\s*&\s*|\s*;\s*|\s+feat\.?\s+|\s+ft\.?\s+|\s+featuring\s+|\s+vs\.?\s+/i;
  return String(str).split(re).map(s => s.trim()).filter(Boolean);
}

function normalizeArtistKey(name) {
  return String(name || '').trim().toLowerCase();
}

function queryArtists() {
  // Leemos todos los tracks y agrupamos en JS: case-insensitive y
  // separando colaboraciones, de forma que "sunn O)))" y "SUNN O)))"
  // colapsen, y "Sunn O))) & Ulver" cuente para los dos artistas.
  const rows = db.get().prepare(`
    SELECT id, artista, album, cover_path
    FROM tracks
    WHERE artista IS NOT NULL AND artista <> ''
    ORDER BY id
  `).all();

  // key (lowercased) -> { displayCounts, trackCount, albumKeys, cover_path, minId }
  const groups = new Map();
  for (const r of rows) {
    const parts = splitArtists(r.artista);
    for (const part of parts) {
      const key = normalizeArtistKey(part);
      if (!key) continue;
      let g = groups.get(key);
      if (!g) {
        g = {
          displayCounts: new Map(),
          trackCount: 0,
          albumKeys: new Set(),
          cover_path: r.cover_path || null,
          minId: r.id,
        };
        groups.set(key, g);
      }
      g.trackCount++;
      if (r.album) g.albumKeys.add(r.album.toLowerCase().trim());
      g.displayCounts.set(part, (g.displayCounts.get(part) || 0) + 1);
      if (r.id < g.minId) g.minId = r.id;
      if (!g.cover_path && r.cover_path) g.cover_path = r.cover_path;
    }
  }

  // Para el nombre mostrado escogemos la grafía más frecuente (en empate,
  // alfabéticamente). Así "SUNN O)))" no se impone si aparece menos.
  function pickDisplayName(counts) {
    let best = null, bestN = -1;
    for (const [name, n] of counts) {
      if (n > bestN || (n === bestN && (best == null || name.localeCompare(best) < 0))) {
        best = name; bestN = n;
      }
    }
    return best;
  }

  return Array.from(groups.values())
    .map(g => ({
      id: g.minId,
      nombre: pickDisplayName(g.displayCounts),
      trackCount: g.trackCount,
      albumCount: g.albumKeys.size,
      coverUrl: g.cover_path ? `/cover/${g.minId}` : null,
    }))
    .sort((a, b) => a.nombre.localeCompare(b.nombre));
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

// Álbumes en los que un artista (por nombre) participa, considerando
// colaboraciones. Pasa tanto el campo `artista` del track como el
// `albumartist` por splitArtists() y comprueba si alguno de los
// componentes coincide (case-insensitive) con el nombre pedido. Así un
// álbum "Sunn O))) & Ulver" aparece en la discografía de ambos.
function albumsForArtist(artistName, userId) {
  const key = normalizeArtistKey(artistName);
  if (!key) return [];

  // Pre-filtro SQL barato con LIKE para no traer toda la tabla. El JS
  // después aplica el match exacto por componente.
  const likeParam = '%' + key.replace(/[\\%_]/g, '\\$&') + '%';
  const rows = db.get().prepare(`
    SELECT id, album, albumartist, artista, year, cover_path
    FROM tracks
    WHERE album IS NOT NULL AND album <> ''
      AND (LOWER(artista) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(albumartist, '')) LIKE ? ESCAPE '\\')
  `).all(likeParam, likeParam);

  const matches = rows.filter(r => {
    const comps = [
      ...splitArtists(r.artista),
      ...splitArtists(r.albumartist || ''),
    ];
    return comps.some(c => normalizeArtistKey(c) === key);
  });

  // Agrupamos por álbum (case-insensitive). El display name del album y
  // el albumartist conservan la grafía de una fila arbitraria del grupo.
  const albums = new Map();
  for (const r of matches) {
    const aKey = (r.album || '').toLowerCase().trim();
    if (!aKey) continue;
    let a = albums.get(aKey);
    if (!a) {
      a = {
        id: r.id,
        titulo: r.album,
        albumartist: r.albumartist || r.artista,
        year: r.year || null,
        cover_path: r.cover_path,
        trackCount: 0,
      };
      albums.set(aKey, a);
    }
    a.trackCount++;
    if (r.id < a.id) {
      a.id = r.id;
      // Cuando cambia el id "ancla" del álbum, también su cover.
      if (r.cover_path) a.cover_path = r.cover_path;
    }
    if (r.year && (!a.year || r.year < a.year)) a.year = r.year;
    if (!a.cover_path && r.cover_path) a.cover_path = r.cover_path;
  }

  const ratings = userId ? db.getAllAlbumRatings(userId) : new Map();
  return Array.from(albums.values())
    .map(a => ({
      id: a.id,
      titulo: a.titulo,
      artista: a.albumartist,
      albumartist: a.albumartist,
      year: a.year,
      trackCount: a.trackCount,
      coverUrl: a.cover_path ? `/cover/${a.id}` : null,
      rating: ratings.get(db.albumKey(a.titulo, a.albumartist)) ?? null,
    }))
    .sort((x, y) => (x.year || 9999) - (y.year || 9999)
                 || (x.titulo || '').localeCompare(y.titulo || ''));
}

// Todos los tracks de un artista (split-aware) ordenados por año/álbum/disco/track,
// que es lo que espera "Reproducir artista" para sonar como una discografía
// secuencial.
function tracksForArtist(artistName) {
  const key = normalizeArtistKey(artistName);
  if (!key) return [];
  const likeParam = '%' + key.replace(/[\\%_]/g, '\\$&') + '%';
  const rows = db.get().prepare(`
    SELECT id, titulo, artista, album, albumartist, year, genre,
           track_no, disc_no, duration_ms, codec, cover_path
    FROM tracks
    WHERE LOWER(artista) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(albumartist, '')) LIKE ? ESCAPE '\\'
  `).all(likeParam, likeParam);

  const matches = rows.filter(r => {
    const comps = [
      ...splitArtists(r.artista),
      ...splitArtists(r.albumartist || ''),
    ];
    return comps.some(c => normalizeArtistKey(c) === key);
  });

  matches.sort((a, b) => {
    const ya = a.year || 9999, yb = b.year || 9999;
    if (ya !== yb) return ya - yb;
    const al = (a.album || '').toLowerCase().localeCompare((b.album || '').toLowerCase());
    if (al !== 0) return al;
    const da = a.disc_no || 1, dbn = b.disc_no || 1;
    if (da !== dbn) return da - dbn;
    return (a.track_no || 9999) - (b.track_no || 9999);
  });

  return matches.map(toTrackJson);
}

// Agrupa la biblioteca por "género maestro" (tag más votado en MB) sobre
// los items que ya tienen entrada en mb_album_cache / mb_artist_cache. Si
// no hay cache, ese item se omite del listado — se rellenará a medida
// que el usuario abra álbumes/artistas. Devuelve:
//   { filter: 'album'|'artist'|'song', genres: [{ name, count, items: [...] }] }
// donde items son resúmenes ligeros para pintar cards (id, titulo, etc).
function buildMasterGenres(filter, userId) {
  // Mapas auxiliares: keyLower → tag más votado.
  const albumMaster = new Map();
  for (const r of db.getAllMbAlbumTags()) {
    const top = (r.tags || [])[0];
    if (top?.name) albumMaster.set(r.album_key, top.name);
  }
  const artistMaster = new Map();
  for (const r of db.getAllMbArtistTags()) {
    const top = (r.tags || [])[0];
    if (top?.name) artistMaster.set(r.artist_key, top.name);
  }

  // FALLBACK: si MB no tiene tags para algún elemento, usamos el campo
  // `genre` del ID3 — el más común en sus pistas. Así garantizamos que
  // ningún álbum se quede sin categoría visible.
  const id3 = buildId3GenreMaps();

  const out = new Map();  // genreName(lowercased) → { name, count, items }
  const push = (genreName, item) => {
    const name = (genreName && genreName.trim()) || 'Sin clasificar';
    const k = name.toLowerCase();
    let e = out.get(k);
    if (!e) { e = { name, count: 0, items: [] }; out.set(k, e); }
    e.items.push(item);
    e.count++;
  };

  // Fallback de tercer nivel: si un álbum/canción no tiene tag propio,
  // hereda el del artista (MB o ID3). Esto reduce muchísimo "Sin clasificar"
  // para bootlegs, EPs y splits que MB no tiene tagueados pero sí su autor.
  const tagFromArtist = (artistName) => {
    if (!artistName) return null;
    for (const comp of splitArtists(artistName)) {
      const k = comp.toLowerCase().trim();
      if (!k) continue;
      const t = artistMaster.get(k) || id3.artistTop.get(k);
      if (t) return t;
    }
    return null;
  };

  if (filter === 'album') {
    const albums = queryAlbums(userId);
    for (const a of albums) {
      const key = db.mbAlbumKey(a.titulo, a.albumartist);
      const g = albumMaster.get(key)
             || id3.albumTop.get(key)
             || tagFromArtist(a.albumartist || a.artista)
             || null;
      push(g, {
        id: a.id, titulo: a.titulo, artista: a.artista,
        year: a.year, coverUrl: a.coverUrl, trackCount: a.trackCount,
      });
    }
  } else if (filter === 'artist') {
    const artists = queryArtists();
    for (const a of artists) {
      const key = (a.nombre || '').toLowerCase().trim();
      const g = artistMaster.get(key) || id3.artistTop.get(key) || null;
      push(g, { id: a.id, nombre: a.nombre, coverUrl: a.coverUrl, trackCount: a.trackCount });
    }
  } else if (filter === 'song') {
    // Para canciones: tag maestro del álbum (MB → ID3 álbum) → genre ID3
    // de la pista → tag del artista. Tres niveles de respaldo.
    const rows = db.get().prepare(`
      SELECT id, titulo, artista, album, COALESCE(albumartist, artista) AS aa,
             genre, cover_path, duration_ms
      FROM tracks
      WHERE album IS NOT NULL AND album <> ''
      ORDER BY artista, album, COALESCE(disc_no, 1), COALESCE(track_no, 9999)
    `).all();
    for (const r of rows) {
      const key = db.mbAlbumKey(r.album, r.aa);
      const g = albumMaster.get(key)
             || id3.albumTop.get(key)
             || r.genre
             || tagFromArtist(r.aa || r.artista)
             || null;
      push(g, {
        id: r.id, titulo: r.titulo, artista: r.artista, album: r.album,
        durationMs: r.duration_ms, coverUrl: r.cover_path ? `/cover/${r.id}` : null,
      });
    }
  }

  // Adjunta coverUrl si hay portada custom para este género, además de
  // sampleCovers (hasta 9 portadas únicas por álbum) para alimentar el
  // collage del frontend. Dedup robusta: para songs comparamos por
  // album+artista; para album/artist por el id propio del item.
  const customCovers = new Map();
  for (const c of db.getAllGenreCovers()) customCovers.set(c.name_key, c.cover_path);

  const genres = Array.from(out.values()).map(g => {
    const sampleCovers = [];
    const seen = new Set();
    for (const it of g.items) {
      let key;
      if (filter === 'song') {
        key = (it.album || '').toLowerCase().trim()
            + '\x1f' + (it.artista || '').toLowerCase().trim();
      } else {
        key = 'id:' + it.id;
      }
      if (seen.has(key) || !it.coverUrl) continue;
      seen.add(key);
      sampleCovers.push(it.coverUrl);
      if (sampleCovers.length >= 9) break;
    }
    const cover = customCovers.get(g.name.toLowerCase());
    return {
      ...g,
      coverUrl: cover ? '/genre-cover/' + encodeURIComponent(g.name) : null,
      sampleCovers,
    };
  }).sort((a, b) => b.count - a.count);
  return { filter, genres };
}

// Lee `tracks.genre` para construir dos mapas: género más común por álbum
// y por artista (split-aware). Lo invoca buildMasterGenres como fallback
// cuando MusicBrainz aún no ha cacheado un elemento.
function buildId3GenreMaps() {
  const rows = db.get().prepare(`
    SELECT album, COALESCE(albumartist, artista) AS aa, artista, genre
    FROM tracks
    WHERE genre IS NOT NULL AND genre <> ''
  `).all();
  // album_key -> Map(genre -> count)
  const albumCounts = new Map();
  // artist_key (lowercased) -> Map(genre -> count)
  const artistCounts = new Map();
  for (const r of rows) {
    if (r.album && r.aa) {
      const k = db.mbAlbumKey(r.album, r.aa);
      let m = albumCounts.get(k);
      if (!m) { m = new Map(); albumCounts.set(k, m); }
      m.set(r.genre, (m.get(r.genre) || 0) + 1);
    }
    if (r.artista) {
      for (const comp of splitArtists(r.artista)) {
        const k = comp.toLowerCase().trim();
        if (!k) continue;
        let m = artistCounts.get(k);
        if (!m) { m = new Map(); artistCounts.set(k, m); }
        m.set(r.genre, (m.get(r.genre) || 0) + 1);
      }
    }
  }
  const albumTop = new Map();
  for (const [k, m] of albumCounts) albumTop.set(k, pickTop(m));
  const artistTop = new Map();
  for (const [k, m] of artistCounts) artistTop.set(k, pickTop(m));
  return { albumTop, artistTop };
}
function pickTop(m) {
  let best = null, bestN = -1;
  for (const [g, n] of m) if (n > bestN) { best = g; bestN = n; }
  return best;
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
let _scrobbleFlushTimer = null;
const MAX_QUEUE_ATTEMPTS = 10;

// Drena la cola de scrobbles pendientes de un usuario. Para en cuanto
// vuelve a fallar (asume que la red sigue muerta), descarta entradas que
// han superado el límite de reintentos para no quedarnos encallados.
async function flushScrobbleQueueFor(userId) {
  const a = db.getLastfmAuth(userId);
  if (!a?.session_key) return { sent: 0, remaining: db.countQueuedScrobbles(userId), reason: 'no-session' };
  let sent = 0, discarded = 0;
  let batch;
  while ((batch = db.getQueuedScrobbles(userId, 50)).length) {
    for (const s of batch) {
      try {
        await lastfm.scrobble({
          sessionKey: a.session_key,
          artist: s.artist, track: s.track, album: s.album,
          startedAt: s.started_at, durationMs: s.duration_ms,
        });
        db.removeQueuedScrobble(s.id);
        sent++;
      } catch (e) {
        db.bumpQueuedScrobbleAttempts(s.id);
        if (s.attempts + 1 >= MAX_QUEUE_ATTEMPTS) {
          db.removeQueuedScrobble(s.id);
          discarded++;
          console.warn('[lastfm] cola: descartado tras', MAX_QUEUE_ATTEMPTS, 'intentos:', s.artist, '—', s.track);
        }
        // Red caída: no insistas con el resto del lote, espera al próximo flush.
        return { sent, remaining: db.countQueuedScrobbles(userId), discarded };
      }
    }
  }
  return { sent, remaining: db.countQueuedScrobbles(userId), discarded };
}

// Flusher periódico: cada 5 min intenta vaciar la cola de cada usuario.
function startScrobbleFlusher() {
  if (_scrobbleFlushTimer) return;
  _scrobbleFlushTimer = setInterval(() => {
    const users = db.listUsersWithQueuedScrobbles();
    for (const uid of users) flushScrobbleQueueFor(uid).catch(() => {});
  }, 5 * 60 * 1000);
}

function start(opts = {}) {
  if (server) return;
  webDir = opts.webDir || null;
  const app = build();
  server = app.listen(PORT, HOST, () => {
    const where = webDir ? `con sitio web en /` : `(API solo)`;
    console.log(`NoBreak HTTP server escuchando en http://${HOST}:${PORT} ${where}`);
  });
  startScrobbleFlusher();
  // Flush inicial a los pocos segundos: si volvió la conexión mientras
  // estábamos cerrados, los scrobbles antiguos salen ya.
  setTimeout(() => {
    for (const uid of db.listUsersWithQueuedScrobbles()) {
      flushScrobbleQueueFor(uid).catch(() => {});
    }
  }, 8000);
}

function stop() {
  if (_scrobbleFlushTimer) { clearInterval(_scrobbleFlushTimer); _scrobbleFlushTimer = null; }
  if (!server) return;
  server.close();
  server = null;
}

module.exports = { start, stop, PORT, HOST, splitArtists };
