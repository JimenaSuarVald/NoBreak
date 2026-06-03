-- Migración 003 — rediseño post-fase-4: el Worker es solo proxy.
--
-- Borramos las tablas de cuentas cloud que ya no usamos (los usuarios son
-- los del SQLite del .exe, no del D1) y recreamos `devices` con esquema
-- mínimo (sin FK a users, sin NOT NULL en user_id, sin machine_token).
-- Una sola fila device_id='primary' guarda la tunnel_url + tunnel_secret
-- publicada por el heartbeat del .exe.
--
-- DESTRUCTIVA: borra las 3 cuentas cloud, 3 sesiones, códigos de pairing.
-- Eran solo de pruebas, ningún dato real.

DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS pairing_codes;
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS devices;

CREATE TABLE devices (
    device_id     TEXT PRIMARY KEY,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER,
    tunnel_url    TEXT,
    tunnel_secret TEXT
);
