// Electron main process. Owns: DB, scanner, watcher, HTTP server, app window,
// app menu (Biblioteca → cambiar carpeta / actualizar / cerrar sesión).
//
// The renderer authenticates over HTTP (same flow as the browser), so /auth/login,
// /api/*, /stream/* are all handled in webserver.js. IPC is only used for things
// the renderer can't do from the browser sandbox: native folder dialog, settings.

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

// Carga variables de un .env adyacente al main.js antes de que cualquier
// módulo las consulte. Implementación mínima — soporta KEY=VALUE, líneas
// vacías y comentarios con #. No sobrescribe variables ya presentes en el
// entorno (útil cuando el usuario las exporta en su shell).
(function loadDotenv() {
  try {
    const file = path.join(__dirname, '.env');
    if (!fs.existsSync(file)) return;
    const raw = fs.readFileSync(file, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
      if (!m) continue;
      const key = m[1];
      let val = m[2];
      // Quita comillas envolventes opcionales.
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] == null) process.env[key] = val;
    }
  } catch (e) { console.warn('[dotenv]', e.message); }
})();

const db = require('./db');
const auth = require('./auth');
const scanner = require('./scanner');
const { LibraryWatcher } = require('./watcher');
const webserver = require('./webserver');
const musicbrainz = require('./musicbrainz');
const cloud = require('./cloud');
const cloudRelay = require('./cloud-relay');
const tunnel = require('./tunnel');

let mainWindow = null;
let watcher = null;
let scanInProgress = false;
let coverDir = null;

function dbPath() {
  return path.join(app.getPath('userData'), 'NoBreak.db');
}

function appCoverDir() {
  // Use a top-level "covers" dir, not "cache/art": Electron uses several
  // capital-cased subdirs ("Cache", "Code Cache", "GPUCache") and a
  // lowercase "cache" of its own at runtime — colocating ours under there
  // risks files being managed/cleared by Electron's session machinery.
  return path.join(app.getPath('userData'), 'covers');
}

/**
 * Where to find the static website to serve at /. Two locations searched
 * in order, since dev (running from repo) and packaged distribution put
 * the files in different places:
 *   1. {appDir}/../Frontend ← repo's Frontend/ when running with npm start
 *                             (only exists in the dev tree)
 *   2. {appDir}/web/        ← copied here at build time by copy-web.js
 *                             (the only one that exists in the packaged EXE)
 * Frontend/ is checked first so editing Frontend/* during dev is reflected
 * on a browser refresh, even when a stale desktop/web/ from a prior `npm run
 * dist` is still on disk.
 * Returns null if neither exists; the API still works without static serving.
 */
function findWebDir() {
  // En dev (npm start desde el repo) servimos Frontend/ del repo para poder
  // usar la app entera desde 127.0.0.1:8080 sin pasar por el Worker — útil
  // cuando la red bloquea el túnel (universidades, redes corporativas) o
  // cuando se quiere probar local sin levantar cloudflared.
  // En el .exe packagiado no existe esa carpeta hermana, así que devolvemos
  // null y / responde con el placeholder "NoBreak vault activo".
  const devFrontend = path.join(__dirname, '..', 'Frontend');
  try {
    if (fs.existsSync(path.join(devFrontend, 'index.html'))) return devFrontend;
  } catch {}
  return null;
}

