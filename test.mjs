// Runs the addon against a fake AllDebrid. No network, no real key.
import assert from 'node:assert/strict';
import worker from './worker.js';

const KEY = 'FAKE_API_KEY_FOR_TESTS_ONLY';
const env = { SECRET_KEY: 'fake-test-secret-not-a-real-secret' };
const calls = [];

const links = [
  { link: 'https://1fichier.com/?aaa', filename: 'Family.Movie.2020.mkv', size: 2147483648, date: 1700000000, host: '1fichier' },
  { link: 'https://1fichier.com/?bbb', filename: 'Cartoon.S01E01.mp4', size: 500000000, date: 1710000000, host: '1fichier' },
];
const history = [
  { link: 'https://rapidgator.net/file/private', filename: 'Private.Thing.mkv', size: 1000, date: 1720000000, host: 'rapidgator' },
  { link: 'https://rapidgator.net/file/private', filename: 'Private.Thing.mkv', size: 1000, date: 1720000001, host: 'rapidgator' },
];
const ok = (data) => new Response(JSON.stringify({ status: 'success', data }));
const err = (code, message) => new Response(JSON.stringify({ status: 'error', error: { code, message } }));

globalThis.fetch = async (url, init = {}) => {
  const u = new URL(url);
  const form = Object.fromEntries(new URLSearchParams(init.body ? String(init.body) : ''));
  calls.push({ path: u.pathname, form, auth: init.headers.Authorization });
  if (init.headers.Authorization !== `Bearer ${KEY}`) return err('AUTH_BAD_APIKEY', 'The auth apikey is invalid');
  switch (u.pathname) {
    case '/v4/user': return ok({ user: { isPremium: true } });
    case '/v4/user/links': return ok({ links });
    case '/v4/user/history': return ok({ links: history });
    case '/v4.1/magnet/status': return ok({ magnets: [
      { id: 77, filename: 'Show.S01', size: 3000000000, statusCode: 4, completionDate: 1715000000 },
      { id: 78, filename: 'Still.Downloading', size: 1, statusCode: 1 } ] });
    case '/v4/magnet/files': return form['id[]'] === '77'
      ? ok({ magnets: [{ id: 77, files: [{ n: 'Show.S01', e: [
          { n: 'E01.mkv', s: 1500000000, l: 'https://alldebrid.com/f/e01' },
          { n: 'E02.mkv', s: 1500000000, l: 'https://alldebrid.com/f/e02' },
          { n: 'info.nfo', s: 100, l: 'https://alldebrid.com/f/nfo' } ] }] }] })
      : ok({ magnets: [{ id: Number(form['id[]']), error: { code: 'MAGNET_INVALID_ID', message: 'bad id' } }] });
    case '/v4/link/unlock': return ok({ link: `https://dl.debrid.it/direct/${encodeURIComponent(form.link)}`, filename: 'x' });
  }
  return new Response('nope', { status: 404 });
};

const call = (path, init) => worker.fetch(new Request(`https://addon.example${path}`, init), env);
const get = async (path) => { const r = await call(path); return { r, body: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() }; };

// --- generate
const gen = await call('/api/generate', { method: 'POST', body: JSON.stringify({ apikey: KEY, sections: ['links', 'history', 'magnets'], testUnlock: true }) });
const g = await gen.json();
assert.equal(g.urls.length, 4, 'three single-section URLs plus one combined');
assert.ok(g.checks.every((c) => c.ok), JSON.stringify(g.checks));
for (const u of g.urls) assert.ok(!u.manifest.includes(KEY), 'API key must not appear in the URL');
const tok = Object.fromEntries(g.urls.map((u) => [u.label, new URL(u.manifest).pathname.split('/')[1]]));
const L = tok['Saved Links'], H = tok['History'], M = tok['Magnets'];

// --- manifest is scoped and has no key
const man = (await get(`/${L}/manifest.json`)).body;
assert.deepEqual(man.catalogs.map((c) => c.id), ['adsec-links']);
assert.deepEqual(man.idPrefixes, ['adsec:links:']);
assert.ok(!JSON.stringify(man).includes(KEY));
assert.notEqual(man.id, (await get(`/${H}/manifest.json`)).body.id, 'separate installs need separate ids');
assert.equal((await get(`/${L}/manifest.json`)).r.headers.get('access-control-allow-origin'), '*');

// --- links catalog, newest first, search, skip
const cat = (await get(`/${L}/catalog/other/adsec-links.json`)).body.metas;
assert.deepEqual(cat.map((m) => m.name), ['Cartoon.S01E01.mp4', 'Family.Movie.2020.mkv']);
assert.equal((await get(`/${L}/catalog/other/adsec-links/search=family%20movie.json`)).body.metas.length, 1);
assert.equal((await get(`/${L}/catalog/other/adsec-links/skip=100.json`)).body.metas.length, 0);

