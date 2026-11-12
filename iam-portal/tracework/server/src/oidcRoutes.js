/**
 * OIDC（统一身份 sso.tri.local）登录路由。
 *
 * 三个入口：
 *   GET  /api/auth/login            → 302 到 IdP（带 PKCE/state/nonce）
 *   GET  /api/auth/oidc/callback    → 校验并建本系统会话，302 回原页面
 *   POST /api/auth/logout           → 清本地会话，返回 IdP 登出地址
 *
 * 设计要点：
 *   · 一次性状态（state/nonce/verifier）存进程内 Map，TTL 10 分钟
 *     单实例部署够用；若以后多实例，需换成共享存储（见 README）
 *   · 浏览器只拿本系统 HttpOnly cookie，不接触任何令牌
 *   · 准入、角色、用户落库全部沿用原有逻辑，业务代码零改动
 *   · IdP 不可用时**拒绝登录**，不存在降级免登录路径
 */
import * as oidc from './oidc.js';
import { config } from './config.js';
import * as repo from './repo.js';
import {
  deriveRole, deriveEmployeeType,
  createSession, setSessionCookie, clearSessionCookie, currentUser,
} from './auth.js';
import { extractCn } from './ldap.js';

// state -> { nonce, verifier, returnTo, exp }
const pending = new Map();
const PENDING_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING = 5000;

function sweep() {
  const now = Date.now();
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
  // 防御：异常流量下避免 Map 无限增长
  if (pending.size > MAX_PENDING) {
    const keys = [...pending.keys()].slice(0, pending.size - MAX_PENDING);
    for (const k of keys) pending.delete(k);
  }
}

/**
 * 把各种形态的组标识归一化为纯组名。
 *   "Group_AllStaffs"                     -> "Group_AllStaffs"
 *   "CN=Group_AllStaffs,OU=Groups,DC=..." -> "Group_AllStaffs"
 *   "/Group_AllStaffs"（Keycloak 路径）    -> "Group_AllStaffs"
 */
function normalizeGroupName(g) {
  if (!g) return '';
  const s = String(g).trim();
  if (!s) return '';
  // DN 形态：取 CN
  if (/CN=/i.test(s)) {
    const cn = extractCn(s);
    if (cn) return cn;
  }
  // 路径形态：取最后一段
  if (s.includes('/')) return s.split('/').filter(Boolean).pop() || '';
  return s;
}

/** 只接受站内相对路径，防止开放重定向 */
function safeReturnTo(v, fallback = '/') {
  const s = typeof v === 'string' ? v : '';
  if (!s.startsWith('/') || s.startsWith('//') || s.startsWith('/\\')) return fallback;
  if (s.startsWith('/api/')) return fallback;      // 不要把用户送回接口地址
  return s;
}

