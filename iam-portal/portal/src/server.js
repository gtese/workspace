'use strict';
/**
 * ============================================================
 * 门户服务（零依赖：node:http + node:https）
 * ============================================================
 * 路由：
 *   GET  /                  已登录 → 门户页；未登录 → 自动跳统一身份登录
 *   GET  /auth/login        302 到 sso.tri.local（带 state/nonce/PKCE）
 *   GET  /auth/callback     校验并建会话 → 302 回门户
 *   POST /auth/logout       清本地会话 → 返回 IdP 登出地址（前端整页跳转）
 *   GET  /api/apps          当前用户可见的应用列表（前端渲染用）
 *   GET  /api/me            当前用户信息
 *   GET  /healthz           健康检查（给 nginx/监控用）
 *   GET  /static/*          静态资源
 *
 * 设计取舍：
 *   - 不引入框架，减少依赖与升级面（本内网环境装包不便）
 *   - 令牌不落浏览器；会话 cookie: HttpOnly + Secure + SameSite=Lax
 *   - IdP 不可用时**不放行**（宁可登录失败，也不做"降级免登录"）
 * ============================================================
 */

const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs');
const path = require('node:path');

const oidc = require('./oidc');
const session = require('./session');
const storeMod = require('./store');

const PORT = Number(process.env.PORT || 8090);
const HOST = process.env.HOST || '127.0.0.1';
const COOKIE_NAME = process.env.SESSION_COOKIE_NAME || 'portal_sid';
const TRUST_PROXY = process.env.TRUST_PROXY !== 'false';
const PUBLIC_DIR = path.join(__dirname, 'public');

/* 内网自签证书：给 OIDC 的 fetch 用企业根 CA（Node 18+ 支持 NODE_EXTRA_CA_CERTS，
   这里显式指定，避免依赖环境变量） */
if (oidc.CA_FILE && fs.existsSync(oidc.CA_FILE)) {
  process.env.NODE_EXTRA_CA_CERTS = oidc.CA_FILE;
}

/* ------------------------------------------------------------------ 工具 */
function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const out = {};
  raw.split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function currentUser(req) {
  return session.getSession(parseCookies(req)[COOKIE_NAME]);
}

function sendJson(res, code, obj, extra = {}) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extra,
  });
  res.end(body);
}

function sendHtml(res, code, html) {
  res.writeHead(code, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'same-origin',
    'content-security-policy':
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
      "script-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'",
  });
  res.end(html);
}

function redirect(res, location, extraHeaders = {}) {
  res.writeHead(302, { location, 'cache-control': 'no-store', ...extraHeaders });
  res.end();
}

function sessionCookie(sid) {
  const maxAge = Number(process.env.SESSION_TTL_MINUTES || 480) * 60;
  return `${COOKIE_NAME}=${sid}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
const clearCookie = () => `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;

/** 只允许站内相对路径，防开放重定向 */
function safeReturnTo(v) {
  if (typeof v !== 'string' || !v.startsWith('/') || v.startsWith('//')) return '/';
  return v;
}

/** 是否管理员：任一 `*:admin` 业务角色 */
function isAdminUser(user) {
  return (user?.roles || []).some((r) => r.endsWith(':admin'));
}

/**
 * 按可见性过滤应用。
 * @param user 当前用户（可为 null：未登录时只看 public 应用）
 */
function visibleApps(user) {
  const cfg = storeMod.getConfig();
  const admin = isAdminUser(user);
  return cfg.apps
    .filter((a) => {
      if (a.hidden) return false;
      if (!user) return !!a.public;          // 未登录：只展示公开应用
      if (a.adminOnly && !admin) return false;
      return true;
    })
    .map((a) => ({
      id: a.id, name: a.name, desc: a.desc, url: a.url, icon: a.icon,
      category: a.category, external: !!a.external, coming: !!a.coming,
      sso: !!a.sso, public: !!a.public,
    }));
}

/* ------------------------------------------------------------------ 静态资源 */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, urlPath) {
  const rel = urlPath.replace(/^\/static\//, '');
  const full = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!full.startsWith(PUBLIC_DIR)) return sendJson(res, 400, { error: 'bad path' });
  fs.readFile(full, (err, buf) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, {
      'content-type': MIME[path.extname(full)] || 'application/octet-stream',
      'cache-control': 'public, max-age=300',
    });
    res.end(buf);
  });
}

