-- Schema inicial de la D1 central. Aplicar con:
--   wrangler d1 execute nobreak-db --remote --file=schema.sql
--
-- Es idempotente (CREATE TABLE IF NOT EXISTS) — se puede re-ejecutar.

CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT UNIQUE NOT NULL,
    email       TEXT UNIQUE,
    -- PBKDF2-SHA256 derivado vía Web Crypto. salt + iter + hash hex.
    pass_hash   TEXT NOT NULL,
    salt        TEXT NOT NULL,
    iter_count  INTEGER NOT NULL,
    created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
    -- SHA-256 hex del token bearer real. El token plano sólo vive en
    -- memoria del cliente; nunca se guarda en la BD por seguridad.
    token_hash  TEXT PRIMARY KEY,
    user_id     INTEGER NOT NULL,
    created_at  INTEGER NOT NULL,
    expires_at  INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- Pairing entre la cuenta cloud y el NoBreak.exe local del usuario.
-- Flujo (fase 2 más adelante):
--   1. Web logueada llama POST /api/pair → genera código de 6 dígitos.
--   2. Usuario abre su NoBreak.exe y mete ese código.
--   3. El .exe llama POST /api/pair/claim con el código + un device_id propio.
--   4. Cloud devuelve un token de máquina largo, único, no caduca.
--   5. El .exe usa ese token para abrir su WebSocket al relay (fase 3).
CREATE TABLE IF NOT EXISTS pairing_codes (
    code         TEXT PRIMARY KEY,
    user_id      INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    expires_at   INTEGER NOT NULL,
    claimed_at   INTEGER,
    device_id    TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS devices (
    -- device_id lo genera el .exe la primera vez (UUID v4) y lo guarda
    -- localmente. Sirve para identificar la máquina concreta del usuario
    -- cuando se conecta al relay.
    device_id      TEXT PRIMARY KEY,
    user_id        INTEGER NOT NULL,
    -- machine_token_hash igual que sessions: sha256 hex del token plano.
    machine_token_hash TEXT NOT NULL,
    label          TEXT,
    created_at     INTEGER NOT NULL,
    last_seen_at   INTEGER,
    -- URL pública del .exe (cloudflared u otro tunnel). El .exe la publica
    -- vía POST /api/devices/heartbeat. El Worker la usa (hito C.2) para
    -- proxear peticiones de usuarios cloud al .exe correcto. Para DBs ya
    -- creadas la columna se añade vía migrations/001_add_tunnel_url.sql.
    tunnel_url     TEXT,
    -- Secreto compartido .exe↔Worker para autenticar requests proxeadas.
    -- El .exe lo genera localmente y lo manda en heartbeat; el Worker lo
    -- reenvía en header X-NoBreak-Tunnel-Secret al proxear. En plano (no
    -- hashed) porque el Worker tiene que poder reenviarlo. Para DBs ya
    -- creadas se añade vía migrations/002_add_tunnel_secret.sql.
    tunnel_secret  TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_devices_user ON devices(user_id);
