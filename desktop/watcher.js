// Watches a folder (recursively) with chokidar and fires a callback after a
// quiet period — needed because dropping 200 files into a folder generates
// ~200 events; we want one rescan, not 200.

const chokidar = require('chokidar');

const DEBOUNCE_MS = 2000;
const WATCHED_EXTS = /\.(mp3|flac|m4a|aac|ogg|opus|wav)$/i;

class LibraryWatcher {
  constructor(folder, onChange) {
    this.folder = folder;
    this.onChange = onChange;
    this.watcher = null;
    this.timer = null;
  }

  start() {
    if (this.watcher) return;
    this.watcher = chokidar.watch(this.folder, {
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      ignored: (p) => {
        // Ignore non-audio files. Directories pass so we walk into them.
        try {
          const fs = require('fs');
          if (fs.existsSync(p) && fs.statSync(p).isDirectory()) return false;
        } catch { /* ignore */ }
        return !WATCHED_EXTS.test(p);
      },
    });
    const fire = () => this._schedule();
    this.watcher.on('add', fire).on('change', fire).on('unlink', fire)
               .on('addDir', fire).on('unlinkDir', fire);
  }

  _schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      try { this.onChange(); } catch (e) { console.error('watcher onChange threw', e); }
    }, DEBOUNCE_MS);
  }

  async stop() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (this.watcher) { await this.watcher.close(); this.watcher = null; }
  }
}

module.exports = { LibraryWatcher };
