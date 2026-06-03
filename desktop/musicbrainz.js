// Cliente MusicBrainz para enriquecer la biblioteca con tags ("voted
// genres"), descripciones de release-group y datos editoriales (sello,
// fecha de lanzamiento).
//
// Política de MusicBrainz:
// - Lecturas no requieren clave, pero el User-Agent es obligatorio y
//   debe identificar la app + contacto. Lo leemos de MUSICBRAINZ_USER_AGENT.
// - Rate limit: 1 req/segundo por User-Agent. Encadenamos las llamadas a
//   través de un semáforo simple para no superar el límite.
// - Si el usuario ha configurado MUSICBRAINZ_API_KEY, se manda como
//   Authorization: Bearer <key>. MB lo ignora para lecturas anónimas,
//   pero queda listo si más adelante se usan endpoints autenticados.

const db = require('./db');

const BASE = 'https://musicbrainz.org/ws/2';
const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;  // 30 días

function userAgent() {
  return process.env.MUSICBRAINZ_USER_AGENT
      || 'NoBreak/0.1 (https://github.com/j1ain/NoBreak)';
}
function apiKey() {
  const v = process.env.MUSICBRAINZ_API_KEY;
  return v && v.trim() && v.trim() !== 'TU_API_KEY_AQUI' ? v.trim() : null;
}

// --- Throttle (1 req/segundo) ---------------------------------------------

let queue = Promise.resolve();
let lastCallAt = 0;
const MIN_INTERVAL_MS = 1100;  // un pelín por encima de 1s para evitar 503s

function throttledFetch(url) {
  queue = queue.then(async () => {
    const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastCallAt));
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    const headers = {
      'User-Agent': userAgent(),
      'Accept': 'application/json',
    };
    const k = apiKey();
    if (k) headers.Authorization = 'Bearer ' + k;
    // Timeout explícito: MB puede tardar bastante (10–25 s), pero si pasa
    // de 45 s lo damos por colgado. Sin esto Electron a veces "fetch failed"
    // sin causa visible cuando la conexión se queda muerta.
    const ctrl = new AbortController();
    const tid = setTimeout(() => ctrl.abort(), 45000);
    let res;
    try {
      res = await fetch(url, { headers, signal: ctrl.signal });
    } catch (e) {
      clearTimeout(tid);
      lastCallAt = Date.now();
      const cause = e?.cause?.code || e?.cause?.message || e?.cause;
      const msg = 'fetch fallido' + (cause ? ' (' + cause + ')' : '') + ' — ' + e.message;
      const wrapped = new Error(msg);
      wrapped.original = e;
      throw wrapped;
    }
    clearTimeout(tid);
    lastCallAt = Date.now();
    if (!res.ok) {
      const err = new Error('MusicBrainz http ' + res.status);
      err.status = res.status;
      throw err;
    }
    return res.json();
  });
  return queue;
}

// --- Búsqueda y normalización ----------------------------------------------

function normTags(rawTags) {
  // Acepta el formato que MB devuelve: [{count, name}, ...] y también
  // `genres` que tienen el mismo shape. Ordena por count desc y filtra
  // los que tienen <= 0 votos.
  if (!Array.isArray(rawTags)) return [];
  return rawTags
    .map(t => ({ name: String(t.name || '').trim(), count: Number(t.count) || 0 }))
    .filter(t => t.name && t.count > 0)
    .sort((a, b) => b.count - a.count);
}

// Busca un release-group por (álbum, artista) y devuelve los datos
// enriquecidos. Usa la cache si tiene menos de 30 días.
async function lookupAlbum(album, artist) {
  if (!album) return null;
  const cached = db.getMbAlbumCache(album, artist);
  if (cached && (Date.now() - cached.fetched_at) < CACHE_TTL_MS) {
    return shapeAlbumFromCache(cached);
  }
  try {
    const data = await fetchAlbumFromMB(album, artist);
    if (data) {
      db.setMbAlbumCache(album, artist, data);
      return data;
    }
  } catch (e) {
    console.warn('[mb] lookupAlbum failed:', e.message);
  }
  // Upstream falló y no hay cache fresca: si tenemos cache rancia, devuélvela.
  if (cached) return shapeAlbumFromCache(cached);
  return null;
}

