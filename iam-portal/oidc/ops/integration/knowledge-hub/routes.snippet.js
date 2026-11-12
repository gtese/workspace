'use strict';
/**
 * ============================================================
 * 三个 OIDC 路由 —— 合并进 server/src/index.js
 * ============================================================
 * 现有代码的登录是：POST /api/login（域账号口令）→ ldapmod.authenticate →
 * ldapmod.upsertProfile → newSession → setSessionCookie。
 *
 * 改造后：GET /api/auth/oidc/login → IdP → GET /api/auth/oidc/callback → 
 *         upsertProfile（同样的函数！只是 profile 来源换成 OIDC）→ newSession → setSessionCookie。
 *
 * 复用点（重要）：会话、CSRF、权限、审计全部沿用现有实现，不改。
 */

const crypto = require('crypto');
const oidc = require('./oidc');
const oidcIdentity = require('./oidcIdentity');
const ldapmod = require('./ldap');
const config = require('./config');
const db = require('./db');
const perms = require('./permissions');

// 一次性登录票据（state → {nonce, verifier, exp}）。
// 本系统是单实例（kb-app），进程内 Map 足够；
// 若将来多实例部署，改为落 Redis 或 DB（表结构见 migration.sql）。
const PENDING = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;
function sweepPending() {
  const now = Date.now();
  for (const [k, v] of PENDING) if (v.exp < now) PENDING.delete(k);
}

module.exports = function registerOidcRoutes(app, { newSession, setSessionCookie, clientMeta, normalizeUsername, publicUser }) {
  // ① 发起登录：整页跳转（前端 <a href="/api/auth/oidc/login">）
  app.get('/api/auth/oidc/login', async (req, reply) => {
    sweepPending();
    const state = oidc.randomToken();
    const nonce = oidc.randomToken();
    const verifier = oidc.randomToken(48);
    const returnTo = typeof req.query?.returnTo === 'string' && req.query.returnTo.startsWith('/')
      ? req.query.returnTo : '/';
    PENDING.set(state, { nonce, verifier, returnTo, exp: Date.now() + PENDING_TTL_MS });
    const url = await oidc.buildAuthorizeUrl({ state, nonce, verifier });
    reply.header('cache-control', 'no-store');
    return reply.redirect(url);
  });

  // ② 回调
  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const { code, state, error, error_description: desc } = req.query || {};
    if (error) {
      req.log.warn({ error, desc }, 'IdP 返回错误');
      return reply.code(401).send({ error: { code: 'OIDC_ERROR', message: desc || error } });
    }
    const ticket = PENDING.get(String(state));
    PENDING.delete(String(state));
    if (!ticket || ticket.exp < Date.now()) {
      return reply.code(400).send({ error: { code: 'INVALID_STATE', message: '登录已超时，请重新登录' } });
    }

    let tokens, claims, ui;
    try {
      tokens = await oidc.exchangeCode(String(code), ticket.verifier);
      claims = await oidc.verifyJwt(tokens.id_token, { nonce: ticket.nonce });
      await oidc.verifyJwt(tokens.access_token);       // 校验 access token（角色在里面）
      ui = await oidc.userinfo(tokens.access_token);
    } catch (err) {
      req.log.warn({ err: err.message }, 'OIDC 校验失败');
      await db.query(
        `INSERT INTO audit_log (actor_name, action, target_type, detail, ip, user_agent)
         VALUES ($1,'login','user',$2,$3,$4)`,
        [String(req.query?.state || '').slice(0, 20), JSON.stringify({ ok: false, via: 'oidc', reason: err.message }),
         clientMeta(req).ip, clientMeta(req).ua]);
      return reply.code(401).send({ error: { code: 'OIDC_VERIFY', message: '公司账号验证失败，请重试' } });
    }

    // 角色：access_token.realm_access.roles（groups 来自 userinfo）
    const atPayload = JSON.parse(Buffer.from(tokens.access_token.split('.')[1], 'base64url').toString('utf8'));
    const roles = atPayload?.realm_access?.roles || [];

    const built = oidcIdentity.buildProfile(claims, { groups: ui.groups, roles }, config.ldap.allowedGroups);
    if (!built.ok) {
      await db.query(
        `INSERT INTO audit_log (actor_name, action, target_type, detail, ip, user_agent)
         VALUES ($1,'login','user',$2,$3,$4)`,
        [String(claims.preferred_username || ''), JSON.stringify({ ok: false, via: 'oidc', reason: built.reason }),
         clientMeta(req).ip, clientMeta(req).ua]);
      return reply.code(403).send({ error: { code: 'NOT_AUTHORIZED', message: built.message } });
    }

    // ★ 完全复用现有 upsertProfile：用户、部门、角色、AD 组关系都按原逻辑落库
    const user = await ldapmod.upsertProfile(db, {
      ...built.profile,
      username: normalizeUsername(built.profile.username),
    });
    // 记录 IdP 主体（新增列，见 migration.sql）
    if (built.profile.oidcSub && built.profile.oidcSub !== user.oidc_sub) {
      await db.query('UPDATE users SET oidc_sub = $2, updated_at = now() WHERE id = $1', [user.id, built.profile.oidcSub]);
    }

    // 会话与 CSRF 沿用现有实现
    const { sid, csrf } = newSession(user.id);
    setSessionCookie(reply, sid);
    await db.query(
      `INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, detail, ip, user_agent)
       VALUES ($1,$2,'login','user',$3,$4,$5,$6)`,
      [user.id, user.display_name || user.username, user.id,
        JSON.stringify({ role: user.role, department: user.department_key, via: 'oidc' }),
        clientMeta(req).ip, clientMeta(req).ua]);

    // 回到原页面（cookie 已带 csrf，前端 boot() 会从 /api/me 再取一次）
    reply.header('cache-control', 'no-store');
    return reply.redirect(ticket.returnTo || '/');
  });

  // ③ 登出：清本地会话 + 跳 IdP（让其它系统一起退出）
  app.post('/api/auth/logout/oidc', async (req, reply) => {
    const url = await oidc.logoutUrl(null);
    return { ok: true, logoutUrl: url };
  });
};
