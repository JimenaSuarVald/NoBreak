// Seeds a test user + library folder in the real userData DB the packaged
// EXE will use, then exits. After this runs, launch the EXE and you can
// sign in with the seeded credentials to exercise the full flow.
//
// Run: ELECTRON_RUN_AS_NODE=1 npx electron try-it.js

const path = require('path');
const fs = require('fs');
const os = require('os');

// Replicate Electron's app.getPath('userData') manually since we run as node.
// On Windows: %APPDATA%/<productName> using package.json "productName" or "name".
const pkg = require('./package.json');
const productName = pkg.productName || pkg.name || 'nobreak-desktop';
const userData = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), productName);
fs.mkdirSync(userData, { recursive: true });
const dbPath = path.join(userData, 'NoBreak.db');

const db = require('./db');
const auth = require('./auth');

console.log('userData:', userData);
console.log('db file: ', dbPath);

db.init(dbPath);

if (!auth.hasAnyUser()) {
    auth.createUser('test', 'testpass123');
    console.log('Created user: test / testpass123');
} else {
    console.log('User already exists; not creating.');
}

const music = path.join(os.homedir(), 'Music');
db.setLibraryFolder(music);
console.log('Library folder set to:', music);

db.close();
console.log('Done. Launch NoBreak.exe and sign in as test / testpass123.');
