# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project context

NoBreak is a student music-player project (no commercial intent) authored in Spanish. UI strings, comments, variable names, and prompts are predominantly Spanish — preserve that language when editing user-facing text. The README states the philosophy is ad-free local music playback as an alternative to streaming monopolies.

## Architecture: three coexisting stacks

The repo is unusual — it bundles **three separate implementations** of the same product, none of which are wired together by a build system. Identify which stack a request targets before editing:

1. **Static web frontend** (`Frontend/`) — Plain HTML/CSS/JS, no framework, no build step. `menu.html` is the entry; `reproductor.html` is a WIP player page; `descargable.html` is the desktop-app download page. All three pages share `estilo.css` and `javascript.js`. Auth state (users, session, theme) is persisted in `localStorage`. Registration also POSTs to `http://localhost:8080/api/registro` to sync into the Java SQLite DB — that endpoint is not yet implemented in `NoBreakCore.java` (only `/api/lista` is), so sync calls currently fail silently by design.

2. **React frontend** (`App.js` + `components/` + `styles/`) — Loose JSX/JS files at the repo root, no `create-react-app` scaffold, no `index.html`, no bundler config. `App.js`, `components/TopNavBar.js`, `components/BottomPlayer.js`, `components/albumDisplay.js` exist as sources but cannot be run as-is — they're scaffolding awaiting a build setup. `albumDisplay.js` fetches from `http://localhost:3001/api/{albums,artists}` (the Node server below).

3. **Node/Express mock API** (`server.js`) — Listens on port **3001**, serves a hardcoded `musicDatabase` (Oneohtrix Point Never sample data) at `/api/albums` and `/api/artists`. Pure stub for the React frontend; no DB, no persistence.

4. **Java desktop player** (`NoBreak_Project/src/com/nobreak/core/NoBreakCore.java`) — Standalone Swing app that scans `~/Music/*.mp3`, stores tracks in **SQLite** (`NoBreak.db`, JDBC URL `jdbc:sqlite:NoBreak.db`), and exposes an **HTTP API on port 8080** via `com.sun.net.httpserver.HttpServer`. Currently only `GET /api/lista` is implemented (returns track titles). `togglePlay()` only flips the button label — actual audio playback is not wired up yet.

5. **Electron skeleton** (`desktop/`) — Has `electron` binary in `node_modules` but no `package.json`, no `main.js`, and `src/renderer/components/` is empty. Treat as not-yet-started.

The empty `NoBreak/` and `NoBreak-frontendSara/` directories are placeholders.

## Port map

| Port | Service                          | Source                |
|------|----------------------------------|-----------------------|
| 3001 | Node mock API (albums/artists)   | `server.js`           |
| 8080 | Java HTTP API (track list)       | `NoBreakCore.java`    |

Both set permissive CORS. The static frontend (`Frontend/javascript.js`) calls 8080; the React frontend (`components/albumDisplay.js`) calls 3001. They are independent.

## Running things

There are no `scripts` defined in `package.json` and no build tooling. Run components directly:

- **Node mock API:** `node server.js` (from repo root). Requires `npm install` first if `node_modules/` is missing the listed deps (`express`, `cors`, `multer`).
- **Static frontend:** open `Frontend/menu.html` in a browser, or serve `Frontend/` with any static server. No build step.
- **Java desktop player:** compile and run `com.nobreak.core.NoBreakCore`. Needs the SQLite JDBC driver on the classpath (not vendored — `NoBreak_Project/` has no `lib/` or build file). `bin/com/nobreak/` exists as the compile output target.
- **React components:** there is currently no way to run them — no bundler, no entry HTML, no `react`/`react-dom` in `package.json`. Adding a Vite or CRA setup is a prerequisite to executing them.

There are no tests, no linter config, and no CI in this repo.

## Things that look broken but are intentional / known WIP

- `index.js` is empty (0 bytes). Don't "fix" it without context.
- The frontend's registration POST to `:8080/api/registro` will fail — that route is not in `NoBreakCore.java`. The `.catch` in `javascript.js` logs and continues; web-side registration still succeeds via `localStorage`.
- `BottomPlayer.js` controls are static (no state, no `onClick`), and `App.js` renders `MainDisplay` which doesn't exist as a file — `albumDisplay.js` (note lowercase `a`) is the closest match. Imports will break until `MainDisplay` is added or the import is changed to `AlbumDisplay`.
- `reproductor.html` literally says "WORK IN PROGRESS" — the web player UI is a placeholder.
