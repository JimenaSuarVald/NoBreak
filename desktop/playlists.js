// Playlist CRUD + track membership. Mounted as /api/playlists/* by webserver.js.
// All routes require an authenticated session (the global guard handles that).

const db = require('./db');

function listPlaylists() {
    return db.get().prepare(`
        SELECT p.id, p.name, p.created_at, p.updated_at,
               COUNT(pt.track_id) AS trackCount
        FROM playlists p
        LEFT JOIN playlist_tracks pt ON pt.playlist_id = p.id
        GROUP BY p.id
        ORDER BY p.updated_at DESC
    `).all();
}

function getPlaylist(id) {
    const pl = db.get().prepare(`
        SELECT id, name, created_at, updated_at FROM playlists WHERE id = ?
    `).get(id);
    if (!pl) return null;
    const tracks = db.get().prepare(`
        SELECT t.id, t.titulo, t.artista, t.album, t.year, t.track_no, t.disc_no,
               t.duration_ms, t.cover_path, pt.position
        FROM playlist_tracks pt
        JOIN tracks t ON t.id = pt.track_id
        WHERE pt.playlist_id = ?
        ORDER BY pt.position
    `).all(id);
    return {
        ...pl,
        trackCount: tracks.length,
        tracks: tracks.map(t => ({
            id: t.id,
            titulo: t.titulo,
            artista: t.artista,
            album: t.album,
            year: t.year,
            trackNo: t.track_no,
            discNo: t.disc_no,
            durationMs: t.duration_ms,
            position: t.position,
            coverUrl: t.cover_path ? `/cover/${t.id}` : null,
        })),
    };
}

function createPlaylist(name) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw new ValidationError('El nombre no puede estar vacío');
    const now = Date.now();
    const info = db.get().prepare(`
        INSERT INTO playlists (name, created_at, updated_at) VALUES (?, ?, ?)
    `).run(trimmed, now, now);
    return getPlaylist(info.lastInsertRowid);
}

function renamePlaylist(id, name) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw new ValidationError('El nombre no puede estar vacío');
    const r = db.get().prepare(`
        UPDATE playlists SET name = ?, updated_at = ? WHERE id = ?
    `).run(trimmed, Date.now(), id);
    if (r.changes === 0) return null;
    return getPlaylist(id);
}

function deletePlaylist(id) {
    // playlist_tracks rows go away via FK ON DELETE CASCADE.
    const r = db.get().prepare(`DELETE FROM playlists WHERE id = ?`).run(id);
    return r.changes > 0;
}

function addTrack(playlistId, trackId, position) {
    // Validate refs exist before INSERT — the FK would catch it but with a less helpful message.
    const pl = db.get().prepare(`SELECT id FROM playlists WHERE id = ?`).get(playlistId);
    if (!pl) throw new NotFoundError('Playlist no encontrada');
    const tr = db.get().prepare(`SELECT id FROM tracks WHERE id = ?`).get(trackId);
    if (!tr) throw new NotFoundError('Track no encontrado');

    // Default position = end of list.
    if (position == null) {
        const max = db.get().prepare(
            `SELECT MAX(position) AS m FROM playlist_tracks WHERE playlist_id = ?`
        ).get(playlistId).m;
        position = (max == null ? 0 : max + 1);
    }
    const now = Date.now();
    try {
        db.get().prepare(`
            INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
            VALUES (?, ?, ?, ?)
        `).run(playlistId, trackId, position, now);
    } catch (e) {
        // PK collision = the track is already in this playlist; treat as success.
        if (!/UNIQUE constraint/i.test(e.message)) throw e;
    }
    db.get().prepare(`UPDATE playlists SET updated_at = ? WHERE id = ?`).run(now, playlistId);
    return getPlaylist(playlistId);
}

function removeTrack(playlistId, trackId) {
    const r = db.get().prepare(`
        DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?
    `).run(playlistId, trackId);
    if (r.changes > 0) {
        db.get().prepare(`UPDATE playlists SET updated_at = ? WHERE id = ?`)
            .run(Date.now(), playlistId);
    }
    return r.changes > 0;
}

function reorder(playlistId, orderedTrackIds) {
    if (!Array.isArray(orderedTrackIds)) {
        throw new ValidationError('Se esperaba un array de track ids');
    }
    const upd = db.get().prepare(`
        UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?
    `);
    const txn = db.get().transaction((ids) => {
        ids.forEach((trackId, i) => upd.run(i, playlistId, trackId));
    });
    txn(orderedTrackIds);
    db.get().prepare(`UPDATE playlists SET updated_at = ? WHERE id = ?`)
        .run(Date.now(), playlistId);
    return getPlaylist(playlistId);
}

class ValidationError extends Error {}
class NotFoundError extends Error {}

module.exports = {
    listPlaylists, getPlaylist,
    createPlaylist, renamePlaylist, deletePlaylist,
    addTrack, removeTrack, reorder,
    ValidationError, NotFoundError,
};