// --- meta -> stream -> play for a saved link
const id = cat[1].id;
const meta = (await get(`/${L}/meta/other/${encodeURIComponent(id)}.json`)).body.meta;
assert.equal(meta.name, 'Family.Movie.2020.mkv');
assert.equal(meta.behaviorHints.defaultVideoId, id);
const st = (await get(`/${L}/stream/other/${encodeURIComponent(id)}.json`)).body.streams;
assert.equal(st.length, 1);
assert.ok(st[0].url.startsWith(`https://addon.example/${L}/play/`));
const play = await call(new URL(st[0].url).pathname);
assert.equal(play.status, 302);
assert.equal(play.headers.get('location'), `https://dl.debrid.it/direct/${encodeURIComponent('https://1fichier.com/?aaa')}`);

// --- SCOPE: the links-only URL must not reach history or magnets
calls.length = 0;
assert.deepEqual((await get(`/${L}/catalog/other/adsec-history.json`)).body.metas, []);
assert.deepEqual((await get(`/${L}/catalog/other/adsec-magnets.json`)).body.metas, []);
const hid = (await get(`/${H}/catalog/other/adsec-history.json`)).body.metas[0].id;
assert.equal((await get(`/${H}/catalog/other/adsec-history.json`)).body.metas.length, 1, 'history is de-duplicated');
calls.length = 0;
assert.equal((await get(`/${L}/meta/other/${encodeURIComponent(hid)}.json`)).body.meta, null);
assert.deepEqual((await get(`/${L}/stream/other/${encodeURIComponent(hid)}.json`)).body.streams, []);
assert.equal((await call(`/${L}/play/${encodeURIComponent(hid)}`)).status, 404);
assert.equal((await call(`/${L}/play/${encodeURIComponent('adsec:magnets:77:0')}`)).status, 404);
// same hash but relabelled as a link: not in the saved-links list, so refused
assert.equal((await call(`/${L}/play/${encodeURIComponent(hid.replace('history', 'links'))}`)).status, 404);
// arbitrary link smuggled in as an id
assert.equal((await call(`/${L}/play/${encodeURIComponent('adsec:links:https://evil.example/file')}`)).status, 404);
assert.ok(!calls.some((c) => c.path === '/v4/link/unlock'), 'no unlock may happen for out-of-scope ids');
assert.ok(!calls.some((c) => c.path === '/v4/user/history' || c.path.includes('magnet')), 'links token must never even query other sections');

// --- magnets
const mcat = (await get(`/${M}/catalog/other/adsec-magnets.json`)).body.metas;
assert.deepEqual(mcat.map((m) => m.id), ['adsec:magnets:77'], 'only ready magnets are listed');
const mm = (await get(`/${M}/meta/other/${encodeURIComponent('adsec:magnets:77')}.json`)).body.meta;
assert.deepEqual(mm.videos.map((v) => v.title), ['Show.S01/E01.mkv', 'Show.S01/E02.mkv'], 'non-video files are hidden');
const mp = await call(`/${M}/play/${encodeURIComponent('adsec:magnets:77:1')}`);
assert.equal(mp.headers.get('location'), `https://dl.debrid.it/direct/${encodeURIComponent('https://alldebrid.com/f/e02')}`);
assert.equal((await call(`/${M}/play/${encodeURIComponent('adsec:magnets:78:0')}`)).status, 404, 'unfinished magnet is not playable');
assert.equal((await call(`/${M}/play/${encodeURIComponent('adsec:magnets:77:9')}`)).status, 404);

// --- tampering and wrong secret
const flipped = L.slice(0, -2) + (L.endsWith('AA') ? 'BB' : 'AA');
assert.equal((await call(`/${flipped}/manifest.json`)).status, 404);
assert.equal((await worker.fetch(new Request(`https://addon.example/${L}/manifest.json`), { SECRET_KEY: 'another-fake-secret-for-tests' })).status, 404, 'rotating SECRET_KEY revokes every URL');
assert.equal((await call('/garbage/manifest.json')).status, 404);

// --- AllDebrid refusing the server is reported, not hidden
const bad = await (await call('/api/generate', { method: 'POST', body: JSON.stringify({ apikey: 'wrongkey', sections: ['links'] }) })).json();
assert.ok(bad.checks.some((c) => !c.ok && c.detail.includes('AUTH_BAD_APIKEY')));

// --- configure password
const penv = { ...env, CONFIG_PASSWORD: 'letmein' };
const post = (password) => worker.fetch(new Request('https://addon.example/api/generate', { method: 'POST', body: JSON.stringify({ apikey: KEY, sections: ['links'], password }) }), penv);
assert.equal((await post('nope')).status, 403);
assert.equal((await post('letmein')).status, 200);

// --- misc
assert.equal((await call('/')).status, 302);
assert.ok((await get('/configure')).body.includes('AllDebrid Sections'));
assert.equal((await worker.fetch(new Request('https://addon.example/configure'), {})).status, 500, 'refuses to run without SECRET_KEY');

console.log('all tests passed');
