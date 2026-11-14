// Runs the same addon on a home machine (Node 18+), for when AllDebrid refuses
// requests from Cloudflare's datacenter IPs.
//
//   SECRET_KEY="long-random-string" PORT=7000 node server.mjs
//
// Stremio needs HTTPS for anything other than 127.0.0.1, so put this behind
// Cloudflare Tunnel, Tailscale Funnel, or Caddy.

import http from 'node:http';
import worker from './worker.js';

const env = { SECRET_KEY: process.env.SECRET_KEY, CONFIG_PASSWORD: process.env.CONFIG_PASSWORD };
const port = Number(process.env.PORT) || 7000;

http.createServer(async (req, res) => {
  try {
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const request = new Request(`${proto}://${host}${req.url}`, {
      method: req.method,
      headers: req.headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
    const response = await worker.fetch(request, env);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Server error');
    console.error(e);
  }
}).listen(port, () => console.log(`AllDebrid Sections listening on http://127.0.0.1:${port}/configure`));
