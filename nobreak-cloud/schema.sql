-- Schema D1 del Worker `nobreak-cloud` (post-rediseño fase 4).
--
-- El Worker es un proxy transparente, NO un servicio de cuentas. Por eso
-- el schema es mínimo: una tabla `devices` con una sola fila ('primary')
-- que guarda la tunnel_url + tunnel_secret publicada por el heartbeat
-- del .exe. No hay usuarios, sesiones ni pairing — las cuentas viven en
-- el SQLite del .exe y se acceden vía proxy.
--
-- Aplicar con: wrangler d1 execute nobreak-db --remote --file=schema.sql
-- Idempotente (CREATE TABLE IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS devices (
    device_id     TEXT PRIMARY KEY,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER,
    -- URL pública del .exe (cloudflared, ngrok, etc). El Worker la lee
    -- cada vez que tiene que proxear una request.
    tunnel_url    TEXT,
    -- Secreto compartido .exe↔Worker para autenticar requests proxeadas.
    -- El .exe lo genera localmente, lo manda en heartbeat; el Worker lo
    -- reenvía como header X-NoBreak-Tunnel-Secret en cada proxy.
    tunnel_secret TEXT
);