async function fetchAlbumFromMB(album, artist) {
  // 1) Busca el release-group con search?query=release:"X" AND artist:"Y"
  const params = new URLSearchParams({
    query: buildSearchQuery({ release: album, artist }),
    fmt: 'json',
    limit: '5',
  });
  const search = await throttledFetch(`${BASE}/release-group/?${params.toString()}`);
  const rg = pickBestReleaseGroup(search?.['release-groups'] || [], album, artist);
  if (!rg) return null;

  // 2) Detalle del release-group con tags + genres + ratings + releases.
  const detailUrl = `${BASE}/release-group/${encodeURIComponent(rg.id)}`
    + '?inc=tags+genres+ratings+releases+artist-credits&fmt=json';
  const detail = await throttledFetch(detailUrl);

  // 3) Tomamos UNA release del grupo para extraer label + fecha exacta.
  let label = null;
  let firstRelease = detail['first-release-date'] || rg['first-release-date'] || null;
  const releases = detail.releases || [];
  if (releases.length) {
    // Preferimos la release con fecha más antigua + etiqueta no vacía.
    const sorted = releases.slice().sort((a, b) =>
      (a.date || '9999').localeCompare(b.date || '9999'));
    for (const r of sorted) {
      try {
        const relUrl = `${BASE}/release/${encodeURIComponent(r.id)}?inc=labels&fmt=json`;
        const rel = await throttledFetch(relUrl);
        const labelInfo = (rel['label-info'] || [])[0];
        if (labelInfo?.label?.name) { label = labelInfo.label.name; break; }
      } catch (e) { /* ignora y prueba la siguiente */ }
    }
  }

  // MB ofrece "disambiguation" como mini-descripción. La wiki real
  // estaría en "annotation" pero requiere otra llamada — usamos lo más
  // accesible para no agotar el rate limit.
  const description = (detail.disambiguation && detail.disambiguation.trim())
    || (rg.disambiguation && rg.disambiguation.trim())
    || null;

  // Unimos tags + genres (genres son una subcategoría especial de tags).
  const allTags = [...(detail.tags || []), ...(detail.genres || [])];

  return {
    mbid: detail.id,
    title: detail.title || album,
    artist: ((detail['artist-credit'] || []).map(c => c.name || c.artist?.name).filter(Boolean).join(' & '))
            || artist,
    first_release: firstRelease,
    label,
    description,
    tags: normTags(allTags),
  };
}

