// nobreak-cloud — Worker central de NoBreak.
// Hostea cuentas de usuario, sesiones y (en fases futuras) el pairing +
// relay hacia los .exe locales de cada usuario.
//
// Endpoints fase 1 (cuentas globales):
//   POST /api/auth/register   → crear cuenta
//   POST /api/auth/login      → emitir token de sesión
//   POST /api/auth/logout     → revocar sesión
//   GET  /api/auth/me         → datos del usuario actual
//
// Endpoints fase 2 (pairing web↔.exe):
//   POST /api/pair            → (Bearer) genera código 6 dígitos (TTL 10 min)
//   POST /api/pair/claim      → el .exe lo reclama con su device_id + label
//                                → devuelve machine_token largo (no caduca)
//
// Endpoints fase 3a (presencia):
//   POST /api/devices/heartbeat   → (Bearer machineToken) actualiza
//                                    tunnel_url + tunnel_secret + last_seen_at
//   GET  /api/me/devices          → (Bearer sessionToken) lista los devices
//                                    del cloud user con online/offline
//
// Endpoints fase 3b (proxy hacia el .exe):
//   ANY /api/devices/:deviceId/proxy/<resto>
//                                  → (Bearer sessionToken) reenvía el request
//                                    a tunnel_url + /<resto>, añadiendo el
//                                    header X-NoBreak-Tunnel-Secret para que
//                                    el .exe sepa que viene del Worker. Body,
//                                    method y headers relevantes se propagan;
//                                    la respuesta se devuelve en streaming
//                                    (importante para /stream/<id> de audio).
//
// Dos tipos de Bearer distintos:
//   - sessionToken  → usuario cloud (cliente web). Tabla sessions.
//   - machineToken  → .exe vinculado. Tabla devices.machine_token_hash.
// Internamente guardamos solo sha256(token).

const PBKDF2_ITERATIONS = 100_000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;   // 30 días
const PAIR_TTL_MS    = 10 * 60 * 1000;             // 10 min para reclamar un código
const DEVICE_ONLINE_MS = 2 * 60 * 1000;            // <= 2 min sin heartbeat → online

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

        try {
            if (path === '/health') return json({ ok: true });
            if (method === 'GET'  && (path === '/' || path === '/pair')) return handleHomeHtml();

            if (method === 'POST' && path === '/api/auth/register') return await handleRegister(request, env);
            if (method === 'POST' && path === '/api/auth/login')    return await handleLogin(request, env);
            if (method === 'POST' && path === '/api/auth/logout')   return await handleLogout(request, env);
            if (method === 'GET'  && path === '/api/auth/me')       return await handleMe(request, env);

            if (method === 'POST' && path === '/api/pair')          return await handlePairCreate(request, env);
            if (method === 'POST' && path === '/api/pair/claim')    return await handlePairClaim(request, env);

            if (method === 'POST' && path === '/api/devices/heartbeat') return await handleHeartbeat(request, env);
            if (method === 'GET'  && path === '/api/me/devices')        return await handleMyDevices(request, env);

            // Proxy: /api/devices/<deviceId>/proxy/<resto> (cualquier método)
            const proxyMatch = path.match(/^\/api\/devices\/([^/]+)\/proxy(\/.*)?$/);
            if (proxyMatch) {
                return await handleProxy(request, env, proxyMatch[1], proxyMatch[2] || '/', url);
            }

            return json({ error: 'Not found' }, 404);
        } catch (e) {
            console.error('[unhandled]', e?.stack || e?.message || e);
            return json({ error: 'Internal error' }, 500);
        }
    },
};

// --- helpers --------------------------------------------------------------

function json(body, status = 200, extraHeaders = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extraHeaders },
    });
}

function bytesToHex(bytes) {
    return Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
}

async function sha256Hex(s) {
    const data = new TextEncoder().encode(s);
    const hash = await crypto.subtle.digest('SHA-256', data);
    return bytesToHex(hash);
}

async function pbkdf2Hex(password, saltHex, iterations) {
    const keyMaterial = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        { name: 'PBKDF2' },
        false,
        ['deriveBits'],
    );
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations },
        keyMaterial,
        256,
    );
    return bytesToHex(bits);
}

