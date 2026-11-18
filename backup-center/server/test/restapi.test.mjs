import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRepoApi } from '../src/restapi.mjs';

function sha256(s) { return crypto.createHash('sha256').update(s).digest('hex'); }

test('REST 协议：建库、上传、列表、范围读取、append-only 删除策略', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-rest-'));
  const repo = { id: 'r_test', mountpoint: root };
  const api = createRepoApi({ getRepo: (id) => (id === 'r_test' ? repo : null) });
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const m = /^\/repo\/([^/]+)\/([^/]+)(\/.*)?$/.exec(u.pathname);
    if (!m) { res.writeHead(404); return res.end(); }
    api(req, res, { repoId: m[1], clientId: m[2], restPath: m[3] || '/', query: u.searchParams });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}/repo/r_test/c_1`;

  try {
    let res = await fetch(`${base}/?create=true`, { method: 'POST' });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(path.join(root, 'c_1', 'data')), true);

    // 非 data 类型：平铺写入 key
    const keyBody = '{"k":1}';
    const keyName = sha256(keyBody);
    res = await fetch(`${base}/keys/${keyName}`, { method: 'POST', body: keyBody, headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(path.join(root, 'c_1', 'keys', keyName)), true);

    res = await fetch(`${base}/keys/`, { headers: { accept: 'application/vnd.x.restic.rest.v2' } });
    assert.equal(res.headers.get('content-type'), 'application/vnd.x.restic.rest.v2');
    const list = await res.json();
    assert.deepEqual(list.map((x) => x.name), [keyName]);

    // data 类型：写入分片目录
    const packBody = 'pack-data';
    const packName = sha256(packBody);
    res = await fetch(`${base}/data/${packName}`, { method: 'POST', body: packBody, headers: { 'content-type': 'application/octet-stream' } });
    assert.equal(res.status, 200);
    assert.equal(fs.existsSync(path.join(root, 'c_1', 'data', packName.slice(0, 2), packName)), true);

    res = await fetch(`${base}/data/${packName}`, { headers: { range: 'bytes=0-3' } });
    assert.equal(res.status, 206);
    assert.equal(await res.text(), 'pack');
    assert.equal(res.headers.get('content-range'), `bytes 0-3/${packBody.length}`);

    // append-only：locks 可删，其他不可删
    res = await fetch(`${base}/locks/${keyName}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    res = await fetch(`${base}/keys/${keyName}`, { method: 'DELETE' });
    assert.equal(res.status, 403);
  } finally {
    await new Promise((r) => server.close(r));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
