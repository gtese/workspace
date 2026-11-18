import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { hashPassword, verifyPassword, hashToken } from './crypt.mjs';
import { ApiError, fail, id, nowIso, randomToken } from './util.mjs';

const SESSION_TTL_MS = 8 * 3600 * 1000;

function b64url(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function createAuth({ cfg, store }) {
  const loginFails = new Map();

  function rateLimit(key) {
    const now = Date.now();
    const rec = loginFails.get(key);
    if (!rec || now - rec.first > 5 * 60 * 1000) { loginFails.set(key, { count: 0, first: now }); return; }
    if (rec.count >= 8) throw new ApiError(429, 'rate_limited', '登录尝试过于频繁，请 5 分钟后再试');
  }

  function userById(userId) {
    return store.get('SELECT id,username,display_name,email,role,source,enabled,created_at,last_login_at FROM users WHERE id=?', userId);
  }

  function createSession(userId, { ip = '', ua = '' } = {}) {
    const sid = randomToken(32);
    const csrf = randomToken(24);
    const expires = new Date(Date.now() + SESSION_TTL_MS).toISOString();
    store.run('INSERT INTO sessions(sid_hash,user_id,csrf,ip,ua,created_at,expires_at) VALUES(?,?,?,?,?,?,?)',
      hashToken(sid), userId, csrf, ip, String(ua).slice(0, 255), nowIso(), expires);
    return { sid, csrf, expiresAt: expires };
  }

  function sessionFromSid(sid) {
    if (!sid) return null;
    const row = store.get('SELECT * FROM sessions WHERE sid_hash=?', hashToken(sid));
    if (!row) return null;
    if (new Date(row.expires_at).getTime() < Date.now()) {
      store.run('DELETE FROM sessions WHERE sid_hash=?', row.sid_hash);
      return null;
    }
    const user = userById(row.user_id);
    if (!user || !user.enabled) return null;
    return { sidHash: row.sid_hash, csrf: row.csrf, user };
  }

  function destroySession(sid) {
    if (sid) store.run('DELETE FROM sessions WHERE sid_hash=?', hashToken(sid));
  }

  function cleanup() {
    store.run("DELETE FROM sessions WHERE expires_at < ?", nowIso());
    const now = Date.now();
    for (const [k, v] of loginFails) if (now - v.first > 10 * 60 * 1000) loginFails.delete(k);
  }

  function loginLocal(username, password, meta = {}) {
    const key = `${meta.ip || ''}|${username}`;
    rateLimit(key);
    const user = store.get('SELECT * FROM users WHERE username=? AND source=\'local\'', String(username || ''));
    const ok = !!user && user.enabled && verifyPassword(password, user.password_hash);
    if (!ok) {
      const rec = loginFails.get(key) || { count: 0, first: Date.now() };
      rec.count += 1;
      loginFails.set(key, rec);
      throw new ApiError(401, 'unauthorized', '用户名或密码错误');
    }
    loginFails.delete(key);
    store.run('UPDATE users SET last_login_at=? WHERE id=?', nowIso(), user.id);
    return createSession(user.id, meta);
  }

  function ensureAdmin() {
    const count = store.get('SELECT COUNT(*) AS n FROM users');
    if (count && count.n > 0) return null;
    const username = cfg.bootstrap_admin.username || 'admin';
    let password = cfg.bootstrap_admin.password || '';
    let generated = false;
    if (!password) { password = randomToken(18); generated = true; }
    const userId = id('u', 6);
    store.run('INSERT INTO users(id,username,display_name,role,source,password_hash,enabled,created_at) VALUES(?,?,?,?,?,?,1,?)',
      userId, username, '系统管理员', 'admin', 'local', hashPassword(password), nowIso());
    if (generated) {
      const file = path.join(cfg.paths.data, 'initial-admin.txt');
      fs.writeFileSync(file, `username: ${username}\npassword: ${password}\ncreated: ${nowIso()}\n`, { mode: 0o600 });
      return { username, file };
    }
    return { username, file: null };
  }

  /* ---------------- OIDC ---------------- */
  let discoveryCache = null;

  function httpsJson(url, { method = 'GET', headers = {}, body = null, caFile } = {}) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const opts = { method, headers: { accept: 'application/json', ...headers }, timeout: 15000, ...(caFile && fs.existsSync(caFile) ? { ca: fs.readFileSync(caFile, 'utf8') } : {}) };
      const req = https.request(u, opts, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          if (res.statusCode < 200 || res.statusCode >= 300) return reject(new ApiError(502, 'oidc_error', `OIDC 请求失败：${res.statusCode}`));
          try { resolve(JSON.parse(text)); } catch { reject(new ApiError(502, 'oidc_error', 'OIDC 响应不是 JSON')); }
        });
      });
      req.on('timeout', () => req.destroy(new Error('OIDC 超时')));
      req.on('error', reject);
      if (body) req.write(body);
      req.end();
    });
  }

  async function discovery() {
    if (discoveryCache && Date.now() - discoveryCache.at < 10 * 60 * 1000) return discoveryCache.value;
    const url = `${cfg.oidc.issuer.replace(/\/$/, '')}/.well-known/openid-configuration`;
    const value = await httpsJson(url, { caFile: cfg.oidc.ca_file });
    discoveryCache = { at: Date.now(), value };
    return value;
  }

  async function jwks() {
    const d = await discovery();
    return httpsJson(d.jwks_uri, { caFile: cfg.oidc.ca_file });
  }

  function verifyJwt(token, keys, { issuer, clientId, nonce }) {
    const parts = String(token).split('.');
    if (parts.length !== 3) throw new ApiError(401, 'oidc_error', 'id_token 格式错误');
    const [h, p, s] = parts;
    const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    const jwk = keys.find((k) => k.kid === header.kid) || keys[0];
    if (!jwk) throw new ApiError(401, 'oidc_error', '找不到签名密钥');
    const key = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'));
    if (!ok) throw new ApiError(401, 'oidc_error', 'id_token 签名校验失败');
    if (payload.iss !== issuer) throw new ApiError(401, 'oidc_error', 'issuer 不匹配');
    const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (!aud.includes(clientId)) throw new ApiError(401, 'oidc_error', 'audience 不匹配');
    if (payload.exp && payload.exp * 1000 < Date.now()) throw new ApiError(401, 'oidc_error', 'id_token 已过期');
    if (nonce && payload.nonce !== nonce) throw new ApiError(401, 'oidc_error', 'nonce 不匹配');
    return payload;
  }

  async function oidcStart(returnTo = '/') {
    if (!cfg.oidc.enabled) throw new ApiError(404, 'not_found', '未启用 OIDC');
    const d = await discovery();
    const state = randomToken(24);
    const nonce = randomToken(24);
    const verifier = randomToken(48);
    const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
    store.run('DELETE FROM oidc_states WHERE created_at < ?', new Date(Date.now() - 10 * 60 * 1000).toISOString());
    store.run('INSERT INTO oidc_states(state,nonce,verifier,return_to,created_at) VALUES(?,?,?,?,?)',
      state, nonce, verifier, returnTo, nowIso());
    const u = new URL(d.authorization_endpoint);
    u.searchParams.set('client_id', cfg.oidc.client_id);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('redirect_uri', cfg.oidc.redirect_uri);
    u.searchParams.set('scope', cfg.oidc.scope || 'openid profile email');
    u.searchParams.set('state', state);
    u.searchParams.set('nonce', nonce);
    u.searchParams.set('code_challenge', challenge);
    u.searchParams.set('code_challenge_method', 'S256');
    return { url: u.toString(), state };
  }

  async function oidcCallback(code, state) {
    if (!cfg.oidc.enabled) throw new ApiError(404, 'not_found', '未启用 OIDC');
    const row = store.get('SELECT * FROM oidc_states WHERE state=?', String(state || ''));
    if (!row) throw new ApiError(400, 'oidc_error', 'state 无效或已过期');
    store.run('DELETE FROM oidc_states WHERE state=?', row.state);
    const d = await discovery();
    const form = new URLSearchParams({
      grant_type: 'authorization_code', code: String(code),
      redirect_uri: cfg.oidc.redirect_uri, client_id: cfg.oidc.client_id,
      code_verifier: row.verifier,
    });
    const headers = { 'content-type': 'application/x-www-form-urlencoded' };
    if (cfg.oidc.client_secret) {
      headers.authorization = 'Basic ' + Buffer.from(`${cfg.oidc.client_id}:${cfg.oidc.client_secret}`).toString('base64');
    }
    const tok = await httpsJson(d.token_endpoint, { method: 'POST', headers, body: form.toString(), caFile: cfg.oidc.ca_file });
    if (!tok.id_token) throw new ApiError(502, 'oidc_error', '未返回 id_token');
    const keys = await jwks();
    const claims = verifyJwt(tok.id_token, keys.keys || [], {
      issuer: cfg.oidc.issuer.replace(/\/$/, ''), clientId: cfg.oidc.client_id, nonce: row.nonce,
    });
    const asList = (v) => (Array.isArray(v) ? v : v ? [v] : []);
    const groups = asList(claims.groups);
    const roles = [...asList(claims.roles), ...asList(claims.realm_access && claims.realm_access.roles)];
    const norm = (s) => String(s || '').toLowerCase().replace(/^\/+/, '');
    const adminMatchers = [cfg.oidc.admin_group, cfg.oidc.admin_role, 'Group_Roots', 'backup:admin']
      .filter(Boolean).map(norm);
    const hasAdmin = [...groups, ...roles].some((v) => adminMatchers.includes(norm(v)));
    let role = 'viewer';
    if (hasAdmin) role = 'admin';
    else if (cfg.oidc.operator_group && [...groups, ...roles].some((v) => norm(v) === norm(cfg.oidc.operator_group))) role = 'operator';
    const username = String(claims.preferred_username || claims.email || claims.sub).slice(0, 128);
    let user = store.get('SELECT * FROM users WHERE username=?', username);
    if (!user) {
      const userId = id('u', 6);
      store.run('INSERT INTO users(id,username,display_name,email,role,source,enabled,created_at) VALUES(?,?,?,?,?,?,1,?)',
        userId, username, String(claims.name || username), String(claims.email || ''), role, 'oidc', nowIso());
      user = store.get('SELECT * FROM users WHERE id=?', userId);
    } else {
      store.run('UPDATE users SET display_name=?,email=?,role=?,last_login_at=? WHERE id=?',
        String(claims.name || user.display_name || username), String(claims.email || user.email || ''), role, nowIso(), user.id);
      user = store.get('SELECT * FROM users WHERE id=?', user.id);
    }
    const session = createSession(user.id, {});
    return { session, returnTo: row.return_to || '/', user };
  }

  function logoutUrl() {
    if (!cfg.oidc.enabled) return null;
    const d = discoveryCache && discoveryCache.value;
    if (!d || !d.end_session_endpoint) return null;
    const u = new URL(d.end_session_endpoint);
    u.searchParams.set('post_logout_redirect_uri', cfg.oidc.post_logout_uri);
    u.searchParams.set('client_id', cfg.oidc.client_id);
    return u.toString();
  }

  return {
    createSession, sessionFromSid, destroySession, loginLocal, ensureAdmin, cleanup,
    oidcStart, oidcCallback, logoutUrl, userById, discovery, rateLimit,
  };
}
