import http from 'node:http';
import https from 'node:https';
import { randomUUID } from 'node:crypto';

export function routerBase(value) {
  const u = new URL(value);
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.search || u.hash) throw new Error('Use an HTTP(S) router URL without credentials/query');
  u.pathname = u.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return u.toString().replace(/\/$/, '');
}
const hop = new Set(['host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-authenticate', 'te', 'trailer']);
export async function startProxy({ base, key, session, onRequest = () => {}, onResponse = () => {} }) {
  base = routerBase(base);
  const secret = randomUUID();
  const server = http.createServer((req, res) => {
    if (req.headers.origin || !req.url?.startsWith('/' + secret + '/')) { res.writeHead(403).end(); return; }
    const incoming = req.url.slice(secret.length + 1);
    if (!/^\/v1(?:\/|\?)/.test(incoming)) { res.writeHead(404).end(); return; }
    const target = new URL(base + incoming);
    const basePath = new URL(base).pathname.replace(/\/$/, '');
    if (!target.pathname.startsWith(basePath + '/v1/')) { res.writeHead(404).end(); return; }
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!hop.has(k) && !['authorization', 'x-api-key', 'x-9router-session'].includes(k)) headers[k] = v;
    headers.authorization = 'Bearer ' + key;
    headers['x-api-key'] = key;
    headers['x-9router-session'] = session;
    onRequest(req);
    const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, response => {
      const outgoing = {};
      for (const [k, v] of Object.entries(response.headers)) if (!hop.has(k)) outgoing[k] = v;
      res.writeHead(response.statusCode || 502, outgoing);
      response.pipe(res);
      response.on('error', () => res.destroy());
      onResponse(response.statusCode);
    });
    upstream.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { base: 'http://127.0.0.1:' + server.address().port + '/' + secret, close: () => { server.close(); server.closeAllConnections(); } };
}
