-- Migración 001 — añade tunnel_url a devices (hito C.1).
--
-- El .exe envía heartbeats cada 60s con su URL pública (cloudflared u otra).
-- El Worker la guarda aquí para que, en el hito C.2, sepa adónde reenviar
-- peticiones de usuarios cloud.
--
-- SQLite no soporta IF NOT EXISTS en ADD COLUMN, así que esta migración
-- falla en re-ejecución con "duplicate column name". Sólo se aplica una vez.
-- Para verificarlo antes:
--   wrangler d1 execute nobreak-db --remote --command "PRAGMA table_info(devices)"
-- Si la salida ya incluye tunnel_url, no la apliques.

ALTER TABLE devices ADD COLUMN tunnel_url TEXT;
