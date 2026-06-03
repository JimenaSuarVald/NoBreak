// Fetch artist descriptions from Last.fm (preferred, when an API key is
// configured) or Wikipedia (always available). Results are cached in the
// `artist_info` table for 30 days so a popular artist's bio is hit once.
//
// API key sources, in order:
//   1. app_settings.lastfm_api_key (via the in-app settings UI later)
//   2. NOBREAK_LASTFM_KEY env var (handy for local development)
// If neither is set, the module falls back to Wikipedia silently.

const db = require('./db');
const musicbrainz = require('./musicbrainz');

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
// Set en memoria para evitar reintentar el "sin imagen" en cada navegación
// dentro de la misma sesión. La cache en disco sigue marcando freshness,
// pero si lo que tiene no es útil (sin foto) reintentamos UNA vez por
// sesión por artista.
const _refetchedThisSession = new Set();

async function getArtistInfo(name, opts = {}) {
    const norm = normalize(name);
    if (!norm) return null;

    const cached = readCache(norm);
    const fresh  = cached && (Date.now() - cached.fetched_at) < CACHE_TTL_MS;

    // Si llega un MBID explícito (el usuario eligió uno en el picker de
    // desambiguación) saltamos cache y resolvemos por MBID — cualquier
    // entrada cacheada antigua se pisa con la resolución elegida.
    if (opts.mbid) {
        return await resolveByMbid(name, norm, opts.mbid);
    }

    // Si la cache es fresca Y tiene imagen, devolvemos directo.
    if (fresh && hasUsableImage(cached)) return shape(cached, name);
    // Si la cache es fresca pero SIN imagen, intentamos enriquecer una vez
    // por sesión; tras eso ya servimos lo cacheado para no martillear las APIs.
    if (fresh && _refetchedThisSession.has(norm)) return shape(cached, name);
    if (fresh) _refetchedThisSession.add(norm);

    // Resolución contextual: si el cliente pide desambiguación y no hay
    // cache, pedimos a MusicBrainz los candidatos con ese nombre EXACTO y
    // elegimos UNO usando el contexto local (géneros de ID3 + tags MB de
    // los álbumes que el usuario tiene). El backend NUNCA devuelve varios
    // resultados — la UI siempre recibe una sola descripción.
    if (opts.disambiguate && !cached) {
        try {
            const candidates = await musicbrainz.searchArtistCandidates(name);
            if (candidates.length >= 1) {
                const localTags = localTagsForArtist(name);
                const chosen = pickContextualCandidate(candidates, localTags);
                if (chosen?.mbid) {
                    return await resolveByMbid(name, norm, chosen.mbid);
                }
            }
        } catch (e) {
            console.warn('[artistinfo] contextual disambiguation failed:', e.message);
            // No bloqueamos el flujo si MB falla — seguimos a Last.fm/Wikipedia.
        }
    }

    // Recogemos de Last.fm (bio + posible imagen). Si Last.fm no da imagen
    // útil, vamos a Wikipedia A POR LA IMAGEN — antes nos saltábamos esta
    // segunda fuente cuando Last.fm devolvía bio sin foto, dejando huecos.
    let lastFmData = null, wikiData = null;
    const key = lastFmKey();
    if (key) {
        try { lastFmData = await fetchLastFm(name, key); }
        catch (e) { console.warn('[artistinfo] last.fm failed:', e.message); }
    }
    const needImage = !lastFmData || !lastFmData.thumbnail && !lastFmData.image_large;
    if (needImage) {
        try { wikiData = await fetchWikipedia(name); }
        catch (e) { console.warn('[artistinfo] wikipedia failed:', e.message); }
    }

    let merged = mergeArtistSources([lastFmData, wikiData], norm, name);

    // Fallbacks de IMAGEN (no de bio) cuando Last.fm + Wikipedia summary no
    // dejaron foto. Orden: Wikidata (P18) → Fanart.tv → Wikipedia pageimages.
    // Cada paso es no-op si el anterior ya rellenó la imagen.
    if (!merged || !hasUsableImage(merged)) {
        const fallback = await fetchImageFallbacks(name, norm, merged?.url || null);
        if (fallback) {
            if (!merged) {
                merged = mergeArtistSources([fallback], norm, name);
            } else {
                if (!merged.thumbnail   && fallback.thumbnail)   merged.thumbnail   = fallback.thumbnail;
                if (!merged.image_large && fallback.image_large) merged.image_large = fallback.image_large;
            }
        }
    }

    if (merged) {
        writeCache(norm, merged);
        return shape({ ...merged, artist_norm: norm }, name);
    }
    // Si todas las fuentes fallaron y había cache rancia, sírvela.
    if (cached) return shape(cached, name);
    return null;
}

