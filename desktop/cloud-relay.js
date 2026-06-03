// desktop/cloud-relay.js — Heartbeat al Worker.
//
// Modelo simplificado: cada 60s manda { tunnelUrl, tunnelSecret } al
// Worker para que sepa adónde proxear las peticiones del frontend. NO hay
// auth de heartbeat por ahora (alcance: 1 PC, una sola tunnel; cualquiera
// que conozca la URL del Worker puede pegar al endpoint, pero solo cambia
// la fila única de routing, no expone datos de usuario).
//
// Falla silenciosamente (log, no excepción).

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

async function tick() {
    timer = null;
    const tunnelUrl = cloud?.getTunnelUrl?.() || null;
    if (!tunnelUrl) {
        // Sin tunnel URL configurada no hay nada que publicar — el usuario
        // todavía no la ha pegado en Ajustes. Reintenta en 1 min.
        timer = setTimeout(tick, HEARTBEAT_INTERVAL_MS);
        return;
    }
    // Aseguramos el tunnel_secret existe antes del primer heartbeat.
    const tunnelSecret = cloud.ensureTunnelSecret?.() || null;

    try {
        const r = await fetch(cloud.CLOUD_URL + '/_w/heartbeat', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tunnelUrl, tunnelSecret }),
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

module.exports = { start, stop, getDiagnostics };
