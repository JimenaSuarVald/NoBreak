/**
 * Cliente HTTP de NoBreak: login con usuario/contraseña, gestión de la
 * sesión y wrapper de fetch que añade el Authorization Bearer.
 *
 * Almacenamiento: sessionStorage. Se mantiene entre menu.html y
 * reproductor.html y se borra al cerrar el navegador. El token también
 * se inyecta como query param `?t=` para las URLs servidas a etiquetas
 * <audio>, que no pueden enviar cabeceras de Authorization.
 */
(function () {
  const API = "http://127.0.0.1:8080";

  const TOK = {
    get token()  { return sessionStorage.getItem("nb_token");  },
    set token(v) { v ? sessionStorage.setItem("nb_token",  v) : sessionStorage.removeItem("nb_token");  },
    get user()   { return sessionStorage.getItem("nb_user");   },
    set user(v)  { v ? sessionStorage.setItem("nb_user",   v) : sessionStorage.removeItem("nb_user");   },
    clear() {
      ["nb_token", "nb_user"].forEach(k => sessionStorage.removeItem(k));
    }
  };

  function withAuth(opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (TOK.token) headers["Authorization"] = "Bearer " + TOK.token;
    return Object.assign({}, opts, { headers });
  }

  async function apiFetch(path, opts = {}) {
    const res = await fetch(API + path, withAuth(opts));
    if (res.status === 401) {
      // Sesión muerta: limpia y deja que el llamador decida (típicamente,
      // redirigir al login).
      TOK.clear();
    }
    return res;
  }

  async function login(username, password) {
    const r = await fetch(API + "/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username, password })
    });
    if (!r.ok) {
      let msg = "Credenciales inválidas";
      try { msg = (await r.json()).error || msg; } catch (_) {}
      throw new Error(msg);
    }
    const t = await r.json();
    TOK.token = t.sessionToken;
    TOK.user  = t.username;
    return t;
  }

  async function logout() {
    if (TOK.token) {
      try {
        await fetch(API + "/auth/logout", {
          method: "POST",
          headers: { "Authorization": "Bearer " + TOK.token }
        });
      } catch (_) { /* mejor esfuerzo */ }
    }
    TOK.clear();
  }

  function isLoggedIn() { return !!TOK.token; }
  function currentUser() { return TOK.user; }

  async function ping() {
    if (!TOK.token) return false;
    const r = await apiFetch("/auth/me");
    return r.ok;
  }

  // ---- Helpers tipados ----

  async function getLibrary() {
    const r = await apiFetch("/api/library");
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function getAlbum(id) {
    const r = await apiFetch("/api/albums/" + encodeURIComponent(id));
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function getGenres() {
    const r = await apiFetch("/api/genres");
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function getAlbumsByArtist(id) {
    const r = await apiFetch("/api/artists/" + encodeURIComponent(id) + "/albums");
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function getAlbumsByGenre(id) {
    const r = await apiFetch("/api/genres/" + encodeURIComponent(id) + "/albums");
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }

  async function getArtistInfo(name) {
    const r = await apiFetch("/api/artist-info?name=" + encodeURIComponent(name));
    if (!r.ok) return null;
    return r.json();
  }

  // ---- Playlists ----
  async function getPlaylists() {
    const r = await apiFetch("/api/playlists");
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function getPlaylist(id) {
    const r = await apiFetch("/api/playlists/" + id);
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function createPlaylist(name) {
    const r = await apiFetch("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) {
      let m = "HTTP " + r.status;
      try { m = (await r.json()).error || m; } catch {}
      throw new Error(m);
    }
    return r.json();
  }
  async function renamePlaylist(id, name) {
    const r = await apiFetch("/api/playlists/" + id, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  }
  async function deletePlaylist(id) {
    const r = await apiFetch("/api/playlists/" + id, { method: "DELETE" });
    if (!r.ok && r.status !== 204) throw new Error("HTTP " + r.status);
  }
  async function addTrackToPlaylist(playlistId, trackId) {
    const r = await apiFetch("/api/playlists/" + playlistId + "/tracks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trackId }),
    });
    if (!r.ok) {
      let m = "HTTP " + r.status;
      try { m = (await r.json()).error || m; } catch {}
      throw new Error(m);
    }
    return r.json();
  }
  async function removeTrackFromPlaylist(playlistId, trackId) {
    const r = await apiFetch("/api/playlists/" + playlistId + "/tracks/" + trackId, { method: "DELETE" });
    if (!r.ok && r.status !== 204) throw new Error("HTTP " + r.status);
  }

  /**
   * URL absoluta del stream del track. El token va en la query porque
   * <audio> no puede enviar cabeceras Authorization.
   */
  function streamUrl(trackId) {
    if (!TOK.token) return null;
    return API + "/stream/" + encodeURIComponent(trackId)
        + "?t=" + encodeURIComponent(TOK.token);
  }

  function coverUrl(path) {
    return path ? API + path : null;
  }

  window.NoBreak = {
    login, logout, isLoggedIn, currentUser, ping,
    getLibrary, getAlbum, getGenres,
    getAlbumsByArtist, getAlbumsByGenre, getArtistInfo,
    getPlaylists, getPlaylist, createPlaylist, renamePlaylist, deletePlaylist,
    addTrackToPlaylist, removeTrackFromPlaylist,
    streamUrl, coverUrl,
    apiBase: API
  };
})();
