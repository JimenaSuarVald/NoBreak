-- Migración 002 — añade tunnel_secret a devices (hito C.2).
--
-- El .exe genera un secreto aleatorio la primera vez que arranca el relay y
-- lo envía al Worker en cada heartbeat. El Worker lo guarda y se lo reenvía
-- al .exe (header X-NoBreak-Tunnel-Secret) en cada petición proxeada, para
-- que el .exe sepa que el request viene del Worker y no de alguien que ha
-- scrapeado la tunnel_url pública.
--
-- Se guarda en plano (no hash): el Worker tiene que poder enviarlo. Esto no
-- es peor que machine_token_hash en términos de superficie — si alguien lee
-- la D1 ya tiene acceso a la cuenta de todos modos.
--
-- Idempotencia: SQLite no soporta IF NOT EXISTS en ADD COLUMN. Verifica
-- antes con:
--   wrangler d1 execute nobreak-db --remote --command "PRAGMA table_info(devices)"

ALTER TABLE devices ADD COLUMN tunnel_secret TEXT;
