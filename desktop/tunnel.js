// desktop/tunnel.js — Auto-túnel TryCloudflare.
//
// Lanza `cloudflared.exe tunnel --url http://127.0.0.1:<PORT>` para exponer
// el HTTP server local a Internet con una URL `*.trycloudflare.com`. La
// extrae del stderr de cloudflared y la publica via cloud.setTunnelUrl()
// para que el siguiente heartbeat la mande al Worker.
//
// El binario se descarga on-demand desde el release oficial al primer
// arranque y queda cacheado en `userData/bin/cloudflared.exe` (~22 MB).
// No se embebe en el instalador para mantenerlo ligero.
//
// Override: `NOBREAK_DISABLE_AUTO_TUNNEL=1` desactiva el módulo entero
// (en ese caso la usuaria puede seguir pegando URL manual en Ajustes).

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');

const RELEASE_URL = 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe';
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

let proc = null;
let binPath = null;
let userDataDir = null;
let cloudRef = null;
let relayRef = null;
let httpPort = null;
let lastUrl = null;
let lastError = null;
let restartTimer = null;
let backoffMs = 2000;
let stopped = false;

function ensureBinDir() {
    const dir = path.join(userDataDir, 'bin');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

function binExists() {
    try {
        const st = fs.statSync(binPath);
        // sanity: cloudflared-windows-amd64.exe ronda los 22 MB. Si vemos un
        // archivo mucho más pequeño asumimos descarga corrupta y rebajamos.
        return st.isFile() && st.size > 5 * 1024 * 1024;
    } catch { return false; }
}

function downloadBinary() {
    return new Promise((resolve, reject) => {
        const tmp = binPath + '.part';
        try { fs.unlinkSync(tmp); } catch {}
        const file = fs.createWriteStream(tmp);
        const get = (url, redirects) => {
            const req = https.get(url, (res) => {
                if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                    res.resume();
                    if (redirects > 5) return reject(new Error('demasiadas redirecciones'));
                    return get(res.headers.location, redirects + 1);
                }
                if (res.statusCode !== 200) {
                    res.resume();
                    return reject(new Error('HTTP ' + res.statusCode + ' bajando cloudflared'));
                }
                res.pipe(file);
                file.on('finish', () => file.close((err) => {
                    if (err) return reject(err);
                    try { fs.renameSync(tmp, binPath); resolve(); }
                    catch (e) { reject(e); }
                }));
            });
            req.on('error', (err) => {
                file.destroy();
                try { fs.unlinkSync(tmp); } catch {}
                reject(err);
            });
        };
        get(RELEASE_URL, 0);
    });
}

async function ensureBinary() {
    ensureBinDir();
    if (binExists()) return;
    console.log('[tunnel] descargando cloudflared.exe…');
    await downloadBinary();
    console.log('[tunnel] cloudflared listo en', binPath);
}

function publish(url) {
    if (!cloudRef || !cloudRef.setTunnelUrl) return;
    try {
        cloudRef.setTunnelUrl(url);
        lastUrl = url;
        lastError = null;
        backoffMs = 2000;
        console.log('[tunnel] URL pública:', url);
        try { relayRef?.kick?.(); } catch {}
    } catch (e) {
        console.warn('[tunnel] setTunnelUrl falló:', e?.message || e);
    }
}

function spawnProcess() {
    if (proc || stopped) return;
    // --protocol http2: usa TCP/443 en vez de QUIC/UDP 7844. Muchos
    //   routers domésticos y antivirus bloquean QUIC, lo que provoca que
    //   cloudflared imprima la URL pero el edge devuelva 1033 porque las
    //   conexiones de datos nunca llegan.
    // --edge-ip-version 4: fuerza IPv4 al edge; algunos firewalls hacen
    //   shaping/bloqueo selectivo a IPv6 outbound.
    const args = [
        'tunnel',
        '--url', 'http://127.0.0.1:' + httpPort,
        '--no-autoupdate',
        '--metrics', '127.0.0.1:0',
        '--protocol', 'http2',
        '--edge-ip-version', '4',
    ];
    let child;
    try {
        child = spawn(binPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
        lastError = e.message || String(e);
        console.warn('[tunnel] spawn falló:', lastError);
        scheduleRestart();
        return;
    }
    proc = child;
    const onData = (chunk) => {
        const s = chunk.toString('utf8');
        const m = s.match(URL_RE);
        if (m && m[0] !== lastUrl) publish(m[0]);
        // Visibilidad: levantamos al log las líneas con error/warn/fatal de
        // cloudflared para diagnosticar problemas de conectividad al edge
        // (1033/1016 vienen de aquí). El resto del stderr es ruido.
        for (const line of s.split(/\r?\n/)) {
            if (!line) continue;
            if (/\b(ERR|ERROR|WARN|WRN|FATAL|failed|unable|refused|timeout)\b/i.test(line)) {
                console.warn('[tunnel:cf]', line.trim());
            }
        }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code, signal) => {
        console.warn('[tunnel] cloudflared exit code=' + code + ' signal=' + signal);
        proc = null;
        if (!stopped) scheduleRestart();
    });
    child.on('error', (err) => {
        lastError = err.message || String(err);
        console.warn('[tunnel] error proceso:', lastError);
    });
}

function scheduleRestart() {
    if (stopped || restartTimer) return;
    const delay = Math.min(backoffMs, 60000);
    console.log('[tunnel] reintento en', delay, 'ms');
    restartTimer = setTimeout(() => {
        restartTimer = null;
        backoffMs = Math.min(backoffMs * 2, 60000);
        spawnProcess();
    }, delay);
}

async function start({ cloud, relay, port, userData }) {
    if (process.env.NOBREAK_DISABLE_AUTO_TUNNEL === '1') {
        console.log('[tunnel] desactivado por NOBREAK_DISABLE_AUTO_TUNNEL=1');
        return;
    }
    if (proc) return;
    stopped = false;
    cloudRef = cloud;
    relayRef = relay;
    httpPort = port;
    userDataDir = userData;
    binPath = path.join(ensureBinDir(), 'cloudflared.exe');
    try {
        await ensureBinary();
    } catch (e) {
        lastError = e.message || String(e);
        console.warn('[tunnel] no se pudo bajar cloudflared:', lastError);
        console.warn('[tunnel] desactivado; queda como fallback la URL manual en Ajustes');
        return;
    }
    spawnProcess();
}

function stop() {
    stopped = true;
    if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
    if (proc) {
        try { proc.kill('SIGTERM'); } catch {}
        proc = null;
    }
}

function getDiagnostics() {
    return { running: !!proc, url: lastUrl, lastError, backoffMs };
}

module.exports = { start, stop, getDiagnostics };
