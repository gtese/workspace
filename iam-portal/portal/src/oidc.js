'use strict';
/**
 * ============================================================
 * OIDC 客户端（零依赖，只用 node:crypto + fetch）
 * ============================================================
 * 职责：登录跳转、回调换令牌、验签、userinfo、登出地址。
 * 不保存任何令牌到浏览器：令牌只在回调那一瞬间用于读取身份，之后只用本站会话。
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');

/* 内网自签证书：Keycloak 的证书链由企业根 CA 签发，Node 默认不信任。
   这里显式构造 https.Agent（ca = 企业根 CA）并用于所有 OIDC 请求，
   不依赖 NODE_EXTRA_CA_CERTS（那必须在进程启动前设置）。 */
const ISSUER = process.env.OIDC_ISSUER || 'https://sso.tri.local/realms/tri';
const CLIENT_ID = process.env.OIDC_CLIENT_ID || 'portal';
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET || '';
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI || 'https://portal.tri.local/auth/callback';
const POST_LOGOUT_URI = process.env.OIDC_POST_LOGOUT_URI || 'https://portal.tri.local/';
const SCOPE = process.env.OIDC_SCOPE || 'openid profile email roles';

let httpsAgent = null;
const CA_FILE = process.env.OIDC_CA_FILE || '';

function agent() {
  if (httpsAgent) return httpsAgent;
  if (CA_FILE && fs.existsSync(CA_FILE)) {
    httpsAgent = new https.Agent({ ca: fs.readFileSync(CA_FILE, 'utf8'), keepAlive: true });
  } else {
    httpsAgent = new https.Agent({ keepAlive: true });
  }
  return httpsAgent;
}

/**
 * 统一出站请求（GET / POST 表单），用 node:https + ca，保证信任企业根 CA。
 * 不依赖 undici/NODE_EXTRA_CA_CERTS，行为可预测、可离线部署。
 * @returns {Promise<{status:number, text:()=>Promise<string>, json:()=>Promise<any>}>}
 */
function request(url, init = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      method: init.method || 'GET',
      headers: Object.assign({ accept: 'application/json' }, init.headers || {}),
      agent: agent(),
      timeout: 15000,
    };
    if (opts.agent && opts.agent.options && opts.agent.options.ca) {
      opts.ca = opts.agent.options.ca;
    }
    const req = https.request(u, opts, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({
        status: res.statusCode,
        headers: res.headers,
        text: async () => buf,
        json: async () => JSON.parse(buf),
      }));
    });
    req.on('timeout', () => req.destroy(new Error('请求 IdP 超时')));
    req.on('error', reject);
    if (init.body) {
      const body = String(init.body);
      req.setHeader('content-length', Buffer.byteLength(body));
      req.write(body);
    }
    req.end();
  });
}

let discoveryCache = null;
let jwksCache = { keys: null, at: 0 };

async function discovery() {
  if (discoveryCache) return discoveryCache;
  const res = await request(`${ISSUER}/.well-known/openid-configuration`);
  if (res.status !== 200) throw new Error(`discovery 失败: HTTP ${res.status}`);
  discoveryCache = await res.json();
  return discoveryCache;
}

async function jwks(force = false) {
  const now = Date.now();
  if (!force && jwksCache.keys && now - jwksCache.at < 3600_000) return jwksCache.keys;
  const d = await discovery();
  const res = await request(d.jwks_uri);
  if (res.status !== 200) throw new Error(`JWKS 失败: HTTP ${res.status}`);
  const body = await res.json();
  jwksCache = { keys: body.keys, at: now };
  return body.keys;
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
const randomToken = (n = 32) => b64url(crypto.randomBytes(n));
const pkceChallenge = (v) => b64url(crypto.createHash('sha256').update(v).digest());

/** 校验 JWT：RS256 签名 + iss + aud + exp/nbf + nonce */
async function verifyJwt(token, { nonce = null, checkAud = true } = {}) {
  const [h, p, s] = String(token).split('.');
  if (!h || !p || !s) throw new Error('JWT 格式错误');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') throw new Error(`不支持的算法: ${header.alg}`);
  const check = (keys) => {
    const k = keys.find((x) => x.kid === header.kid);
    if (!k) return false;
    return crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`),
      crypto.createPublicKey({ key: k, format: 'jwk' }), Buffer.from(s, 'base64url'));
  };
  let ok = check(await jwks());
  if (!ok) ok = check(await jwks(true));
  if (!ok) throw new Error('签名校验失败');

  const c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (c.iss !== ISSUER) throw new Error(`iss 不匹配: ${c.iss}`);
  if (checkAud) {
    const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
    if (!aud.includes(CLIENT_ID)) throw new Error('aud 不匹配');
  }
  if (c.exp && c.exp < now - 60) throw new Error('令牌已过期');
  if (c.nbf && c.nbf > now + 60) throw new Error('令牌尚未生效');
  if (nonce !== null && c.nonce !== nonce) throw new Error('nonce 不匹配');
  return c;
}

/** 生成授权跳转地址 */
async function authorizeUrl({ state, nonce, verifier }) {
  const d = await discovery();
  const u = new URL(d.authorization_endpoint);
  u.searchParams.set('client_id', CLIENT_ID);
  u.searchParams.set('redirect_uri', REDIRECT_URI);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', SCOPE);
  u.searchParams.set('state', state);
  u.searchParams.set('nonce', nonce);
  u.searchParams.set('code_challenge', pkceChallenge(verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

/** 授权码换令牌（服务端到服务端） */
async function exchangeCode(code, verifier) {
  const d = await discovery();
  const res = await request(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    }).toString(),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`换令牌失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

/** 取 userinfo（含业务角色与 AD 组，取决于 scope） */
async function userinfo(accessToken) {
  const d = await discovery();
  const res = await request(d.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } });
  if (res.status !== 200) throw new Error(`userinfo 失败: HTTP ${res.status}`);
  const ui = await res.json();
  ui.groups = Array.isArray(ui.groups) ? ui.groups : [];
  return ui;
}

/** 登出地址（带 id_token_hint，让 IdP 会话真正结束） */
async function logoutUrl(idTokenHint) {
  const d = await discovery();
  const u = new URL(d.end_session_endpoint);
  u.searchParams.set('client_id', CLIENT_ID);
  if (idTokenHint) u.searchParams.set('id_token_hint', idTokenHint);
  u.searchParams.set('post_logout_redirect_uri', POST_LOGOUT_URI);
  return u.toString();
}

/** 业务角色：过滤掉 Keycloak 内建角色，只留 `域:动作` 形式的业务角色 */
function businessRoles(claims) {
  const all = (claims && claims.realm_access && claims.realm_access.roles) || [];
  return all.filter((r) => r.includes(':') && !r.startsWith('default-roles'));
}

module.exports = {
  ISSUER, CLIENT_ID, CA_FILE, discovery, verifyJwt, authorizeUrl, request,
  exchangeCode, userinfo, logoutUrl, randomToken, businessRoles,
};