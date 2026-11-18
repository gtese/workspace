import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from '../src/db.mjs';
import { createAuth } from '../src/auth.mjs';

test('本地管理员初始化、登录、会话与 CSRF', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bc-auth-'));
  const cfg = {
    paths: { data: dir },
    bootstrap_admin: { username: 'admin', password: '' },
    oidc: { enabled: false },
  };
  const store = openDb(path.join(dir, 'test.db'));
  try {
    const auth = createAuth({ cfg, store });
    const created = auth.ensureAdmin();
    assert.equal(created.username, 'admin');
    assert.ok(fs.existsSync(path.join(dir, 'initial-admin.txt')));
    const password = fs.readFileSync(path.join(dir, 'initial-admin.txt'), 'utf8').match(/^password: (.*)$/m)[1];

    assert.throws(() => auth.loginLocal('admin', 'wrong'), /用户名或密码错误/);
    const session = auth.loginLocal('admin', password, { ip: '127.0.0.1' });
    assert.match(session.csrf, /^[A-Za-z0-9_-]{20,}$/);
    const s = auth.sessionFromSid(session.sid);
    assert.equal(s.user.username, 'admin');
    assert.equal(s.user.role, 'admin');
    auth.destroySession(session.sid);
    assert.equal(auth.sessionFromSid(session.sid), null);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