// Camino de resolución cuando el usuario ya ha elegido un artista concreto
// en el picker. Usamos el MBID para sacar el Wikipedia oficial de MB
// (url-rels), pedir su summary directamente sin pasar por opensearch, y
// rellenar imagen vía Wikidata. Last.fm también recibe el nombre canónico
// de MB, no el que tecleó el usuario.
async function resolveByMbid(originalName, norm, mbid) {
    let mbDetail = null;
    try { mbDetail = await musicbrainz.getArtistDetailByMbid(mbid); }
    catch (e) { console.warn('[artistinfo] mb detail by mbid failed:', e.message); }
    const canonicalName = mbDetail?.name || originalName;

    let rels = [];
    try { rels = await musicbrainz.getArtistUrlRels(mbid); }
    catch (e) { console.warn('[artistinfo] mb url-rels failed:', e.message); }
    const wikipediaUrl = musicbrainz.pickRelUrl(rels, 'wikipedia');

    // Bio + imagen desde la página exacta de Wikipedia que enlaza MB.
    let wikiData = null;
    if (wikipediaUrl) {
        const title = wikipediaTitleFromUrl(wikipediaUrl);
        if (title) {
            try {
                const summary = await wikipediaSummary(title);
                if (summary && !looksLikeDisambiguation(summary)) {
                    wikiData = shapeWikipediaResult(summary, title);
                }
            } catch (e) { console.warn('[artistinfo] wikipedia summary by mbid failed:', e.message); }
        }
    } else {
        // Sin Wikipedia en MB: probamos la búsqueda normal con el nombre canónico.
        try { wikiData = await fetchWikipedia(canonicalName); }
        catch (e) { console.warn('[artistinfo] wikipedia fallback by name failed:', e.message); }
    }

    // Last.fm con el nombre canónico (el que aparezca en MB).
    let lastFmData = null;
    const key = lastFmKey();
    if (key) {
        try { lastFmData = await fetchLastFm(canonicalName, key); }
        catch (e) { console.warn('[artistinfo] last.fm by mbid failed:', e.message); }
    }

    let merged = mergeArtistSources([lastFmData, wikiData], norm, canonicalName);

    // Fallbacks de imagen: Wikidata (vía mbid), luego Fanart.tv, luego pageimages.
    if (!merged || !hasUsableImage(merged)) {
        // Como ya tenemos el MBID elegido, llamamos a los fallbacks pasándolo.
        const fallback = await fetchImageFallbacksByMbid(canonicalName, mbid, merged?.url || wikipediaUrl);
        if (fallback) {
            if (!merged) {
                merged = mergeArtistSources([fallback], norm, canonicalName);
            } else {
                if (!merged.thumbnail   && fallback.thumbnail)   merged.thumbnail   = fallback.thumbnail;
                if (!merged.image_large && fallback.image_large) merged.image_large = fallback.image_large;
            }
        }
    }

    if (merged) {
        // Pisa la cache con la resolución elegida — futuras visitas servirán
        // este artista directamente sin re-disparar el picker.
        writeCache(norm, merged);
        return shape({ ...merged, artist_norm: norm }, originalName);
    }
    return null;
}

