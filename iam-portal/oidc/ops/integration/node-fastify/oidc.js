'use strict';

/**
 * ============================================================
 * OIDC 接入参考实现（Node 20 + Fastify，零第三方 OIDC 依赖）
 * ============================================================
 * 适用：man-timesheet / knowledge-hub 这类「Fastify + 服务端会话」的系统。
 *
 * 设计要点（对应部署文档 §9）：
 *  - 浏览器只持有本系统自己的 session cookie（不接触任何令牌）
 *  - 后端做授权码 + PKCE(S256) 换取，令牌只存在服务端内存/会话里
 *  - 用户主键用 sub；preferred_username 仅用于展示与首次迁移对账
 *  - 登出走 RP-Initiated Logout（带 id_token_hint）
 *
 * 依赖：仅 node:crypto / fetch（Node 18+）。不需要 passport / openid-client。
 * 生产建议：把 pending（state/verifier）与会话放到 Redis 或数据库，
 *           本示例用内存 Map，便于阅读。
 * ============================================================
 */

const crypto = require('node:crypto');

const ISSUER = process.env.OIDC_ISSUER || 'https://sso.tri.local/realms/tri';
const CLIENT_ID = process.env.OIDC_CLIENT_ID;
const CLIENT_SECRET = process.env.OIDC_CLIENT_SECRET;
const REDIRECT_URI = process.env.OIDC_REDIRECT_URI; // 例：https://man.tri.local/auth/callback
const POST_LOGOUT_URI = process.env.OIDC_POST_LOGOUT_URI || 'https://man.tri.local/';
const SESSION_TTL_SECONDS = Number(process.env.SESSION_TTL_MINUTES || 480) * 60;

// ---- 运行时缓存（discovery + JWKS）-------------------------------------
let discovery = null;
let jwks = null;
let jwksFetchedAt = 0;

async function getDiscovery() {
  if (discovery) return discovery;
    const res = await fetch(`${ISSUER}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery 失败: HTTP ${res.status}`);
    discovery = await res.json();
    return discovery;
}

async function getJwks(force = false) {
  const now = Date.now();
  if (!force && jwks && now - jwksFetchedAt < 3600_000) return jwks;
  const d = await getDiscovery();
  const res = await fetch(d.jwks_uri);
  if (!res.ok) throw new Error(`JWKS 获取失败: HTTP ${res.status}`);
  jwks = await res.json();
  jwksFetchedAt = now;
  return jwks;
}

// ---- 工具 ---------------------------------------------------------------
function base64url(buf) {
  return Buffer.from(buf).toString('base64url');
}
function sha256(str) {
  return crypto.createHash('sha256').update(str).digest();
}
function random(n = 32) {
  return base64url(crypto.randomBytes(n));
}