function randomHex(byteLen) {
    const bytes = new Uint8Array(byteLen);
    crypto.getRandomValues(bytes);
    return bytesToHex(bytes);
}

function extractToken(request) {
    const h = request.headers.get('Authorization');
    if (!h) return null;
    const m = h.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : null;
}

// --- handlers --------------------------------------------------------------

async function handleRegister(request, env) {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'JSON inválido' }, 400); }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const email    = body.email != null ? String(body.email).trim().toLowerCase() : null;

    if (!username || username.length < 3 || username.length > 40) {
        return json({ error: 'Usuario debe tener entre 3 y 40 caracteres' }, 400);
    }
    if (!password || password.length < 6) {
        return json({ error: 'Contraseña mínima 6 caracteres' }, 400);
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return json({ error: 'Correo no válido' }, 400);
    }

    const salt = randomHex(16);
    const passHash = await pbkdf2Hex(password, salt, PBKDF2_ITERATIONS);
    const now = Date.now();

    try {
        await env.nobreak_db.prepare(
            `INSERT INTO users (username, email, pass_hash, salt, iter_count, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(username, email, passHash, salt, PBKDF2_ITERATIONS, now).run();
    } catch (e) {
        if (/UNIQUE constraint/i.test(e.message)) {
            return json({ error: 'Ese usuario o correo ya existe' }, 409);
        }
        console.error('[register]', e);
        return json({ error: 'No se pudo crear el usuario' }, 500);
    }
    return json({ ok: true }, 201);
}

async function handleLogin(request, env) {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'JSON inválido' }, 400); }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || !password) return json({ error: 'Falta username o password' }, 400);

    const row = await env.nobreak_db.prepare(
        `SELECT id, username, salt, iter_count, pass_hash FROM users WHERE username = ?`
    ).bind(username).first();
    if (!row) return json({ error: 'Credenciales inválidas' }, 401);

    const computed = await pbkdf2Hex(password, row.salt, row.iter_count);
    if (computed !== row.pass_hash) return json({ error: 'Credenciales inválidas' }, 401);

    const token = randomHex(32);                    // 64 hex chars
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    const expiresAt = now + SESSION_TTL_MS;
    await env.nobreak_db.prepare(
        `INSERT INTO sessions (token_hash, user_id, created_at, expires_at)
         VALUES (?, ?, ?, ?)`
    ).bind(tokenHash, row.id, now, expiresAt).run();

    return json({
        sessionToken: token,
        expiresAt,
        username: row.username,
        tokenType: 'Bearer',
    });
}

async function handleLogout(request, env) {
    const token = extractToken(request);
    if (token) {
        const tokenHash = await sha256Hex(token);
        await env.nobreak_db.prepare(
            `DELETE FROM sessions WHERE token_hash = ?`
        ).bind(tokenHash).run();
    }
    return new Response(null, { status: 204, headers: CORS });
}

async function handleMe(request, env) {
    const userId = await authenticate(request, env);
    if (!userId) return json({ error: 'Sesión inválida o caducada' }, 401);
    const u = await env.nobreak_db.prepare(
        `SELECT id, username, email, created_at FROM users WHERE id = ?`
    ).bind(userId).first();
    if (!u) return json({ error: 'Usuario inexistente' }, 401);
    return json({
        id: u.id,
        username: u.username,
        email: u.email || null,
        createdAt: u.created_at,
    });
}

// --- pairing ---------------------------------------------------------------

// Genera un código de 6 dígitos (100000..999999) único en la tabla
// pairing_codes. Reintenta hasta 5 veces si hay colisión (probabilidad
// despreciable con TTL 10 min y baja concurrencia).
async function generatePairCode(env, userId) {
    for (let attempt = 0; attempt < 5; attempt++) {
        const code = String(100000 + Math.floor(Math.random() * 900000));
        const now = Date.now();
        try {
            await env.nobreak_db.prepare(
                `INSERT INTO pairing_codes (code, user_id, created_at, expires_at)
                 VALUES (?, ?, ?, ?)`
            ).bind(code, userId, now, now + PAIR_TTL_MS).run();
            return { code, expiresAt: now + PAIR_TTL_MS };
        } catch (e) {
            if (!/UNIQUE constraint/i.test(e.message)) throw e;
            // colisión — limpia el viejo si caducó y reintenta
            await env.nobreak_db.prepare(
                `DELETE FROM pairing_codes WHERE code = ? AND expires_at < ?`
            ).bind(code, now).run();
        }
    }
    throw new Error('No se pudo generar un código único');
}

async function handlePairCreate(request, env) {
    const userId = await authenticate(request, env);
    if (!userId) return json({ error: 'Sesión inválida o caducada' }, 401);

    const { code, expiresAt } = await generatePairCode(env, userId);
    return json({ code, expiresAt, ttlSeconds: Math.floor(PAIR_TTL_MS / 1000) });
}

async function handlePairClaim(request, env) {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'JSON inválido' }, 400); }

    const code     = String(body.code || '').trim();
    const deviceId = String(body.deviceId || '').trim();
    const label    = body.label != null ? String(body.label).slice(0, 80) : null;

    if (!/^\d{6}$/.test(code)) {
        return json({ error: 'Código debe ser 6 dígitos' }, 400);
    }
    // UUID v4 laxo: 32 hex con guiones. No rechazamos formatos no-UUID
    // por flexibilidad, sólo limitamos longitud razonable.
    if (!deviceId || deviceId.length < 8 || deviceId.length > 64) {
        return json({ error: 'deviceId requerido (8-64 chars)' }, 400);
    }

    const now = Date.now();
    const row = await env.nobreak_db.prepare(
        `SELECT user_id, expires_at, claimed_at FROM pairing_codes WHERE code = ?`
    ).bind(code).first();
    if (!row) return json({ error: 'Código inválido' }, 404);
    if (row.claimed_at != null) return json({ error: 'Código ya usado' }, 409);
    if (row.expires_at < now) {
        await env.nobreak_db.prepare(
            `DELETE FROM pairing_codes WHERE code = ?`
        ).bind(code).run();
        return json({ error: 'Código caducado' }, 410);
    }

    const machineToken = randomHex(32);
    const machineTokenHash = await sha256Hex(machineToken);

    // INSERT OR REPLACE: si el mismo device_id ya estaba registrado por este
    // usuario (reinstall del .exe en el mismo PC), sustituimos el token.
    await env.nobreak_db.prepare(
        `INSERT OR REPLACE INTO devices
           (device_id, user_id, machine_token_hash, label, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(deviceId, row.user_id, machineTokenHash, label, now, now).run();

    await env.nobreak_db.prepare(
        `UPDATE pairing_codes SET claimed_at = ?, device_id = ? WHERE code = ?`
    ).bind(now, deviceId, code).run();

    // El .exe necesita el username para mostrar "Vinculado a <usuario>" en su UI.
    const userRow = await env.nobreak_db.prepare(
        `SELECT username FROM users WHERE id = ?`
    ).bind(row.user_id).first();

    return json({
        machineToken,
        deviceId,
        userId: row.user_id,
        username: userRow?.username || null,
        pairedAt: now,
    });
}

// --- presence / heartbeat (hito C.1) --------------------------------------

// Autentica un machineToken Bearer y devuelve { deviceId, userId } o null.
async function authenticateMachine(request, env) {
    const token = extractToken(request);
    if (!token) return null;
    const tokenHash = await sha256Hex(token);
    const row = await env.nobreak_db.prepare(
        `SELECT device_id, user_id FROM devices WHERE machine_token_hash = ?`
    ).bind(tokenHash).first();
    if (!row) return null;
    return { deviceId: row.device_id, userId: row.user_id };
}

async function handleHeartbeat(request, env) {
    const machine = await authenticateMachine(request, env);
    if (!machine) return json({ error: 'machineToken inválido' }, 401);

    let body = {};
    try { body = await request.json(); }
    catch { /* sin body es válido: sólo refresca last_seen_at */ }

    const tunnelUrl = body.tunnelUrl != null ? String(body.tunnelUrl).trim().slice(0, 500) : null;
    if (tunnelUrl && !/^https?:\/\//i.test(tunnelUrl)) {
        return json({ error: 'tunnelUrl debe empezar por http(s)://' }, 400);
    }
    // tunnelSecret: opcional, hasta 128 chars. Si llega vacío lo limpiamos
    // (útil si el .exe quiere rotarlo o invalidar el proxy).
    let tunnelSecret = null;
    let hasTunnelSecret = false;
    if (Object.prototype.hasOwnProperty.call(body, 'tunnelSecret')) {
        hasTunnelSecret = true;
        const v = body.tunnelSecret;
        tunnelSecret = v == null || v === '' ? null : String(v).slice(0, 128);
    }
    const now = Date.now();

    // Construye UPDATE dinámico para no machacar columnas no enviadas.
    const sets = ['last_seen_at = ?'];
    const params = [now];
    if (tunnelUrl != null) { sets.push('tunnel_url = ?'); params.push(tunnelUrl || null); }
    if (hasTunnelSecret)   { sets.push('tunnel_secret = ?'); params.push(tunnelSecret); }
    params.push(machine.deviceId);
    await env.nobreak_db.prepare(
        `UPDATE devices SET ${sets.join(', ')} WHERE device_id = ?`
    ).bind(...params).run();

    return json({ ok: true, lastSeenAt: now });
}

async function handleMyDevices(request, env) {
    const userId = await authenticate(request, env);
    if (!userId) return json({ error: 'Sesión inválida o caducada' }, 401);

    const rows = await env.nobreak_db.prepare(
        `SELECT device_id, label, created_at, last_seen_at, tunnel_url
         FROM devices WHERE user_id = ?
         ORDER BY COALESCE(last_seen_at, 0) DESC`
    ).bind(userId).all();

    const now = Date.now();
    const devices = (rows.results || []).map(d => ({
        deviceId: d.device_id,
        label: d.label,
        createdAt: d.created_at,
        lastSeenAt: d.last_seen_at,
        tunnelUrl: d.tunnel_url,
        online: d.last_seen_at != null && (now - d.last_seen_at) <= DEVICE_ONLINE_MS,
    }));

    return json({ devices, onlineWindowMs: DEVICE_ONLINE_MS });
}

// --- proxy hacia el .exe (hito C.2) ---------------------------------------

// Cabeceras que NO se reenvían al .exe. Las hop-by-hop no deben atravesar
// un proxy según RFC 7230 §6.1, y `host`/`authorization` los reemplazamos
// nosotros (el .exe tiene su propia sesión, distinta de la del Worker).
const HOP_HEADERS_REQ = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
    'te', 'trailer', 'proxy-connection', 'proxy-authorization',
    'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
    'cf-worker', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
]);
const HOP_HEADERS_RES = new Set([
    'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
    'te', 'trailer', 'proxy-connection',
]);

