// server.js — Servidor de la web NoBreak (puerto 3000).
//
// Sirve la carpeta Frontend/ como estático y hace proxy de /auth/*, /api/*,
// /stream/* etc. al desktop player que esté corriendo en 127.0.0.1:8080
// (el .exe portable o `npm start` del desktop).
//
// Bindea SOLO a 127.0.0.1 — la exposición a internet se delega en
// cloudflared (Cloudflare Tunnel), que conecta saliente y termina TLS en el
// edge de Cloudflare. Así no hay puertos abiertos en el router del usuario
// ni el server queda accesible en la LAN sin pasar por el tunnel.
//
// Uso:
//   1) Arranca la app de escritorio (NoBreak-0.1.0-portable.exe o
//      `cd desktop && npm start`). Sin ella /auth/* y /api/* darán 502.
//   2) En otra terminal:  node server.js
//   3) Local:  http://localhost:3000/
//   4) Remoto: levanta cloudflared (ver instrucciones del proyecto).
//
// Variables de entorno:
//   PORT             — puerto público del frontend (default 3000)
//   BIND_HOST        — interfaz a la que bindear (default 127.0.0.1, sólo
//                       cámbialo si NO usas cloudflared y sabes lo que haces)
//   NOBREAK_API_HOST — host del desktop player (default 127.0.0.1)
//   NOBREAK_API_PORT — puerto del desktop player (default 8080)
//
// Sin dependencias externas — solo módulos built-in de Node.

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = Number(process.env.PORT) || 3000;
const BIND_HOST = process.env.BIND_HOST || '127.0.0.1';
const FRONTEND_DIR = path.join(__dirname, 'Frontend');
const API_HOST = process.env.NOBREAK_API_HOST || '127.0.0.1';
const API_PORT = Number(process.env.NOBREAK_API_PORT) || 8080;

// Rutas que NO son frontend — se redirigen tal cual al desktop.
// Cualquier path que NO empiece por uno de estos se sirve estático desde
// Frontend/. Si añades un endpoint nuevo en el backend cuya URL no encaja
// con ninguno, añádelo aquí.
const PROXY_PREFIXES = [
    '/auth/',
    '/api/',
    '/stream/',
    '/cover/',
    '/playlist-cover/',
    '/genre-cover/',
    '/profile-photo/',
    '/profile-bg/',
    '/profile-frame/',
    '/health',
];

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js':   'application/javascript; charset=utf-8',
    '.css':  'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif':  'image/gif',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.mp3':  'audio/mpeg',
    '.m4a':  'audio/mp4',
    '.flac': 'audio/flac',
    '.ogg':  'audio/ogg',
};

function isProxied(pathname) {
    return PROXY_PREFIXES.some(p => pathname === p || pathname.startsWith(p));
}

function proxy(req, res) {
    const upstream = http.request({
        host: API_HOST,
        port: API_PORT,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `${API_HOST}:${API_PORT}` },
    }, (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
    });
    upstream.on('error', (e) => {
        res.statusCode = 502;
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.end(JSON.stringify({
            error: `Backend NoBreak no responde en ${API_HOST}:${API_PORT}. ¿Está abierta la app?`,
            detail: e.message,
        }));
    });
    req.pipe(upstream);
}

function serveStatic(req, res, pathname) {
    // Normalizar y proteger contra path traversal (../).
    let safe = pathname.replace(/\\/g, '/').replace(/^\/+/, '');
    if (!safe || safe.endsWith('/')) safe = path.join(safe, 'index.html');
    const filePath = path.join(FRONTEND_DIR, safe);
    if (!filePath.startsWith(FRONTEND_DIR)) {
        res.statusCode = 403; res.end('forbidden'); return;
    }
    fs.stat(filePath, (err, stat) => {
        if (err || !stat.isFile()) {
            res.statusCode = 404;
            res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end('404 — no se encontró ' + safe);
            return;
        }
        res.statusCode = 200;
        res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
        res.setHeader('Content-Length', String(stat.size));
        fs.createReadStream(filePath).pipe(res);
    });
}

const server = http.createServer((req, res) => {
    const pathname = decodeURIComponent(url.parse(req.url).pathname || '/');
    if (isProxied(pathname)) proxy(req, res);
    else                     serveStatic(req, res, pathname);
});

server.listen(PORT, BIND_HOST, () => {
    console.log(`[server] Frontend/ servido en http://${BIND_HOST}:${PORT}`);
    console.log(`[server] API proxy → http://${API_HOST}:${API_PORT}`);
    console.log(`[server] Asegúrate de que la app NoBreak está corriendo (puerto ${API_PORT}).`);
    if (BIND_HOST === '127.0.0.1') {
        console.log('[server] Bind 127.0.0.1: para exposición remota usa cloudflared (HTTPS).');
    }
});
