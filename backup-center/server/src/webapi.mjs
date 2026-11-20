import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRouter, parseCookies, cookieHeader, clearCookie, sendJson, sendError, readJsonBody, securityHeaders } from './http.mjs';
import { ApiError, id, nowIso, parseJson, parseBool, toInt, timingSafeEqualStr, clientIp, randomToken } from './util.mjs';
import { hashPassword, encryptText } from './crypt.mjs';
import { validateCron, nextOccurrence } from './cron.mjs';

const ROLES = ['admin', 'operator', 'viewer', 'auditor'];

export function createWebApi({ cfg, store, masterKey, auth, storage, clients, jobs, snapshots, alerts, scheduler, metrics, audit }) {
  const router = createRouter();
  const secureCookie = !!cfg.tls.enabled;
  const cookieName = 'bc_sid';

  function listOf(rows) { return rows; }

  function getUser(req) {
    const cookies = parseCookies(req);
    const session = auth.sessionFromSid(cookies[cookieName]);
    return session ? { session, user: session.user } : null;
  }

  function requireUser(ctx) {
    if (!ctx.user) throw new ApiError(401, 'unauthorized', '请先登录');
    return ctx.user;
  }

  function requireRole(ctx, roles) {
    const user = requireUser(ctx);
    if (!roles.includes(user.role)) throw new ApiError(403, 'forbidden', '权限不足');
    return user;
  }

  function checkCsrf(ctx) {
    if (!ctx.user) return;
    if (['GET', 'HEAD', 'OPTIONS'].includes(ctx.req.method)) return;
    const token = ctx.req.headers['x-csrf-token'];
    if (!token || !timingSafeEqualStr(String(token), ctx.session.csrf)) throw new ApiError(403, 'csrf', 'CSRF 校验失败，请刷新页面');
  }

  function actor(ctx) { return ctx.user ? ctx.user.username : 'anonymous'; }

  function log(ctx, action, target, detail) {
    audit({ actor: actor(ctx), action, target, ip: clientIp(ctx.req), detail });
  }

  const mask = (v) => (v ? '***' : '');

  /* ---------- auth ---------- */
  router.add('GET', '/api/auth/me', async (ctx) => {
    const user = requireUser(ctx);
    sendJson(ctx.res, 200, { user: { id: user.id, username: user.username, display_name: user.display_name, email: user.email, role: user.role }, csrf: ctx.session.csrf });
  });

  router.add('POST', '/api/auth/login', async (ctx) => {
    const body = await readJsonBody(ctx.req);
    const result = auth.loginLocal(body.username, body.password, { ip: clientIp(ctx.req), ua: ctx.req.headers['user-agent'] || '' });
    ctx.res.setHeader('Set-Cookie', cookieHeader(cookieName, result.sid, { secure: secureCookie, maxAge: 8 * 3600 }));
    const user = store.get('SELECT * FROM users WHERE username=?', String(body.username));
    log({ ...ctx, user: { username: String(body.username) } }, 'auth.login', String(body.username), { result: 'ok' });
    sendJson(ctx.res, 200, { ok: true, user: user ? { id: user.id, username: user.username, display_name: user.display_name, role: user.role } : null });
  });

  router.add('POST', '/api/auth/logout', async (ctx) => {
    if (ctx.user) log(ctx, 'auth.logout', ctx.user.username);
    if (ctx.session) store.run('DELETE FROM sessions WHERE sid_hash=?', ctx.session.sidHash);
    ctx.res.setHeader('Set-Cookie', clearCookie(cookieName, { secure: secureCookie }));
    sendJson(ctx.res, 200, { ok: true });
  });

  router.add('GET', '/api/auth/config', async (ctx) => {
    sendJson(ctx.res, 200, {
      local: true,
      oidc_enabled: !!cfg.oidc.enabled,
      oidc_issuer: cfg.oidc.enabled ? cfg.oidc.issuer : '',
      site_name: 'TRI 集中备份平台',
    });
  });

  router.add('GET', '/auth/oidc/start', async (ctx) => {
    if (!cfg.oidc.enabled) {
      ctx.res.writeHead(302, { Location: '/login?oidc=disabled' });
      return ctx.res.end();
    }
    const { url } = await auth.oidcStart(ctx.query.get('next') || '/');
    ctx.res.writeHead(302, { Location: url });
    ctx.res.end();
  });

  router.add('GET', '/auth/oidc/callback', async (ctx) => {
    const oidcError = ctx.query.get('error');
    if (oidcError) {
      const desc = ctx.query.get('error_description') || '';
      ctx.res.writeHead(302, { Location: `/login?oidc_error=${encodeURIComponent(oidcError)}&oidc_desc=${encodeURIComponent(desc)}` });
      return ctx.res.end();
    }
    try {
      const { session, returnTo, user } = await auth.oidcCallback(ctx.query.get('code'), ctx.query.get('state'));
      ctx.res.setHeader('Set-Cookie', cookieHeader(cookieName, session.sid, { secure: secureCookie, maxAge: 8 * 3600 }));
      audit({ actor: user.username, action: 'auth.oidc_login', target: user.username, ip: clientIp(ctx.req) });
      ctx.res.writeHead(302, { Location: returnTo || '/' });
      ctx.res.end();
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'oidc_error';
      const desc = e instanceof ApiError ? e.message : '统一身份登录失败';
      audit({ actor: 'anonymous', action: 'auth.oidc_denied', target: '', ip: clientIp(ctx.req), result: 'denied', detail: { code, desc } });
      ctx.res.writeHead(302, { Location: `/login?oidc_error=${encodeURIComponent(code)}&oidc_desc=${encodeURIComponent(desc)}` });
      ctx.res.end();
    }
  });

  router.add('GET', '/auth/oidc/logout', async (ctx) => {
    const target = auth.logoutUrl();
    ctx.res.setHeader('Set-Cookie', clearCookie(cookieName, { secure: secureCookie }));
    ctx.res.writeHead(302, { Location: target || '/' });
    ctx.res.end();
  });

  router.add('GET', '/healthz', async (ctx) => {
    let dbOk = true;
    let checks = {};
    try { store.get('SELECT 1 AS x'); } catch { dbOk = false; }
    if (ctx.query.get('deep')) {
      try { dbOk = dbOk && store.get('PRAGMA quick_check').quick_check === 'ok'; } catch { dbOk = false; }
      const repos = store.all('SELECT id,name,mountpoint FROM repositories');
      for (const r of repos) {
        try { fs.statfsSync(r.mountpoint); checks[r.name] = 'ok'; } catch { checks[r.name] = 'unavailable'; }
      }
      checks.restic = fs.existsSync(cfg.restic.binary) ? 'ok' : 'missing';
      try {
        const cert = new crypto.X509Certificate(fs.readFileSync(cfg.tls.cert));
        checks.tls_cert = cert.validTo;
      } catch { checks.tls_cert = 'unreadable'; }
    }
    const ok = dbOk && Object.values(checks).every((v) => v !== 'unavailable' && v !== 'missing' && v !== 'unreadable');
    sendJson(ctx.res, ok ? 200 : 503, { ok, version: '0.1.0', db: dbOk ? 'ok' : 'error', checks, time: nowIso() });
  });

  /* ---------- clients ---------- */
  router.add('GET', '/api/clients', async (ctx) => {
    requireUser(ctx);
    sendJson(ctx.res, 200, clients.list({
      status: ctx.query.get('status'),
      q: ctx.query.get('q'),
      includeDeleted: ['1', 'true'].includes(String(ctx.query.get('include_deleted') || '')),
    }));
  });

  router.add('GET', '/api/clients/:id', async (ctx) => {
    requireUser(ctx);
    const c = clients.get(ctx.params.id);
    if (!c) throw new ApiError(404, 'not_found', '节点不存在');
    const hb = c.last_heartbeat || {};
    sendJson(ctx.res, 200, { ...c, disks: hb.disks || [], mounts: hb.mounts || [], system: { os: c.os, os_version: c.os_version, arch: c.arch, disks: hb.disks || [], mounts: hb.mounts || [] }, heartbeat: hb });
  });

  router.add('PATCH', '/api/clients/:id', async (ctx) => {
    checkCsrf(ctx);
    requireRole(ctx, ['admin', 'operator']);
    const body = await readJsonBody(ctx.req);
    const out = clients.update(ctx.params.id, body);
    log(ctx, 'client.update', ctx.params.id, body);
    sendJson(ctx.res, 200, out);
  });

  router.add('POST', '/api/clients/:id/enable', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    const out = clients.setStatus(ctx.params.id, 'active');
    log(ctx, 'client.enable', ctx.params.id);
    sendJson(ctx.res, 200, out);
  });

  router.add('POST', '/api/clients/:id/disable', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    const out = clients.setStatus(ctx.params.id, 'disabled', 'disabled by admin');
    log(ctx, 'client.disable', ctx.params.id);
    sendJson(ctx.res, 200, out);
  });

  router.add('DELETE', '/api/clients/:id', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin']);
    const out = clients.remove(ctx.params.id);
    log(ctx, 'client.delete', ctx.params.id);
    sendJson(ctx.res, 200, out);
  });

  router.add('GET', '/api/clients/:id/fs', async (ctx) => {
    requireUser(ctx);
    const client = clients.get(ctx.params.id);
    if (!client) throw new ApiError(404, 'not_found', '节点不存在');
    if (!scheduler.clientOnline(client)) throw new ApiError(504, 'client_offline', '节点离线，无法浏览文件系统');
    const p = snapshots.normalizePath(ctx.query.get('path') || '/');
    const taskId = jobs.enqueueTask({ type: 'fs_list', clientId: client.id, payload: { path: p, request_id: id('fsr', 8) } });
    const out = await jobs.waitTaskResult(taskId, 15000);
    if (!out) throw new ApiError(504, 'timeout', '节点响应超时');
    if (!out.ok) throw new ApiError(502, 'agent_error', (out.result && out.result.error) || '节点返回错误');
    const summary = out.result.summary || {};
    sendJson(ctx.res, 200, { path: summary.path || p, parent: summary.parent || '/', entries: summary.entries || [], mounts: summary.mounts || [] });
  });

  router.add('POST', '/api/clients/:id/check', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    const body = await readJsonBody(ctx.req).catch(() => ({}));
    const result = await scheduler.checkClient(ctx.params.id, { readData: !!(body && body.readData), repositoryId: (body && body.repository_id) || ctx.query.get('repository_id') });
    log(ctx, 'client.check', ctx.params.id, body);
    sendJson(ctx.res, 200, result);
  });

  router.add('POST', '/api/clients/:id/prune', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    const body = await readJsonBody(ctx.req).catch(() => ({}));
    const result = await scheduler.pruneClient(ctx.params.id, undefined, (body && body.repository_id) || ctx.query.get('repository_id'));
    log(ctx, 'client.prune', ctx.params.id);
    sendJson(ctx.res, 200, result);
  });

  router.add('GET', '/api/clients/:id/snapshots', async (ctx) => {
    requireUser(ctx);
    sendJson(ctx.res, 200, await snapshots.list(ctx.params.id, ctx.query.get('repository_id')));
  });

  /* ---------- enroll ---------- */
  router.add('GET', '/api/enroll-requests', async (ctx) => {
    requireUser(ctx);
    const status = ctx.query.get('status') || 'pending';
    const rows = status === 'all'
      ? store.all('SELECT * FROM enroll_requests ORDER BY created_at DESC LIMIT 300')
      : clients.listEnroll({ status });
    sendJson(ctx.res, 200, rows.map((r) => ({ ...r, token_hash: undefined, enroll_secret_hash: undefined, csr_pem: undefined })));
  });

  router.add('GET', '/api/enroll-requests/:id', async (ctx) => {
    requireUser(ctx);
    const row = clients.getEnroll(ctx.params.id);
    if (!row) throw new ApiError(404, 'not_found', '请求不存在');
    sendJson(ctx.res, 200, row);
  });

  router.add('POST', '/api/enroll-requests', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin']);
    const body = await readJsonBody(ctx.req);
    const out = clients.createEnroll({ userId: ctx.user.id, hostnameHint: body.hostname_hint || body.hostname || '', ttlMinutes: body.ttl_minutes, repositoryId: body.repository_id || null });
    log(ctx, 'enroll.create', out.id, { hostname_hint: body.hostname_hint || '' });
    sendJson(ctx.res, 200, out);
  });

  router.add('POST', '/api/enroll-requests/:id/approve', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin']);
    const body = await readJsonBody(ctx.req).catch(() => ({}));
    const out = clients.approve(ctx.params.id, { userId: ctx.user.id, repositoryId: body.repository_id || null });
    log(ctx, 'enroll.approve', ctx.params.id, { client_id: out.id });
    sendJson(ctx.res, 200, { ok: true, client_id: out.id, client: out });
  });

  router.add('POST', '/api/enroll-requests/:id/reject', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin']);
    const body = await readJsonBody(ctx.req).catch(() => ({}));
    const out = clients.reject(ctx.params.id, { userId: ctx.user.id, reason: body.reason || '' });
    log(ctx, 'enroll.reject', ctx.params.id);
    sendJson(ctx.res, 200, { ok: true, request: out });
  });

  /* ---------- repositories ---------- */
  router.add('GET', '/api/repositories', async (ctx) => {
    requireUser(ctx);
    sendJson(ctx.res, 200, storage.list());
  });

  router.add('POST', '/api/repositories', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin']);
    const body = await readJsonBody(ctx.req);
    const out = await storage.create({ name: body.name, type: body.type, config: body.config || {} });
    log(ctx, 'repository.create', out.id, { name: out.name, type: out.type });
    sendJson(ctx.res, 200, out);
  });

  router.add('PATCH', '/api/repositories/:id', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin']);
    const body = await readJsonBody(ctx.req);
    const out = await storage.update(ctx.params.id, { name: body.name, config: body.config });
    log(ctx, 'repository.update', ctx.params.id, { name: body.name });
    sendJson(ctx.res, 200, out);
  });

  router.add('DELETE', '/api/repositories/:id', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin']);
    const out = storage.remove(ctx.params.id);
    log(ctx, 'repository.delete', ctx.params.id);
    sendJson(ctx.res, 200, out);
  });

  router.add('POST', '/api/repositories/:id/validate', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    const out = await storage.validateRepo(ctx.params.id);
    log(ctx, 'repository.validate', ctx.params.id);
    sendJson(ctx.res, 200, out);
  });

  router.add('GET', '/api/repositories/:id/usage', async (ctx) => {
    requireUser(ctx);
    sendJson(ctx.res, 200, await storage.usage(ctx.params.id));
  });

  /* ---------- plans ---------- */
  function planOut(row) {
    return {
      ...row,
      paths: parseJson(row.paths_json, []),
      excludes: parseJson(row.excludes_json, []),
      window: parseJson(row.window_json, {}),
      retention: parseJson(row.retention_json, {}),
      hooks: parseJson(row.hooks_json, {}),
    };
  }

  function validatePlan(body, { partial = false } = {}) {
    const out = {};
    if (body.name !== undefined) out.name = String(body.name).trim();
    if (body.client_id !== undefined) out.client_id = String(body.client_id);
    if (body.repository_id !== undefined) out.repository_id = String(body.repository_id);
    if (body.paths !== undefined) {
      if (!Array.isArray(body.paths) || !body.paths.length) throw new ApiError(400, 'validation', '至少选择一个备份路径');
      const list = body.paths.map(String);
      jobs.safetyExcludes(list);
      out.paths_json = JSON.stringify(list);
    }
    if (body.excludes !== undefined) out.excludes_json = JSON.stringify((body.excludes || []).map(String));
    if (body.cron !== undefined) {
      try { validateCron(body.cron); } catch (e) { throw new ApiError(400, 'validation', `cron 无效：${e.message}`); }
      out.cron = String(body.cron);
    }
    if (body.window !== undefined) out.window_json = JSON.stringify(body.window || {});
    if (body.compression !== undefined) out.compression = ['auto', 'max', 'off'].includes(body.compression) ? body.compression : 'auto';
    if (body.limit_upload_kib !== undefined) out.limit_upload_kib = Math.max(0, toInt(body.limit_upload_kib, 0));
    if (body.rpo_hours !== undefined) out.rpo_hours = Math.max(1, toInt(body.rpo_hours, 26));
    if (body.retention !== undefined) out.retention_json = JSON.stringify(body.retention || {});
    if (body.hooks !== undefined) out.hooks_json = JSON.stringify(body.hooks || {});
    if (body.enabled !== undefined) out.enabled = body.enabled ? 1 : 0;
    if (!partial) {
      for (const k of ['name', 'client_id', 'paths_json', 'cron']) if (!out[k]) throw new ApiError(400, 'validation', '缺少必填字段');
    }
    return out;
  }

  router.add('GET', '/api/plans', async (ctx) => {
    requireUser(ctx);
    const clientId = ctx.query.get('client_id');
    const rows = clientId
      ? store.all('SELECT * FROM plans WHERE client_id=? ORDER BY created_at DESC', clientId)
      : store.all('SELECT * FROM plans ORDER BY created_at DESC');
    sendJson(ctx.res, 200, rows.map(planOut));
  });

  router.add('POST', '/api/plans', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    const body = await readJsonBody(ctx.req);
    const fields = validatePlan(body);
    const client = store.get('SELECT * FROM clients WHERE id=?', fields.client_id);
    if (!client) throw new ApiError(400, 'validation', '节点不存在');
    const repoId = fields.repository_id || client.repository_id;
    if (!repoId) throw new ApiError(400, 'validation', '节点未分配存储库');
    const planId = id('p', 6);
    const next = nextRun(fields.cron);
    store.run(`INSERT INTO plans(id,name,client_id,repository_id,paths_json,excludes_json,cron,window_json,compression,
      limit_upload_kib,rpo_hours,retention_json,hooks_json,enabled,created_by,created_at,next_run_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      planId, fields.name, fields.client_id, repoId, fields.paths_json, fields.excludes_json || '[]', fields.cron,
      fields.window_json || '{}', fields.compression || 'auto', fields.limit_upload_kib || 0,
      fields.rpo_hours || 26, fields.retention_json || '{}', fields.hooks_json || '{}',
      fields.enabled === undefined ? 1 : fields.enabled, ctx.user.id, nowIso(), next);
    log(ctx, 'plan.create', planId, { name: fields.name, client_id: fields.client_id });
    sendJson(ctx.res, 200, planOut(store.get('SELECT * FROM plans WHERE id=?', planId)));
  });

  router.add('PATCH', '/api/plans/:id', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    const row = store.get('SELECT * FROM plans WHERE id=?', ctx.params.id);
    if (!row) throw new ApiError(404, 'not_found', '计划不存在');
    const body = await readJsonBody(ctx.req);
    const fields = validatePlan(body, { partial: true });
    if (fields.client_id && fields.client_id !== row.client_id) throw new ApiError(400, 'validation', '不支持修改计划的节点');
    const sets = [];
    const args = [];
    for (const [k, v] of Object.entries(fields)) { sets.push(`${k}=?`); args.push(v); }
    if (fields.cron) { sets.push('next_run_at=?'); args.push(nextRun(fields.cron)); }
    if (!sets.length) return sendJson(ctx.res, 200, planOut(row));
    store.run(`UPDATE plans SET ${sets.join(',')} WHERE id=?`, ...args, ctx.params.id);
    log(ctx, 'plan.update', ctx.params.id, body);
    sendJson(ctx.res, 200, planOut(store.get('SELECT * FROM plans WHERE id=?', ctx.params.id)));
  });

  router.add('DELETE', '/api/plans/:id', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    store.run('DELETE FROM plans WHERE id=?', ctx.params.id);
    log(ctx, 'plan.delete', ctx.params.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  router.add('POST', '/api/plans/:id/run', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    const plan = store.get('SELECT * FROM plans WHERE id=?', ctx.params.id);
    if (!plan) throw new ApiError(404, 'not_found', '计划不存在');
    const body = await readJsonBody(ctx.req).catch(() => ({}));
    const run = jobs.createRun(plan, { trigger: 'manual', paths: body.paths, excludes: body.excludes, userId: ctx.user.id });
    log(ctx, 'plan.run', plan.id, { run_id: run.id });
    sendJson(ctx.res, 200, run);
  });

  router.add('POST', '/api/plans/:id/enable', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    const row = store.get('SELECT * FROM plans WHERE id=?', ctx.params.id);
    if (!row) throw new ApiError(404, 'not_found', '计划不存在');
    store.run('UPDATE plans SET enabled=1, next_run_at=? WHERE id=?', nextRun(row.cron), row.id);
    log(ctx, 'plan.enable', row.id);
    sendJson(ctx.res, 200, planOut(store.get('SELECT * FROM plans WHERE id=?', row.id)));
  });

  router.add('POST', '/api/plans/:id/disable', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    store.run('UPDATE plans SET enabled=0, next_run_at=NULL WHERE id=?', ctx.params.id);
    log(ctx, 'plan.disable', ctx.params.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  function nextRun(cron) {
    try { return nextOccurrence(cron, new Date()).toISOString(); } catch { return null; }
  }

  /* ---------- runs ---------- */
  router.add('GET', '/api/runs', async (ctx) => {
    requireUser(ctx);
    sendJson(ctx.res, 200, jobs.listRuns({
      clientId: ctx.query.get('client_id') || undefined,
      status: ctx.query.get('status') || undefined,
      limit: toInt(ctx.query.get('limit'), 50),
      offset: toInt(ctx.query.get('offset'), 0),
    }));
  });

  router.add('GET', '/api/runs/:id', async (ctx) => {
    requireUser(ctx);
    const run = jobs.getRun(ctx.params.id);
    if (!run) throw new ApiError(404, 'not_found', '运行不存在');
    sendJson(ctx.res, 200, run);
  });

  router.add('GET', '/api/runs/:id/events', async (ctx) => {
    requireUser(ctx);
    ctx.res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    ctx.res.write(': connected\n\n');
    const run = jobs.getRun(ctx.params.id);
    if (run && run.progress) ctx.res.write(`event: progress\ndata: ${JSON.stringify(run.progress)}\n\n`);
    if (run && run.log_tail) ctx.res.write(`event: log\ndata: ${JSON.stringify({ line: run.log_tail })}\n\n`);
    if (run && ['success', 'failed', 'canceled'].includes(run.status)) {
      ctx.res.write(`event: done\ndata: ${JSON.stringify({ status: run.status })}\n\n`);
    }
    const off = jobs.subscribe('run', ctx.params.id, ctx.res);
    ctx.req.on('close', off);
  });

  router.add('POST', '/api/runs/:id/cancel', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    const run = jobs.cancelRun(ctx.params.id);
    log(ctx, 'run.cancel', ctx.params.id);
    sendJson(ctx.res, 200, run);
  });

  /* ---------- snapshots ---------- */
  router.add('GET', '/api/snapshots/:clientId/:snapshotId/ls', async (ctx) => {
    requireUser(ctx);
    const out = await snapshots.ls(ctx.params.clientId, ctx.params.snapshotId, ctx.query.get('path') || '/', ctx.query.get('repository_id'));
    sendJson(ctx.res, 200, out);
  });

  router.add('GET', '/api/snapshots/:clientId/:snapshotId/search', async (ctx) => {
    requireUser(ctx);
    const out = await snapshots.search(ctx.params.clientId, ctx.params.snapshotId, ctx.query.get('q') || '', ctx.query.get('repository_id'));
    sendJson(ctx.res, 200, out);
  });

  router.add('GET', '/api/snapshots/:clientId/:snapshotId/download', async (ctx) => {
    requireUser(ctx);
    const target = ctx.query.get('path') || '/';
    const { child, isDir, name, size } = await snapshots.download(ctx.params.clientId, ctx.params.snapshotId, target, ctx.query.get('repository_id'));
    const filename = String(name || 'download').replace(/[^\w.\-]+/g, '_');
    const headers = {
      'Content-Type': isDir ? 'application/zip' : 'application/octet-stream',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}${isDir ? '.zip' : ''}`,
      'Cache-Control': 'no-store',
    };
    if (!isDir && size) headers['Content-Length'] = String(size);
    ctx.res.writeHead(200, headers);
    child.stdout.pipe(ctx.res);
    child.stderr.on('data', () => {});
    child.on('error', () => { try { ctx.res.destroy(); } catch { /* ignore */ } });
    ctx.req.on('close', () => { try { child.kill('SIGTERM'); } catch { /* ignore */ } });
    log(ctx, 'snapshot.download', `${ctx.params.clientId}/${ctx.params.snapshotId}`, { path: target });
  });

  router.add('POST', '/api/snapshots/:clientId/:snapshotId/restore', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    const body = await readJsonBody(ctx.req);
    const restore = jobs.createRestore({
      clientId: ctx.params.clientId, repositoryId: body.repository_id || null, snapshotId: ctx.params.snapshotId,
      includes: body.includes || [], target: body.target || '/', overwrite: body.overwrite || 'always',
      dryRun: !!body.dry_run, userId: ctx.user.id,
    });
    log(ctx, 'snapshot.restore', `${ctx.params.clientId}/${ctx.params.snapshotId}`, body);
    sendJson(ctx.res, 200, restore);
  });

  router.add('POST', '/api/snapshots/:clientId/:snapshotId/pin', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    const body = await readJsonBody(ctx.req);
    const out = await snapshots.pin(ctx.params.clientId, ctx.params.snapshotId, !!body.pinned, body.repository_id || ctx.query.get('repository_id'));
    log(ctx, 'snapshot.pin', `${ctx.params.clientId}/${ctx.params.snapshotId}`, body);
    sendJson(ctx.res, 200, out);
  });

  router.add('DELETE', '/api/snapshots/:clientId/:snapshotId', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin']);
    const out = await snapshots.remove(ctx.params.clientId, ctx.params.snapshotId, ctx.query.get('repository_id'));
    log(ctx, 'snapshot.delete', `${ctx.params.clientId}/${ctx.params.snapshotId}`);
    sendJson(ctx.res, 200, out);
  });

  /* ---------- restores ---------- */
  router.add('GET', '/api/restores', async (ctx) => {
    requireUser(ctx);
    sendJson(ctx.res, 200, jobs.listRestores({ status: ctx.query.get('status') || undefined, limit: toInt(ctx.query.get('limit'), 50), offset: toInt(ctx.query.get('offset'), 0) }));
  });

  router.add('GET', '/api/restores/:id', async (ctx) => {
    requireUser(ctx);
    const r = jobs.getRestore(ctx.params.id);
    if (!r) throw new ApiError(404, 'not_found', '恢复任务不存在');
    sendJson(ctx.res, 200, r);
  });

  router.add('GET', '/api/restores/:id/events', async (ctx) => {
    requireUser(ctx);
    ctx.res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    ctx.res.write(': connected\n\n');
    const r = jobs.getRestore(ctx.params.id);
    if (r && r.progress) ctx.res.write(`event: progress\ndata: ${JSON.stringify(r.progress)}\n\n`);
    if (r && ['success', 'failed', 'canceled'].includes(r.status)) ctx.res.write(`event: done\ndata: ${JSON.stringify({ status: r.status })}\n\n`);
    const off = jobs.subscribe('restore', ctx.params.id, ctx.res);
    ctx.req.on('close', off);
  });

  router.add('POST', '/api/restores/:id/cancel', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    sendJson(ctx.res, 200, jobs.cancelRestore(ctx.params.id));
  });

  /* ---------- users ---------- */
  router.add('GET', '/api/users', async (ctx) => {
    requireRole(ctx, ['admin']);
    const rows = store.all('SELECT id,username,display_name,email,role,source,enabled,created_at,last_login_at FROM users ORDER BY created_at');
    sendJson(ctx.res, 200, rows);
  });

  router.add('POST', '/api/users', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin']);
    const body = await readJsonBody(ctx.req);
    const username = String(body.username || '').trim();
    if (!/^[A-Za-z0-9_.@-]{2,64}$/.test(username)) throw new ApiError(400, 'validation', '用户名格式无效');
    if (store.get('SELECT id FROM users WHERE username=?', username)) throw new ApiError(409, 'conflict', '用户名已存在');
    const role = ROLES.includes(body.role) ? body.role : 'viewer';
    const source = body.source === 'oidc' ? 'oidc' : 'local';
    const passwordHash = source === 'local' ? hashPassword(String(body.password || randomToken(12))) : null;
    const userId = id('u', 6);
    store.run('INSERT INTO users(id,username,display_name,email,role,source,password_hash,enabled,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      userId, username, String(body.display_name || username), String(body.email || ''), role, source, passwordHash,
      body.enabled === false ? 0 : 1, nowIso());
    log(ctx, 'user.create', userId, { username, role });
    sendJson(ctx.res, 200, store.get('SELECT id,username,display_name,email,role,source,enabled,created_at FROM users WHERE id=?', userId));
  });

  router.add('PATCH', '/api/users/:id', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin']);
    const body = await readJsonBody(ctx.req);
    const row = store.get('SELECT * FROM users WHERE id=?', ctx.params.id);
    if (!row) throw new ApiError(404, 'not_found', '用户不存在');
    const fields = [];
    const args = [];
    for (const k of ['display_name', 'email']) if (body[k] !== undefined) { fields.push(`${k}=?`); args.push(String(body[k])); }
    if (body.role !== undefined) { if (!ROLES.includes(body.role)) throw new ApiError(400, 'validation', '角色无效'); fields.push('role=?'); args.push(body.role); }
    if (body.enabled !== undefined) { fields.push('enabled=?'); args.push(body.enabled ? 1 : 0); }
    if (body.password) { fields.push('password_hash=?'); args.push(hashPassword(String(body.password))); }
    if (fields.length) store.run(`UPDATE users SET ${fields.join(',')} WHERE id=?`, ...args, ctx.params.id);
    log(ctx, 'user.update', ctx.params.id, { role: body.role, enabled: body.enabled });
    sendJson(ctx.res, 200, store.get('SELECT id,username,display_name,email,role,source,enabled,created_at FROM users WHERE id=?', ctx.params.id));
  });

  router.add('DELETE', '/api/users/:id', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin']);
    if (ctx.params.id === ctx.user.id) throw new ApiError(400, 'validation', '不能删除当前登录用户');
    store.run('DELETE FROM sessions WHERE user_id=?', ctx.params.id);
    store.run('DELETE FROM users WHERE id=?', ctx.params.id);
    log(ctx, 'user.delete', ctx.params.id);
    sendJson(ctx.res, 200, { ok: true });
  });

  /* ---------- audit ---------- */
  router.add('GET', '/api/audit', async (ctx) => {
    requireRole(ctx, ['admin', 'auditor', 'operator']);
    const limit = Math.min(500, toInt(ctx.query.get('limit'), 100));
    const offset = toInt(ctx.query.get('offset'), 0);
    const where = [];
    const args = [];
    const actorQ = ctx.query.get('actor');
    const actionQ = ctx.query.get('action');
    if (actorQ) { where.push('actor LIKE ?'); args.push(`%${actorQ}%`); }
    if (actionQ) { where.push('action LIKE ?'); args.push(`%${actionQ}%`); }
    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const total = store.get(`SELECT COUNT(*) AS n FROM audit_log ${w}`, ...args);
    const rows = store.all(`SELECT * FROM audit_log ${w} ORDER BY at DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
    sendJson(ctx.res, 200, { logs: rows, total: total ? total.n : 0 });
  });

  /* ---------- settings ---------- */
  router.add('GET', '/api/settings/alerts', async (ctx) => {
    requireUser(ctx);
    const raw = getAlertsRaw();
    const smtp = raw.smtp || {};
    const webhook = raw.webhook || {};
    sendJson(ctx.res, 200, {
      smtp: {
        enabled: !!smtp.enabled, host: smtp.host || '', port: Number(smtp.port || 587),
        tls: smtp.tls !== false, username: smtp.username || '', from: smtp.from || '',
        to: Array.isArray(smtp.to) ? smtp.to : [], password: mask(smtp.password_enc),
      },
      webhook: { enabled: !!webhook.enabled, url: webhook.url || '', secret: mask(webhook.secret_enc) },
      recipients: raw.recipients || smtp.to || [],
    });
  });

  router.add('PUT', '/api/settings/alerts', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin']);
    const body = await readJsonBody(ctx.req);
    const raw = getAlertsRaw();
    const smtp = { ...(raw.smtp || {}), ...(body.smtp || {}) };
    const webhook = { ...(raw.webhook || {}), ...(body.webhook || {}) };
    if (body.smtp && body.smtp.password && body.smtp.password !== '***') smtp.password_enc = encryptText(masterKey, String(body.smtp.password));
    if (body.smtp && body.smtp.password === '') delete smtp.password_enc;
    if (body.webhook && body.webhook.secret && body.webhook.secret !== '***') webhook.secret_enc = encryptText(masterKey, String(body.webhook.secret));
    delete smtp.password; delete webhook.secret;
    const value = { ...raw, smtp, webhook, recipients: Array.isArray(smtp.to) ? smtp.to : [] };
    store.run("INSERT INTO settings(key,value) VALUES('alerts',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(value));
    log(ctx, 'settings.update', 'alerts', { smtp: { enabled: smtp.enabled, host: smtp.host }, webhook: { enabled: webhook.enabled } });
    sendJson(ctx.res, 200, { ok: true });
  });

  router.add('POST', '/api/settings/alerts/test', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin']);
    const body = await readJsonBody(ctx.req).catch(() => ({}));
    const channel = body.channel || 'smtp';
    const s = alerts.settings();
    try {
      if (channel === 'webhook') {
        if (!s.webhook || !s.webhook.url) throw new Error('Webhook 未配置');
        await fetch(s.webhook.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'test', message: 'backup-center 测试消息' }) });
      } else {
        const { sendMail } = await import('./smtp.mjs');
        const smtp = s.smtp || {};
        const to = Array.isArray(smtp.to) ? smtp.to : [];
        if (!smtp.host || !to.length) throw new Error('SMTP 未配置');
        await sendMail({ host: smtp.host, port: Number(smtp.port || 587), secure: smtp.tls !== false, user: smtp.username, pass: smtp.password || '', from: smtp.from || smtp.username, to, subject: '[backup-center] 测试告警', text: '这是一封测试告警。' });
        log(ctx, 'settings.test', 'smtp');
        return sendJson(ctx.res, 200, { ok: true });
      }
      log(ctx, 'settings.test', channel);
      sendJson(ctx.res, 200, { ok: true });
    } catch (e) {
      throw new ApiError(502, 'alert_test_failed', e.message);
    }
  });

  router.add('GET', '/api/settings/general', async (ctx) => {
    requireUser(ctx);
    sendJson(ctx.res, 200, {
      site_name: 'TRI 集中备份平台',
      default_repository_id: getSetting('default_repository_id'),
      retention_default: cfg.defaults.retention,
      window_default: cfg.defaults.window,
      version: '0.1.0',
      timezone: 'Asia/Shanghai',
      base_url: cfg.server.public_url,
      oidc: { enabled: !!cfg.oidc.enabled, issuer: cfg.oidc.issuer, client_id: cfg.oidc.client_id, redirect_uri: cfg.oidc.redirect_uri },
    });
  });

  function getAlertsRaw() {
    const row = store.get("SELECT value FROM settings WHERE key='alerts'");
    return parseJson(row && row.value, {});
  }
  function getSetting(key) {
    const row = store.get('SELECT value FROM settings WHERE key=?', key);
    return row ? parseJson(row.value, row.value) : null;
  }

  router.add('GET', '/api/alerts', async (ctx) => {
    requireUser(ctx);
    sendJson(ctx.res, 200, alerts.list({ limit: toInt(ctx.query.get('limit'), 100), offset: toInt(ctx.query.get('offset'), 0) }));
  });

  router.add('POST', '/api/alerts/:id/ack', async (ctx) => {
    checkCsrf(ctx); requireRole(ctx, ['admin', 'operator']);
    sendJson(ctx.res, 200, alerts.ack(ctx.params.id));
  });

  router.add('GET', '/api/metrics', async (ctx) => {
    const bearer = String(ctx.req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
    const token = bearer || String(ctx.query.get('token') || '');
    if (!(cfg.metrics.token && timingSafeEqualStr(token, cfg.metrics.token))) requireRole(ctx, ['admin']);
    ctx.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    ctx.res.end(metrics.render());
  });

  return {
    async handle(req, res, url) {
      securityHeaders(res);
      const pathname = url.pathname;
      const match = router.match(req.method, pathname);
      if (!match) throw new ApiError(404, 'not_found', '接口不存在');
      const cookies = parseCookies(req);
      const session = auth.sessionFromSid(cookies[cookieName]);
      const ctx = {
        req, res, url, params: match.params, query: url.searchParams,
        session: session || null, user: session ? session.user : null,
      };
      try {
        // 仅管理员可访问管理/数据接口（Group_Roots 成员或本地应急 admin）
        const publicApi = new Set(['/api/auth/login', '/api/auth/config', '/api/auth/logout']);
        const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '').trim();
        const metricsTokenOk = pathname === '/api/metrics' && cfg.metrics.token &&
          timingSafeEqualStr(bearer || String(url.searchParams.get('token') || ''), cfg.metrics.token);
        if (pathname.startsWith('/api/') && !publicApi.has(pathname) && !metricsTokenOk) {
          if (!session) throw new ApiError(401, 'unauthorized', '请先登录');
          if (session.user.role !== 'admin') throw new ApiError(403, 'forbidden', '仅管理员可访问');
        }
        if (req.method !== 'GET' && req.method !== 'HEAD' && !pathname.startsWith('/api/auth/login') && !pathname.startsWith('/auth/oidc')) checkCsrf(ctx);
        await match.handler(ctx);
      } catch (e) {
        sendError(res, e);
      }
    },
  };
}
