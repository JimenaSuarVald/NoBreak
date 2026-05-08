// Replicates exactly what main.js does on startup, but as a CLI script.
// Catches and logs any error so we can see what's breaking the packaged EXE's scan.

const path = require('path');
const fs = require('fs');
const os = require('os');

const userData = path.join(process.env.APPDATA, 'nobreak-desktop');
const dbPath = path.join(userData, 'NoBreak.db');
const coverDir = path.join(userData, 'cache', 'art');
fs.mkdirSync(coverDir, { recursive: true });

const db = require('./db');
const scanner = require('./scanner');

(async () => {
    console.log('init db at', dbPath);
    db.init(dbPath);

    const folder = db.getLibraryFolder();
    console.log('library folder:', folder);
    console.log('exists?', folder && fs.existsSync(folder));
    console.log('isDir?', folder && fs.statSync(folder).isDirectory());

    console.log('starting scan…');
    try {
        const t0 = Date.now();
        const report = await scanner.scan(folder, coverDir, (msg) => {
            console.log(`  [${((Date.now()-t0)/1000).toFixed(1)}s]`, msg);
        });
        console.log('scan done:', report);
    } catch (e) {
        console.error('scan FAILED:', e.message);
        console.error(e.stack);
    }

    console.log('tracks rows:', db.get().prepare('SELECT COUNT(*) AS n FROM tracks').get().n);
    db.close();
})();
