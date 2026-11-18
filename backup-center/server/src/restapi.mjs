import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const TYPES = new Set(['config', 'data', 'index', 'keys', 'locks', 'snapshots']);
const NAME_RE = /^[0-9a-f]{64}$/;
const MAX_UPLOAD = 2 * 1024 * 1024 * 1024; // 2 GiB
const V2 = 'application/vnd.x.restic.rest.v2';

function repoDir(repo, clientId) {
  return path.join(repo.mountpoint, clientId);
}

function ensureLayout(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const t of ['data', 'index', 'keys', 'locks', 'snapshots']) {
    fs.mkdirSync(path.join(dir, t), { recursive: true, mode: 0o700 });
  }
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body ?? '');
}

function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!m) return { invalid: true };
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) return { invalid: true };
  if (start === null) { start = Math.max(0, size - end); end = size - 1; }
  else if (end === null) { end = size - 1; }
  if (start > end || start >= size) return { invalid: true };
  end = Math.min(end, size - 1);
  return { start, end };
}

function safeName(name) {
  return NAME_RE.test(name);
}

// restic 0.18 仓库格式 v2 的 pack 文件按前两位十六进制分目录存放；其余类型平铺。
function filePathFor(dir, type, name) {
  if (type === 'data') return path.join(dir, 'data', name.slice(0, 2), name);
  return path.join(dir, type, name);
}

function atomicWrite(finalPath, req, res, onDone) {
  fs.mkdirSync(path.dirname(finalPath), { recursive: true, mode: 0o700 });
  if (fs.existsSync(finalPath)) {
    // 内容寻址：同名文件已存在，直接丢弃本次上传
    req.resume();
    req.on('end', () => onDone(null));
    return;
  }
  const tmp = path.join(path.dirname(finalPath), `.upload-${crypto.randomBytes(8).toString('hex')}`);
  const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
  let bytes = 0;
  let aborted = false;
  const cleanup = () => { try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ } };
  req.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD) {
      aborted = true;
      req.unpipe(out);
      out.destroy();
      cleanup();
      req.destroy();
    }
  });
  req.pipe(out);
  out.on('error', (e) => {
    if (aborted) return;
    aborted = true;
    cleanup();
    try { send(res, 500, 'write error'); } catch { /* ignore */ }
    onDone(e);
  });
  out.on('finish', () => {
    if (aborted) return;
    try {
      fs.renameSync(tmp, finalPath);
      onDone(null);
    } catch (e) {
      cleanup();
      onDone(e);
    }
  });
  req.on('close', () => {
    // req.complete 为 true 表示请求体已完整接收，此时 close 属于正常结束
    if (!req.complete && !aborted && !out.writableFinished) {
      aborted = true;
      cleanup();
      out.destroy();
    }
  });
}

export function createRepoApi({ getRepo, getClientRepoPassword }) {
  return async function handleRepo(req, res, { repoId, clientId, restPath, query }) {
    const repo = getRepo(repoId);
    if (!repo) return send(res, 404, 'repo not found');
    const dir = repoDir(repo, clientId);
    if (!fs.existsSync(dir)) ensureLayout(dir);

    const method = req.method.toUpperCase();
    const p = (restPath || '/').replace(/\/+$/, '');
    if (p === '' || p === '/') {
      if (method === 'POST' && (query.get('create') === 'true' || query.get('create') === '')) {
        ensureLayout(dir);
        return send(res, 200, '');
      }
      return send(res, 405, 'method not allowed');
    }
    const parts = p.split('/').filter(Boolean);
    const type = parts[0];
    if (!TYPES.has(type)) return send(res, 404, 'not found');

    // /config
    if (type === 'config') {
      const file = path.join(dir, 'config');
      if (parts.length === 1 && parts[0] === 'config') {
        if (method === 'GET' || method === 'HEAD') return serveFile(req, res, file, method);
        if (method === 'POST') return atomicWrite(path.join(dir, 'config'), req, res, (err) => {
          if (!err) send(res, 200, '');
        });
        return send(res, 405, 'method not allowed');
      }
      return send(res, 404, 'not found');
    }

    // /<type>/ 列表
    if (parts.length === 1) {
      if (method !== 'GET' && method !== 'HEAD') return send(res, 405, 'method not allowed');
      const typeDir = path.join(dir, type);
      fs.mkdirSync(typeDir, { recursive: true, mode: 0o700 });
      const last = query.get('last') || '';
      const limit = Number(query.get('limit') || 0) || 0;
      let names;
      if (type === 'data') {
        names = [];
        for (const sub of fs.readdirSync(typeDir)) {
          if (!/^[0-9a-f]{2}$/.test(sub)) continue;
          for (const n of fs.readdirSync(path.join(typeDir, sub))) if (safeName(n)) names.push(n);
        }
      } else {
        names = fs.readdirSync(typeDir).filter((n) => safeName(n));
      }
      names.sort();
      if (last) names = names.filter((n) => n > last);
      if (limit > 0) names = names.slice(0, limit);
      const v2 = String(req.headers.accept || '').includes(V2);
      const body = v2
        ? names.map((n) => ({ name: n, size: fs.statSync(filePathFor(dir, type, n)).size }))
        : names;
      const ctype = v2 ? 'application/vnd.x.restic.rest.v2' : 'application/vnd.x.restic.rest.v1';
      res.writeHead(200, { 'Content-Type': ctype, 'Content-Length': Buffer.byteLength(JSON.stringify(body)) });
      if (method === 'HEAD') return res.end();
      return res.end(JSON.stringify(body));
    }

    // /<type>/<name>
    if (parts.length !== 2) return send(res, 404, 'not found');
    const name = parts[1];
    if (!safeName(name)) return send(res, 400, 'invalid name');
    const file = filePathFor(dir, type, name);

    if (method === 'GET' || method === 'HEAD') return serveFile(req, res, file, method);
    if (method === 'POST') {
      return atomicWrite(file, req, res, (err) => {
        if (err) return send(res, 500, 'write failed');
        send(res, 200, '');
      });
    }
    if (method === 'DELETE') {
      if (type !== 'locks') return send(res, 403, 'append-only repository');
      try {
        fs.rmSync(file, { force: true });
        return send(res, 200, '');
      } catch {
        return send(res, 404, 'not found');
      }
    }
    return send(res, 405, 'method not allowed');
  };
}

function serveFile(req, res, file, method) {
  let st;
  try { st = fs.statSync(file); } catch { return send(res, 404, 'not found'); }
  if (!st.isFile()) return send(res, 404, 'not found');
  const size = st.size;
  const headers = {
    'Content-Type': 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(size),
    'Last-Modified': new Date(st.mtimeMs).toUTCString(),
  };
  if (method === 'HEAD') {
    res.writeHead(200, headers);
    return res.end();
  }
  const range = parseRange(req.headers.range, size);
  if (range && range.invalid) {
    res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Content-Type': 'text/plain' });
    return res.end('range not satisfiable');
  }
  if (range) {
    const len = range.end - range.start + 1;
    res.writeHead(206, {
      ...headers,
      'Content-Length': String(len),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
    });
    return fs.createReadStream(file, { start: range.start, end: range.end }).pipe(res);
  }
  res.writeHead(200, headers);
  return fs.createReadStream(file).pipe(res);
}

export function repoLayoutPaths(repo, clientId) {
  const dir = repoDir(repo, clientId);
  return { dir, typeDir: (t) => path.join(dir, t), file: (t, n) => filePathFor(dir, t, n) };
}
