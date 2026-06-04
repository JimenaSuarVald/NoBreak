-- Migración 004 — multi-PC. Cada NoBreak.exe se registra como un host
-- independiente con su propio host_id. El directorio `user_routes` mapea
-- cada username al host que sirve su cuenta. El binding cuenta↔servidor es
-- automático: el .exe manda en su heartbeat la lista de usernames de su
-- SQLite local y el Worker upserts user_routes desde ahí (no hay picker
-- en el formulario de registro).
--
-- DESTRUCTIVA: borra la tabla `devices` (que tenía solo la fila 'primary').
-- La tunnel_url + tunnel_secret se vuelven a publicar al primer heartbeat
-- del .exe actualizado, así que no se pierde nada irrecuperable.

DROP TABLE IF EXISTS devices;

CREATE TABLE hosts (
    host_id       TEXT PRIMARY KEY,
    label         TEXT NOT NULL,
    tunnel_url    TEXT,
    tunnel_secret TEXT,
    created_at    INTEGER NOT NULL,
    last_seen_at  INTEGER
);

CREATE TABLE user_routes (
    username      TEXT PRIMARY KEY,
    host_id       TEXT NOT NULL,
    created_at    INTEGER NOT NULL,
    FOREIGN KEY (host_id) REFERENCES hosts(host_id) ON DELETE CASCADE
);
CREATE INDEX idx_user_routes_host ON user_routes(host_id);