/** 校验 RS256 JWT：签名 + iss + aud + exp/nbf。返回 payload 或抛错。 */
async function verifyJwt(token, { verifyNonce = null } = {}) {
  const [h, p, s] = token.split('.');
  if (!h || !p || !s) throw new Error('JWT 格式错误');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  if (header.alg !== 'RS256') throw new Error(`不接受的签名算法: ${header.alg}`);
  const key = (await getJwks()).keys.find((k) => k.kid === header.kid);
  if (!key) throw new Error(`JWKS 中找不到 kid=${header.kid}`);
  const pub = crypto.createPublicKey({ key, format: 'jwk' });
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${h}.${p}`), pub, Buffer.from(s, 'base64url'));
  if (!ok) throw new Error('JWT 签名校验失败');

  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  const now = Math.floor(Date.now() / 1000);
  if (claims.iss !== ISSUER) throw new Error(`iss 不匹配: ${claims.iss}`);
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(CLIENT_ID)) throw new Error('aud 不匹配');
  if (claims.exp && claims.exp < now - 60) throw new Error('令牌已过期');
  if (claims.nbf && claims.nbf > now + 60) throw new Error('令牌尚未生效');
  if (verifyNonce !== null && claims.nonce !== verifyNonce) throw new Error('nonce 不匹配');
  return claims;
}

// ---- 路由实现（挂到 Fastify 实例）--------------------------------------
/**
 * @param {import('fastify').FastifyInstance} app
 * @param {object} deps  { sessions: SessionStore, users: UserStore }
 */
function registerOidcRoutes(app, deps) {
  const { sessions, users } = deps;

  // ① 发起登录
  app.get('/auth/login', async (req, reply) => {
    const d = await getDiscovery();
    const state = random();
    const nonce = random();
    const verifier = random(48);
    const challenge = base64url(sha256(verifier));
    // 保存一次性参数（与浏览器的 session 绑定）
    await sessions.putPending(state, { nonce, verifier, returnTo: req.query.returnTo || '/' });
    const url = new URL(d.authorization_endpoint);
    url.searchParams.set('client_id', CLIENT_ID);
    url.searchParams.set('redirect_uri', REDIRECT_URI);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid profile email roles');
    url.searchParams.set('state', state);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');
    return reply.code(302).header('location', url.toString()).send();
  });

  // ② 回调
  app.get('/auth/callback', async (req, reply) => {
    const { code, state, error, error_description: errDesc } = req.query;
    if (error) {
      app.log.warn({ error, errDesc }, 'IdP 返回错误');
      return reply.code(401).send({ error, error_description: errDesc });
    }
    const pending = await sessions.takePending(state); // 一次性：取出即删
    if (!pending) return reply.code(400).send({ error: 'invalid_state' });

    const d = await getDiscovery();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: pending.verifier,
    });
    const res = await fetch(d.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      app.log.error({ status: res.status, body: await res.text() }, '换取令牌失败');
      return reply.code(401).send({ error: 'token_exchange_failed' });
    }
    const tokens = await res.json();
    const idClaims = await verifyJwt(tokens.id_token, { verifyNonce: pending.nonce });
    const atClaims = await verifyJwt(tokens.access_token);

    const roles = (atClaims.realm_access && atClaims.realm_access.roles) || [];
    const authUser = {
      sub: idClaims.sub,                       // 主键，永不变
      username: idClaims.preferred_username,   // 展示 & 一次性对账
      name: idClaims.name || idClaims.preferred_username,
      email: idClaims.email,
      roles: roles.filter((r) => r.includes(':')), // 只保留业务角色
    };
    const localUser = await users.upsertBySub(authUser); // 内部按 sub 找/建本地用户
    const sid = random();
    await sessions.create(sid, {
      userId: localUser.id,
      authUser,
      // 只存 refresh_token 用于静默续期；access/id token 不落浏览器
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
    });
    return reply
      .code(302)
      .header('location', pending.returnTo || '/')
      .setCookie('sid', sid, { path: '/', httpOnly: true, secure: true, sameSite: 'lax', maxAge: SESSION_TTL_SECONDS })
      .send();
  });

  // ③ 当前用户（业务页面据此授权）
  app.get('/api/me', async (req, reply) => {
    const session = await sessions.get(req.cookies.sid);
    if (!session) return reply.code(401).send({ error: 'unauthenticated' });
    return {
      user: session.authUser,
      // 业务授权示例：只认角色
      can: {
        approveWorklog: session.authUser.roles.includes('ts:admin'),
        manageFinance: session.authUser.roles.includes('ts:finance'),
      },
    };
  });

  // ④ 登出：本地 + IdP（RP-Initiated Logout）
  app.post('/auth/logout', async (req, reply) => {
    const session = await sessions.get(req.cookies.sid);
    await sessions.destroy(req.cookies.sid);
    let url = POST_LOGOUT_URI;
    if (session) {
      const d = await getDiscovery();
      const u = new URL(d.end_session_endpoint);
      // id_token_hint 用于让 IdP 识别当前会话；示例里保存了 refresh_token，
      // 实际实现可在会话中保存 id_token 原文（不落浏览器即可）
      u.searchParams.set('client_id', CLIENT_ID);
      u.searchParams.set('post_logout_redirect_uri', POST_LOGOUT_URI);
      url = u.toString();
    }
    return reply
      .clearCookie('sid', { path: '/' })
      .code(302)
      .header('location', url)
      .send();
  });
}

module.exports = { registerOidcRoutes, verifyJwt, getDiscovery };

/*
 * ---- 迁移注意（从现有 LDAP 直连切换时）----
 * 1. 现有用户表的 key 若是 sAMAccountName，迁移时加一列 oidc_sub：
 *      UPDATE users SET oidc_sub = <首次登录时按 preferred_username 对账得到的 sub>
 *    之后所有查询按 sub 关联。
 * 2. 现有 LDAP_* 配置与 AD 同步任务全部删除。
 * 3. 保留 AUTH_MODE=oidc|ldap 开关 1 周，验收后删除 LDAP 分支。
 */