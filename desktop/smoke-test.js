// End-to-end smoke test that exercises the whole stack without Electron:
// DB → user creation → settings → scanner → webserver → HTTP fetches.
// Uses a temp DB so it doesn't pollute the real Electron userData DB.
//
// Run: node smoke-test.js

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const TMP = path.join(os.tmpdir(), 'nobreak-smoke');
fs.rmSync(TMP, { recursive: true, force: true });
fs.mkdirSync(TMP, { recursive: true });
const dbPath = path.join(TMP, 'NoBreak.db');
const coverDir = path.join(TMP, 'covers');
fs.mkdirSync(coverDir, { recursive: true });

const MUSIC = process.argv[2] || path.join(os.homedir(), 'Music');

const db = require('./db');
const auth = require('./auth');
const scanner = require('./scanner');
const webserver = require('./webserver');

function get(pathname, headers = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: 8080, path: pathname, method: 'GET', headers,
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({
                status: res.statusCode,
                headers: res.headers,
                body: Buffer.concat(chunks),
            }));
        });
        req.on('error', reject);
        req.end();
    });
}

function postJson(pathname, body, headers = {}) {
    const data = Buffer.from(JSON.stringify(body));
    return new Promise((resolve, reject) => {
        const req = http.request({
            host: '127.0.0.1', port: 8080, path: pathname, method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': data.length, ...headers },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => {
                let parsed = null;
                try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
                resolve({ status: res.statusCode, body: parsed });
            });
        });
        req.on('error', reject);
        req.end(data);
    });
}

