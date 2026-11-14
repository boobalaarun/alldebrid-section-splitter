// AllDebrid Sections - a Stremio/Nuvio addon that exposes ONE section of an
// AllDebrid account (saved links, history, or magnets) per manifest URL.
//
// Runs unchanged on Cloudflare Workers (paste this file) and on Node 18+
// (via server.mjs). No dependencies.
//
// Required secret:  SECRET_KEY       long random string; encrypts the config in the URL
// Optional secret:  CONFIG_PASSWORD  if set, the configure page asks for it

const AD = 'https://api.alldebrid.com';
const VERSION = '1.0.0';
const PAGE = 100;
const CACHE_TTL = 60_000;
const SECTIONS = {
  links: { name: 'Saved Links' },
  history: { name: 'History' },
  magnets: { name: 'Magnets' },
};
const VIDEO_EXT = /\.(mkv|mp4|avi|mov|m4v|webm|ts|m2ts|wmv|flv|mpg|mpeg)$/i;

// ---------------------------------------------------------------- helpers

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64u(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str) {
  const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

async function aesKey(secret) {
  const hash = await crypto.subtle.digest('SHA-256', enc.encode(secret));
  return crypto.subtle.importKey('raw', hash, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(secret, obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), enc.encode(JSON.stringify(obj)))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64u(out);
}
async function unseal(secret, token) {
  try {
    const raw = unb64u(token);
    if (raw.length < 29) return null;
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12) },
      await aesKey(secret),
      raw.slice(12)
    );
    const cfg = JSON.parse(dec.decode(pt));
    if (!cfg || typeof cfg.k !== 'string' || !Array.isArray(cfg.s)) return null;
    cfg.s = cfg.s.filter((s) => SECTIONS[s]);
    return cfg.s.length ? cfg : null;
  } catch {
    return null;
  }
}

