// Electron main process. Owns: DB, scanner, watcher, HTTP server, app window,
// app menu (Biblioteca → cambiar carpeta / actualizar / cerrar sesión).
//
// The renderer authenticates over HTTP (same flow as the browser), so /auth/login,
// /api/*, /stream/* are all handled in webserver.js. IPC is only used for things
// the renderer can't do from the browser sandbox: native folder dialog, settings.

const { app, BrowserWindow, ipcMain, dialog, Menu, shell } = require('electron');
const path = require('path');
const fs = require('fs');

const db = require('./db');
const auth = require('./auth');
const scanner = require('./scanner');
const { LibraryWatcher } = require('./watcher');
const webserver = require('./webserver');

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
 *   1. {appDir}/web/        ← copied here at build time by copy-web.js
 *   2. {appDir}/../Frontend ← repo's Frontend/ when running with npm start
 * Returns null if neither exists; the API still works without static serving.
 */
function findWebDir() {
  const candidates = [
    path.join(__dirname, 'web'),
    path.join(__dirname, '..', 'Frontend'),
  ];
  for (const c of candidates) {
    try { if (fs.statSync(c).isDirectory()) return c; } catch {}
  }
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
    return report;
  } catch (e) {
    notifyRenderer('scan:error', e.message || String(e));
    return null;
  } finally {
    scanInProgress = false;
  }
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

  ipcMain.handle('auth:register', (_e, username, password) => {
    if (auth.hasAnyUser()) throw new Error('Ya existe una cuenta. Inicia sesión.');
    auth.createUser(username, password);
    return { ok: true };
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

  ipcMain.handle('app:port', () => webserver.PORT);
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
  webserver.start({ webDir: findWebDir() });

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

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (watcher) { await watcher.stop(); watcher = null; }
  webserver.stop();
  db.close();
  if (process.platform !== 'darwin') app.quit();
});
