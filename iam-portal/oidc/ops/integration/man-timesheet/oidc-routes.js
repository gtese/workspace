/**
 * ============================================================
 * OIDC 路由（合并进 server/src/routes.js 的 routes(app) 函数内）
 * ============================================================
 * 三个路由：
 *   GET  /api/auth/login            302 → IdP 登录页（带 PKCE/state/nonce）
 *   GET  /api/auth/oidc/callback    校验并换令牌 → 建本系统会话 → 302 回原页面
 *   POST /api/auth/logout           清本地会话 → 跳 IdP 登出（RP-Initiated Logout）
 *
 * 与旧 LDAP 登录的关系：
 *   - AUTH_MODE=oidc 时只暴露上面两个 GET；旧的 POST /api/auth/login（账号口令）整段删除/关闭
 *   - AUTH_MODE=ldap 时（仅切换期保留）逆向使用旧路由，便于回滚
 */
import { z } from 'zod';
import * as oidc from './oidc.js';
import { config } from './config.js';
import * as repo from './repo.js';
import { deriveRole } from './auth.js';
import { loadUser, currentUser, createSession, setSessionCookie, clearSessionCookie } from './auth.js';
import { groupMatches, groupNames } from './ldap.js';

// ------------------------------------------------------------------ 一次性状态
// state/nonce/verifier 需要跨两次请求（登录时存、回调时取）。
// 本系统已有 DB，直接落到「一次性票据表」，避免引入 Redis；
// 若不想加表，也可以用一个进程内 Map（单实例可行，多实例必须用共享存储）。
const pending = new Map(); // state -> { nonce, verifier, returnTo, exp }
const PENDING_TTL_MS = 10 * 60 * 1000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
}

export default async function oidcRoutes(app) {
  if (config.authMode !== 'oidc') return;   // 切换期：ldap 模式不暴露 OIDC 路由

  // ① 发起登录
  app.get('/api/auth/login', async (req, reply) => {
    sweep();
    const state = oidc.randomToken();
    const nonce = oidc.randomToken();
    const verifier = oidc.randomToken(48);
    const returnTo = typeof req.query?.returnTo === 'string' && req.query.returnTo.startsWith('/')
      ? req.query.returnTo : '/';
    pending.set(state, { nonce, verifier, returnTo, exp: Date.now() + PENDING_TTL_MS });
    const url = await oidc.buildAuthorizationUrl({
      state, nonce, codeChallenge: oidc.pkceChallenge(verifier), returnTo,
    });
    reply.header('cache-control', 'no-store');
    return reply.redirect(url);
  });

  // ② 回调
  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const { code, state, error, error_description: desc } = req.query ?? {};
    if (error) {
      app.log.warn({ error, desc }, 'IdP 返回错误');
      return reply.code(401).send({ error: desc || error, code: 'OIDC_ERROR' });
    }
    const ticket = pending.get(String(state));
    pending.delete(String(state));            // 一次性
    if (!ticket || ticket.exp < Date.now()) {
      await repo.audit(null, 'auth.login.failed', null, null, { code: 'INVALID_STATE' }, req.ip);
      return reply.code(400).send({ error: '登录会话已过期，请重新登录', code: 'INVALID_STATE' });
    }

    // 2.1 换令牌 + 校验
    let tokens, idc, ui;
    try {
      tokens = await oidc.exchangeCode(String(code), ticket.verifier);
      idc = await oidc.verifyIdToken(tokens.id_token, ticket.nonce);
      ui = await oidc.fetchUserInfo(tokens.access_token);
    } catch (err) {
      app.log.warn({ err: err.message }, 'OIDC 换取/校验失败');
      await repo.audit(null, 'auth.login.failed', null, null, { code: err.code || 'OIDC_VERIFY' }, req.ip);
      return reply.code(401).send({ error: '公司账号验证失败，请重试', code: 'OIDC_VERIFY' });
    }

    // 2.2 准入（沿用现有的"组准入"语义，只是组改从 userinfo 拿）
    const username = String(idc.preferred_username).toLowerCase();
    const groups = ui.groups ?? [];
    if (config.ldap.allowedGroups.length && !oidc.groupsAllowed(groups, config.ldap.allowedGroups)) {
      await repo.audit(null, 'auth.login.denied', username, null,
        { reason: 'not_in_allowed_groups', groups }, req.ip);
      return reply.code(403).send({
        error: '您的账号不在本系统授权范围内，请联系 IT 或人力资源部',
        code: 'NOT_AUTHORIZED',
      });
    }

    // 2.3 对账：首次按 username 绑定 oidc_sub；之后按 sub 找
    let user = await repo.getUserByOidcSub(idc.sub);
    if (!user) user = await repo.getUserByUsername(username);
    const adShape = {
      username,
      displayName: idc.name || idc.preferred_username,
      email: idc.email || null,
      dn: null,                       // OIDC 不再暴露 DN，留空（历史列兼容）
      department: null,
      title: null,
      disabled: false,
      groups: groups.map((g) => `CN=${g}`),   // 复用现有 upsert 的 groups 解析
    };
    if (!user) {
      user = await repo.upsertUserFromAd(adShape, deriveRole(adShape.groups));
    } else if (!user.is_active) {
      return reply.code(403).send({ error: '该账号已停用，请联系人力资源部', code: 'INACTIVE' });
    } else {
      user = await repo.upsertUserFromAd(adShape, user.role);   // 刷新姓名/邮箱/组，不动业务属性
    }
    await repo.bindOidcSubject(user.id, idc.sub);                 // users.oidc_sub = sub

    // 2.4 建立本系统会话（复用现有 HS256 JWT + cookie）
    const token = await createSession(user);
    setSessionCookie(reply, token);
    await repo.touchLogin(user.id);
    await repo.audit(user.id, 'auth.login', username, null, { via: 'oidc' }, req.ip);

    // 2.5 回到用户原本要去的页面（只允许站内相对路径）
    const back = ticket.returnTo?.startsWith('/') ? ticket.returnTo : '/';
    reply.header('cache-control', 'no-store');
    return reply.redirect(back);
  });

  // ③ 登出：本地 + IdP
  app.post('/api/auth/logout', async (req, reply) => {
    const me = await currentUser(req);
    clearSessionCookie(reply);
    if (me) await repo.audit(me.id, 'auth.logout', me.username, null, { via: 'oidc' }, req.ip);
    // 注意：要让"登出其它系统"生效，必须走 IdP 的 end_session_endpoint；
    // 前端拿到 logoutUrl 后整页跳转（不要 fetch），否则 cookie 清不掉。
    const url = await oidc.buildLogoutUrl(null);
    return { ok: true, logoutUrl: url };
  });
}

/*
 * ------------------------------------------------------------------
 * 前端配合（web/src）：
 *  1) LoginView.vue：删掉账号口令表单，只留一个按钮：
 *       window.location.href = '/api/auth/login?returnTo=' + encodeURIComponent(location.pathname)
 *  2) api.js 的 401 处理：原来是跳 /login，改为跳 '/api/auth/login?returnTo=...'
 *  3) 登出：await api.post('/api/auth/logout') 然后 location.href = res.logoutUrl
 *  4) App.vue 顶部"用户名"从 /api/auth/me 的 user.display_name 取（不变）
 * ------------------------------------------------------------------
 */