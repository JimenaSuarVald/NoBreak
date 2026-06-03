// Test directo de conectividad a MusicBrainz desde el runtime de Electron.
(async () => {
  const url = 'https://musicbrainz.org/ws/2/release-group/?query=release:%22Altar%22&fmt=json&limit=1';
  console.log('GET', url);
  const t = Date.now();
  try {
    const r = await fetch(url, {
      headers: {
        'User-Agent': 'NoBreak/0.1 (test)',
        'Accept': 'application/json',
      },
    });
    console.log('status:', r.status, 'ms:', Date.now() - t);
    const data = await r.json();
    console.log('release-groups:', (data['release-groups'] || []).length);
  } catch (e) {
    console.log('FETCH FAILED after', Date.now() - t, 'ms');
    console.log('error message:', e.message);
    console.log('error cause:', e.cause && (e.cause.code || e.cause.message || e.cause));
    console.log('stack:', e.stack);
  }
})();