export default async function oidcAuthRoutes(app) {
  if (config.authMode !== 'oidc') return;   // ldap 模式不注册这些路由

  // ---------------------------------------------------------- ① 发起登录
  app.get('/api/auth/login', async (req, reply) => {
    sweep();
    try {
      const state = oidc.randomToken();
      const nonce = oidc.randomToken();
      const verifier = oidc.randomToken(48);
      const returnTo = safeReturnTo(req.query?.returnTo);
      pending.set(state, { nonce, verifier, returnTo, exp: Date.now() + PENDING_TTL_MS });

      const url = await oidc.buildAuthorizationUrl({
        state, nonce, codeChallenge: oidc.pkceChallenge(verifier), returnTo,
      });
      reply.header('cache-control', 'no-store');
      return reply.redirect(url);
    } catch (err) {
      app.log.error({ err: err.message }, 'OIDC 发起登录失败');
      return reply.code(503).send({
        error: '统一身份服务暂时不可用，请稍后重试',
        code: 'IDP_UNAVAILABLE',
      });
    }
  });

  // ---------------------------------------------------------- ② 回调
  app.get('/api/auth/oidc/callback', async (req, reply) => {
    const { code, state, error, error_description: desc } = req.query ?? {};

    // 2.0 IdP 明确返回错误
    if (error) {
      app.log.warn({ error, desc }, 'IdP 返回错误');
      await repo.audit(null, 'auth.login.failed', null, null,
        { code: 'OIDC_ERROR', error, desc }, req.ip).catch(() => {});
      return reply.code(401).send({
        error: desc || '统一身份认证失败',
        code: 'OIDC_ERROR',
      });
    }

    // 2.1 校验一次性状态
    const ticket = state ? pending.get(String(state)) : null;
    if (state) pending.delete(String(state));
    if (!ticket || ticket.exp < Date.now()) {
      await repo.audit(null, 'auth.login.failed', null, null,
        { code: 'INVALID_STATE' }, req.ip).catch(() => {});
      return reply.code(400).send({
        error: '登录会话已过期或已使用，请重新登录',
        code: 'INVALID_STATE',
      });
    }

    // 2.2 换令牌 + 验签 + 取 userinfo
    let idToken, userInfo;
    try {
      const tokens = await oidc.exchangeCode(String(code ?? ''), ticket.verifier);
      idToken = await oidc.verifyIdToken(tokens.id_token, ticket.nonce);
      userInfo = await oidc.fetchUserInfo(tokens.access_token);
    } catch (err) {
      app.log.warn({ err: err.message }, 'OIDC 令牌换取或校验失败');
      await repo.audit(null, 'auth.login.failed', null, null,
        { code: err.code || 'OIDC_VERIFY', message: err.message }, req.ip).catch(() => {});
      return reply.code(401).send({
        error: '公司账号验证失败，请重试',
        code: 'OIDC_VERIFY',
      });
    }

    // 2.3 取用户名与 AD 组
    const username = String(idToken.preferred_username ?? userInfo.preferred_username ?? '')
      .toLowerCase().trim();
    if (!username) {
      await repo.audit(null, 'auth.login.failed', null, null,
        { code: 'NO_USERNAME' }, req.ip).catch(() => {});
      return reply.code(401).send({ error: '统一身份未返回账号名', code: 'NO_USERNAME' });
    }
    // userinfo 的 groups：Keycloak 默认下发**纯组名**（full.path=false），
    // 如 "Group_AllStaffs"；个别配置下可能是 DN（"CN=Group_AllStaffs,OU=..."）。
    // 这里统一成纯组名，后续再按需包成 CN= 形态喂给 deriveRole/groupMatches。
    const rawGroups = Array.isArray(userInfo.groups) ? userInfo.groups : [];
    const groups = rawGroups
      .map((g) => normalizeGroupName(g))
      .filter(Boolean);
    app.log.debug({ username, rawGroups, groups }, 'OIDC userinfo 组信息');

    // 2.4 准入：仍是「AD 组 ∩ LDAP_ALLOWED_GROUPS」，只是组改从 userinfo 拿
    const allowed = config.ldap.allowedGroups;
    if (allowed.length) {
      const okGroup = groups.some((g) => allowed.some((w) => w.toLowerCase() === g.toLowerCase()));
      if (!okGroup) {
        await repo.audit(null, 'auth.login.denied', username, null,
          { reason: 'not_in_allowed_groups', groups, via: 'oidc' }, req.ip).catch(() => {});
        return reply.code(403).send({
          error: '您的账号不在本系统授权范围内，请联系 IT 或人力资源部',
          code: 'NOT_AUTHORIZED',
        });
      }
    }

    // 2.5 身份对账：优先按 sub 找，其次按 username 绑定
    let user = await repo.getUserByOidcSub(idToken.sub);
    if (!user) user = await repo.getUserByUsername(username);

    // 构造与 AD 同步等价的组数组（deriveRole / deriveEmployeeType 需要 DN 形态）
    const groupDns = groups.map((g) => `CN=${g}`);

    if (!user) {
      // 首次登录（如 AD 同步尚未覆盖到的人）
      const role = deriveRole(groupDns);
      const empType = deriveEmployeeType(groupDns);
      user = await repo.upsertUserFromOidc({
        username,
        displayName: idToken.name || userInfo.name || username,
        email: idToken.email || userInfo.email || null,
        groups,
      }, role, empType);
    } else if (!user.is_active) {
      await repo.audit(user.id, 'auth.login.denied', username, null,
        { reason: 'inactive', via: 'oidc' }, req.ip).catch(() => {});
      return reply.code(403).send({ error: '该账号已停用，请联系人力资源部', code: 'INACTIVE' });
    } else {
      // 已有用户：刷新姓名/邮箱/组/研发类型，但**不覆盖** role（业务指派）
      user = await repo.upsertUserFromOidc({
        username,
        displayName: idToken.name || userInfo.name || user.display_name,
        email: idToken.email || userInfo.email || user.email,
        groups,
      }, user.role, deriveEmployeeType(groupDns));
    }

    // 2.6 绑定 sub（冲突时不覆盖，记告警）
    const bound = await repo.bindOidcSubject(user.id, idToken.sub);
    if (!bound) {
      app.log.warn({ username, sub: idToken.sub }, 'oidc_sub 绑定冲突，需人工核对');
      await repo.audit(user.id, 'auth.oidc.bind_conflict', username, null,
        { sub: idToken.sub }, req.ip).catch(() => {});
    }

    // 2.7 建立本系统会话（复用原 HS256 JWT + HttpOnly cookie）
    const token = await createSession(user);
    setSessionCookie(reply, token);
    await repo.touchLogin(user.id).catch(() => {});
    await repo.audit(user.id, 'auth.login', username, null, { via: 'oidc' }, req.ip)
      .catch(() => {});

    // 2.8 回到用户原本要去的页面
    reply.header('cache-control', 'no-store');
    return reply.redirect(safeReturnTo(ticket.returnTo));
  });

  // ---------------------------------------------------------- ③ 登出
  app.post('/api/auth/logout', async (req, reply) => {
    const me = await currentUser(req).catch(() => null);
    clearSessionCookie(reply);
    if (me) {
      await repo.audit(me.id, 'auth.logout', me.username, null, { via: 'oidc' }, req.ip)
        .catch(() => {});
    }
    let url = null;
    try {
      url = await oidc.buildLogoutUrl(null);
    } catch (err) {
      app.log.warn({ err: err.message }, 'OIDC 登出地址获取失败');
    }
    // 前端必须整页跳转 logoutUrl（不能 fetch），否则 IdP 会话不会结束
    return { ok: true, logoutUrl: url };
  });

  // ---------------------------------------------------------- 辅助
  /** 供前端判断当前认证模式（登录页展示不同 UI）。 */
  app.get('/api/auth/mode', async (req, reply) => ({
    mode: 'oidc',
    issuer: config.oidc.issuer,
  }));
}