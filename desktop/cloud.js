// desktop/cloud.js — Vínculo con NoBreak Cloud (hito B fase 2).
//
// El usuario se loguea en la web del cloud (https://…workers.dev/), genera
// un código de 6 dígitos, abre Ajustes → Vincular con NoBreak Cloud, lo pega.
// Este módulo intercambia ese código por un machine_token largo y lo persiste
// en un JSON sidecar (NO se toca el SQLite del .exe).
//
// El machine_token vive sólo en disco local + memoria del proceso main —
// nunca se expone al renderer. La UI ve un objeto resumen (linked, username,
// label, pairedAt) sin el token.
//
// Override del backend para tests locales:
//   NOBREAK_CLOUD_URL=http://localhost:8787   (wrangler dev)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLOUD_URL = (process.env.NOBREAK_CLOUD_URL
    || 'https://nobreak-cloud.jimenasuarezvaldesss.workers.dev').replace(/\/+$/, '');

let stateFile = null;
let cached = null;

function init(userDataDir) {
    stateFile = path.join(userDataDir, 'cloud-state.json');
    cached = readDisk();
}

function readDisk() {
    try {
        if (!stateFile || !fs.existsSync(stateFile)) return null;
        return JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    } catch (e) {
        console.warn('[cloud] cloud-state.json corrupto, lo ignoro:', e.message);
        return null;
    }
}

function writeDisk(state) {
    if (!stateFile) throw new Error('cloud.init() no ha sido llamado');
    const tmp = stateFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
    fs.renameSync(tmp, stateFile);
    cached = state;
}

// device_id se genera una vez por instalación y persiste aunque el .exe
// nunca llegue a vincularse. Mantenerlo estable hace que un re-claim
// (rotación del machine_token) se reconozca como la misma máquina.
function ensureDeviceId() {
    if (cached?.deviceId) return cached.deviceId;
    const id = crypto.randomUUID();
    cached = { ...(cached || {}), deviceId: id };
    writeDisk(cached);
    return id;
}

// tunnel_secret: 64 hex chars. Lo generamos una vez y persiste. El relay
// lo envía al Worker en heartbeat; el Worker lo reenvía en header
// X-NoBreak-Tunnel-Secret al proxear. webserver.js lo verifica para que
// nadie con sólo la tunnel_url pueda pegarle al .exe.
function ensureTunnelSecret() {
    if (cached?.tunnelSecret) return cached.tunnelSecret;
    const secret = crypto.randomBytes(32).toString('hex');
    cached = { ...(cached || {}), tunnelSecret: secret };
    writeDisk(cached);
    return secret;
}

function getTunnelSecret() {
    return cached?.tunnelSecret || null;
}

// Resumen seguro para el renderer. NUNCA incluye machineToken.
function getStatus() {
    if (!cached || !cached.machineToken) {
        return { linked: false, cloudUrl: CLOUD_URL, tunnelUrl: cached?.tunnelUrl || null };
    }
    return {
        linked: true,
        deviceId: cached.deviceId,
        username: cached.username || null,
        userId: cached.userId || null,
        label: cached.label || null,
        pairedAt: cached.pairedAt || null,
        tunnelUrl: cached.tunnelUrl || null,
        cloudUrl: CLOUD_URL,
    };
}

async function claimCode(rawCode, rawLabel) {
    const code = String(rawCode || '').trim();
    if (!/^\d{6}$/.test(code)) {
        throw new Error('El código debe ser 6 dígitos.');
    }
    const label = (rawLabel || '').toString().trim().slice(0, 80) || null;
    const deviceId = ensureDeviceId();

    let r;
    try {
        r = await fetch(CLOUD_URL + '/api/pair/claim', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, deviceId, label }),
        });
    } catch (e) {
        throw new Error('No se pudo contactar con NoBreak Cloud: ' + e.message);
    }

    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
        throw new Error(data.error || ('Error ' + r.status));
    }

    writeDisk({
        deviceId,
        machineToken: data.machineToken,
        userId: data.userId,
        username: data.username || null,
        label,
        pairedAt: data.pairedAt,
    });
    return getStatus();
}

// URL pública del tunnel (cloudflared u otro) que apunta a este .exe. La
// pega el usuario en Ajustes — no la auto-detectamos porque cloudflared no
// expone su URL en una API estable (la imprime por stdout). Persistida en
// el mismo JSON sidecar para sobrevivir a reinicios.
function getTunnelUrl() {
    return cached?.tunnelUrl || null;
}

function setTunnelUrl(url) {
    const clean = (url == null || url === '') ? null : String(url).trim();
    if (clean && !/^https?:\/\//i.test(clean)) {
        throw new Error('La URL debe empezar por http:// o https://');
    }
    if (!cached) cached = {};
    cached = { ...cached, tunnelUrl: clean };
    writeDisk(cached);
    return getStatus();
}

// Sólo lo invoca cloud-relay.js (main process). NUNCA expongas esto al
// renderer vía IPC — el token es la única credencial del .exe contra el cloud.
function getMachineToken() {
    return cached?.machineToken || null;
}

function unlink() {
    // Mantenemos device_id y tunnel_secret para que un futuro re-pair en el
    // mismo PC se reconozca como la misma máquina y no haya que regenerar
    // el secreto (el .exe sigue siendo la misma instancia).
    const keepDeviceId = cached?.deviceId || null;
    const keepTunnelSecret = cached?.tunnelSecret || null;
    const next = {};
    if (keepDeviceId) next.deviceId = keepDeviceId;
    if (keepTunnelSecret) next.tunnelSecret = keepTunnelSecret;
    cached = Object.keys(next).length ? next : null;
    if (cached) writeDisk(cached);
    else try { if (stateFile && fs.existsSync(stateFile)) fs.unlinkSync(stateFile); } catch {}
    return getStatus();
}

module.exports = {
    init, getStatus, claimCode, unlink,
    getTunnelUrl, setTunnelUrl, getMachineToken,
    ensureTunnelSecret, getTunnelSecret,
    CLOUD_URL,
};
