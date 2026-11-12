'use strict';
/**
 * ============================================================
 * 知识平台（ai.tri.local）OIDC 客户端 —— 复制为 server/src/oidc.js
 * ============================================================
 * 依赖：node:crypto + node 内置 fetch + pg（本项目已有），无需第三方 OIDC 库。
 * 校验：RS256 签名（JWKS 进程内缓存 1h）、iss、aud、exp/nbf、nonce。
 *
 * 注意：本系统与工时系统不同——它的角色/部门都从 **AD 组** 推导
 * （见 ldap.js 的 mapRole / resolveDepartment），所以必须请求 groups scope，
 * 并从 userinfo 取 groups 数组。roles scope 拿到的 kb:admin / kb:reviewer
 * 用于和 AD 组推导结果做「取高」合并（见 oidc-identity.js）。
 */
const crypto = require('crypto');
const config = require('./config');

const oidc = config.oidc;
let discoveryCache = null;
const jwkCache = { keys: null, at: 0 };

async function discovery() {
  if (discoveryCache) return discoveryCache;
  const res = await fetch(`${oidc.issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery 失败: HTTP ${res.status}`);
  discoveryCache = await res.json();
  return discoveryCache;
}

async function jwks(force = false) {
  const now = Date.now();
  if (!force && jwkCache.keys && now - jwkCache.at < 3600_000) return jwkCache.keys;
  const d = await discovery();
  const res = await fetch(d.jwks_uri);
  if (!res.ok) throw new Error(`JWKS 获取失败: HTTP ${res.status}`);
  const body = await res.json();
  jwkCache.keys = body.keys;
  jwkCache.at = now;
  return body.keys;
}

const b64url = (b) => Buffer.from(b).toString('base64url');
const randomToken = (n = 32) => b64url(crypto.randomBytes(n));
const pkceChallenge = (v) => b64url(crypto.createHash('sha256').update(v).digest());

async function verifyJwt(token, { nonce = null } = {}) {
  const [h, p, s] = String(token).split('.');
  if (!h || !p || !s) throw new Error('JWT 格式错误');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
  if (header.alg !== 'RS256') throw new Error(`不接受的签名算法: ${header.alg}`);

  const tryVerify = (keys) => {
    const key = keys.find((k) => k.kid === header.kid);
    if (!key) return false;
    const pub = crypto.createPublicKey({ key, format: 'jwk' });
    return crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'));
  };
  let ok = tryVerify(await jwks());
  if (!ok) ok = tryVerify(await jwks(true));   // 换密钥后强制刷新一次
  if (!ok) throw new Error('JWT 签名校验失败');

  const c = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (c.iss !== oidc.issuer) throw new Error(`iss 不匹配: ${c.iss}`);
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(oidc.clientId)) throw new Error('aud 不匹配');
  if (c.exp && c.exp < now - 60) throw new Error('令牌已过期');
  if (c.nbf && c.nbf > now + 60) throw new Error('令牌尚未生效');
  if (nonce !== null && c.nonce !== nonce) throw new Error('nonce 不匹配');
  return c;
}

async function buildAuthorizeUrl({ state, nonce, verifier }) {
  const d = await discovery();
  const url = new URL(d.authorization_endpoint);
  url.searchParams.set('client_id', oidc.clientId);
  url.searchParams.set('redirect_uri', oidc.redirectUri);
  url.searchParams.set('response_type', 'code');
  // groups 必须带：本系统的角色与部门都靠 AD 组推导
  url.searchParams.set('scope', oidc.scope);           // openid profile email roles groups
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', pkceChallenge(verifier));
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function exchangeCode(code, verifier) {
  const d = await discovery();
  const res = await fetch(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: oidc.clientId,
      client_secret: oidc.clientSecret,
      code,
      redirect_uri: oidc.redirectUri,
      code_verifier: verifier,
    }),
  });
  const text = await res.text();
  if (!res.ok) throw Object.assign(new Error(`换取令牌失败 HTTP ${res.status}: ${text.slice(0, 200)}`), { code: 'TOKEN_EXCHANGE' });
  return JSON.parse(text);
}

async function userinfo(accessToken) {
  const d = await discovery();
  const res = await fetch(d.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`userinfo 失败: HTTP ${res.status}`);
  const ui = await res.json();
  ui.groups = Array.isArray(ui.groups) ? ui.groups : [];
  return ui;
}

async function logoutUrl(idTokenHint) {
  const d = await discovery();
  const url = new URL(d.end_session_endpoint);
  url.searchParams.set('client_id', oidc.clientId);
  if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
  url.searchParams.set('post_logout_redirect_uri', oidc.postLogoutUri);
  return url.toString();
}

module.exports = { discovery, verifyJwt, buildAuthorizeUrl, exchangeCode, userinfo, logoutUrl, randomToken };
