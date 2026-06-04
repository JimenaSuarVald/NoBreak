-- Schema D1 del Worker `nobreak-cloud` (multi-host).
--
-- El Worker es un proxy que enruta tráfico de la web a múltiples PCs
-- (cada uno con su `host_id` único). Las cuentas viven en cada `.exe`,
-- el Worker solo guarda el directorio routing username → host.
--
-- Aplicar con: wrangler d1 execute nobreak-db --remote --file=schema.sql
-- Idempotente (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS hosts (
    host_id       TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    tunnel_url    TEXT,
    tunnel_secret TEXT,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER
);

-- Directorio username → host. Se reconcilia desde el heartbeat del .exe
-- (cada .exe manda en su POST /_w/heartbeat la lista de cuentas que tiene
-- en su SQLite local). También /auth/register y /auth/login lo upsertan
-- en caliente cuando el flujo pasa por el Worker. El Worker lo lee en
-- /auth/login para enrutar al .exe correspondiente.
CREATE TABLE IF NOT EXISTS user_routes (
    username      TEXT PRIMARY KEY,
    host_id       TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (host_id) REFERENCES hosts(host_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_user_routes_host ON user_routes(host_id);
