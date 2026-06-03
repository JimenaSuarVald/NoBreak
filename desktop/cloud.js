// desktop/cloud.js — Estado mínimo del vínculo .exe ↔ Worker NoBreak.
//
// Modelo simplificado (sin cuentas cloud, sin pairing):
//   - La web del Worker (frontend) reenvía /auth/* /api/* /stream/* al .exe.
//   - Para evitar que alguien con la URL del tunnel pegue al .exe sin pasar
//     por el Worker, el .exe genera un `tunnel_secret` aleatorio y lo
//     publica al Worker en cada heartbeat. El Worker lo reenvía en cada
//     proxy como header `X-NoBreak-Tunnel-Secret`. El webserver del .exe
//     valida que el header coincide; si no, rechaza con 403.
//   - El usuario pega manualmente la URL del cloudflared en Ajustes →
//     "URL del tunnel". Persiste en `cloud-state.json` del userData.
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

// tunnel_secret: 64 hex chars generados localmente. Se publica al Worker
// en cada heartbeat. El Worker lo reenvía en proxy → webserver del .exe.
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

// URL pública del tunnel (cloudflared, ngrok, etc) que apunta a este .exe.
// La pega el usuario en Ajustes — no la auto-detectamos.
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

// Resumen seguro para el renderer. El tunnel_secret NO se expone.
function getStatus() {
    return {
        cloudUrl: CLOUD_URL,
        tunnelUrl: cached?.tunnelUrl || null,
        hasTunnelSecret: !!cached?.tunnelSecret,
    };
}

module.exports = {
    init, getStatus,
    getTunnelUrl, setTunnelUrl,
    ensureTunnelSecret, getTunnelSecret,
    CLOUD_URL,
};
