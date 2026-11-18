import fs from 'node:fs';
import path from 'node:path';
import { ApiError, fail } from './util.mjs';

export function createRouter() {
  const routes = [];
  const add = (method, pattern, handler) => {
    const keys = [];
    const re = new RegExp('^' + pattern.replace(/\/:([A-Za-z0-9_]+)/g, (_, k) => { keys.push(k); return '/([^/]+)'; }).replace(/\*/g, '(.*)') + '$');
    routes.push({ method: method.toUpperCase(), re, keys, handler });
  };
  const match = (method, pathname) => {
    for (const r of routes) {
      if (r.method !== method.toUpperCase()) continue;
      const m = r.re.exec(pathname);
      if (!m) continue;
      const params = {};
      r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
      return { handler: r.handler, params };
    }
    return null;
  };
  return { add, match };
}

export function parseCookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) { try { out[k] = decodeURIComponent(v); } catch { out[k] = v; } }
  }
  return out;
}

export function cookieHeader(name, value, { maxAge, secure = true, httpOnly = true, sameSite = 'Lax', path: p = '/' } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${p}`, `SameSite=${sameSite}`];
  if (httpOnly) parts.push('HttpOnly');
  if (secure) parts.push('Secure');
  if (maxAge !== undefined) parts.push(`Max-Age=${Math.floor(maxAge)}`);
  return parts.join('; ');
}

export function clearCookie(name, { secure = true, path: p = '/' } = {}) {
  return `${name}=; Path=${p}; Max-Age=0; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
}

export function sendJson(res, status, obj, headers = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

export function sendError(res, err) {
  if (res.headersSent) { try { res.end(); } catch { /* ignore */ } return; }
  const status = err instanceof ApiError ? err.status : 500;
  const code = err instanceof ApiError ? err.code : 'internal';
  const message = err instanceof ApiError ? err.message : '服务器内部错误';
  if (!(err instanceof ApiError)) console.error('[error]', err);
  sendJson(res, status, { error: { code, message, detail: err && err.detail } });
}

export function readBody(req, limit = 1 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new ApiError(413, 'too_large', '请求体过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJsonBody(req, limit) {
  const buf = await readBody(req, limit);
  if (!buf.length) return {};
  try { return JSON.parse(buf.toString('utf8')); } catch { throw new ApiError(400, 'invalid_json', 'JSON 格式错误'); }
}

export function serveStatic(publicDir, req, res, pathname) {
  const clean = pathname === '/' ? '/index.html' : pathname;
  const target = path.normalize(path.join(publicDir, clean));
  if (!target.startsWith(path.normalize(publicDir))) { fail(403, 'forbidden', '非法路径'); }
  let file = target;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const index = path.join(publicDir, 'index.html');
    if (!fs.existsSync(index)) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('web ui 未构建'); return; }
    file = index;
  }
  const ext = path.extname(file).toLowerCase();
  const types = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.map': 'application/json' };
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': types[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(file).pipe(res);
}

export function sseStart(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write(': connected\n\n');
  const send = (event, data) => {
    try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
  };
  const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20000);
  return { send, close: () => { clearInterval(ping); try { res.end(); } catch { /* ignore */ } } };
}