async function handleProxy(request, env, deviceId, subPath, url) {
    const userId = await authenticate(request, env);
    if (!userId) return json({ error: 'Sesión inválida o caducada' }, 401);

    const device = await env.nobreak_db.prepare(
        `SELECT user_id, tunnel_url, tunnel_secret, last_seen_at
         FROM devices WHERE device_id = ?`
    ).bind(deviceId).first();
    if (!device || device.user_id !== userId) {
        // Mismo 404 si no existe o no es del usuario, para no filtrar IDs.
        return json({ error: 'Dispositivo no encontrado' }, 404);
    }
    if (!device.tunnel_url) {
        return json({ error: 'El dispositivo no tiene tunnel_url publicada' }, 502);
    }
    if (!device.tunnel_secret) {
        // Sin secret no podemos demostrarle al .exe que somos el Worker.
        // Mejor 502 explícito que un 401 confuso desde el .exe.
        return json({ error: 'El dispositivo aún no ha publicado tunnel_secret (heartbeat pendiente)' }, 502);
    }

    // tunnel_url puede venir con o sin slash final. Resolvemos manualmente
    // para preservar query string y evitar dobles slashes.
    const base = device.tunnel_url.replace(/\/+$/, '');
    const targetUrl = base + subPath + (url.search || '');

    // Cabeceras: copiar todas excepto hop-by-hop. Sobrescribir Authorization
    // si el cliente cloud mandó la suya (no debería — es para el Worker —
    // pero por si acaso). El .exe usa su propia auth en /api/* y /stream/*.
    const fwdHeaders = new Headers();
    for (const [k, v] of request.headers) {
        if (HOP_HEADERS_REQ.has(k.toLowerCase())) continue;
        fwdHeaders.set(k, v);
    }
    fwdHeaders.delete('authorization');
    fwdHeaders.set('X-NoBreak-Tunnel-Secret', device.tunnel_secret);
    // Le pasamos también el username del usuario cloud por si el .exe quiere
    // loguearlo o mostrarlo. NO es una credencial — sólo informativo.
    const userRow = await env.nobreak_db.prepare(
        `SELECT username FROM users WHERE id = ?`
    ).bind(userId).first();
    if (userRow?.username) fwdHeaders.set('X-NoBreak-Cloud-User', userRow.username);

    // Body: GET/HEAD no llevan body. Para el resto, streamea el cuerpo
    // original sin buffer (importante para subidas grandes — aunque por ahora
    // el límite es express.json 64kb, conviene no romperlo a futuro).
    const init = {
        method: request.method,
        headers: fwdHeaders,
        redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        init.body = request.body;
    }

    let upstream;
    try {
        upstream = await fetch(targetUrl, init);
    } catch (e) {
        console.warn('[proxy]', deviceId, e?.message || e);
        return json({ error: 'No se pudo contactar con el dispositivo' }, 504);
    }

    // Respuesta: copiar todas las cabeceras excepto hop-by-hop. Forzamos
    // CORS para que el navegador del cloud user pueda leer la respuesta
    // (el .exe ya pone CORS permisivo, pero por si cambia).
    const resHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
        if (HOP_HEADERS_RES.has(k.toLowerCase())) continue;
        resHeaders.set(k, v);
    }
    for (const [k, v] of Object.entries(CORS)) resHeaders.set(k, v);

    return new Response(upstream.body, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: resHeaders,
    });
}

