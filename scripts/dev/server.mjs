// A local stand-in for Vercel: serves the site as static files and runs
// api/**/*.js (not api/_lib) with the same Web Request/Response handlers.
// With LOCAL_PG=1, @neondatabase/serverless is swapped for neon-shim.mjs so
// DATABASE_URL can point at a plain local Postgres.
//
//   LOCAL_PG=1 DATABASE_URL=postgres://… SOCIAL_ENABLED=true \
//   ADMIN_PASSWORD_HASH=… ADMIN_SESSION_SECRET=… node scripts/dev/server.mjs [port]

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { register } from 'node:module';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 8080);

if (process.env.LOCAL_PG === '1') {
  const shim = pathToFileURL(join(ROOT, 'scripts/dev/neon-shim.mjs')).href;
  register(`data:text/javascript,${encodeURIComponent(`
    export async function resolve(spec, ctx, next) {
      if (spec === '@neondatabase/serverless') return { url: ${JSON.stringify(shim)}, shortCircuit: true };
      return next(spec, ctx);
    }`)}`);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.wav': 'audio/wav', '.woff2': 'font/woff2', '.txt': 'text/plain',
};

async function api(req, res, path) {
  if (path.includes('/_') || !/^[a-z0-9/_-]+$/i.test(path)) return send(res, 404, 'not found');
  const file = join(ROOT, 'api', path + '.js');
  try { await stat(file); } catch { return send(res, 404, 'not found'); }
  const mod = await import(pathToFileURL(file).href);
  const handler = mod[req.method];
  if (typeof handler !== 'function') return send(res, 405, 'method not allowed');
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
  if (!headers.has('x-forwarded-for')) headers.set('x-forwarded-for', req.socket.remoteAddress || '');
  const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
  const request = new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body });
  const response = await handler(request);
  res.statusCode = response.status;
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await response.arrayBuffer()));
}

async function file(res, path) {
  let p = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, '');
  if (p === '' || p.endsWith('/')) p += 'index.html';
  const full = join(ROOT, p);
  if (!full.startsWith(ROOT) || /(^|\/)(\.|node_modules|scripts|db)/.test(p)) return send(res, 404, 'not found');
  try {
    let s = await stat(full);
    let f = full;
    if (s.isDirectory()) { f = join(full, 'index.html'); s = await stat(f); }
    res.setHeader('content-type', TYPES[extname(f)] || 'application/octet-stream');
    res.end(await readFile(f));
  } catch {
    send(res, 404, 'not found');
  }
}

function send(res, status, text) {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain');
  res.end(text);
}

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://x');
    if (pathname.startsWith('/api/')) await api(req, res, pathname.slice(5));
    else await file(res, pathname);
  } catch (e) {
    console.error('dev_server_error', e && e.name);
    if (!res.headersSent) send(res, 500, 'error');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