// Delegación: la cascada actual (Wikipedia → TheAudioDB) no necesita el
// MBID, pero conservamos la firma porque resolveByMbid pasa el wikipediaUrl
// que sacó de url-rels y eso ahorra una búsqueda extra en Wikipedia.
async function fetchImageFallbacksByMbid(name, mbid, existingWikiUrl) {
    return fetchImageFallbacks(name, null, existingWikiUrl);
}

function wikipediaTitleFromUrl(url) {
    const m = /wikipedia\.org\/wiki\/([^?#]+)/i.exec(url || '');
    if (!m) return null;
    try { return decodeURIComponent(m[1]); }
    catch { return m[1]; }
}

// Junta los tags/géneros que ya tenemos localmente para un artista:
//   1) tracks.genre (lo que el usuario tenga puesto en sus ID3)
//   2) mb_album_cache.tags_json (etiquetas votadas de los álbumes que tiene)
// Devuelve la lista de tags en minúsculas, sin duplicados.
function localTagsForArtist(name) {
    const norm = (name || '').toLowerCase().trim();
    if (!norm) return [];
    const tags = new Set();

    let trackRows = [];
    try {
        trackRows = db.get().prepare(
            `SELECT DISTINCT genre, album, COALESCE(albumartist, artista) AS aa
             FROM tracks
             WHERE LOWER(COALESCE(artista, '')) = ? OR LOWER(COALESCE(albumartist, '')) = ?`
        ).all(norm, norm);
    } catch { /* DB no disponible o tabla vacía */ }

    for (const r of trackRows) {
        const parts = String(r.genre || '')
            .split(/[,;/&]/).map(s => s.trim().toLowerCase()).filter(Boolean);
        for (const p of parts) tags.add(p);
    }
    for (const r of trackRows) {
        if (!r.album) continue;
        let cache = null;
        try { cache = db.getMbAlbumCache(r.album, r.aa); } catch {}
        if (!cache?.tags_json) continue;
        try {
            const list = JSON.parse(cache.tags_json) || [];
            for (const t of list) {
                if (t?.name) tags.add(String(t.name).toLowerCase());
            }
        } catch { /* JSON malformado */ }
    }
    return Array.from(tags);
}

// Elige el candidato de MB cuya "disambiguation" tenga más solapamiento con
// los tags locales del usuario. Sin contexto → primer candidato (el de mejor
// score MB). Con empate → también gana el primero.
function pickContextualCandidate(candidates, localTags) {
    if (!candidates || !candidates.length) return null;
    if (candidates.length === 1) return candidates[0];
    if (!localTags || !localTags.length) return candidates[0];

    let best = candidates[0];
    let bestScore = 0;
    for (const c of candidates) {
        const disamb = String(c.disambiguation || '').toLowerCase();
        if (!disamb) continue;
        let score = 0;
        for (const t of localTags) {
            if (!t) continue;
            const safe = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // \b en español tolera bien "rock", "metal", "country" — palabras
            // ASCII. Para tags con caracteres latinos extendidos perdemos
            // precisión, pero el caso clásico (anglosajón) queda cubierto.
            if (new RegExp('\\b' + safe + '\\b', 'i').test(disamb)) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            best = c;
        }
    }
    return best;
}

function hasUsableImage(row) {
    if (!row) return false;
    const t = isPlaceholderImage(row.thumbnail)   ? null : row.thumbnail;
    const b = isPlaceholderImage(row.image_large) ? null : row.image_large;
    return !!(t || b);
}

// Combina varias fuentes en una sola fila para la cache. La primera fuente
// con datos manda en "source"/"name"/"url"; bio e imágenes se rellenan
// independientemente con el primer valor presente, así Last.fm puede dar
// la bio y Wikipedia la imagen sin pisarse.
function mergeArtistSources(list, norm, queriedName) {
    const merged = {
        artist_norm: norm,
        source: null,
        name: queriedName,
        extract: null,
        thumbnail: null,
        image_large: null,
        url: null,
        raw_json: null,
    };
    for (const d of list) {
        if (!d) continue;
        if (!merged.source) {
            merged.source = d.source;
            merged.name = d.name || merged.name;
            merged.url  = d.url  || merged.url;
            merged.raw_json = d.raw_json || merged.raw_json;
        }
        if (!merged.extract     && d.extract)     merged.extract     = d.extract;
        if (!merged.thumbnail   && d.thumbnail)   merged.thumbnail   = d.thumbnail;
        if (!merged.image_large && d.image_large) merged.image_large = d.image_large;
    }
    return merged.source ? merged : null;
}

// --- Wikipedia -------------------------------------------------------------

async function fetchWikipedia(name) {
    // Probamos primero con sufijos de desambiguación musical para evitar
    // que "Sunn" caiga en Sunn Microsystems o "Earth" en el planeta. Si
    // ninguna desambiguación da resultado con resumen útil, caemos al
    // nombre pelado.
    const candidates = [
        name + ' (band)',
        name + ' (musician)',
        name + ' (singer)',
        name,
    ];
    let lastSummary = null;
    for (const q of candidates) {
        const title = await wikipediaSearchTitle(q);
        if (!title) continue;
        const summary = await wikipediaSummary(title);
        if (!summary) continue;
        // Si el resumen sugiere desambiguación pura, ignóralo y sigue probando.
        if (looksLikeDisambiguation(summary)) { lastSummary = summary; continue; }
        return shapeWikipediaResult(summary, title);
    }
    if (lastSummary) return shapeWikipediaResult(lastSummary, lastSummary.title || name);
    return null;
}

async function wikipediaSearchTitle(query) {
    const url = 'https://en.wikipedia.org/w/api.php?'
        + new URLSearchParams({
            action: 'opensearch',
            search: query,
            limit: '1',
            namespace: '0',
            format: 'json',
        }).toString();
    const r = await fetch(url, { headers: { 'User-Agent': 'NoBreak/0.1 (local)' } });
    if (!r.ok) throw new Error('wikipedia search ' + r.status);
    const j = await r.json();
    return j?.[1]?.[0] || null;
}

async function wikipediaSummary(title) {
    const r = await fetch(
        'https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title),
        { headers: { 'User-Agent': 'NoBreak/0.1 (local)' } }
    );
    if (!r.ok) return null;
    return r.json();
}

function looksLikeDisambiguation(data) {
    if (!data) return true;
    if (data.type === 'disambiguation') return true;
    const ext = (data.extract || '').toLowerCase();
    if (!ext) return true;
    return /may refer to:?$/.test(ext.trim());
}

function shapeWikipediaResult(data, title) {
    return {
        source:     'wikipedia',
        name:       data.title || title,
        extract:    data.extract || null,
        thumbnail:  data.thumbnail?.source || null,
        image_large: data.originalimage?.source || data.thumbnail?.source || null,
        url:        data.content_urls?.desktop?.page
                 || ('https://en.wikipedia.org/wiki/' + encodeURIComponent(title)),
        raw_json:   JSON.stringify(data),
    };
}

// --- Last.fm ---------------------------------------------------------------
// Last.fm SÓLO se usa como fuente de biografía. NO se aceptan sus imágenes
// porque su placeholder por defecto (la estrella gris) tiene varias variantes
// y se cuelan como falsa foto del artista. Las imágenes salen de Wikipedia
// pageimages → TheAudioDB → iniciales.

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
    // Last.fm tiene dos campos: bio.summary (recortado, suele cortar la lista
    // de desambiguación a la mitad) y bio.content (texto completo). Para
    // que el sanitizador pueda agrupar las entradas cortas del índice con
    // los párrafos largos de cada artista, necesitamos el content entero —
    // si no, nos quedamos con la entrada corta y el párrafo largo se pierde.
    // En ambos casos el trailer "Read more on Last.fm" se quita por regex.
    let extract = (a.bio?.content || '').replace(/<a href.*$/s, '').trim();
    if (!extract) extract = (a.bio?.summary || '').replace(/<a href.*$/s, '').trim();
    // Limpia el boilerplate de desambiguación de la comunidad de Last.fm
    // antes de cachear — así nuevas filas guardan ya texto sanitizado.
    extract = sanitizeLastFmBoilerplate(extract, a.name || name);
    return {
        source:      'lastfm',
        name:        a.name || name,
        extract:     extract || null,
        thumbnail:   null,
        image_large: null,
        url:         a.url || null,
        raw_json:    JSON.stringify(a),
    };
}

// Detecta y elimina el boilerplate de desambiguación que Last.fm a veces
// devuelve cuando varios artistas comparten nombre. La comunidad escribe
// bios del estilo:
//
//   "There are at least two different artists using the name Boris:
//
//    1. a Japanese experimental metal band            ← entrada corta
//    2. a Dutch pop/soul singer                       ← entrada corta
//
//    1. Boris is a Japanese band, formed in 1992...   ← bio completa
//    2. Boris (born 1979 as Boris Titulaer)...        ← bio completa"
//
// La función:
//   - detecta el patrón con regex sobre las frases típicas del header.
//   - captura TODAS las secciones numeradas con su número.
//   - agrupa por número y se queda con la versión MÁS LARGA de cada uno
//     (la bio completa vs la entrada corta del índice).
//   - elige el grupo cuyos términos coinciden con los tags locales del
//     usuario (vía localTagsForArtist).
//   - sin contexto → devuelve la del #1.
//   - sin lista parseable → null (UI muestra fallback genérico).
function sanitizeLastFmBoilerplate(extract, name) {
    if (!extract || typeof extract !== 'string') return extract;

    const headerRe1 = /\bthere are (?:at least )?(?:two|three|four|five|several|multiple|many|\d+)[^\n]{0,60}\bartists?\b/i;
    const headerRe2 = /\b(?:multiple|several|two|three|four|five) (?:different )?artists? (?:using|with|known by|sharing) (?:the |this )?name\b/i;
    if (!headerRe1.test(extract) && !headerRe2.test(extract)) return extract;

    // Captura todas las secciones numeradas. Para cada match: { num, text }
    // donde text se extiende hasta el siguiente marcador "<num> [.):]" al
    // inicio de línea o hasta el final del bloque. [\s\S]*? es no-greedy
    // para no devorar la siguiente entrada.
    const re = /(?:^|\n)[ \t]*(\d+)[ \t]*[.\):][ \t]*([\s\S]*?)(?=\n[ \t]*\d+[ \t]*[.\):]|$)/g;
    const sections = [];
    let m;
    while ((m = re.exec(extract)) !== null) {
        const num = Number(m[1]);
        const text = (m[2] || '').trim();
        if (text) sections.push({ num, text });
    }
    if (sections.length === 0) return null;

    // Para cada número, conserva sólo la versión más larga (descarta la
    // entrada corta del índice cuando hay también un párrafo desarrollado
    // del mismo número).
    const byNum = new Map();
    for (const s of sections) {
        const prev = byNum.get(s.num);
        if (!prev || s.text.length > prev.length) byNum.set(s.num, s.text);
    }
    const ordered = Array.from(byNum.entries())
        .sort((a, b) => a[0] - b[0])
        .map(e => e[1]);
    if (ordered.length === 0) return null;

    const localTags = localTagsForArtist(name);
    if (!localTags.length) return ordered[0];

    let best = ordered[0], bestScore = 0;
    for (const sec of ordered) {
        const lower = sec.toLowerCase();
        let score = 0;
        for (const t of localTags) {
            if (!t) continue;
            const safe = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp('\\b' + safe + '\\b', 'i').test(lower)) score++;
        }
        if (score > bestScore) {
            bestScore = score;
            best = sec;
        }
    }
    return best;
}