// ---------------- Window ----------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 820,
    minHeight: 520,
    backgroundColor: '#121212',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
    title: 'NoBreak Player',
  });
  mainWindow.loadFile(path.join(__dirname, 'src', 'renderer', 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

// ---------------- App menu --------------------------------------------------

function buildMenu() {
  const template = [
    {
      label: 'Biblioteca',
      submenu: [
        { label: 'Cambiar carpeta…', click: () => menuChangeFolder() },
        { label: 'Actualizar biblioteca', click: () => menuRescan() },
        { type: 'separator' },
        { label: 'Cerrar sesión', click: () => menuLogout() },
        { type: 'separator' },
        { label: 'Salir', role: 'quit' },
      ],
    },
    {
      label: 'Ver',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' },
      ],
    },
    {
      label: 'Ayuda',
      submenu: [
        { label: 'Sobre NoBreak', click: () => dialog.showMessageBox(mainWindow, {
          type: 'info', title: 'NoBreak',
          message: 'NoBreak Player',
          detail: 'Reproductor de música local sin anuncios.\nServidor HTTP en http://127.0.0.1:' + webserver.PORT,
        })},
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

async function menuChangeFolder() {
  const folder = await pickFolderDialog();
  if (!folder) return;
  db.setLibraryFolder(folder);
  await restartWatcher(folder);
  notifyRenderer('library:folder-changed', folder);
  triggerRescan();
}

function menuRescan() {
  triggerRescan();
}

function menuLogout() {
  notifyRenderer('auth:logged-out');
}

// ---------------- Folder picker ---------------------------------------------

async function pickFolderDialog() {
  const current = db.getLibraryFolder();
  const r = await dialog.showOpenDialog(mainWindow, {
    title: 'Selecciona la carpeta de música',
    properties: ['openDirectory'],
    defaultPath: current && fs.existsSync(current)
      ? current
      : path.join(app.getPath('home'), 'Music'),
  });
  if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
  return r.filePaths[0];
}

// ---------------- Scan + watcher --------------------------------------------

async function triggerRescan() {
  const folder = db.getLibraryFolder();
  if (!folder) return null;
  if (scanInProgress) return null;
  scanInProgress = true;
  notifyRenderer('scan:start');
  try {
    const report = await scanner.scan(folder, coverDir, (msg) => {
      notifyRenderer('scan:progress', msg);
    });
    notifyRenderer('scan:done', report);
    // Tras el escaneo arrancamos (sin esperar) un backfill de tags de MB
    // para los álbumes nuevos. La función ya filtra los que tengan cache
    // reciente, así que llamarla de nuevo es barato.
    scheduleMbBackfill();
    return report;
  } catch (e) {
    notifyRenderer('scan:error', e.message || String(e));
    return null;
  } finally {
    scanInProgress = false;
  }
}

// Lanza un backfill de MusicBrainz en background. Se debouncea para que
// múltiples eventos (arranque + rescan + watcher) no apilen ejecuciones.
let _mbBackfillRunning = false;
let _mbBackfillPending = false;
function scheduleMbBackfill() {
  if (_mbBackfillRunning) { _mbBackfillPending = true; return; }
  _mbBackfillRunning = true;
  // Pequeño delay para no competir con el escaneo recién terminado.
  setTimeout(async () => {
    try {
      // Pasamos splitArtists desde webserver (ya lo tiene).
      const { splitArtists } = require('./webserver');
      await musicbrainz.backfillCache(db, splitArtists || ((s) => [s].filter(Boolean)));
    } catch (e) {
      console.warn('[mb] backfill threw:', e.message || e);
    } finally {
      _mbBackfillRunning = false;
      if (_mbBackfillPending) { _mbBackfillPending = false; scheduleMbBackfill(); }
    }
  }, 4000);
}

// Decodifica un data-url "data:image/<ext>;base64,<base64>" y devuelve
// { bytes: Buffer, ext: string }. Lanza si el formato/tamaño no es válido.
function decodeImageDataUrl(dataUrl, maxBytes) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
    throw new Error('Formato de imagen no válido');
  }
  const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
  if (!m) throw new Error('No se pudo leer la imagen');
  const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
  const bytes = Buffer.from(m[2], 'base64');
  if (maxBytes && bytes.length > maxBytes) {
    throw new Error('La imagen supera el tamaño máximo permitido');
  }
  return { bytes, ext };
}

async function restartWatcher(folder) {
  if (watcher) { await watcher.stop(); watcher = null; }
  if (!folder || !fs.existsSync(folder)) return;
  watcher = new LibraryWatcher(folder, () => triggerRescan());
  watcher.start();
}

function notifyRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------- IPC -------------------------------------------------------

function registerIpc() {
  ipcMain.handle('auth:hasUser', () => auth.hasAnyUser());

  // Multi-cuenta: cualquier usuario puede registrarse desde la pantalla de
  // registro. La biblioteca de música se comparte entre cuentas en la misma
  // máquina; ratings, listening stats y foto de perfil son por usuario.
  ipcMain.handle('auth:register', (_e, username, password, email) => {
    try {
      auth.createUser(username, password, { email });
      // Avisa al Worker para que actualice user_routes sin esperar al
      // próximo heartbeat de 60s (binding cuenta↔servidor "instantáneo").
      cloudRelay.kick?.();
      return { ok: true };
    } catch (e) {
      if (/UNIQUE constraint/i.test(e.message)) {
        throw new Error('Ese usuario ya existe. Elige otro o inicia sesión.');
      }
      throw e;
    }
  });

  // Guarda el data-url como archivo en userData/photos/<userId>.<ext> y persiste
  // la ruta absoluta en la fila del usuario. Devuelve { photoUrl } servible
  // por el HTTP server (/profile-photo/<userId>).
  ipcMain.handle('profile:savePhoto', (_e, sessionToken, dataUrl) => {
    const userId = auth.verifySession(sessionToken);
    if (!userId) throw new Error('Sesión inválida');
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      throw new Error('Formato de imagen no válido');
    }
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
    if (!m) throw new Error('No se pudo leer la imagen');
    const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 5 * 1024 * 1024) throw new Error('La imagen no puede superar 5 MB');
    const photosDir = path.join(app.getPath('userData'), 'photos');
    fs.mkdirSync(photosDir, { recursive: true });
    // Limpia variantes anteriores con otra extensión.
    for (const f of fs.readdirSync(photosDir)) {
      if (f.startsWith(userId + '.')) {
        try { fs.unlinkSync(path.join(photosDir, f)); } catch {}
      }
    }
    const out = path.join(photosDir, `${userId}.${ext}`);
    fs.writeFileSync(out, buf);
    auth.setProfilePhoto(userId, out);
    return { photoUrl: `/profile-photo/${userId}?v=${Date.now()}` };
  });

  // Fondo de perfil. Acepta dataUrl=null para limpiar.
  ipcMain.handle('profile:saveBackground', (_e, sessionToken, dataUrl) => {
    const userId = auth.verifySession(sessionToken);
    if (!userId) throw new Error('Sesión inválida');
    const bgsDir = path.join(app.getPath('userData'), 'backgrounds');
    fs.mkdirSync(bgsDir, { recursive: true });
    if (dataUrl == null) {
      // Borrar variantes existentes y limpiar.
      try {
        for (const f of fs.readdirSync(bgsDir)) {
          if (f.startsWith(userId + '.')) fs.unlinkSync(path.join(bgsDir, f));
        }
      } catch {}
      auth.setProfileBackground(userId, null);
      return { backgroundUrl: null };
    }
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      throw new Error('Formato de imagen no válido');
    }
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
    if (!m) throw new Error('No se pudo leer la imagen');
    const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) throw new Error('La imagen no puede superar 8 MB');
    for (const f of fs.readdirSync(bgsDir)) {
      if (f.startsWith(userId + '.')) {
        try { fs.unlinkSync(path.join(bgsDir, f)); } catch {}
      }
    }
    const out = path.join(bgsDir, `${userId}.${ext}`);
    fs.writeFileSync(out, buf);
    auth.setProfileBackground(userId, out);
    return { backgroundUrl: `/profile-bg/${userId}?v=${Date.now()}` };
  });

  // Marco PNG superpuesto a la foto. dataUrl=null para borrar.
  ipcMain.handle('profile:saveFrame', (_e, sessionToken, dataUrl) => {
    const userId = auth.verifySession(sessionToken);
    if (!userId) throw new Error('Sesión inválida');
    const dir = path.join(app.getPath('userData'), 'frames');
    fs.mkdirSync(dir, { recursive: true });
    if (dataUrl == null) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (f.startsWith(userId + '.')) fs.unlinkSync(path.join(dir, f));
        }
      } catch {}
      auth.setProfileFrame(userId, null);
      return { frameUrl: null };
    }
    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
      throw new Error('Formato de imagen no válido');
    }
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(dataUrl);
    if (!m) throw new Error('No se pudo leer la imagen');
    const ext = m[1].toLowerCase().replace('jpeg', 'jpg');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 4 * 1024 * 1024) throw new Error('El marco no puede superar 4 MB');
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(userId + '.')) {
        try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
    }
    const out = path.join(dir, `${userId}.${ext}`);
    fs.writeFileSync(out, buf);
    auth.setProfileFrame(userId, out);
    return { frameUrl: `/profile-frame/${userId}?v=${Date.now()}` };
  });

  ipcMain.handle('library:getFolder', () => db.getLibraryFolder());

  ipcMain.handle('library:pickFolder', async () => {
    const folder = await pickFolderDialog();
    if (!folder) return null;
    db.setLibraryFolder(folder);
    await restartWatcher(folder);
    triggerRescan();
    return folder;
  });

  ipcMain.handle('library:rescan', () => triggerRescan());

  // Re-analiza tags de MusicBrainz para todo, sin tocar el escaneo local.
  // Útil cuando el usuario quiere "rellenar géneros" rápido sin esperar a
  // que el watcher detecte cambios.
  ipcMain.handle('library:refreshTags', () => { scheduleMbBackfill(); return { ok: true }; });

  ipcMain.handle('app:port', () => webserver.PORT);

  // --- NoBreak Cloud (hito B fase 2) -------------------------------------
  // El renderer pregunta estado, reclama códigos y desvincula. El
  // machine_token nunca cruza el bridge IPC — sólo el resumen.
  ipcMain.handle('cloud:status', () => cloud.getStatus());
  ipcMain.handle('cloud:setTunnelUrl', (_e, url) => {
    try { return { ok: true, status: cloud.setTunnelUrl(url) }; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
  ipcMain.handle('cloud:relayDiagnostics', () => cloudRelay.getDiagnostics());

  // Portada custom de una playlist. dataUrl=null limpia.
  ipcMain.handle('playlist:saveCover', (_e, sessionToken, playlistId, dataUrl) => {
    const userId = auth.verifySession(sessionToken);
    if (!userId) throw new Error('Sesión inválida');
    const pid = Number(playlistId);
    if (!Number.isFinite(pid)) throw new Error('playlistId no válido');
    const dir = path.join(app.getPath('userData'), 'playlist-covers');
    fs.mkdirSync(dir, { recursive: true });
    if (dataUrl == null) {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(pid + '.')) try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
      db.setPlaylistCover(pid, null);
      return { coverUrl: null };
    }
    const buf = decodeImageDataUrl(dataUrl, 8 * 1024 * 1024);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(pid + '.')) try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
    const out = path.join(dir, `${pid}.${buf.ext}`);
    fs.writeFileSync(out, buf.bytes);
    db.setPlaylistCover(pid, out);
    return { coverUrl: `/playlist-cover/${pid}?v=${Date.now()}` };
  });

  // Portada custom de un género. dataUrl=null limpia.
  ipcMain.handle('genre:saveCover', (_e, sessionToken, genreName, dataUrl) => {
    const userId = auth.verifySession(sessionToken);
    if (!userId) throw new Error('Sesión inválida');
    if (typeof genreName !== 'string' || !genreName.trim()) throw new Error('género vacío');
    const slug = genreName.toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').slice(0, 80) || 'g';
    const dir = path.join(app.getPath('userData'), 'genre-covers');
    fs.mkdirSync(dir, { recursive: true });
    if (dataUrl == null) {
      for (const f of fs.readdirSync(dir)) {
        if (f.startsWith(slug + '.')) try { fs.unlinkSync(path.join(dir, f)); } catch {}
      }
      db.setGenreCover(genreName, null);
      return { coverUrl: null };
    }
    const buf = decodeImageDataUrl(dataUrl, 8 * 1024 * 1024);
    for (const f of fs.readdirSync(dir)) {
      if (f.startsWith(slug + '.')) try { fs.unlinkSync(path.join(dir, f)); } catch {}
    }
    const out = path.join(dir, `${slug}.${buf.ext}`);
    fs.writeFileSync(out, buf.bytes);
    db.setGenreCover(genreName, out);
    return { coverUrl: `/genre-cover/${encodeURIComponent(genreName)}?v=${Date.now()}` };
  });

  // Abrir una URL en el navegador por defecto. Filtramos a http(s) para no
  // permitir esquemas peligrosos desde el renderer.
  ipcMain.handle('shell:openExternal', (_e, url) => {
    if (typeof url !== 'string') return false;
    if (!/^https?:\/\//i.test(url)) return false;
    shell.openExternal(url);
    return true;
  });
}

// ---------------- App lifecycle ---------------------------------------------

// Surface async errors that would otherwise be silently swallowed in the
// main-process event loop. Without this, a thrown promise in startup leaves
// the EXE running with an empty library and no clue why.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandledRejection:', reason && reason.stack || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[main] uncaughtException:', err && err.stack || err);
});

