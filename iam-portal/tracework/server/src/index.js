/**
 * 服务入口：Fastify + Cookie + 静态前端 + 统一错误处理。
 */
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config, validateConfig } from './config.js';
import { healthcheck, closePool } from './db.js';
import { closeServiceClient } from './ldap.js';
import { runMigrations } from './migrate.js';
import routes from './routes.js';
import costingRoutes from './costingRoutes.js';
import assetRoutes from './assetRoutes.js';
import apiV1Routes from './apiV1Routes.js';
import workflowRoutes from './workflowRoutes.js';
import oidcAuthRoutes from './oidcRoutes.js';
import { syncAdUsers } from './jobs/syncAd.js';

const here = dirname(fileURLToPath(import.meta.url));
// 前端产物位置：优先使用环境变量，其次按「源码同级的 web/dist」解析，
// 最后回退到容器内的 /app/web/dist。
const webRoot = resolveWebRoot();

function resolveWebRoot() {
  const candidates = [];
  if (process.env.WEB_ROOT) candidates.push(process.env.WEB_ROOT);
  candidates.push(join(here, '..', '..', 'web', 'dist')); // 源码布局: server/src -> ../web/dist
  candidates.push(join(here, '..', 'web', 'dist'));       // 容器布局: /app/src -> /app/web/dist
  candidates.push('/app/web/dist');
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return candidates[1];
}

validateConfig();

const app = Fastify({
  logger: {
    level: config.logLevel,
    transport: config.env === 'development'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
  },
  trustProxy: config.trustProxy,
  bodyLimit: 2 * 1024 * 1024,
});

await app.register(helmet, {
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", 'data:'],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
  hsts: { maxAge: 31536000, includeSubDomains: false },
});

await app.register(cookie, { secret: config.session.secret });
await app.register(rateLimit, { global: false, max: 300, timeWindow: '1 minute' });

app.setErrorHandler((err, req, reply) => {
  const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
  if (status >= 500) {
    req.log.error({ err }, '未处理异常');
  } else {
    req.log.warn({ code: err.code, msg: err.message }, '请求被拒绝');
  }
  reply.code(status).send({
    error: status >= 500 ? '服务器内部错误，请联系管理员' : err.message,
    code: err.code ?? 'ERROR',
    ...(err.details ? { details: err.details } : {}),
  });
});

app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/api/')) {
    return reply.code(404).send({ error: '接口不存在', code: 'NOT_FOUND' });
  }
  // SPA 回退。
  // 关键：入口 HTML 必须禁止缓存，否则浏览器会拿到引用「已删除旧 chunk」的
  // 旧 index.html，部署新版本后表现为页面白屏 / 路由打不开。
  if (existsSync(join(webRoot, 'index.html'))) {
    return reply
      .header('Cache-Control', 'no-cache, no-store, must-revalidate')
      .header('Pragma', 'no-cache')
      .type('text/html')
      .sendFile('index.html');
  }
  return reply.code(404).send({ error: '前端资源未构建', code: 'NO_WEB' });
});

await app.register(routes);
await app.register(costingRoutes);
await app.register(assetRoutes);
await app.register(apiV1Routes);
await app.register(workflowRoutes);
await app.register(oidcAuthRoutes);

// 静态资源
if (existsSync(webRoot)) {
  await app.register(fastifyStatic, {
    root: webRoot,
    prefix: '/',
    wildcard: false,
    // /assets/ 下是带内容哈希的文件，可长缓存；其余（index.html 等）不缓存
    setHeaders(res, path) {
      if (path.includes('/assets/') && /\.[0-9a-zA-Z_-]{8,}\.(js|css|woff2?|png|svg|jpg)$/.test(path)) {
        res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  });
} else {
  app.log.warn(`前端目录不存在：${webRoot}（开发模式请单独启动 Vite）`);
}

// ---------------------------------------------------------------- 启动
async function start() {
  await runMigrations({ silent: false });
  if (!(await healthcheck())) throw new Error('数据库连接失败');

  await app.listen({ port: config.port, host: config.host });
  app.log.info(`TraceWork 已启动 http://${config.host}:${config.port}`);

  // OIDC 模式：启动时预热 discovery/JWKS，避免首次登录多一次往返
  if (config.authMode === 'oidc') {
    const { warmup } = await import('./oidc.js');
    const ok = await warmup();
    app.log.info({ ok, issuer: config.oidc.issuer },
      ok ? 'OIDC 已预热（discovery + JWKS）' : 'OIDC 预热失败，登录时重试');
  }

  // 首次启动：若本地还没有任何用户，自动从 AD 同步一次
  try {
    const { query } = await import('./db.js');
    const { rows } = await query('SELECT count(*)::int AS n FROM users');
    if (rows[0].n === 0) {
      app.log.info('本地用户表为空，正在从 AD 同步初始用户 ...');
      const stats = await syncAdUsers({ trigger: 'startup' });
      app.log.info({ stats }, 'AD 初始同步完成');
    }
  } catch (err) {
    app.log.error({ err }, 'AD 初始同步失败（不影响启动，可稍后手工触发）');
  }

  // 定时同步
  //
  // 注意 OIDC 模式：登录时已从 userinfo 刷新姓名/邮箱/AD 组/研发类型，
  // 此处仍保留同步的价值是「离职自动禁用 + 新增员工预置」。
  // 但前提是 LDAP 服务账号可用（OIDC 模式下 .env 可能已移除 LDAP_BIND_PASSWORD），
  // 因此仅在「ldap.enabled 且 bind 账号已配置」时才启用。
  const canSyncAd = config.ldap.enabled
    && Boolean(config.ldap.bindDn && config.ldap.bindPassword)
    && config.ldap.syncIntervalMinutes > 0;
  if (canSyncAd) {
    const ms = config.ldap.syncIntervalMinutes * 60 * 1000;
    const timer = setInterval(async () => {
      try {
        const stats = await syncAdUsers({ trigger: 'scheduled' });
        app.log.info({ stats }, 'AD 定时同步完成');
      } catch (err) {
        app.log.error({ err }, 'AD 定时同步失败');
      }
    }, ms);
    timer.unref();
  }
}

async function shutdown(signal) {
  app.log.info(`收到 ${signal}，正在优雅退出 ...`);
  try {
    await app.close();
    await closeServiceClient();
    await closePool();
  } catch (err) {
    app.log.error({ err }, '退出时出错');
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch((err) => {
  app.log.error({ err }, '启动失败');
  console.error(err.message);
  process.exit(1);
});