// Hash(es) de placeholder de Last.fm — la estrella gris y variantes. Se usa
// defensivamente sobre la cache: aunque fetchLastFm ya no aporta imágenes,
// puede haber filas viejas en artist_info con esas URLs cacheadas.
const LASTFM_PLACEHOLDER_HASHES = [
    '2a96cbd8b46e442fc41c2b86b821562f',
    'c6f59c1e5e7240a4c0d427abd71f3dbb',
    '4128a6eb29f94943c9d206c08e625904',
];
function isPlaceholderImage(url) {
    if (typeof url !== 'string') return false;
    return LASTFM_PLACEHOLDER_HASHES.some(h => url.includes(h));
}

// --- Fallbacks de imagen (Wikipedia pageimages → TheAudioDB) ---------------
//
// Cascada SIN API keys: 1) Wikipedia con varias variantes de título,
// 2) TheAudioDB con la clave pública "2", 3) en último término el renderer
// pinta iniciales sobre fondo de color (.av-photo-empty). Cada paso devuelve
// {thumbnail, image_large, ...} o null y se aborta en cuanto uno acierta.
async function fetchImageFallbacks(name, norm, existingWikiUrl) {
    try {
        const wp = await fetchWikipediaPageImage(name, existingWikiUrl);
        if (wp) return wp;
    } catch (e) { console.warn('[artistinfo] wikipedia pageimage fallback failed:', e.message); }

    try {
        const tadb = await fetchTheAudioDbImage(name);
        if (tadb) return tadb;
    } catch (e) { console.warn('[artistinfo] theaudiodb fallback failed:', e.message); }

    return null;
}

