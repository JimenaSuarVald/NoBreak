// desktop/cloud-relay.js — Heartbeat al Worker (hito C.1).
//
// Cada 60 segundos, si el .exe está vinculado, envía POST
// /api/devices/heartbeat con la URL del tunnel actual (la pega el usuario en
// Ajustes → NoBreak Cloud → "URL del tunnel").
//
// Esto NO proxea peticiones todavía — sólo registra "estoy vivo y mi tunnel
// está en X" para que el Worker pueda en hito C.2 enrutar tráfico al .exe
// correcto. Mientras no se implemente ese proxy, la información ya es útil
// para mostrar "online/offline" en la UI del cloud.
//
// Falla silenciosamente (log, no excepción) — si el Worker está caído o la
// red no funciona, el .exe sigue operativo en local.

const HEARTBEAT_INTERVAL_MS = 60 * 1000;
const HEARTBEAT_RETRY_MS    = 15 * 1000;   // si falló, reintenta a los 15 s

let cloud = null;
let timer = null;
let lastOk = null;
let lastError = null;

function start(cloudModule) {
    cloud = cloudModule;
    if (timer) return;  // ya arrancado
    // Pequeño delay inicial para no pegarle al Worker en el mismo instante
    // que se inicia el resto de la app.
    timer = setTimeout(tick, 3000);
    console.log('[relay] heartbeat client arrancado');
}

function stop() {
    if (timer) { clearTimeout(timer); timer = null; }
}

async function tick() {
    timer = null;
    const status = cloud?.getStatus?.();
    if (!status || !status.linked) {
        // No vinculado — no hay nada que hacer. Reintenta en 1 min por si el
        // usuario vincula sin reiniciar.
        timer = setTimeout(tick, HEARTBEAT_INTERVAL_MS);
        return;
    }

    const tunnelUrl = cloud.getTunnelUrl?.() || null;
    const machineToken = cloud.getMachineToken?.();
    if (!machineToken) {
        // estado raro: linked pero sin token. Re-intenta más tarde.
        timer = setTimeout(tick, HEARTBEAT_INTERVAL_MS);
        return;
    }
    // Aseguramos el tunnel_secret existe antes del primer heartbeat. Si ya
    // estaba (instalaciones previas), se reutiliza; si no, se genera ahora.
    const tunnelSecret = cloud.ensureTunnelSecret?.() || null;

    try {
        const r = await fetch(cloud.CLOUD_URL + '/api/devices/heartbeat', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + machineToken,
            },
            body: JSON.stringify({
                tunnelUrl: tunnelUrl || undefined,
                tunnelSecret: tunnelSecret || undefined,
            }),
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
