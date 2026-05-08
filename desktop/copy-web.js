// Pre-package step: copies the repo's Frontend/ into desktop/web/ so the
// packaged EXE can serve the website from inside its bundle.
//
// Run by `npm run dist` before electron-packager picks up the project files.

const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'Frontend');
const dst = path.join(__dirname, 'web');

if (!fs.existsSync(src)) {
    console.warn(`copy-web: source ${src} not found; skipping. Packaged EXE will only expose the API.`);
    process.exit(0);
}

fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
console.log(`copy-web: ${src} → ${dst}`);