function serveFile(res, name) {
  fs.readFile(path.join(PUBLIC_DIR, name), (err, buf) => {
    if (err) return sendHtml(res, 500, 'portal: 缺少页面文件');
    sendHtml(res, 200, buf.toString('utf8'));
  });
}

/* ------------------------------------------------------------------ 路由 */
async function handle(req, res) {
  const url = new URL(req.url, `https://${req.headers.host || 'portal.tri.local'}`);
  const p = url.pathname;

  if (p === '/healthz') {
    return sendJson(res, 200, { ok: true, ...session.stats() });
  }

  if (p.startsWith('/static/')) {
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method' });
    return serveStatic(res, p);
  }

  // ① 发起登录
  if (p === '/auth/login') {
    const state = oidc.randomToken();
    const nonce = oidc.randomToken();
    const verifier = oidc.randomToken(48);
    session.putPending(state, { nonce, verifier, returnTo: safeReturnTo(url.searchParams.get('returnTo')) });
    const target = await oidc.authorizeUrl({ state, nonce, verifier });
    log('login ->', target.slice(0, 90));
    return redirect(res, target);
  }

  // ② 回调
  if (p === '/auth/callback') {
    const err = url.searchParams.get('error');
    if (err) {
      log('IdP error:', err, url.searchParams.get('error_description'));
      return sendHtml(res, 401, loginFailedPage(url.searchParams.get('error_description') || err));
    }
    const pending = session.takePending(url.searchParams.get('state'));
    if (!pending) {
      log('invalid state');
      return sendHtml(res, 400, loginFailedPage('登录会话已过期，请重新访问门户'));
    }
    try {
      const tokens = await oidc.exchangeCode(url.searchParams.get('code'), pending.verifier);
      const idClaims = await oidc.verifyJwt(tokens.id_token, { nonce: pending.nonce });
      // 注意：Keycloak 的 access_token 默认 aud="account"，不是 clientId，
      // 因此 access token 只校验签名/iss/exp；aud 校验放在 ID Token 上（见上一行）。
      const atClaims = await oidc.verifyJwt(tokens.access_token, { checkAud: false });
      const ui = await oidc.userinfo(tokens.access_token);
      const roles = oidc.businessRoles(atClaims);
      const sid = session.createSession({
        sub: idClaims.sub,
        username: idClaims.preferred_username || ui.preferred_username,
        name: idClaims.name || idClaims.preferred_username,
        email: idClaims.email || ui.email,
        roles,
        groups: ui.groups,
        // 仅存服务端内存，用于登出时带 id_token_hint；不落浏览器
        idToken: tokens.id_token,
      });
      log('login ok:', idClaims.preferred_username, 'roles=', roles.join(',') || '-');
      return redirect(res, pending.returnTo || '/', { 'set-cookie': sessionCookie(sid) });
    } catch (e) {
      log('callback failed:', e.message);
      return sendHtml(res, 401, loginFailedPage('统一身份校验失败，请重试或联系 IT'));
    }
  }

  // ③ 登出：清本地会话，返回 IdP 登出地址（前端整页跳转）
  if (p === '/auth/logout') {
    const cookieSid = parseCookies(req)[COOKIE_NAME];
    const me = session.getSession(cookieSid);
    // 带 id_token_hint：Keycloak 才会直接结束会话，而不是停在确认页报错
    const url2 = await oidc.logoutUrl(me && me.idToken);
    session.destroySession(cookieSid);
    log('logout');
    return sendJson(res, 200, { ok: true, logoutUrl: url2 }, { 'set-cookie': clearCookie() });
  }

  // ④ 首页
  if (p === '/' || p === '/index.html') {
    const user = currentUser(req);
    if (!user) {
      // 没有公开应用时：服务端直接 302 到统一身份（打开即登录，无闪屏）。
      // 有公开应用时渲染首页并展示「登录」按钮，避免员工必须先登录才能看公开内容。
      const hasPublic = storeMod.getConfig().apps.some((a) => a.public && !a.hidden);
      if (!hasPublic && url.searchParams.get('auto') !== '0') {
        return redirect(res, `/auth/login?returnTo=${encodeURIComponent('/')}`);
      }
    }
    return serveFile(res, 'index.html');
  }

  if (p === '/api/me') {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'unauthenticated' });
    return sendJson(res, 200, {
      sub: user.sub, username: user.username, name: user.name,
      email: user.email, roles: user.roles,
    });
  }

  if (p === '/api/apps') {
    const user = currentUser(req);
    return sendJson(res, 200, {
      authenticated: !!user,
      apps: visibleApps(user),
      categories: storeMod.getConfig().categories,
    });
  }

  // ---------------- 配置编辑 API（仅管理员） ----------------
  if (p === '/api/admin/config') {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'unauthenticated' });
    if (!isAdminUser(user)) return sendJson(res, 403, { error: 'forbidden', message: '仅管理员可编辑门户' });
    if (req.method === 'GET') {
      return sendJson(res, 200, {
        ...storeMod.getConfig(),
        customized: storeMod.isCustomized(),
      });
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 512 * 1024) return sendJson(res, 413, { error: '配置过大' });
      }
      let body;
      try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: '请求体不是合法 JSON' }); }
      try {
        const { sanitizeApp } = require('./apps');
        const incoming = Array.isArray(body.apps) ? body.apps : [];
        if (!incoming.length) return sendJson(res, 400, { error: '至少保留一个应用' });
        const apps = incoming.map((a, i) => sanitizeApp(a, `app-${i + 1}`));
        const ids = new Set();
        for (const a of apps) {
          if (ids.has(a.id)) return sendJson(res, 400, { error: `应用 id 重复：${a.id}` });
          ids.add(a.id);
        }
        const cats = Array.from(new Set([
          ...(Array.isArray(body.categories) ? body.categories.map((c) => String(c).trim()).filter(Boolean) : []),
          ...apps.map((a) => a.category),
        ]));
        const saved = storeMod.setConfig({ apps, categories: cats }, user.username);
        log(`config saved by ${user.username}: ${apps.length} apps`);
        return sendJson(res, 200, { ok: true, config: saved });
      } catch (e) {
        return sendJson(res, 400, { error: e.message });
      }
    }
    return sendJson(res, 405, { error: 'method not allowed' });
  }

  if (p === '/api/admin/config/reset') {
    const user = currentUser(req);
    if (!user) return sendJson(res, 401, { error: 'unauthenticated' });
    if (!isAdminUser(user)) return sendJson(res, 403, { error: 'forbidden' });
    if (req.method !== 'POST') return sendJson(res, 405, { error: 'method not allowed' });
    const cfg = storeMod.resetConfig(user.username);
    log(`config reset to defaults by ${user.username}`);
    return sendJson(res, 200, { ok: true, config: cfg });
  }

  return sendHtml(res, 404, '<!doctype html><meta charset="utf-8"><p>页面不存在，<a href="/">回门户</a></p>');
}

/* ------------------------------------------------------------------ 错误页 */
function loginFailedPage(detail) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>登录失败 · 企业应用门户</title>
<link rel="stylesheet" href="/static/style.css"></head>
<body class="centered"><main class="card error-card">
<h1>登录失败</h1>
<p>${esc(detail)}</p>
<p class="muted">如果反复失败，请联系 IT 并提供以下信息：${esc(new Date().toISOString())}</p>
<a class="btn" href="/auth/login">重新登录</a>
</main></body></html>`;
}

/* ------------------------------------------------------------------ 启动 */
const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    log('unhandled:', e.message);
    if (!res.headersSent) sendJson(res, 500, { error: 'internal', message: e.message });
    else res.end();
  });
});

server.listen(PORT, HOST, () => {
  log(`portal listening on http://${HOST}:${PORT}  issuer=${oidc.ISSUER} client=${oidc.CLIENT_ID}`);
  log(`apps: ${storeMod.getConfig().apps.map((a) => a.id).join(', ')} (customized=${storeMod.isCustomized()})`);
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => { log(`${sig}, shutting down`); server.close(() => process.exit(0)); });
}