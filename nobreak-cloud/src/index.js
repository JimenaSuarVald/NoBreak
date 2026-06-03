// nobreak-cloud — Worker como proxy transparente al .exe del usuario.
//
// Modelo (post-rediseño):
//   - El Worker hace DOS cosas:
//     1) Sirve Frontend/ via assets binding (HTML/CSS/JS estático).
//     2) Cualquier path que no sea asset y no sea ruta interna del Worker
//        se reenvía al .exe via cloudflared. El Worker añade el header
//        X-NoBreak-Tunnel-Secret para que el .exe sepa que viene del
//        Worker y no de alguien con la URL pública del tunnel.
//   - El .exe publica su tunnel_url + tunnel_secret cada 60s en
//     POST /_w/heartbeat. El Worker guarda UNA fila en D1 (devices con
//     device_id = 'primary').
//   - No hay cuentas cloud, no hay pairing, no hay sessionToken del Worker.
//     Los usuarios son los del SQLite del .exe; el frontend habla con el
//     .exe a través del proxy igual que si fuera 127.0.0.1.
//
// Alcance "1 PC, 1 puerto" (declarado por la usuaria). Cuando haya N PCs
// habrá que multiplexar por hostname/path.

const RELAY_DEVICE_ID = 'primary';

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS, HEAD',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Range',
    'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges',
    'Access-Control-Max-Age': '86400',
};

// Cabeceras hop-by-hop que NO se reenvían al .exe (RFC 7230 §6.1) y
// cabeceras de Cloudflare que solo confunden al destino.
const HOP_HEADERS_REQ = new Set([
    'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
    'te', 'trailer', 'proxy-connection', 'proxy-authorization',
    'cf-connecting-ip', 'cf-ipcountry', 'cf-ray', 'cf-visitor',
    'cf-worker', 'x-forwarded-for', 'x-forwarded-proto', 'x-real-ip',
    'content-length',  // fetch lo recomputa
]);
const HOP_HEADERS_RES = new Set([
    'connection', 'keep-alive', 'transfer-encoding', 'upgrade',
    'te', 'trailer', 'proxy-connection',
]);

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        if (method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: CORS });
        }

        try {
            if (path === '/health') return json({ ok: true });
            if (method === 'POST' && path === '/_w/heartbeat') return await handleHeartbeat(request, env);

            // Cualquier otra cosa: el assets binding ya intercepta los
            // ficheros estáticos antes de llegar aquí. Lo que llegue al
            // fetch handler es porque NO existe como asset → toca proxear
            // al .exe.
            return await proxyToExe(request, env, url);
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

// --- heartbeat ------------------------------------------------------------

async function handleHeartbeat(request, env) {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: 'JSON inválido' }, 400); }

    const tunnelUrl = body.tunnelUrl != null ? String(body.tunnelUrl).trim().slice(0, 500) : null;
    if (!tunnelUrl || !/^https?:\/\//i.test(tunnelUrl)) {
        return json({ error: 'tunnelUrl debe empezar por http(s)://' }, 400);
    }
    const tunnelSecret = body.tunnelSecret != null ? String(body.tunnelSecret).slice(0, 128) : null;
    if (!tunnelSecret) {
        return json({ error: 'tunnelSecret requerido' }, 400);
    }
    const now = Date.now();

    // Schema simplificado (migración 003): solo device_id + created_at +
    // last_seen_at + tunnel_url + tunnel_secret. Una sola fila device_id='primary'.
    await env.nobreak_db.prepare(
        `INSERT OR REPLACE INTO devices
           (device_id, created_at, last_seen_at, tunnel_url, tunnel_secret)
         VALUES (?, COALESCE((SELECT created_at FROM devices WHERE device_id = ?), ?), ?, ?, ?)`
    ).bind(RELAY_DEVICE_ID, RELAY_DEVICE_ID, now, now, tunnelUrl, tunnelSecret).run();

    return json({ ok: true, lastSeenAt: now });
}

// --- proxy al .exe --------------------------------------------------------

async function getRelay(env) {
    return await env.nobreak_db.prepare(
        `SELECT tunnel_url, tunnel_secret, last_seen_at
         FROM devices WHERE device_id = ?`
    ).bind(RELAY_DEVICE_ID).first();
}

async function proxyToExe(request, env, url) {
    const relay = await getRelay(env);
    if (!relay || !relay.tunnel_url) {
        return json({ error: 'No hay tunnel registrado. Arranca cloudflared en el .exe y pega la URL en Ajustes.' }, 502);
    }
    if (!relay.tunnel_secret) {
        return json({ error: 'El .exe aún no ha publicado tunnel_secret (heartbeat pendiente).' }, 502);
    }

    const base = relay.tunnel_url.replace(/\/+$/, '');
    const targetUrl = base + url.pathname + (url.search || '');

    const fwdHeaders = new Headers();
    for (const [k, v] of request.headers) {
        if (HOP_HEADERS_REQ.has(k.toLowerCase())) continue;
        fwdHeaders.set(k, v);
    }
    fwdHeaders.set('X-NoBreak-Tunnel-Secret', relay.tunnel_secret);

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
        console.warn('[proxy]', url.pathname, e?.message || e);
        return json({ error: 'No se pudo contactar con el dispositivo (¿cloudflared apagado?)' }, 504);
    }

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