// Página mínima para que el usuario logueado genere un código. Sin
// dependencias externas, todo inline. Cuando exista la integración del
// frontend completo (hito D), esta página se sustituye.
function handleHomeHtml() {
    const html = `<!doctype html>
<html lang="es"><meta charset="utf-8">
<title>NoBreak Cloud — Vincular .exe</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0e0e10;color:#e8e8ea;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{background:#17171a;border:1px solid #2a2a30;border-radius:14px;padding:28px;max-width:420px;width:100%}
  h1{margin:0 0 6px;font-size:20px}
  p{color:#a0a0a8;font-size:14px;line-height:1.5;margin:6px 0 14px}
  input{width:100%;background:#0a0a0c;border:1px solid #2a2a30;color:#fff;padding:10px 12px;border-radius:8px;font-size:14px;margin:6px 0}
  input:focus{outline:none;border-color:#7c5cff}
  button{width:100%;background:#7c5cff;color:#fff;border:none;padding:11px;border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px}
  button:disabled{opacity:.5;cursor:not-allowed}
  .err{color:#ff6b7a;font-size:13px;min-height:18px;margin-top:8px}
  .code{font-size:42px;font-weight:700;letter-spacing:6px;text-align:center;padding:18px;background:#0a0a0c;border-radius:10px;margin:14px 0;font-variant-numeric:tabular-nums}
  .hint{font-size:13px;color:#9090a0;text-align:center}
  .hidden{display:none}
  a{color:#7c5cff}
</style>
<div class="card">
  <h1>NoBreak Cloud</h1>
  <p>Inicia sesión y genera un código para vincular tu <strong>NoBreak.exe</strong> con esta cuenta.</p>

  <div id="step-login">
    <input id="username" placeholder="usuario" autocomplete="username">
    <input id="password" type="password" placeholder="contraseña" autocomplete="current-password">
    <button id="login-btn">Iniciar sesión</button>
    <div class="err" id="login-err"></div>
    <p style="text-align:center;margin-top:16px"><a href="#" id="show-register">Crear cuenta</a></p>
  </div>

  <div id="step-register" class="hidden">
    <input id="reg-username" placeholder="usuario (3-40)" autocomplete="username">
    <input id="reg-email" type="email" placeholder="email (opcional)" autocomplete="email">
    <input id="reg-password" type="password" placeholder="contraseña (min 6)" autocomplete="new-password">
    <button id="reg-btn">Crear cuenta</button>
    <div class="err" id="reg-err"></div>
    <p style="text-align:center;margin-top:16px"><a href="#" id="show-login">Ya tengo cuenta</a></p>
  </div>

  <div id="step-paired" class="hidden">
    <p>Hola <strong id="me-username"></strong>. Pulsa para generar un código de un solo uso (válido 10 minutos):</p>
    <button id="gen-btn">Generar código</button>
    <div id="code-box" class="hidden">
      <div class="code" id="code-display"></div>
      <p class="hint">Abre tu NoBreak.exe → Ajustes → Vincular con NoBreak Cloud y pega este código.</p>
    </div>

    <div style="margin-top:24px;padding-top:18px;border-top:1px solid #2a2a30">
      <p style="display:flex;justify-content:space-between;align-items:center;margin:0 0 10px">
        <strong style="font-size:14px">Tus dispositivos</strong>
        <a href="#" id="refresh-devices" style="font-size:13px">Refrescar</a>
      </p>
      <div id="devices-list" style="font-size:13px;color:#a0a0a8">Cargando…</div>
    </div>

    <p style="text-align:center;margin-top:18px"><a href="#" id="logout">Cerrar sesión</a></p>
  </div>
</div>

<script>
const $ = (id) => document.getElementById(id);
const show = (id) => { ['step-login','step-register','step-paired'].forEach(s => $(s).classList.toggle('hidden', s !== id)); };
let token = localStorage.getItem('nobreak-cloud-token') || null;

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers.Authorization = 'Bearer ' + token;
  const r = await fetch(path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || ('HTTP ' + r.status));
  return data;
}

async function refreshMe() {
  try {
    const me = await api('/api/auth/me');
    $('me-username').textContent = me.username;
    show('step-paired');
    refreshDevices().catch(() => {});
  } catch {
    token = null;
    localStorage.removeItem('nobreak-cloud-token');
    show('step-login');
  }
}

function formatRel(ms) {
  if (ms == null) return 'nunca';
  const s = Math.floor((Date.now() - ms) / 1000);
  if (s < 60) return s + ' s';
  if (s < 3600) return Math.floor(s/60) + ' min';
  if (s < 86400) return Math.floor(s/3600) + ' h';
  return Math.floor(s/86400) + ' d';
}

async function refreshDevices() {
  const el = $('devices-list');
  if (!el) return;
  try {
    const d = await api('/api/me/devices');
    if (!d.devices || d.devices.length === 0) {
      el.innerHTML = '<em>Ningún dispositivo vinculado. Genera un código y pégalo en NoBreak.exe → Ajustes.</em>';
      return;
    }
    el.innerHTML = d.devices.map(dev => {
      const dot = dev.online ? '<span style="color:#5cff8c">●</span>' : '<span style="color:#666">●</span>';
      const lbl = dev.label || '(sin etiqueta)';
      const tunnel = dev.tunnelUrl
        ? '<div style="font-size:12px;color:#7c5cff;word-break:break-all">' + dev.tunnelUrl + '</div>'
        : '<div style="font-size:12px;color:#666">sin tunnel registrado todavía</div>';
      // Botón "Probar proxy": hace fetch con el sessionToken hacia
      // /api/devices/<id>/proxy/health del .exe y muestra el resultado. No
      // podemos usar <a target=_blank> porque el browser no enviaría el
      // Bearer; necesitamos un fetch JS.
      const open = dev.online && dev.tunnelUrl
        ? '<div style="margin-top:6px"><button class="proxy-ping" data-id="'
          + encodeURIComponent(dev.deviceId)
          + '" style="font-size:12px;padding:4px 10px;width:auto">Probar proxy</button>'
          + ' <span class="proxy-result" data-id="' + encodeURIComponent(dev.deviceId)
          + '" style="font-size:12px;color:#9090a0;margin-left:6px"></span></div>'
        : '';
      return [
        '<div style="padding:10px;background:#0a0a0c;border-radius:8px;margin-bottom:8px">',
          '<div>' + dot + ' <strong>' + lbl + '</strong> · visto hace ' + formatRel(dev.lastSeenAt) + '</div>',
          tunnel,
          open,
        '</div>',
      ].join('');
    }).join('');
    // Wire up ping buttons. La delegación es por simplicidad: re-renderizamos
    // el HTML completo cada refresh, así que enganchar onclick aquí es lo
    // más simple y barato.
    el.querySelectorAll('button.proxy-ping').forEach(btn => {
      btn.onclick = async () => {
        const id = btn.getAttribute('data-id');
        const out = el.querySelector('.proxy-result[data-id="' + id + '"]');
        if (out) out.textContent = 'pingando…';
        btn.disabled = true;
        try {
          const r = await api('/api/devices/' + id + '/proxy/health');
          if (out) out.textContent = r && r.ok ? 'OK ✓' : JSON.stringify(r);
        } catch (e) {
          if (out) out.textContent = 'Error: ' + e.message;
        } finally {
          btn.disabled = false;
        }
      };
    });
  } catch (e) {
    el.textContent = 'Error: ' + e.message;
  }
}
$('refresh-devices').onclick = (e) => { e.preventDefault(); refreshDevices(); };

$('login-btn').onclick = async () => {
  $('login-err').textContent = '';
  $('login-btn').disabled = true;
  try {
    const r = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('username').value.trim(), password: $('password').value }),
    });
    token = r.sessionToken;
    localStorage.setItem('nobreak-cloud-token', token);
    await refreshMe();
  } catch (e) { $('login-err').textContent = e.message; }
  finally { $('login-btn').disabled = false; }
};

$('reg-btn').onclick = async () => {
  $('reg-err').textContent = '';
  $('reg-btn').disabled = true;
  try {
    await api('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify({
        username: $('reg-username').value.trim(),
        email: $('reg-email').value.trim() || null,
        password: $('reg-password').value,
      }),
    });
    // login automático tras registro
    const r = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username: $('reg-username').value.trim(), password: $('reg-password').value }),
    });
    token = r.sessionToken;
    localStorage.setItem('nobreak-cloud-token', token);
    await refreshMe();
  } catch (e) { $('reg-err').textContent = e.message; }
  finally { $('reg-btn').disabled = false; }
};

$('gen-btn').onclick = async () => {
  $('gen-btn').disabled = true;
  try {
    const r = await api('/api/pair', { method: 'POST' });
    $('code-display').textContent = r.code;
    $('code-box').classList.remove('hidden');
  } catch (e) { alert(e.message); }
  finally { $('gen-btn').disabled = false; }
};

$('show-register').onclick = (e) => { e.preventDefault(); show('step-register'); };
$('show-login').onclick    = (e) => { e.preventDefault(); show('step-login'); };
$('logout').onclick = async (e) => {
  e.preventDefault();
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  token = null;
  localStorage.removeItem('nobreak-cloud-token');
  $('code-box').classList.add('hidden');
  show('step-login');
};

if (token) refreshMe(); else show('step-login');
</script>
</html>`;
    return new Response(html, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS },
    });
}

// Devuelve el user_id si el token bearer es válido y no ha caducado;
// si no, null. Caduca sesiones expiradas perezosamente (no hay job).
async function authenticate(request, env) {
    const token = extractToken(request);
    if (!token) return null;
    const tokenHash = await sha256Hex(token);
    const row = await env.nobreak_db.prepare(
        `SELECT user_id, expires_at FROM sessions WHERE token_hash = ?`
    ).bind(tokenHash).first();
    if (!row) return null;
    if (row.expires_at < Date.now()) {
        await env.nobreak_db.prepare(
            `DELETE FROM sessions WHERE token_hash = ?`
        ).bind(tokenHash).run();
        return null;
    }
    return row.user_id;
}
