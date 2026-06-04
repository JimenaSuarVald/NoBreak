// nobreak-cloud — Worker proxy multi-host.
//
// Cada PC con NoBreak.exe se registra como un `host` en D1 con su
// host_id único + label humano + tunnel_url/tunnel_secret. Los usuarios
// viven en el SQLite local de cada .exe; el Worker mantiene un directorio
// `user_routes(username → host_id)` para enrutar.
//
// Flujos:
//   1) Heartbeat .exe → Worker (POST /_w/heartbeat) actualiza la fila del host.
//   2) Registro: el frontend solo manda username+password+email. El Worker
//      auto-elige el host con heartbeat más reciente, registra user_routes
//      y reenvía al .exe.
//   3) Login: el frontend solo manda username+password. El Worker mira
//      user_routes para resolver el host y proxea ahí. La respuesta
//      enriquece con hostId para que el frontend lo guarde en localStorage.
//   4) Cualquier otra request: el frontend incluye header `X-NoBreak-Host`,
//      el Worker proxea a ese host.

const ONLINE_WINDOW_MS = 2 * 60 * 1000;

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range, X-NoBreak-Host',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
};

const HOP_HEADERS_REQ = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
    'te', 'trailer', 'proxy-connection', 'proxy-authorization',
    'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
    'cf-worker', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
    'content-length',
]);
const HOP_HEADERS_RES = new Set([
    'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
    'te', 'trailer', 'proxy-connection',
]);

const INSTALL_MIME = {
    '.exe':  'application/vnd.microsoft.portable-executable',
    '.7z':   'application/x-7z-compressed',
    '.zip':  'application/zip',
    '.json': 'application/json',
};

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        if (method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });

        try {
            if (path === '/health') return json({ ok: true });
            if (method === 'POST' && path === '/_w/heartbeat') return await handleHeartbeat(request, env);
            if (method === 'GET'  && path === '/_w/hosts')     return await handleListHosts(env);

            if ((method === 'GET' || method === 'HEAD') && path.startsWith('/install/')) {
                const key = path.slice('/install/'.length).replace(/^\/+/, '');
                return await handleInstallAsset(env, key, method);
            }

            // /auth/register y /auth/login son especiales: el Worker tiene
            // que tocar user_routes antes/después del proxy. El resto del
            // /auth/* (logout, me, patch profile) y /api/*, /stream/*, etc
            // se enrutan por el header X-NoBreak-Host.
            if (method === 'POST' && path === '/auth/register') return await handleRegister(request, env);
            if (method === 'POST' && path === '/auth/login')    return await handleLogin(request, env);

            return await proxyByHeader(request, env, url);
        } catch (e) {
            console.error('[unhandled]', e?.stack || e?.message || e);
            return json({ error: 'Internal error' }, 500);
        }
    },
};

// --- helpers --------------------------------------------------------------

function json(body, status = 200, extra = {}) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
    });
}

async function getHost(env, hostId) {
    return await env.nobreak_db.prepare(
        `SELECT host_id, label, tunnel_url, tunnel_secret, last_seen_at
         FROM hosts WHERE host_id = ?`
    ).bind(hostId).first();
}

async function getHostByUsername(env, username) {
    return await env.nobreak_db.prepare(
        `SELECT h.host_id, h.label, h.tunnel_url, h.tunnel_secret, h.last_seen_at
         FROM user_routes r JOIN hosts h ON h.host_id = r.host_id
         WHERE r.username = ?`
    ).bind(username).first();
}

// Auto-resuelve el host para el registro: el más recientemente activo dentro
// de la ventana de heartbeat. Sirve al caso "1 sola usuaria, 1 sólo .exe".
async function getDefaultHost(env) {
    const now = Date.now();
    const row = await env.nobreak_db.prepare(
        `SELECT host_id, label, tunnel_url, tunnel_secret, last_seen_at
         FROM hosts
         WHERE last_seen_at IS NOT NULL AND (? - last_seen_at) <= ?
         ORDER BY last_seen_at DESC
         LIMIT 1`
    ).bind(now, ONLINE_WINDOW_MS).first();
    return row || null;
}

