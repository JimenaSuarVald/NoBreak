// desktop/cloud-relay.js — Heartbeat al Worker.
//
// Cada 60s manda { hostId, label, tunnelUrl, tunnelSecret, usernames } al
// Worker para que sepa adónde proxear las peticiones del frontend y para
// que reconcilie user_routes (username → host) con las cuentas que viven
// en la SQLite local. Así el binding cuenta↔servidor es automático: el
// usuario nunca ve un picker.
//
// Modelo de confianza: bind del .exe es 127.0.0.1, el tunnel hace forward
// al loopback; no hay auth en /_w/heartbeat. Alcance: 1 PC = 1 .exe.
//
// Falla silenciosamente (log, no excepción).

const auth = require('./auth');

const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_RETRY_MS    = 15 * 1000;

let cloud = null;
let timer = null;
let lastOk = null;
let lastError = null;

function start(cloudModule) {
    cloud = cloudModule;
    if (timer) return;
    timer = setTimeout(tick, 3000);
    console.log('[relay] heartbeat client arrancado');
}

function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
}

// Re-arranca el siguiente tick "ya" (próximo loop), saltándose el delay
// pendiente. Útil tras crear un usuario para que el Worker se entere antes
// de los 60s estándar.
function kick() {
    if (!cloud) return;
    if (timer) { clearTimeout(timer); timer = null; }
    timer = setTimeout(tick, 100);
}

async function tick() {
    timer = null;
    const tunnelUrl = cloud?.getTunnelUrl?.() || null;
    if (!tunnelUrl) {
        // Sin tunnel URL configurada no hay nada que publicar — el usuario
        // todavía no la ha pegado en Ajustes. Reintenta en 1 min.
        timer = setTimeout(tick, HEARTBEAT_INTERVAL_MS);
        return;
    }
    const tunnelSecret = cloud.ensureTunnelSecret?.() || null;
    const hostId = cloud.getHostId?.() || null;
    const label  = cloud.getLabel?.()  || null;
    if (!hostId || !label) {
        timer = setTimeout(tick, HEARTBEAT_INTERVAL_MS);
        return;
    }
    let usernames = [];
    try { usernames = auth.listUsernames(); }
    catch (e) { console.warn('[relay] listUsernames falló:', e?.message); }

    try {
        const r = await fetch(cloud.CLOUD_URL + '/_w/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ hostId, label, tunnelUrl, tunnelSecret, usernames }),
        });
        if (!r.ok) {
            const data = await r.json().catch(() => ({}));
            throw new Error(data.error || ('HTTP ' + r.status));
        }
        lastOk = Date.now();
        lastError = null;
        timer = setTimeout(tick, HEARTBEAT_INTERVAL_MS);
    } catch (e) {
        lastError = { at: Date.now(), message: e.message || String(e) };
        console.warn('[relay] heartbeat falló:', lastError.message);
        timer = setTimeout(tick, HEARTBEAT_RETRY_MS);
    }
}

function getDiagnostics() {
    return {
        running: !!timer,
        lastOk,
        lastError,
        intervalMs: HEARTBEAT_INTERVAL_MS,
    };
}

module.exports = { start, stop, kick, getDiagnostics };