// Wikipedia pageimages: para cada variante del nombre se llama directamente
// a action=query&prop=pageimages — si el título no existe, MediaWiki responde
// con pages[*].missing y pasamos al siguiente. Se prueban en orden:
//   1) Título extraído de la URL de Wikipedia que ya tengamos (si hay)
//   2) Nombre tal cual
//   3) Sufijos de desambiguación musicales: (band), (musician), (singer)
//   4) Versión con guiones bajos (algunos títulos de Wikipedia los exigen)
async function fetchWikipediaPageImage(name, existingWikiUrl) {
    const variants = [];
    if (existingWikiUrl) {
        const m = /wikipedia\.org\/wiki\/([^?#]+)/i.exec(existingWikiUrl);
        if (m) {
            try { variants.push(decodeURIComponent(m[1]).replace(/_/g, ' ')); }
            catch { variants.push(m[1]); }
        }
    }
    const cleaned = String(name || '').trim();
    if (cleaned) {
        variants.push(cleaned);
        variants.push(cleaned + ' (band)');
        variants.push(cleaned + ' (musician)');
        variants.push(cleaned + ' (singer)');
    }
    // Dedup conservando orden.
    const seen = new Set();
    for (const v of variants) {
        const k = v.trim().toLowerCase();
        if (!k || seen.has(k)) continue;
        seen.add(k);
        const hit = await wikipediaPageImageForTitle(v);
        if (hit) return hit;
    }
    return null;
}

async function wikipediaPageImageForTitle(title) {
    const apiUrl = 'https://en.wikipedia.org/w/api.php?'
        + new URLSearchParams({
            action: 'query',
            titles: title,
            prop: 'pageimages',
            piprop: 'original|thumbnail',
            pithumbsize: '500',
            format: 'json',
            redirects: '1',
            origin: '*',
        }).toString();
    const r = await fetch(apiUrl, { headers: { 'User-Agent': 'NoBreak/0.1 (local)' } });
    if (!r.ok) return null;
    const j = await r.json();
    const pages = j?.query?.pages;
    if (!pages) return null;
    for (const pid of Object.keys(pages)) {
        const p = pages[pid];
        // Página inexistente — MediaWiki devuelve pageid -1 y "missing": "".
        if (p.missing !== undefined || Number(pid) < 0) continue;
        const original  = p.original?.source  || null;
        const thumbnail = p.thumbnail?.source || null;
        if (!original && !thumbnail) continue;
        const resolvedTitle = p.title || title;
        return {
            source:      'wikipedia-pageimage',
            name:        resolvedTitle,
            extract:     null,
            thumbnail:   thumbnail || original,
            image_large: original  || thumbnail,
            url:         'https://en.wikipedia.org/wiki/' + encodeURIComponent(resolvedTitle.replace(/ /g, '_')),
            raw_json:    null,
        };
    }
    return null;
}

// TheAudioDB: search.php?s=<nombre>. La clave "2" es la clave pública de
// pruebas que ellos mismos documentan para uso sin registro. La respuesta
// tiene la forma { artists: [{ strArtist, strArtistThumb, strArtistFanart,
// strArtistLogo, ... }] } o { artists: null } cuando no hay match.
async function fetchTheAudioDbImage(name) {
    const cleaned = String(name || '').trim();
    if (!cleaned) return null;
    const url = 'https://www.theaudiodb.com/api/v1/json/2/search.php?s='
        + encodeURIComponent(cleaned);
    const r = await fetch(url, { headers: { 'User-Agent': 'NoBreak/0.1 (local)' } });
    if (!r.ok) throw new Error('theaudiodb ' + r.status);
    const j = await r.json();
    const a = (j && Array.isArray(j.artists)) ? j.artists[0] : null;
    if (!a) return null;
    const thumb = a.strArtistThumb || a.strArtistLogo || a.strArtistClearart || null;
    const fan   = a.strArtistFanart || a.strArtistFanart2 || a.strArtistFanart3 || null;
    if (!thumb && !fan) return null;
    return {
        source:      'theaudiodb',
        name:        a.strArtist || cleaned,
        extract:     null,
        thumbnail:   thumb || fan,
        image_large: fan || thumb,
        url:         null,
        raw_json:    JSON.stringify({ id: a.idArtist, name: a.strArtist }),
    };
}

// --- Cache -----------------------------------------------------------------

function readCache(norm) {
    return db.get().prepare(
        `SELECT artist_norm, source, name, extract, thumbnail, image_large, url, raw_json, fetched_at
         FROM artist_info WHERE artist_norm = ?`
    ).get(norm);
}

function writeCache(norm, info) {
    db.get().prepare(`
        INSERT INTO artist_info (artist_norm, source, name, extract, thumbnail, image_large, url, raw_json, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(artist_norm) DO UPDATE SET
            source      = excluded.source,
            name        = excluded.name,
            extract     = excluded.extract,
            thumbnail   = excluded.thumbnail,
            image_large = excluded.image_large,
            url         = excluded.url,
            raw_json    = excluded.raw_json,
            fetched_at  = excluded.fetched_at
    `).run(norm, info.source, info.name, info.extract, info.thumbnail, info.image_large, info.url, info.raw_json, Date.now());
}

// --- Shape for the API -----------------------------------------------------

function shape(row, queriedName) {
    if (!row) return null;
    // Filtra placeholders cacheados de versiones anteriores: si la URL
    // contiene el hash de la estrella de Last.fm, lo tratamos como vacío
    // para que el renderer aplique su fallback local (portada de álbum o
    // iniciales).
    const thumb = !isPlaceholderImage(row.thumbnail) ? row.thumbnail : null;
    const big   = !isPlaceholderImage(row.image_large) ? row.image_large : null;
    // Sanitización defensiva del extract — filas viejas pueden tener el
    // boilerplate de Last.fm con la lista "1. ... 2. ..." dentro. Limpia
    // sobre la marcha; si ya está limpio o no es de Last.fm, no toca nada.
    const extract = sanitizeLastFmBoilerplate(row.extract, row.name || queriedName);
    return {
        source:     row.source,
        name:       row.name || queriedName,
        extract:    extract,
        thumbnail:  thumb,
        imageLarge: big || thumb,
        url:        row.url,
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