// --- heartbeat ------------------------------------------------------------

async function handleHeartbeat(request, env) {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'JSON inválido' }, 400); }

    const hostId = body.hostId != null ? String(body.hostId).trim() : null;
    if (!hostId || hostId.length < 8 || hostId.length > 64) {
        return json({ error: 'hostId requerido (8-64 chars)' }, 400);
    }
    const label = body.label != null ? String(body.label).trim().slice(0, 80) : null;
    if (!label) return json({ error: 'label requerido' }, 400);

    const tunnelUrl = body.tunnelUrl != null ? String(body.tunnelUrl).trim().slice(0, 500) : null;
    if (!tunnelUrl || !/^https?:\/\//i.test(tunnelUrl)) {
        return json({ error: 'tunnelUrl debe empezar por http(s)://' }, 400);
    }
    const tunnelSecret = body.tunnelSecret != null ? String(body.tunnelSecret).slice(0, 128) : null;
    if (!tunnelSecret) return json({ error: 'tunnelSecret requerido' }, 400);

    // Lista opcional de cuentas que viven en la SQLite del .exe. El Worker
    // la usa para mantener user_routes(username → host) al día sin que el
    // usuario tenga que tocar nada: el binding cuenta↔servidor es
    // exactamente "los usuarios que tiene este .exe en local".
    let usernames = [];
    if (Array.isArray(body.usernames)) {
        usernames = body.usernames
            .map(u => String(u || '').trim().toLowerCase())
            .filter(u => u.length > 0 && u.length <= 80);
    }

    const now = Date.now();
    await env.nobreak_db.prepare(
        `INSERT OR REPLACE INTO hosts
           (host_id, label, tunnel_url, tunnel_secret, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, COALESCE((SELECT created_at FROM hosts WHERE host_id = ?), ?), ?)`
    ).bind(hostId, label, tunnelUrl, tunnelSecret, hostId, now, now).run();

    // Reconcilia user_routes con la lista del .exe: upsert de los usernames
    // recibidos y borrado de los que antes apuntaban a este host pero ya no.
    if (usernames.length > 0) {
        const stmts = usernames.map(u => env.nobreak_db.prepare(
            `INSERT INTO user_routes (username, host_id, created_at)
             VALUES (?, ?, ?)
             ON CONFLICT(username) DO UPDATE SET host_id = excluded.host_id`
        ).bind(u, hostId, now));
        await env.nobreak_db.batch(stmts);
    }
    // Limpia rutas viejas de este host que ya no están en la lista. Si la
    // lista llega vacía aceptamos el borrado completo: el .exe está limpio.
    if (Array.isArray(body.usernames)) {
        const placeholders = usernames.length > 0
            ? `AND username NOT IN (${usernames.map(() => '?').join(',')})`
            : '';
        await env.nobreak_db.prepare(
            `DELETE FROM user_routes WHERE host_id = ? ${placeholders}`
        ).bind(hostId, ...usernames).run();
    }

    return json({ ok: true, lastSeenAt: now });
}

// --- lista de hosts online (para picker del registro) ---------------------

async function handleListHosts(env) {
    const rows = await env.nobreak_db.prepare(
        `SELECT host_id, label, last_seen_at FROM hosts ORDER BY label`
    ).all();
    const now = Date.now();
    const hosts = (rows.results || []).map(h => ({
        hostId: h.host_id,
        label: h.label,
        online: h.last_seen_at != null && (now - h.last_seen_at) <= ONLINE_WINDOW_MS,
        lastSeenAt: h.last_seen_at,
    }));
    return json({ hosts, onlineWindowMs: ONLINE_WINDOW_MS });
}

// --- /auth/register: registra ruta + proxea -------------------------------

