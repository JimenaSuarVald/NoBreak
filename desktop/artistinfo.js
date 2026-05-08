// Fetch artist descriptions from Last.fm (preferred, when an API key is
// configured) or Wikipedia (always available). Results are cached in the
// `artist_info` table for 30 days so a popular artist's bio is hit once.
//
// API key sources, in order:
//   1. app_settings.lastfm_api_key (via the in-app settings UI later)
//   2. NOBREAK_LASTFM_KEY env var (handy for local development)
// If neither is set, the module falls back to Wikipedia silently.

const db = require('./db');

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function normalize(name) {
    return (name || '').trim().toLowerCase();
}

function lastFmKey() {
    const fromSettings = db.getSetting('lastfm_api_key');
    if (fromSettings && fromSettings.trim()) return fromSettings.trim();
    if (process.env.NOBREAK_LASTFM_KEY) return process.env.NOBREAK_LASTFM_KEY.trim();
    return null;
}

/**
 * Looks up the artist info, using cache when fresh, otherwise calling the
 * upstream source. On upstream failure, returns the stale cached entry
 * (if any) rather than nothing — better to show old info than empty.
 */
async function getArtistInfo(name) {
    const norm = normalize(name);
    if (!norm) return null;

    const cached = readCache(norm);
    const fresh = cached && (Date.now() - cached.fetched_at) < CACHE_TTL_MS;
    if (fresh) return shape(cached, name);

    let info = null;
    const key = lastFmKey();
    if (key) {
        try { info = await fetchLastFm(name, key); }
        catch (e) { console.warn('[artistinfo] last.fm failed:', e.message); }
    }
    if (!info) {
        try { info = await fetchWikipedia(name); }
        catch (e) { console.warn('[artistinfo] wikipedia failed:', e.message); }
    }

    if (info) {
        writeCache(norm, info);
        return shape({ ...info, artist_norm: norm }, name);
    }
    // Upstream broke; serve stale if we have it.
    if (cached) return shape(cached, name);
    return null;
}

// --- Wikipedia -------------------------------------------------------------

async function fetchWikipedia(name) {
    // Resolve the canonical page title via opensearch (handles redirects /
    // disambiguation roughly: the first hit is usually the right one).
    const searchUrl = 'https://en.wikipedia.org/w/api.php?'
        + new URLSearchParams({
            action: 'opensearch',
            search: name,
            limit: '1',
            namespace: '0',
            format: 'json',
        }).toString();
    const sRes = await fetch(searchUrl, { headers: { 'User-Agent': 'NoBreak/0.1 (local)' } });
    if (!sRes.ok) throw new Error('wikipedia search ' + sRes.status);
    const sJson = await sRes.json();
    const title = sJson?.[1]?.[0];
    if (!title) return null;

    const sumRes = await fetch(
        'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title),
        { headers: { 'User-Agent': 'NoBreak/0.1 (local)' } }
    );
    if (!sumRes.ok) return null;
    const data = await sumRes.json();
    return {
        source:    'wikipedia',
        name:      data.title || title,
        extract:   data.extract || null,
        thumbnail: data.thumbnail?.source || null,
        url:       data.content_urls?.desktop?.page
                || ('https://en.wikipedia.org/wiki/' + encodeURIComponent(title)),
        raw_json:  JSON.stringify(data),
    };
}

// --- Last.fm ---------------------------------------------------------------

async function fetchLastFm(name, apiKey) {
    const url = 'https://ws.audioscrobbler.com/2.0/?'
        + new URLSearchParams({
            method: 'artist.getinfo',
            artist: name,
            api_key: apiKey,
            format: 'json',
            autocorrect: '1',
        }).toString();
    const r = await fetch(url, { headers: { 'User-Agent': 'NoBreak/0.1 (local)' } });
    if (!r.ok) throw new Error('last.fm ' + r.status);
    const data = await r.json();
    if (!data.artist) return null;
    const a = data.artist;
    // Last.fm wraps bio text in "Read more on Last.fm" trailer; strip the trailing link.
    let extract = (a.bio?.summary || '').replace(/<a href.*$/s, '').trim();
    if (!extract) extract = (a.bio?.content || '').replace(/<a href.*$/s, '').trim();
    return {
        source:    'lastfm',
        name:      a.name || name,
        extract:   extract || null,
        thumbnail: pickImage(a.image),
        url:       a.url || null,
        raw_json:  JSON.stringify(a),
    };
}

function pickImage(images) {
    // Last.fm "image" is an array of {#text, size}; prefer "extralarge" or "large".
    if (!Array.isArray(images)) return null;
    const wanted = ['extralarge', 'large', 'medium'];
    for (const w of wanted) {
        const match = images.find(i => i.size === w && i['#text']);
        if (match) return match['#text'];
    }
    const any = images.find(i => i['#text']);
    return any ? any['#text'] : null;
}

// --- Cache -----------------------------------------------------------------

function readCache(norm) {
    return db.get().prepare(
        `SELECT artist_norm, source, name, extract, thumbnail, url, raw_json, fetched_at
         FROM artist_info WHERE artist_norm = ?`
    ).get(norm);
}

function writeCache(norm, info) {
    db.get().prepare(`
        INSERT INTO artist_info (artist_norm, source, name, extract, thumbnail, url, raw_json, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(artist_norm) DO UPDATE SET
            source     = excluded.source,
            name       = excluded.name,
            extract    = excluded.extract,
            thumbnail  = excluded.thumbnail,
            url        = excluded.url,
            raw_json   = excluded.raw_json,
            fetched_at = excluded.fetched_at
    `).run(norm, info.source, info.name, info.extract, info.thumbnail, info.url, info.raw_json, Date.now());
}

// --- Shape for the API -----------------------------------------------------

function shape(row, queriedName) {
    if (!row) return null;
    return {
        source:    row.source,
        name:      row.name || queriedName,
        extract:   row.extract,
        thumbnail: row.thumbnail,
        url:       row.url,
        // External-source links the UI can render, regardless of which source
        // we actually pulled the description from.
        links: {
            wikipedia: row.source === 'wikipedia'
                ? row.url
                : 'https://en.wikipedia.org/wiki/Special:Search?search=' + encodeURIComponent(queriedName),
            lastfm: row.source === 'lastfm'
                ? row.url
                : 'https://www.last.fm/music/' + encodeURIComponent(queriedName.replace(/ /g, '+')),
            // Rate Your Music has no public API; we link to their search page.
            rym: 'https://rateyourmusic.com/search?searchterm=' + encodeURIComponent(queriedName) + '&searchtype=a',
        },
        cachedAt: row.fetched_at,
    };
}

module.exports = { getArtistInfo };