function buildSearchQuery({ release, artist }) {
  // Lucene-syntax. Escapamos comillas y barras invertidas.
  const esc = s => String(s || '').replace(/[\\"]/g, c => '\\' + c);
  const parts = [];
  if (release) parts.push(`release:"${esc(release)}"`);
  if (artist)  parts.push(`artist:"${esc(artist)}"`);
  return parts.join(' AND ');
}

function pickBestReleaseGroup(list, album, artist) {
  if (!list.length) return null;
  // El primer resultado suele ser el correcto (score alto). Pero si el
  // título o artista no encajan en absoluto, descartamos.
  const albumLc = (album || '').toLowerCase();
  const artistLc = (artist || '').toLowerCase();
  for (const rg of list) {
    const titleLc = (rg.title || '').toLowerCase();
    const credit = (rg['artist-credit'] || []).map(c => c.name || c.artist?.name || '').join(' ').toLowerCase();
    if (titleLc === albumLc && (!artist || credit.includes(artistLc))) return rg;
  }
  // Fallback al primero si nada coincide exacto.
  return list[0];
}

function shapeAlbumFromCache(row) {
  return {
    mbid: row.mbid,
    title: row.title,
    artist: row.artist,
    first_release: row.first_release,
    label: row.label,
    description: row.description,
    tags: (() => { try { return JSON.parse(row.tags_json) || []; } catch { return []; } })(),
    cachedAt: row.fetched_at,
  };
}

// --- Artista ---------------------------------------------------------------

async function lookupArtist(name) {
  if (!name) return null;
  const cached = db.getMbArtistCache(name);
  if (cached && (Date.now() - cached.fetched_at) < CACHE_TTL_MS) {
    return shapeArtistFromCache(cached);
  }
  try {
    const data = await fetchArtistFromMB(name);
    if (data) {
      db.setMbArtistCache(name, data);
      return data;
    }
  } catch (e) {
    console.warn('[mb] lookupArtist failed:', e.message);
  }
  if (cached) return shapeArtistFromCache(cached);
  return null;
}

async function fetchArtistFromMB(name) {
  const params = new URLSearchParams({
    query: `artist:"${String(name).replace(/[\\"]/g, c => '\\' + c)}"`,
    fmt: 'json',
    limit: '5',
  });
  const search = await throttledFetch(`${BASE}/artist/?${params.toString()}`);
  const list = search?.artists || [];
  if (!list.length) return null;
  // Match exacto por nombre (case-insensitive), fallback al primero.
  const nameLc = name.toLowerCase();
  const hit = list.find(a => (a.name || '').toLowerCase() === nameLc) || list[0];
  if (!hit) return null;

  const detail = await throttledFetch(
    `${BASE}/artist/${encodeURIComponent(hit.id)}?inc=tags+genres&fmt=json`
  );
  return {
    mbid: detail.id,
    name: detail.name || name,
    tags: normTags([...(detail.tags || []), ...(detail.genres || [])]),
  };
}

function shapeArtistFromCache(row) {
  return {
    mbid: row.mbid,
    name: row.name,
    tags: (() => { try { return JSON.parse(row.tags_json) || []; } catch { return []; } })(),
    cachedAt: row.fetched_at,
  };
}

// Devuelve las URL-relations del artista (Wikidata, Wikipedia, Discogs, redes...).
// El array crudo tiene la forma [{type, url:{resource}, ...}, ...]. Se usa para
// resolver el enlace a Wikidata cuando se busca una imagen de fallback.
async function getArtistUrlRels(mbid) {
  if (!mbid) return [];
  const detail = await throttledFetch(
    `${BASE}/artist/${encodeURIComponent(mbid)}?inc=url-rels&fmt=json`
  );
  return Array.isArray(detail?.relations) ? detail.relations : [];
}

// Lista de candidatos de MusicBrainz para un nombre. Devuelve los datos que
// alimentan el picker de desambiguación (mbid, nombre, etiqueta corta de MB,
// país, tipo, período). Sólo artistas cuyo nombre coincide exactamente con
// el buscado (case-insensitive) — si MB devuelve un único candidato exacto
// no hay ambigüedad y la lista vuelve con un único elemento.
async function searchArtistCandidates(name, limit = 8) {
  if (!name) return [];
  const params = new URLSearchParams({
    query: `artist:"${String(name).replace(/[\\"]/g, c => '\\' + c)}"`,
    fmt: 'json',
    limit: String(limit),
  });
  const search = await throttledFetch(`${BASE}/artist/?${params.toString()}`);
  const list = search?.artists || [];
  const nameLc = name.toLowerCase().trim();
  // Sólo nos quedamos con coincidencias EXACTAS de nombre — los falsos
  // positivos de "Sunni" cuando buscas "Sunn" no son útiles para el picker.
  const exact = list.filter(a => (a.name || '').toLowerCase().trim() === nameLc);
  return exact.map(a => ({
    mbid:           a.id,
    name:           a.name || name,
    disambiguation: a.disambiguation || null,
    country:        a.country || null,
    type:           a.type || null,         // Person / Group / Orchestra / ...
    gender:         a.gender || null,
    lifeSpan: {
      begin: a['life-span']?.begin || null,
      end:   a['life-span']?.end   || null,
      ended: a['life-span']?.ended || false,
    },
    score: Number(a.score) || 0,
  }));
}

// Detalle de un artista concreto por MBID (sin volver a buscar por nombre).
// Trae tags + genres para que la página del artista los pueda pintar tras
// elegir uno en el picker. La fila de mb_artist_cache también se actualiza.
async function getArtistDetailByMbid(mbid) {
  if (!mbid) return null;
  const detail = await throttledFetch(
    `${BASE}/artist/${encodeURIComponent(mbid)}?inc=tags+genres&fmt=json`
  );
  if (!detail?.id) return null;
  return {
    mbid:           detail.id,
    name:           detail.name || null,
    disambiguation: detail.disambiguation || null,
    country:        detail.country || null,
    type:           detail.type || null,
    tags:           normTags([...(detail.tags || []), ...(detail.genres || [])]),
  };
}

function pickRelUrl(relations, type) {
  if (!Array.isArray(relations)) return null;
  const hit = relations.find(r => r && r.type === type && r.url?.resource);
  return hit ? hit.url.resource : null;
}

// Walker que rellena la cache de MB para todos los álbumes (y artistas
// asociados) que aún no tengan entrada fresca. Pensado para correr en
// segundo plano al arrancar el servidor y tras un rescan. Respeta el
// throttle global (1 req/seg) así que tarda lo suyo en bibliotecas
// grandes, pero no bloquea la UI ni rompe el rate-limit de MB.
async function backfillCache(db, splitArtists) {
  let albums = [];
  try {
    albums = db.get().prepare(`
      SELECT MIN(id) AS id, album AS titulo,
             COALESCE(albumartist, artista) AS aa
      FROM tracks
      WHERE album IS NOT NULL AND album <> ''
      GROUP BY LOWER(album), LOWER(COALESCE(albumartist, artista))
    `).all();
  } catch (e) {
    console.warn('[mb] backfill: no se pudo listar álbumes:', e.message);
    return;
  }
  // Recuento previo para que el log inicial ya cuente cuántos quedan.
  let pending = 0;
  for (const a of albums) {
    if (!db.getMbAlbumCache(a.titulo, a.aa || '')) pending++;
  }
  console.log('[mb] backfill: arrancando', { totalAlbums: albums.length, pending });
  const seenArtists = new Set();
  let fetched = 0, skipped = 0, failed = 0;
  for (const a of albums) {
    if (!a.titulo) continue;
    const aa = a.aa || '';
    if (db.getMbAlbumCache(a.titulo, aa)) { skipped++; }
    else {
      try {
        const parts = splitArtists(aa);
        const primary = parts[0] || aa;
        await lookupAlbum(a.titulo, primary);
        fetched++;
        if (fetched % 5 === 0) console.log('[mb] backfill progreso:', { fetched, failed, totalAlbums: albums.length });
      } catch (e) {
        failed++;
        console.warn('[mb] backfill álbum falló:', a.titulo, '|', e.message);
      }
    }
    for (const comp of splitArtists(aa)) {
      const k = comp.toLowerCase().trim();
      if (!k || seenArtists.has(k)) continue;
      seenArtists.add(k);
      if (!db.getMbArtistCache(k)) {
        try { await lookupArtist(comp); }
        catch (e) { console.warn('[mb] backfill artista falló:', comp, '|', e.message); }
      }
    }
  }
  console.log('[mb] backfill completado:', { fetched, skipped, failed, totalAlbums: albums.length });
}

module.exports = {
  lookupAlbum, lookupArtist, normTags, backfillCache,
  getArtistUrlRels, pickRelUrl,
  searchArtistCandidates, getArtistDetailByMbid,
};