async function handleRegister(request, env) {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'JSON inválido' }, 400); }

    const username = String(body.username || '').trim();
    if (!username) return json({ error: 'Falta username' }, 400);

    const existing = await env.nobreak_db.prepare(
        `SELECT host_id FROM user_routes WHERE username = ?`
    ).bind(username).first();
    if (existing) return json({ error: 'Ese usuario ya existe' }, 409);

    const host = await getDefaultHost(env);
    if (!host) {
        return json({ error: 'No hay ningún NoBreak online ahora mismo. Abre la app de escritorio para crear la cuenta.' }, 503);
    }
    if (!host.tunnel_url || !host.tunnel_secret) {
        return json({ error: 'El NoBreak no está accesible (sin tunnel publicado)' }, 502);
    }

    // hostId puede colarse en el body por compatibilidad; lo ignoramos.
    const forwardBody = { ...body };
    delete forwardBody.hostId;

    const upstream = await proxyToHost(request, host, '/auth/register', forwardBody);
    if (!upstream.ok) return upstream.response;

    // Si el .exe respondió 2xx, registramos la ruta. Si no, dejamos que el
    // frontend vea el error del .exe sin tocar D1.
    const cloned = upstream.response.clone();
    const status = cloned.status;
    if (status >= 200 && status < 300) {
        await env.nobreak_db.prepare(
            `INSERT INTO user_routes (username, host_id, created_at) VALUES (?, ?, ?)`
        ).bind(username, host.host_id, Date.now()).run();
    }
    return upstream.response;
}

// --- /auth/login: resuelve ruta y proxea ----------------------------------

async function handleLogin(request, env) {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'JSON inválido' }, 400); }

    const username = String(body.username || '').trim();
    if (!username) return json({ error: 'Falta username' }, 400);

    // Si el usuario tiene ruta registrada la usamos. Si no (caso típico:
    // cuenta creada directamente en la app local antes de pasar por el
    // Worker), caemos al host por defecto (el único .exe con heartbeat).
    let host = await getHostByUsername(env, username);
    let routeExisted = !!host;
    if (!host) host = await getDefaultHost(env);
    if (!host) {
        return json({ error: 'No hay ningún NoBreak online ahora mismo' }, 503);
    }
    if (!host.tunnel_url || !host.tunnel_secret) {
        return json({ error: 'El NoBreak no está accesible ahora mismo' }, 502);
    }

    const upstream = await proxyToHost(request, host, '/auth/login', body);
    if (!upstream.ok) return upstream.response;

    // Enriquecemos la respuesta del .exe con el hostId para que el frontend
    // lo guarde y lo mande como X-NoBreak-Host en las siguientes calls.
    const cloned = upstream.response.clone();
    if (cloned.status < 200 || cloned.status >= 300) return upstream.response;
    let respBody;
    try { respBody = await cloned.json(); }
    catch { return upstream.response; }

    // Si el login fue OK y aún no había ruta para este usuario, la creamos
    // ahora para que las próximas requests resuelvan directo.
    if (!routeExisted) {
        try {
            await env.nobreak_db.prepare(
                `INSERT OR IGNORE INTO user_routes (username, host_id, created_at) VALUES (?, ?, ?)`
            ).bind(username, host.host_id, Date.now()).run();
        } catch (e) {
            console.warn('[login] backfill user_routes:', e?.message || e);
        }
    }
    return json({ ...respBody, hostId: host.host_id, hostLabel: host.label });
}

// --- proxy genérico por header X-NoBreak-Host -----------------------------

