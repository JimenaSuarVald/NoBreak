// Cliente Last.fm para autenticación + scrobbling.
//
// Requiere una API key y un API secret que el usuario obtiene registrando una
// aplicación en https://www.last.fm/api/account/create. Se guardan en
// app_settings (lastfm_api_key, lastfm_api_secret) y la sesión personal del
// usuario en users.lastfm_session_key / users.lastfm_username.
//
// Las llamadas firmadas siguen la fórmula:
//   md5(concat(keyValue...sorted...) + apiSecret)
// excluyendo `format` y `callback` del cómputo (per docs).

const crypto = require('crypto');

const API_URL = 'https://ws.audioscrobbler.com/2.0/';

// Las credenciales de la app son del desarrollador: NUNCA se piden al
// usuario final. Vienen de variables de entorno cargadas desde .env por
// main.js. Aceptamos los nombres preferidos (LASTFM_*) y mantenemos los
// antiguos (NOBREAK_LASTFM_*) por compatibilidad con instalaciones previas.
function getApiKey() {
  const v = process.env.LASTFM_API_KEY || process.env.NOBREAK_LASTFM_KEY;
  return v && v.trim() ? v.trim() : null;
}
function getApiSecret() {
  const v = process.env.LASTFM_SHARED_SECRET || process.env.NOBREAK_LASTFM_SECRET;
  return v && v.trim() ? v.trim() : null;
}

function signParams(params, apiSecret) {
  const keys = Object.keys(params)
    .filter(k => k !== 'format' && k !== 'callback' && params[k] != null)
    .sort();
  const str = keys.map(k => k + params[k]).join('') + apiSecret;
  return crypto.createHash('md5').update(str, 'utf8').digest('hex');
}

async function callLastFm(rawParams, { signed = false, method = 'GET' } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('Last.fm: falta API key');
  const params = { api_key: apiKey };
  for (const [k, v] of Object.entries(rawParams)) {
    if (v != null && v !== '') params[k] = String(v);
  }
  if (signed) {
    const apiSecret = getApiSecret();
    if (!apiSecret) throw new Error('Last.fm: falta API secret');
    params.api_sig = signParams(params, apiSecret);
  }
  params.format = 'json';

  let res;
  if (method === 'POST') {
    res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
  } else {
    res = await fetch(API_URL + '?' + new URLSearchParams(params).toString());
  }
  let data;
  try { data = await res.json(); }
  catch { throw new Error('Last.fm: respuesta no-JSON (' + res.status + ')'); }
  if (data.error) {
    const msg = data.message || ('code ' + data.error);
    const e = new Error('Last.fm: ' + msg);
    e.lastfmCode = data.error;
    throw e;
  }
  if (!res.ok) throw new Error('Last.fm http ' + res.status);
  return data;
}

// --- Auth flow (desktop / mobile-session) ----------------------------------
//
// Implementa el flujo de "Mobile Session" de Last.fm: el usuario nos da su
// username + password una sola vez, se canjean por una session_key vía
// auth.getMobileSession (POST firmado por HTTPS). La password no se guarda
// en ningún sitio — sólo la session_key, que es lo que vale para scrobblear
// y revocable desde Last.fm si hace falta.
async function getMobileSession(username, password) {
  if (!username || !password) throw new Error('Faltan username o password');
  const data = await callLastFm({
    method: 'auth.getMobileSession',
    username, password,
  }, { signed: true, method: 'POST' });
  return {
    sessionKey: data.session?.key || null,
    username:   data.session?.name || null,
  };
}

// --- Scrobbling ------------------------------------------------------------

async function updateNowPlaying({ sessionKey, artist, track, album, durationMs }) {
  return callLastFm({
    method: 'track.updateNowPlaying',
    sk: sessionKey,
    artist, track, album,
    duration: durationMs ? Math.round(durationMs / 1000) : null,
  }, { signed: true, method: 'POST' });
}

async function scrobble({ sessionKey, artist, track, album, startedAt, durationMs }) {
  return callLastFm({
    method: 'track.scrobble',
    sk: sessionKey,
    artist, track, album,
    timestamp: Math.floor(Number(startedAt) / 1000),
    duration: durationMs ? Math.round(durationMs / 1000) : null,
  }, { signed: true, method: 'POST' });
}

module.exports = {
  getApiKey, getApiSecret,
  getMobileSession,
  updateNowPlaying, scrobble,
};