// Fast 53-bit string hash (cyrb53). Used to give each link a short, stable id.
function hash(str) {
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function fmtSize(n) {
  n = Number(n) || 0;
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${u[i]}`;
}
function isoDate(sec) {
  const n = Number(sec);
  return n > 0 ? new Date(n * 1000).toISOString() : undefined;
}

const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*' };
function json(obj, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': maxAge ? `private, max-age=${maxAge}` : 'no-store',
      ...CORS,
    },
  });
}
function text(msg, status) {
  return new Response(msg, { status, headers: { 'Content-Type': 'text/plain; charset=utf-8', ...CORS } });
}

// ---------------------------------------------------------------- AllDebrid

class AdError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}

async function ad(key, path, form) {
  const init = { headers: { Authorization: `Bearer ${key}`, 'User-Agent': 'alldebrid-sections-addon' } };
  if (form) { init.method = 'POST'; init.body = new URLSearchParams(form); }
  let res;
  try { res = await fetch(AD + path, init); } catch (e) { throw new AdError('NETWORK', String(e && e.message || e)); }
  let body;
  try { body = await res.json(); } catch { throw new AdError(`HTTP_${res.status}`, `AllDebrid answered HTTP ${res.status} without JSON`); }
  if (body && body.status === 'success') return body.data || {};
  const err = (body && body.error) || {};
  throw new AdError(err.code || `HTTP_${res.status}`, err.message || 'AllDebrid error');
}

const cache = new Map();
async function cached(key, what, fn) {
  const id = `${key}|${what}`;
  const hit = cache.get(id);
  if (hit && Date.now() - hit.t < CACHE_TTL) return hit.v;
  const v = await fn();
  if (cache.size > 200) cache.clear();
  cache.set(id, { t: Date.now(), v });
  return v;
}

// Saved links and history share one shape: {link, filename, size, date, host}
function linkList(key, section) {
  return cached(key, section, async () => {
    const data = await ad(key, section === 'links' ? '/v4/user/links' : '/v4/user/history');
    const raw = Array.isArray(data.links) ? data.links : Object.values(data.links || {});
    const seen = new Set();
    const out = [];
    for (const l of raw) {
      if (!l || !l.link || seen.has(l.link)) continue;
      seen.add(l.link);
      out.push({ h: hash(l.link), link: l.link, filename: l.filename || l.link, size: l.size, date: l.date, host: l.host });
    }
    out.sort((a, b) => (Number(b.date) || 0) - (Number(a.date) || 0));
    return out;
  });
}

function magnetList(key) {
  return cached(key, 'magnets', async () => {
    const data = await ad(key, '/v4.1/magnet/status', [['status', 'ready']]);
    const raw = Array.isArray(data.magnets) ? data.magnets : Object.values(data.magnets || {});
    return raw
      .filter((m) => m && m.id != null && (m.statusCode === undefined || m.statusCode === 4))
      .map((m) => ({ id: String(m.id), filename: m.filename || `Magnet ${m.id}`, size: m.size, date: m.completionDate || m.uploadDate }))
      .sort((a, b) => (Number(b.date) || 0) - (Number(a.date) || 0));
  });
}

function magnetFiles(key, magnetId) {
  return cached(key, `files:${magnetId}`, async () => {
    let data;
    try { data = await ad(key, '/v4/magnet/files', [['id[]', magnetId]]); }
    catch (e) {
      // The docs list this endpoint under /v4 but their curl sample uses /v4.1.
      if (e.code !== '404' && e.code !== 'HTTP_404') throw e;
      data = await ad(key, '/v4.1/magnet/files', [['id[]', magnetId]]);
    }
    const m = (Array.isArray(data.magnets) ? data.magnets : Object.values(data.magnets || {}))[0];
    if (!m) return [];
    if (m.error) throw new AdError(m.error.code, m.error.message);
    const flat = [];
    (function walk(nodes, prefix) {
      for (const n of nodes || []) {
        if (n && Array.isArray(n.e)) walk(n.e, `${prefix}${n.n}/`);
        else if (n && n.l) flat.push({ name: n.n, path: prefix + n.n, size: n.s, link: n.l });
      }
    })(m.files, '');
    const videos = flat.filter((f) => VIDEO_EXT.test(f.name));
    const list = videos.length ? videos : flat;
    // Index is assigned after filtering, and the same filter runs on every request.
    return list.map((f, i) => ({ ...f, i }));
  });
}

async function unlock(key, link) {
  const data = await ad(key, '/v4/link/unlock', [['link', link]]);
  if (data.link && !data.delayed) return data.link;
  if (data.delayed) {
    for (let n = 0; n < 4; n++) {
      await new Promise((r) => setTimeout(r, 5000));
      const d = await ad(key, '/v4/link/delayed', [['id', String(data.delayed)]]);
      if (d.status === 2 && d.link) return d.link;
      if (d.status === 3) throw new AdError('DELAYED_FAILED', 'AllDebrid could not generate this link');
    }
    throw new AdError('DELAYED_TIMEOUT', 'Link is still being prepared, try again in a minute');
  }
  throw new AdError('NO_LINK', 'AllDebrid returned no download link');
}

// ---------------------------------------------------------------- addon

// ids:  adsec:links:<hash>   adsec:history:<hash>   adsec:magnets:<magnetId>[:<fileIndex>]
function parseId(id) {
  const p = String(id).split(':');
  if (p[0] !== 'adsec' || !SECTIONS[p[1]] || !p[2]) return null;
  if (p[1] === 'magnets' && !/^\d+$/.test(p[2])) return null;
  if (p[3] !== undefined && !/^\d+$/.test(p[3])) return null;
  return { section: p[1], key: p[2], file: p[3] === undefined ? null : Number(p[3]) };
}

function manifest(cfg) {
  const label = cfg.s.map((s) => SECTIONS[s].name).join(' + ');
  return {
    // Different id per section set, so separate installs don't overwrite each other.
    id: `community.alldebrid.sections.${cfg.s.join('-')}`,
    version: VERSION,
    name: `AllDebrid: ${label}`,
    description: `Browse and play AllDebrid ${label.toLowerCase()}. Scoped: nothing else on the account is reachable from this URL.`,
    resources: ['catalog', 'meta', 'stream'],
    types: ['other'],
    catalogs: cfg.s.map((s) => ({
      type: 'other',
      id: `adsec-${s}`,
      name: `AllDebrid ${SECTIONS[s].name}`,
      extra: [{ name: 'search', isRequired: false }, { name: 'skip', isRequired: false }],
    })),
    idPrefixes: cfg.s.map((s) => `adsec:${s}:`),
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

async function catalog(cfg, catalogId, extra) {
  const section = catalogId.replace(/^adsec-/, '');
  if (!cfg.s.includes(section)) return { metas: [] };
  let items = section === 'magnets'
    ? (await magnetList(cfg.k)).map((m) => ({ id: `adsec:magnets:${m.id}`, name: m.filename, size: m.size, date: m.date }))
    : (await linkList(cfg.k, section)).map((l) => ({ id: `adsec:${section}:${l.h}`, name: l.filename, size: l.size, date: l.date, host: l.host }));
  const q = (extra.search || '').toLowerCase().trim();
  if (q) {
    const words = q.split(/\s+/);
    items = items.filter((it) => { const n = it.name.toLowerCase(); return words.every((w) => n.includes(w)); });
  }
  const skip = Math.max(0, parseInt(extra.skip, 10) || 0);
  return {
    metas: items.slice(skip, skip + PAGE).map((it) => ({
      id: it.id,
      type: 'other',
      name: it.name,
      posterShape: 'landscape',
      description: [fmtSize(it.size), it.host, (isoDate(it.date) || '').slice(0, 10)].filter(Boolean).join(' · '),
    })),
  };
}

async function meta(cfg, id) {
  const p = parseId(id);
  if (!p || !cfg.s.includes(p.section)) return { meta: null };
  if (p.section === 'magnets') {
    const m = (await magnetList(cfg.k)).find((x) => x.id === p.key);
    if (!m) return { meta: null };
    const files = await magnetFiles(cfg.k, p.key);
    const base = `adsec:magnets:${p.key}`;
    return {
      meta: {
        id: base, type: 'other', name: m.filename, posterShape: 'landscape',
        description: `${files.length} file(s) · ${fmtSize(m.size)}`,
        videos: files.map((f) => ({ id: `${base}:${f.i}`, title: f.path, released: isoDate(m.date) || '1970-01-01T00:00:00.000Z' })),
        behaviorHints: files.length === 1 ? { defaultVideoId: `${base}:0` } : {},
      },
    };
  }
  const l = (await linkList(cfg.k, p.section)).find((x) => x.h === p.key);
  if (!l) return { meta: null };
  const mid = `adsec:${p.section}:${l.h}`;
  return {
    meta: {
      id: mid, type: 'other', name: l.filename, posterShape: 'landscape',
      description: [fmtSize(l.size), l.host].filter(Boolean).join(' · '),
      videos: [{ id: mid, title: l.filename, released: isoDate(l.date) || '1970-01-01T00:00:00.000Z' }],
      behaviorHints: { defaultVideoId: mid },
    },
  };
}

// Resolves an id to {name, size, link} ONLY if it lives inside a section this
// token is allowed to see. The link always comes from AllDebrid's own list,
// never from the request, so a URL holder cannot unlock arbitrary links.
async function resolve(cfg, id) {
  const p = parseId(id);
  if (!p || !cfg.s.includes(p.section)) return null;
  if (p.section === 'magnets') {
    if (!(await magnetList(cfg.k)).some((x) => x.id === p.key)) return null;
    const files = await magnetFiles(cfg.k, p.key);
    const f = files[p.file === null ? 0 : p.file];
    return f ? { name: f.name, size: f.size, link: f.link } : null;
  }
  const l = (await linkList(cfg.k, p.section)).find((x) => x.h === p.key);
  return l ? { name: l.filename, size: l.size, link: l.link } : null;
}

async function stream(cfg, id, origin, token) {
  const item = await resolve(cfg, id);
  if (!item) return { streams: [] };
  return {
    streams: [{
      name: 'AllDebrid',
      title: [item.name, fmtSize(item.size)].filter(Boolean).join('\n'),
      // Unlocking happens only when someone presses play, not on every listing.
      url: `${origin}/${token}/play/${encodeURIComponent(id)}`,
      behaviorHints: { notWebReady: !/\.mp4$/i.test(item.name), filename: item.name, videoSize: Number(item.size) || undefined },
    }],
  };
}

// ---------------------------------------------------------------- configure

async function generate(request, env) {
  let body;
  try { body = await request.json(); } catch { return json({ error: 'Bad request' }, 400); }
  if (env.CONFIG_PASSWORD && body.password !== env.CONFIG_PASSWORD) return json({ error: 'Wrong configure password' }, 403);
  const key = String(body.apikey || '').trim();
  const sections = (Array.isArray(body.sections) ? body.sections : []).filter((s) => SECTIONS[s]);
  if (!key) return json({ error: 'API key is required' }, 400);
  if (!sections.length) return json({ error: 'Pick at least one section' }, 400);

  // Live check from THIS server's IP - this is what tells you whether AllDebrid blocks the host.
  const checks = [];
  const probe = async (label, fn) => {
    try { checks.push({ label, ok: true, detail: await fn() }); }
    catch (e) { checks.push({ label, ok: false, detail: `${e.code || 'ERROR'}: ${e.message}` }); }
  };
  await probe('API key', async () => { const d = await ad(key, '/v4/user'); return d.user && d.user.isPremium ? 'valid, premium' : 'valid, NOT premium'; });
  let sample = null;
  for (const s of sections) {
    await probe(SECTIONS[s].name, async () => {
      if (s === 'magnets') { const m = await magnetList(key); return `${m.length} ready magnet(s)`; }
      const l = await linkList(key, s);
      if (!sample && l[0]) sample = l[0].link;
      return `${l.length} link(s)`;
    });
  }
  if (body.testUnlock) {
    if (sample) await probe('Playback unlock', async () => { await unlock(key, sample); return 'this server is allowed to unlock links'; });
    else checks.push({ label: 'Playback unlock', ok: false, detail: 'skipped: no saved/history link to test with' });
  }

  const origin = new URL(request.url).origin;
  const urls = [];
  const groups = sections.map((s) => [s]);
  if (sections.length > 1) groups.push(sections);
  for (const g of groups) {
    const token = await seal(env.SECRET_KEY, { v: 1, k: key, s: g });
    urls.push({ label: g.map((s) => SECTIONS[s].name).join(' + '), manifest: `${origin}/${token}/manifest.json` });
  }
  return json({ urls, checks });
}

function configurePage(env) {
  const pw = env.CONFIG_PASSWORD
    ? '<label>Configure password<input id="pw" type="password" autocomplete="off"></label>'
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AllDebrid Sections</title><style>
body{font:16px/1.5 system-ui,sans-serif;max-width:640px;margin:2rem auto;padding:0 1rem;background:#14161a;color:#e8e8e8}
h1{font-size:1.4rem}label{display:block;margin:.8rem 0}input[type=password],input[type=text]{width:100%;padding:.6rem;border-radius:6px;border:1px solid #444;background:#1e2127;color:inherit;box-sizing:border-box}
button{padding:.6rem 1.1rem;border:0;border-radius:6px;background:#5b8def;color:#fff;font-size:1rem;cursor:pointer}
.card{background:#1e2127;border-radius:8px;padding:.8rem 1rem;margin:.8rem 0;word-break:break-all}.ok{color:#6fcf7f}.bad{color:#ff7b7b}
.row{display:flex;gap:.5rem;margin-top:.5rem;flex-wrap:wrap}small{color:#aaa}a{color:#8fb4ff}</style></head><body>
<h1>AllDebrid Sections</h1>
<p><small>Makes one install URL per section. Whoever holds a URL can browse and play that section only. The URL itself is the password: share it privately.</small></p>
<label>AllDebrid API key<input id="key" type="password" autocomplete="off" placeholder="from alldebrid.com/apikeys"></label>${pw}
<label><input type="checkbox" class="sec" value="links" checked> Saved Links</label>
<label><input type="checkbox" class="sec" value="history"> History</label>
<label><input type="checkbox" class="sec" value="magnets"> Magnets</label>
<label><input type="checkbox" id="tu"> Also test playback unlock <small>(unlocks your newest link once; it will show up in your AllDebrid history)</small></label>
<button id="go">Generate URLs</button><div id="out"></div>
<script>
const $=s=>document.querySelector(s),out=$('#out');
function el(t,c,x){const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e}
$('#go').onclick=async()=>{out.textContent='Working...';
 const body={apikey:$('#key').value,sections:[...document.querySelectorAll('.sec:checked')].map(c=>c.value),testUnlock:$('#tu').checked,password:$('#pw')?$('#pw').value:undefined};
 let r,d;try{r=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});d=await r.json()}catch(e){out.textContent='Request failed: '+e;return}
 out.textContent='';if(d.error){out.append(el('p','bad',d.error));return}
 const c=el('div','card');c.append(el('strong',null,'Checks from this server'));
 for(const k of d.checks)c.append(el('div',k.ok?'ok':'bad',(k.ok?'OK  ':'FAIL  ')+k.label+': '+k.detail));out.append(c);
 for(const u of d.urls){const b=el('div','card');b.append(el('strong',null,u.label),el('div',null,u.manifest));
  const row=el('div','row'),cp=el('button',null,'Copy'),a=el('a',null,'Install in Stremio');
  cp.onclick=()=>navigator.clipboard.writeText(u.manifest).then(()=>cp.textContent='Copied');
  a.href=u.manifest.replace(/^https?:/,'stremio:');row.append(cp,a);b.append(row);out.append(b)}
};
</script></body></html>`;
}

// ---------------------------------------------------------------- router

function parseExtra(seg) {
  const out = {};
  for (const [k, v] of new URLSearchParams(seg || '')) out[k] = v;
  return out;
}

async function handle(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { headers: CORS });
  if (!env || !env.SECRET_KEY || String(env.SECRET_KEY).length < 16) {
    return text('Server not set up: add a SECRET_KEY secret (16+ random characters).', 500);
  }
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);

  if (parts.length === 0) return Response.redirect(`${url.origin}/configure`, 302);
  if (parts[0] === 'configure') {
    return new Response(configurePage(env), { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
  }
  if (parts[0] === 'api' && parts[1] === 'generate' && request.method === 'POST') return generate(request, env);
  if (request.method !== 'GET' && request.method !== 'HEAD') return text('Method not allowed', 405);

  const token = parts[0];
  const cfg = await unseal(env.SECRET_KEY, token);
  if (!cfg) return json({ error: 'Invalid or revoked addon URL' }, 404);

  const last = decodeURIComponent((parts[parts.length - 1] || '').replace(/\.json$/, ''));
  try {
    if (parts[1] === 'manifest.json') return json(manifest(cfg), 200, 300);
    if (parts[1] === 'configure') return Response.redirect(`${url.origin}/configure`, 302);
    if (parts[1] === 'catalog' && parts[3]) {
      const hasExtra = parts.length >= 5;
      const catalogId = decodeURIComponent(hasExtra ? parts[3] : parts[3].replace(/\.json$/, ''));
      return json(await catalog(cfg, catalogId, hasExtra ? parseExtra(last) : {}), 200, 60);
    }
    if (parts[1] === 'meta' && parts[3]) return json(await meta(cfg, last), 200, 60);
    if (parts[1] === 'stream' && parts[3]) return json(await stream(cfg, last, url.origin, token), 200, 60);
    if (parts[1] === 'play' && parts[2]) {
      const item = await resolve(cfg, decodeURIComponent(parts[2]));
      if (!item) return text('Not found in this section', 404);
      const direct = await unlock(cfg.k, item.link);
      return new Response(null, { status: 302, headers: { Location: direct, 'Cache-Control': 'no-store', ...CORS } });
    }
  } catch (e) {
    const code = e.code || 'ERROR';
    if (parts[1] === 'play') return text(`AllDebrid error ${code}: ${e.message}`, 502);
    // Stremio shows nothing useful for errors, so answer with empty results plus the reason.
    const empty = parts[1] === 'catalog' ? { metas: [] } : parts[1] === 'meta' ? { meta: null } : { streams: [] };
    return json({ ...empty, error: `${code}: ${e.message}` });
  }
  return json({ error: 'Not found' }, 404);
}

export default { fetch: handle };