async function proxyByHeader(request, env, url) {
    // Headers no se pueden adjuntar a <img src> y <audio src>, así que para
    // /cover, /stream, /profile-photo etc usamos ?h=<hostId> en la URL como
    // fallback. El header tiene preferencia si llega.
    const hostId = request.headers.get('X-NoBreak-Host') || url.searchParams.get('h');
    if (!hostId) {
        return json({ error: 'Falta X-NoBreak-Host (login primero)' }, 400);
    }
    const host = await getHost(env, hostId);
    if (!host) return json({ error: 'Host no encontrado' }, 404);
    if (!host.tunnel_url || !host.tunnel_secret) {
        return json({ error: 'Host sin tunnel publicado (offline)' }, 502);
    }

    const fwdHeaders = new Headers();
    for (const [k, v] of request.headers) {
        if (HOP_HEADERS_REQ.has(k.toLowerCase())) continue;
        fwdHeaders.set(k, v);
    }
    fwdHeaders.set('X-NoBreak-Tunnel-Secret', host.tunnel_secret);

    const init = {
        method: request.method,
        headers: fwdHeaders,
        redirect: 'manual',
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') init.body = request.body;

    let upstream;
    try {
        upstream = await fetch(host.tunnel_url.replace(/\/+$/, '') + url.pathname + (url.search || ''), init);
    } catch (e) {
        console.warn('[proxy]', url.pathname, e?.message || e);
        return json({ error: 'No se pudo contactar con el host' }, 504);
    }
    const resHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
        if (HOP_HEADERS_RES.has(k.toLowerCase())) continue;
        resHeaders.set(k, v);
    }
    for (const [k, v] of Object.entries(CORS)) resHeaders.set(k, v);
    return new Response(upstream.body, {
        status: upstream.status, statusText: upstream.statusText, headers: resHeaders,
    });
}

// Helper interno para /auth/login y /auth/register: reenvía un body JSON
// específico al host (no toca el body del request original).
async function proxyToHost(request, host, path, bodyObj) {
    const fwdHeaders = new Headers();
    for (const [k, v] of request.headers) {
        const lk = k.toLowerCase();
        if (HOP_HEADERS_REQ.has(lk) || lk === 'content-length') continue;
        fwdHeaders.set(k, v);
    }
    fwdHeaders.set('Content-Type', 'application/json');
    fwdHeaders.set('X-NoBreak-Tunnel-Secret', host.tunnel_secret);

    let upstream;
    try {
        upstream = await fetch(host.tunnel_url.replace(/\/+$/, '') + path, {
            method: request.method,
            headers: fwdHeaders,
            body: JSON.stringify(bodyObj),
            redirect: 'manual',
        });
    } catch (e) {
        console.warn('[proxyToHost]', path, e?.message || e);
        return { ok: false, response: json({ error: 'No se pudo contactar con el host' }, 504) };
    }
    const resHeaders = new Headers();
    for (const [k, v] of upstream.headers) {
        if (HOP_HEADERS_RES.has(k.toLowerCase())) continue;
        resHeaders.set(k, v);
    }
    for (const [k, v] of Object.entries(CORS)) resHeaders.set(k, v);
    return {
        ok: true,
        response: new Response(upstream.body, {
            status: upstream.status, statusText: upstream.statusText, headers: resHeaders,
        }),
    };
}

// --- /install/<archivo> ---------------------------------------------------

async function handleInstallAsset(env, key, method) {
    if (!key || key.includes('..') || key.includes('/')) {
        return json({ error: 'Nombre de archivo no válido' }, 400);
    }
    let object;
    try {
        object = method === 'HEAD'
            ? await env.nobreak_installer.head(key)
            : await env.nobreak_installer.get(key);
    } catch (e) {
        console.warn('[install] R2 error', key, e?.message || e);
        return json({ error: 'No se pudo leer el archivo' }, 502);
    }
    if (!object) return json({ error: 'No encontrado' }, 404);

    const ext = key.slice(key.lastIndexOf('.')).toLowerCase();
    const headers = new Headers();
    headers.set('Content-Type', INSTALL_MIME[ext] || 'application/octet-stream');
    headers.set('Content-Disposition', 'attachment; filename="' + key + '"');
    headers.set('Cache-Control', 'public, max-age=86400');
    headers.set('Access-Control-Allow-Origin', '*');
    if (object.size != null) headers.set('Content-Length', String(object.size));
    if (object.etag) headers.set('ETag', object.etag);

    return new Response(method === 'HEAD' ? null : object.body, { status: 200, headers });
}
