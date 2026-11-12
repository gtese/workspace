/**
 * ============================================================
 * OIDC 客户端（Keycloak）— 复制为 server/src/oidc.js
 * ============================================================
 * 只依赖 node:crypto、jose（rnd-timesheet 已有）、node:fetch。
 *
 * 设计：
 *  - 浏览器只持有本系统 session cookie（HS256 JWT，复用 auth.js）
 *  - 授权码 + PKCE(S256) 在后端完成；access/id token 不进浏览器
 *  - discovery 与 JWKS 进程内缓存（JWKS 1 小时，验签失败时强制刷新一次）
 *  - 登出走 RP-Initiated Logout（带 id_token_hint），避免"只登出一个系统"
 */
import crypto from 'node:crypto';
import https from 'node:https';
import fs from 'node:fs';
import { jwtVerify, createLocalJWKSet } from 'jose';
import { config } from './config.js';

const oidc = config.oidc;

/**
 * 带企业根 CA 的 HTTPS 请求。
 *
 * 容器内的 Node 不一定信任 sso.tri.local 的证书（企业自签根 CA），
 * 因此这里显式加载根证书做校验 —— 既保证安全，又不引入新依赖。
 * 若 oidc.caFile 未配置，则退回系统默认信任链。
 */
let _caCache = null;
function caList() {
  if (_caCache !== null) return _caCache;
  try {
    _caCache = oidc.caFile && fs.existsSync(oidc.caFile)
      ? [fs.readFileSync(oidc.caFile)]
      : undefined;
  } catch { _caCache = undefined; }
  return _caCache;
}

function httpsRequest(urlString, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    const opts = {
      method,
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      headers: { ...headers },
      ca: caList(),
      timeout: oidc.timeoutMs || 10000,
    };
    if (body) opts.headers['content-length'] = Buffer.byteLength(body);
    const req = https.request(opts, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          headers: res.headers,
          text: () => Promise.resolve(text),
          json: () => Promise.resolve(JSON.parse(text)),
        });
      });
    });
    req.on('timeout', () => { req.destroy(new Error(`OIDC 请求超时: ${urlString}`)); });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

let discoveryCache = null;
let jwksCache = null;

export async function discovery() {
  if (discoveryCache) return discoveryCache;
  const res = await httpsRequest(`${oidc.issuer}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery 失败: HTTP ${res.status}`);
  discoveryCache = await res.json();
  return discoveryCache;
}

/**
 * JWKS 公钥集。
 *
 * 注意：jose v5 的 createRemoteJWKSet 不支持自定义 fetcher，
 * 无法复用上面带企业 CA 的 httpsRequest。因此这里**自己拉取 JWKS**，
 * 用 createLocalJWKSet 构建验签器，并做 1 小时缓存 + 失败自动刷新。
 */
let _jwksJson = null;
let _jwksAt = 0;
let _localJwks = null;
const JWKS_TTL_MS = 60 * 60 * 1000;

async function loadJwks({ force = false } = {}) {
  const now = Date.now();
  if (!force && _jwksJson && now - _jwksAt < JWKS_TTL_MS) return _localJwks;
  const d = await discovery();
  const res = await httpsRequest(d.jwks_uri);
  if (!res.ok) throw new Error(`JWKS 获取失败: HTTP ${res.status}`);
  _jwksJson = await res.json();
  _jwksAt = now;
  _localJwks = createLocalJWKSet(_jwksJson);
  return _localJwks;
}

/** 启动时预热，避免首次登录多一次往返 */
export async function warmup() {
  try {
    await Promise.all([discovery(), loadJwks()]);
    return true;
  } catch (err) {
    console.warn('[oidc] 预热失败:', err.message);
    return false;
  }
}

const b64url = (buf) => Buffer.from(buf).toString('base64url');
export const pkceChallenge = (verifier) =>
  b64url(crypto.createHash('sha256').update(verifier).digest());
export const randomToken = (n = 32) => b64url(crypto.randomBytes(n));

/** 拼授权地址（登录时 302 到 IdP） */
export async function buildAuthorizationUrl({ state, nonce, codeChallenge, returnTo }) {
  const d = await discovery();
  const url = new URL(d.authorization_endpoint);
  url.searchParams.set('client_id', oidc.clientId);
  url.searchParams.set('redirect_uri', oidc.redirectUri);
  url.searchParams.set('response_type', 'code');
  // groups 必须请求：本系统的准入/财务/管理员判定仍依赖 AD 组
  url.searchParams.set('scope', oidc.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (returnTo) url.searchParams.set('redirect_after', returnTo); // 自定义参数，IdP 会原样带回
  return url.toString();
}

/** 用授权码换令牌（后端到后端） */
export async function exchangeCode(code, codeVerifier) {
  const d = await discovery();
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: oidc.clientId,
    client_secret: oidc.clientSecret,
    code,
    redirect_uri: oidc.redirectUri,
    code_verifier: codeVerifier,
  });
  const res = await httpsRequest(d.token_endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`换取令牌失败: HTTP ${res.status} ${text.slice(0, 200)}`);
    err.code = 'OIDC_TOKEN_EXCHANGE';
    throw err;
  }
  return JSON.parse(text);
}

/**
 * 校验 ID Token：签名(RS256/JWKS) + iss + aud + exp/nbf + nonce。
 * 返回 payload（含 sub / preferred_username / name / email）。
 */
export async function verifyIdToken(idToken, expectedNonce) {
  // 正常用缓存的 JWKS；失败时强制刷新一次（IdP 可能轮换了密钥）
  let jwksSet;
  try {
    jwksSet = await loadJwks();
  } catch (e) {
    throw new Error(`JWKS 不可用: ${e.message}`);
  }
  const opts = {
    issuer: oidc.issuer,
    audience: oidc.clientId,
    algorithms: ['RS256'],
    clockTolerance: 60,
  };
  let payload;
  try {
    ({ payload } = await jwtVerify(idToken, jwksSet, opts));
  } catch (err) {
    // 密钥可能已轮换：刷新后重试一次
    jwksSet = await loadJwks({ force: true });
    ({ payload } = await jwtVerify(idToken, jwksSet, opts));
  }
  if (expectedNonce && payload.nonce !== expectedNonce) throw new Error('nonce 不匹配');
  return payload;
}

/**
 * 取 userinfo（含 groups claim，需 client 分配 groups scope）。
 * 返回 { sub, preferred_username, name, email, groups: ['Group_AllStaffs', ...] }
 */
export async function fetchUserInfo(accessToken) {
  const d = await discovery();
  const res = await httpsRequest(d.userinfo_endpoint, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`userinfo 失败: HTTP ${res.status}`);
  const ui = await res.json();
  ui.groups = Array.isArray(ui.groups) ? ui.groups : [];
  return ui;
}

/** 登出地址（RP-Initiated Logout） */
export async function buildLogoutUrl(idTokenHint) {
  const d = await discovery();
  const url = new URL(d.end_session_endpoint);
  url.searchParams.set('client_id', oidc.clientId);
  if (idTokenHint) url.searchParams.set('id_token_hint', idTokenHint);
  url.searchParams.set('post_logout_redirect_uri', oidc.postLogoutUri);
  return url.toString();
}

/** 是否 IP 与 AD 组准入通过（复用现有 ldap.js 的 groupMatches 语义） */
export function groupsAllowed(groups, allowedGroups) {
  if (!allowedGroups.length) return true;
  const norm = (s) => String(s).toLowerCase();
  return groups.some((g) => allowedGroups.some((w) => norm(g) === norm(w)));
}