app.whenReady().then(async () => {
  console.log('[main] whenReady');
  fs.mkdirSync(app.getPath('userData'), { recursive: true });
  coverDir = appCoverDir();
  fs.mkdirSync(coverDir, { recursive: true });
  console.log('[main] userData=', app.getPath('userData'));
  console.log('[main] coverDir=', coverDir);

  db.init(dbPath());
  console.log('[main] db ready');
  cloud.init(app.getPath('userData'));
  console.log('[main] cloud init, url=', cloud.CLOUD_URL);
  // Si el auto-túnel está activo, invalida la tunnelUrl persistida del run
  // anterior antes de arrancar el relay. TryCloudflare emite una URL nueva
  // cada vez que cloudflared arranca, así que la persistida ya está muerta
  // — mandarla al Worker provoca 530 Origin DNS error hasta el siguiente
  // heartbeat. Con null en disco, el relay salta los ticks hasta que
  // tunnel.start() llame a cloud.setTunnelUrl(newUrl) + kick().
  if (process.env.NOBREAK_DISABLE_AUTO_TUNNEL !== '1') {
    try { cloud.setTunnelUrl(null); } catch (e) { console.warn('[main] reset tunnelUrl:', e.message); }
  }

  cloudRelay.start(cloud);
  webserver.start({ webDir: findWebDir() });

  // Auto-túnel TryCloudflare: lanza cloudflared.exe (lo descarga la primera
  // vez) y publica la URL pública en cloud.setTunnelUrl(). Fallar es no
  // fatal — la usuaria sigue pudiendo pegar URL manual en Ajustes.
  tunnel.start({
    cloud,
    relay: cloudRelay,
    port: webserver.PORT,
    userData: app.getPath('userData'),
  }).catch((e) => console.warn('[main] tunnel.start threw:', e?.message || e));

  registerIpc();
  buildMenu();
  createWindow();

  // If a folder is configured, start the watcher and kick a rescan immediately.
  const folder = db.getLibraryFolder();
  console.log('[main] library folder =', folder);
  if (folder && fs.existsSync(folder)) {
    try {
      await restartWatcher(folder);
      console.log('[main] watcher started');
    } catch (e) {
      console.error('[main] watcher failed to start:', e && e.stack || e);
    }
    console.log('[main] kicking rescan');
    triggerRescan().then((r) => console.log('[main] rescan finished:', r))
                   .catch((e) => console.error('[main] rescan threw:', e));
  } else {
    console.log('[main] no library folder set or folder missing — skipping initial scan');
  }

  // Backfill de tags de MusicBrainz al arrancar para que la pestaña Géneros
  // tenga datos sin que el usuario tenga que abrir cada álbum a mano. Corre
  // en background con throttle de 1 req/seg.
  scheduleMbBackfill();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (watcher) { await watcher.stop(); watcher = null; }
  tunnel.stop();
  cloudRelay.stop();
  webserver.stop();
  db.close();
  if (process.platform !== 'darwin') app.quit();
});

// Asegura que cloudflared se mata aunque la app salga por otra ruta (Cmd+Q
// en macOS, app.quit() programático, etc.) sin disparar window-all-closed.
app.on('before-quit', () => {
  try { tunnel.stop(); } catch {}
  try { cloudRelay.stop(); } catch {}
});
