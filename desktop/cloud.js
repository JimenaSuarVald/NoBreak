// desktop/cloud.js — Estado del .exe como host del Worker.
//
// Cada .exe se registra como un host independiente en el Worker:
//   - hostId: UUID v4, generado la primera vez, persistido en cloud-state.json
//   - label:  nombre humano usado en logs/diagnósticos del Worker
//             (default = nombre de la cuenta del SO; editable en runtime)
//   - tunnelUrl + tunnelSecret: lo que ya conocemos
//
// El relay manda `{hostId, label, tunnelUrl, tunnelSecret, usernames}` en
// cada heartbeat al Worker, que actualiza la fila del host en D1 y reconcilia
// user_routes con la lista de cuentas locales (binding cuenta↔servidor
// automático: el usuario nunca elige host).

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const CLOUD_URL = (process.env.NOBREAK_CLOUD_URL
    || 'https://nobreak-cloud.jimenasuarezvaldesss.workers.dev').replace(/\/+$/, '');

let stateFile = null;
let cached = null;

function init(userDataDir) {
    stateFile = path.join(userDataDir, 'cloud-state.json');
    cached = readDisk();
    // En el primer arranque garantizamos hostId + label, así el relay puede
    // mandar heartbeat sin tener que esperar a setLabel() del renderer.
    ensureHostId();
    ensureLabel();
    ensureTunnelSecret();
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

// --- host_id: UUID v4 estable ---------------------------------------------
function ensureHostId() {
    if (cached?.hostId) return cached.hostId;
    const id = crypto.randomUUID();
    cached = { ...(cached || {}), hostId: id };
    writeDisk(cached);
    return id;
}
function getHostId() { return cached?.hostId || ensureHostId(); }

// --- label: nombre humano para el picker ----------------------------------
// Default = nombre del usuario del SO + " - NoBreak". El usuario puede
// cambiarlo desde Ajustes (IPC cloud:setLabel).
function defaultLabel() {
    try {
        const u = os.userInfo().username || 'NoBreak';
        return u.trim() + ' - NoBreak';
    } catch { return 'NoBreak'; }
}
function ensureLabel() {
    if (cached?.label) return cached.label;
    const lbl = defaultLabel();
    cached = { ...(cached || {}), label: lbl };
    writeDisk(cached);
    return lbl;
}
function getLabel() { return cached?.label || ensureLabel(); }
function setLabel(newLabel) {
    const clean = String(newLabel || '').trim().slice(0, 80);
    if (!clean) throw new Error('Label vacío');
    cached = { ...(cached || {}), label: clean };
    writeDisk(cached);
    return clean;
}

// --- tunnel_secret: random 32 bytes ---------------------------------------
function ensureTunnelSecret() {
    if (cached?.tunnelSecret) return cached.tunnelSecret;
    const secret = crypto.randomBytes(32).toString('hex');
    cached = { ...(cached || {}), tunnelSecret: secret };
    writeDisk(cached);
    return secret;
}
function getTunnelSecret() { return cached?.tunnelSecret || null; }

// --- tunnel_url: la pega el usuario en Ajustes ----------------------------
function getTunnelUrl() { return cached?.tunnelUrl || null; }
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

// Resumen seguro para el renderer (sin tunnel_secret).
function getStatus() {
    return {
        cloudUrl: CLOUD_URL,
        hostId: getHostId(),
        label: getLabel(),
        tunnelUrl: cached?.tunnelUrl || null,
        hasTunnelSecret: !!cached?.tunnelSecret,
    };
}

module.exports = {
    init, getStatus,
    getHostId, getLabel, setLabel,
    getTunnelUrl, setTunnelUrl,
    ensureTunnelSecret, getTunnelSecret,
    CLOUD_URL,
};