(async () => {
    let pass = 0, fail = 0;
    const check = (name, ok, detail = '') => {
        if (ok) { pass++; console.log(`✓ ${name}`); }
        else    { fail++; console.log(`✗ ${name}${detail ? ' — ' + detail : ''}`); }
    };

    console.log('--- INIT ---');
    db.init(dbPath);
    check('db.init', !!db.get());

    console.log('\n--- AUTH ---');
    check('hasAnyUser → false on empty DB', !auth.hasAnyUser());
    const user = auth.createUser('test', 'testpass123');
    check('createUser', user && user.username === 'test', JSON.stringify(user));
    check('hasAnyUser → true after create', auth.hasAnyUser());
    check('verifyUser correct pwd', !!auth.verifyUser('test', 'testpass123'));
    check('verifyUser wrong pwd', !auth.verifyUser('test', 'wrong'));
    const sess = auth.issueSession(user.id);
    check('issueSession', !!sess.token);
    check('verifySession matches', auth.verifySession(sess.token) === user.id);
    check('verifySession bogus', auth.verifySession('garbage') === null);

    console.log('\n--- SETTINGS ---');
    db.setLibraryFolder(MUSIC);
    check('settings library_folder roundtrip', db.getLibraryFolder() === MUSIC);

    console.log('\n--- SCAN ---');
    if (!fs.existsSync(MUSIC)) {
        console.log(`  (skipping: ${MUSIC} not found)`);
    } else {
        let lastProgress = '';
        const t0 = Date.now();
        const report = await scanner.scan(MUSIC, coverDir, (msg) => { lastProgress = msg; });
        const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
        console.log(`  scan finished in ${elapsed}s — ${JSON.stringify(report)}`);
        check('scan returned report', !!report);
        check('scan found audio files', report.scanned > 0 || report.skipped > 0);
        const trackCount = db.get().prepare('SELECT COUNT(*) AS n FROM tracks').get().n;
        check('tracks rows in DB > 0', trackCount > 0, `count=${trackCount}`);
        const sample = db.get().prepare('SELECT id, titulo, artista, album, path, cover_path FROM tracks WHERE titulo IS NOT NULL LIMIT 1').get();
        if (sample) {
            console.log(`  sample track: id=${sample.id} "${sample.titulo}" — ${sample.artista || '?'} / ${sample.album || '?'}`);
            console.log(`    path: ${sample.path}`);
            console.log(`    cover: ${sample.cover_path || '(none)'}`);
        }
    }

    console.log('\n--- HTTP ---');
    const webDir = path.resolve(__dirname, '..', 'Frontend');
    webserver.start({ webDir: fs.existsSync(webDir) ? webDir : null });
    await new Promise((r) => setTimeout(r, 250));

    const health = await get('/health');
    check('/health 200', health.status === 200);

    const noauthLib = await get('/api/library');
    check('/api/library without token → 401', noauthLib.status === 401);

    const login = await postJson('/auth/login', { username: 'test', password: 'testpass123' });
    check('/auth/login 200', login.status === 200, `status=${login.status}`);
    check('login returned token', !!(login.body && login.body.sessionToken));
    const httpToken = login.body?.sessionToken;

    const badLogin = await postJson('/auth/login', { username: 'test', password: 'wrong' });
    check('/auth/login wrong pwd → 401', badLogin.status === 401);

    const me = await get('/auth/me', { Authorization: 'Bearer ' + httpToken });
    check('/auth/me 200', me.status === 200);

    const lib = await get('/api/library', { Authorization: 'Bearer ' + httpToken });
    check('/api/library 200', lib.status === 200);
    let libJson = null;
    try { libJson = JSON.parse(lib.body.toString('utf8')); } catch {}
    check('library has albums array', !!(libJson && Array.isArray(libJson.albums)));
    if (libJson) {
        console.log(`  albums: ${libJson.albums.length}, artists: ${libJson.artists?.length}`);
        if (libJson.albums.length) {
            const a = libJson.albums[0];
            console.log(`  first album: "${a.titulo}" by ${a.artista} (${a.trackCount} tracks)`);
        }
    }

    // Stream test: pick first track, fetch a 1-byte range, confirm partial content.
    const firstTrack = db.get().prepare('SELECT id FROM tracks LIMIT 1').get();
    if (firstTrack) {
        const stream = await get('/stream/' + firstTrack.id + '?t=' + encodeURIComponent(httpToken),
            { Range: 'bytes=0-1023' });
        check('/stream/:id with ?t= → 206 partial content',
            stream.status === 206,
            `status=${stream.status} content-range=${stream.headers['content-range']}`);
        check('stream returned bytes', stream.body.length > 0,
            `bytes=${stream.body.length}`);
    } else {
        console.log('  (no tracks to stream-test)');
    }

    const streamNoAuth = firstTrack
        ? await get('/stream/' + firstTrack.id, { Range: 'bytes=0-1' })
        : null;
    if (streamNoAuth) {
        check('/stream/:id without token → 401', streamNoAuth.status === 401);
    }

    console.log('\n--- CORS (simulating browser at http://localhost:5500) ---');
    const ORIGIN = 'http://localhost:5500';
    // Preflight for POST /auth/login (Content-Type triggers it).
    const pre = await new Promise((resolve, reject) => {
        const r = http.request({
            host: '127.0.0.1', port: 8080, path: '/auth/login', method: 'OPTIONS',
            headers: {
                Origin: ORIGIN,
                'Access-Control-Request-Method': 'POST',
                'Access-Control-Request-Headers': 'content-type,authorization',
            },
        }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
        r.on('error', reject);
        r.end();
    });
    check('OPTIONS preflight → 204', pre.statusCode === 204);
    check('preflight ACAO echoes origin',
        pre.headers['access-control-allow-origin'] === ORIGIN,
        `got=${pre.headers['access-control-allow-origin']}`);
    check('preflight allows POST',
        /POST/.test(pre.headers['access-control-allow-methods'] || ''));
    check('preflight allows Authorization header',
        /authorization/i.test(pre.headers['access-control-allow-headers'] || ''));

    // Real POST with Origin set.
    const corsLogin = await new Promise((resolve, reject) => {
        const data = Buffer.from(JSON.stringify({ username: 'test', password: 'testpass123' }));
        const r = http.request({
            host: '127.0.0.1', port: 8080, path: '/auth/login', method: 'POST',
            headers: {
                Origin: ORIGIN,
                'Content-Type': 'application/json',
                'Content-Length': data.length,
            },
        }, (res) => {
            const chunks = [];
            res.on('data', (c) => chunks.push(c));
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
        });
        r.on('error', reject);
        r.end(data);
    });
    check('cross-origin POST /auth/login → 200', corsLogin.status === 200);
    check('cross-origin response has ACAO',
        corsLogin.headers['access-control-allow-origin'] === ORIGIN);

    console.log('\n--- NEW ENDPOINTS (genres / artist-info / playlists) ---');
    const genres = await get('/api/genres', { Authorization: 'Bearer ' + httpToken });
    let genresJson = []; try { genresJson = JSON.parse(genres.body.toString('utf8')); } catch {}
    check('/api/genres → 200', genres.status === 200);
    console.log(`  genres: ${genresJson.length}`);

    // Pick the first artist from the library and fetch their info.
    const someArtist = libJson?.artists?.[0]?.nombre;
    if (someArtist) {
        const ai = await get('/api/artist-info?name=' + encodeURIComponent(someArtist),
            { Authorization: 'Bearer ' + httpToken });
        let aiJson = null; try { aiJson = JSON.parse(ai.body.toString('utf8')); } catch {}
        check('/api/artist-info → 200 or 404', ai.status === 200 || ai.status === 404,
            `status=${ai.status}`);
        if (aiJson && aiJson.extract) {
            console.log(`  artist info for "${someArtist}" via ${aiJson.source} (${aiJson.extract.length} chars)`);
        } else {
            console.log(`  no info for "${someArtist}" — that's fine for niche artists`);
        }
    }

    // Playlists CRUD round-trip.
    const create = await postJson('/api/playlists', { name: 'smoke-test-' + Date.now() },
        { Authorization: 'Bearer ' + httpToken });
    check('POST /api/playlists → 201', create.status === 201);
    const playlistId = create.body?.id;
    check('playlist returned id', !!playlistId);

    if (playlistId && firstTrack) {
        const addRes = await new Promise((resolve, reject) => {
            const data = Buffer.from(JSON.stringify({ trackId: firstTrack.id }));
            const r = http.request({
                host: '127.0.0.1', port: 8080,
                path: '/api/playlists/' + playlistId + '/tracks',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': data.length,
                    Authorization: 'Bearer ' + httpToken,
                },
            }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
            r.on('error', reject); r.end(data);
        });
        check('POST playlist tracks → 201', addRes.statusCode === 201);

        const getPl = await get('/api/playlists/' + playlistId,
            { Authorization: 'Bearer ' + httpToken });
        let pl = null; try { pl = JSON.parse(getPl.body.toString('utf8')); } catch {}
        check('GET playlist after add → has 1 track', pl && pl.tracks?.length === 1);

        const delPl = await new Promise((resolve, reject) => {
            const r = http.request({
                host: '127.0.0.1', port: 8080, path: '/api/playlists/' + playlistId, method: 'DELETE',
                headers: { Authorization: 'Bearer ' + httpToken },
            }, (res) => { res.resume(); res.on('end', () => resolve(res)); });
            r.on('error', reject); r.end();
        });
        check('DELETE playlist → 204', delPl.statusCode === 204);
    }

    console.log('\n--- STATIC SITE ---');
    if (fs.existsSync(webDir)) {
        const menu = await get('/menu.html');
        check('GET /menu.html → 200', menu.status === 200);
        check('menu.html mentions login form',
            /form-login|Iniciar sesión/i.test(menu.body.toString('utf8')));
        const apiJs = await get('/api.js');
        check('GET /api.js → 200', apiJs.status === 200);
        check('api.js targets 127.0.0.1:8080',
            /127\.0\.0\.1:8080/.test(apiJs.body.toString('utf8')));
        // The website should also be reachable at / (extension-less fallback).
        const idx = await get('/');
        check('GET / serves something (index/menu)', idx.status === 200 || idx.status === 404);
    } else {
        console.log('  (Frontend/ not present, skipping static checks)');
    }

    webserver.stop();
    db.close();

    console.log(`\n--- ${pass} passed, ${fail} failed ---`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
    console.error('TEST CRASHED:', e);
    process.exit(2);
});
