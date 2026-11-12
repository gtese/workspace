/**
 * 开放 API v1 —— 统一路由层。
 *
 * 设计：
 *   · 所有接口挂在 /api/v1/* 下，与浏览器内部接口（/api/*）隔离
 *   · 认证：Authorization: Bearer <API Key 或 JWT>
 *   · 权限：scope（Key 能做什么） ∩ 角色（用户能做什么）
 *   · 统一响应信封：{ ok: true, data } / { ok: false, error: { code, message } }
 *   · 统一分页：?page=1&pageSize=50 → { data: { rows, page, pageSize, total } }
 *   · 内置限流（按 Key）与调用日志
 */
import { currentUser, loadUser } from './auth.js';
import { authenticateUser, groupMatches, groupNames } from './ldap.js';
import { config } from './config.js';
import * as api from './apiAuth.js';
import * as repo from './repo.js';
import * as service from './service.js';
import * as assets from './assets.js';
import * as costingRepo from './costingRepo.js';
import { computeDeduction, complianceCheck, allocateLaborCost } from './costing.js';
import { ledgerCatalog, validateLedgerRow, deriveValues } from './ledgers.js';
import { generateAllDocx, generateDocx, buildDocContext } from './docService.js';
import { STAGES, DOCS } from './docs.js';
import { buildDeduction, buildLaborPreview } from './costingContext.js';
import { query } from './db.js';

// ---------------------------------------------------------------- 工具
function bad(message, code = 'BAD_REQUEST', status = 400) {
  const e = new Error(message); e.code = code; e.statusCode = status; return e;
}

function apiError(reply, status, code, message, extra) {
  return reply.code(status).send({
    ok: false,
    error: { code, message, ...(extra ? { detail: extra } : {}) },
  });
}

function ok(reply, data, meta) {
  return reply.send({ ok: true, data, ...(meta ? { meta } : {}) });
}

/** 简单内存限流：key -> { count, resetAt } */
const rateState = new Map();
function checkRateLimit(identity) {
  const limit = identity.rateLimitPerMin || 600;
  const now = Date.now();
  const slot = Math.floor(now / 60000);
  const id = `${identity.apiKeyId ?? 'jwt'}:${identity.userId}`;
  const cur = rateState.get(id);
  if (!cur || cur.slot !== slot) {
    rateState.set(id, { slot, count: 1 });
    return { allowed: true, remaining: limit - 1, limit };
  }
  cur.count += 1;
  if (cur.count > limit) {
    return { allowed: false, remaining: 0, limit, retryAfter: 60 - Math.floor((now % 60000) / 1000) };
  }
  return { allowed: true, remaining: limit - cur.count, limit };
}
// 定期清理限流状态，防止内存膨胀
setInterval(() => {
  const slot = Math.floor(Date.now() / 60000);
  for (const [k, v] of rateState) if (v.slot < slot) rateState.delete(k);
}, 60000).unref?.();

/** service 层需要 { id, role } 形式的 viewer */
function viewerOf(identity) {
  return { id: identity.userId, role: identity.role };
}

function paginate(req) {
  const page = Math.max(1, Number(req.query.page) || 1);
  const pageSize = Math.min(500, Math.max(1, Number(req.query.pageSize) || 50));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export default async function apiV1Routes(app) {
  // ------------------------------------------------------------
  // 认证钩子：所有 /api/v1/* 都走这里（token 签发接口除外）
  // ------------------------------------------------------------
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/v1/')) return;
    if (req.url.startsWith('/api/v1/auth/token')) return;   // 换取 token 无需预先认证
    if (req.url === '/api/v1/openapi.json' || req.url === '/api/v1/docs') return;

    req._startAt = Date.now();
    const r = await api.resolveApiIdentity(req);
    if (!r.identity) {
      const map = {
        NO_CREDENTIAL: [401, '缺少认证凭证。请设置 Authorization: Bearer <API Key>'],
        INVALID_KEY: [401, 'API Key 无效'],
        INVALID_TOKEN: [401, 'Token 无效或已过期'],
        KEY_REVOKED: [401, 'API Key 已被吊销'],
        KEY_EXPIRED: [401, 'API Key 已过期'],
        OWNER_INACTIVE: [403, 'API Key 归属用户已停用'],
        USER_INACTIVE: [403, '用户已停用'],
      };
      const [status, message] = map[r.error] ?? [401, '认证失败'];
      return apiError(reply, status, r.error, message);
    }
    const rl = checkRateLimit(r.identity);
    if (!rl.allowed) {
      reply.header('Retry-After', String(rl.retryAfter));
      return apiError(reply, 429, 'RATE_LIMITED',
        `请求过于频繁，每分钟上限 ${rl.limit} 次`);
    }
    reply.header('X-RateLimit-Limit', String(rl.limit));
    reply.header('X-RateLimit-Remaining', String(rl.remaining));
    req.api = r.identity;
  });

  // 统一错误处理 + 调用日志
  app.addHook('onResponse', async (req, reply) => {
    if (!req.url.startsWith('/api/v1/') || !req._startAt) return;
    await api.logApiRequest(req.api, req, reply.statusCode, Date.now() - req._startAt,
      reply.statusCode >= 400 ? String(reply.statusCode) : null);
  });

  app.setErrorHandler((err, req, reply) => {
    if (!req.url.startsWith('/api/v1/')) {
      return reply.send(err);
    }
    const status = err.statusCode ?? 500;
    const code = err.code ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
    if (status >= 500) req.log?.error?.(err);
    return apiError(reply, status, code,
      status >= 500 ? '服务器内部错误' : err.message);
  });

  /** 权限校验包装 */
  function guard(scope, roles = null) {
    return async (req, reply) => {
      if (!api.hasScope(req.api, scope)) {
        return apiError(reply, 403, 'FORBIDDEN',
          `当前凭证缺少权限范围「${scope}」`);
      }
      if (roles && !roles.includes(req.api.role)) {
        return apiError(reply, 403, 'ROLE_FORBIDDEN',
          `需要以下角色之一：${roles.join(' / ')}`);
      }
    };
  }

  // ============================================================
  // 认证
  // ============================================================
  /** 用 AD 账号密码换取 API Token（JWT，默认 2 小时）。 */
  app.post('/api/v1/auth/token', async (req, reply) => {
    const b = req.body ?? {};
    const username = String(b.username ?? '').trim().toLowerCase().replace(/@.*$/, '');
    const password = String(b.password ?? '');
    if (!username || !password) {
      return apiError(reply, 400, 'MISSING_CREDENTIALS', '请提供 username 与 password');
    }
    let ad;
    try {
      ad = await authenticateUser(username, password);
    } catch (err) {
      return apiError(reply, 401, err.code ?? 'AUTH_FAILED', '域账号或密码错误');
    }
    if (config.ldap.allowedGroups.length && !groupMatches(ad.groups, config.ldap.allowedGroups)) {
      return apiError(reply, 403, 'NOT_AUTHORIZED', '账号不在本系统授权范围内');
    }
    const user = await repo.getUserByUsername(username);
    if (!user) return apiError(reply, 403, 'NOT_PROVISIONED', '该账号尚未在系统中建立');
    if (!user.is_active) return apiError(reply, 403, 'INACTIVE', '账号已停用');

    const ttl = Math.min(Math.max(Number(b.expiresInMinutes) || 120, 5), 1440);
    const r = await api.issueApiToken(user, ttl);
    await repo.audit(user.id, 'api.token.issue', username, null, { via: 'password' }, req.ip);
    return ok(reply, {
      accessToken: r.token,
      tokenType: 'Bearer',
      expiresIn: r.expiresIn,
      user: { id: user.id, username: user.username, role: user.role },
    });
  });

  /** 查看当前凭证身份与权限。 */
  app.get('/api/v1/auth/whoami', async (req, reply) => {
    const me = await loadUser(req.api.userId);
    const limits = api.maxScopesForRole(req.api.role);
    const granted = req.api.scopes.includes('*')
      ? api.SCOPE_KEYS.filter((s) => s !== '*')
      : req.api.scopes;
    return ok(reply, {
      userId: req.api.userId,
      username: req.api.username,
      role: req.api.role,
      via: req.api.via,
      apiKeyName: req.api.keyName ?? null,
      scopes: granted,
      canUse: api.SCOPE_KEYS.filter((s) => api.hasScope(req.api, s)),
      maxScopesForRole: limits,
    });
  });

  // ============================================================
  // API Key 管理（仅 admin）
  // ============================================================
  app.get('/api/v1/api-keys', { preHandler: guard('admin') }, async (req, reply) => {
    const rows = await api.listApiKeys();
    return ok(reply, rows.map((k) => ({ ...k, key_hash: undefined })));
  });

  app.get('/api/v1/api-keys/scopes', async (req, reply) =>
    ok(reply, api.SCOPE_KEYS.map((k) => ({ scope: k, description: api.SCOPES[k] }))));

  app.post('/api/v1/api-keys', { preHandler: guard('admin') }, async (req, reply) => {
    const b = req.body ?? {};
    if (!b.name) return apiError(reply, 422, 'VALIDATION', 'name 必填');
    const ownerId = Number(b.ownerId ?? req.api.userId);
    const scopes = Array.isArray(b.scopes) && b.scopes.length ? b.scopes : ['*'];
    const created = await api.createApiKey({
      name: b.name,
      ownerId,
      scopes,
      expiresAt: b.expiresAt || null,
      rateLimitPerMin: b.rateLimitPerMin,
    }, req.api.userId);
    return ok(reply, {
      id: created.id,
      name: created.name,
      key: created.key,       // 仅此一次返回明文
      keyPrefix: created.key_prefix,
      scopes: created.scopes,
      expiresAt: created.expires_at,
      warning: '请立即保存此密钥，之后将无法再次查看明文',
    });
  });

  app.delete('/api/v1/api-keys/:id', { preHandler: guard('admin') }, async (req, reply) => {
    await api.revokeApiKey(Number(req.params.id), req.api.userId);
    return ok(reply, { revoked: true });
  });

  app.get('/api/v1/api-logs', { preHandler: guard('admin') }, async (req, reply) => {
    const rows = await api.listApiLogs({
      limit: Number(req.query.limit) || 100,
      keyId: req.query.keyId ? Number(req.query.keyId) : undefined,
    });
    return ok(reply, rows);
  });

  // ============================================================
  // 元数据
  // ============================================================
  app.get('/api/v1/meta', async (req, reply) => {
    const [projects, calendarRows] = await Promise.all([
      repo.listProjects({ activeOnly: true }), repo.getCalendar(),
    ]);
    return ok(reply, {
      service: 'TraceWork API',
      version: 'v1',
      serverTime: new Date().toISOString(),
      roles: ['admin', 'hr', 'finance', 'pm', 'employee'],
      scopes: api.SCOPE_KEYS,
      projects: projects.map((p) => ({
        id: p.id, code: p.code, name: p.name, isRnd: p.is_rnd,
      })),
      holidayCount: calendarRows.length,
    });
  });

  // ============================================================
  // 项目管理
  // ============================================================
  app.get('/api/v1/projects', { preHandler: guard('project:read') }, async (req, reply) => {
    const r = await repo.listProjects({ activeOnly: req.query.activeOnly === '1' });
    const { page, pageSize, offset } = paginate(req);
    return ok(reply, {
      rows: r.slice(offset, offset + pageSize),
      page, pageSize, total: r.length,
    });
  });

  app.get('/api/v1/projects/:id', { preHandler: guard('project:read') }, async (req, reply) => {
    const p = await repo.getProject(Number(req.params.id));
    if (!p) return apiError(reply, 404, 'NOT_FOUND', '项目不存在');
    const [members, approvers] = await Promise.all([
      repo.getProjectMembers(Number(req.params.id)),
      repo.getProjectApprovers(Number(req.params.id)),
    ]);
    return ok(reply, { project: p, members, approvers });
  });

  app.post('/api/v1/projects', { preHandler: guard('project:write', ['admin', 'hr']) },
    async (req, reply) => {
      const p = await repo.createProject(req.body ?? {}, req.api.userId);
      return ok(reply, p);
    });

  app.patch('/api/v1/projects/:id', { preHandler: guard('project:write', ['admin', 'hr']) },
    async (req, reply) => {
      const p = await repo.updateProject(Number(req.params.id), req.body ?? {}, req.api.userId);
      if (!p) return apiError(reply, 404, 'NOT_FOUND', '项目不存在');
      return ok(reply, p);
    });

  app.delete('/api/v1/projects/:id', { preHandler: guard('project:write', ['admin', 'hr']) },
    async (req, reply) => {
      const done = await repo.deleteProject(Number(req.params.id), req.api.userId);
      if (!done) return apiError(reply, 404, 'NOT_FOUND', '项目不存在');
      return ok(reply, { deleted: true });
    });

  app.put('/api/v1/projects/:id/members', { preHandler: guard('project:write', ['admin', 'hr']) },
    async (req, reply) => {
      const ids = Array.isArray(req.body?.userIds) ? req.body.userIds.map(Number) : [];
      await repo.setProjectMembers(Number(req.params.id), ids);
      return ok(reply, { count: ids.length });
    });

  app.put('/api/v1/projects/:id/approvers', { preHandler: guard('project:write', ['admin', 'hr']) },
    async (req, reply) => {
      const ids = Array.isArray(req.body?.userIds) ? req.body.userIds.map(Number) : [];
      if (ids.length > 20) return apiError(reply, 422, 'VALIDATION', '审批人不宜超过 20 位');
      await repo.setProjectApprovers(Number(req.params.id), ids);
      return ok(reply, { count: ids.length });
    });

  // ============================================================
  // 用户
  // ============================================================
  app.get('/api/v1/users', { preHandler: guard('user:read') }, async (req, reply) => {
    const rows = await repo.listUsers({
      activeOnly: req.query.activeOnly !== '0',
      role: req.query.role || undefined,
      search: req.query.q || undefined,
    });
    const { page, pageSize, offset } = paginate(req);
    return ok(reply, {
      rows: rows.slice(offset, offset + pageSize).map((u) => ({
        id: u.id, username: u.username, displayName: u.display_name,
        role: u.role, department: u.department, employeeNo: u.employee_no,
        isActive: u.is_active, adStatus: u.ad_status,
      })),
      page, pageSize, total: rows.length,
    });
  });

  app.get('/api/v1/users/me', async (req, reply) => {
    const u = await loadUser(req.api.userId);
    if (!u) return apiError(reply, 404, 'NOT_FOUND', '用户不存在');
    return ok(reply, {
      id: u.id, username: u.username, displayName: u.display_name,
      role: u.role, department: u.department, email: u.email,
    });
  });

  app.patch('/api/v1/users/:id',
    { preHandler: guard('user:write', ['admin', 'hr']) },
    async (req, reply) => {
      const id = Number(req.params.id);
      const b = req.body ?? {};
      const patch = {};
      const map = {
        displayName: 'display_name', department: 'department', title: 'title',
        role: 'role', employeeNo: 'employee_no', employeeType: 'employee_type',
        monthlySalary: 'monthly_salary', isActive: 'is_active',
        isTechStaff: 'is_tech_staff', isRdStaff: 'is_rd_staff',
        education: 'education', major: 'major', post: 'post',
        rdDuty: 'rd_duty', joinDate: 'join_date',
      };
      for (const [k, col] of Object.entries(map)) {
        if (k in b) patch[col] = b[k];
      }
      if (patch.role && req.api.role !== 'admin') {
        return apiError(reply, 403, 'ROLE_FORBIDDEN', '仅系统管理员可修改角色');
      }
      const u = await repo.updateUser(id, patch, req.api.userId);
      if (!u) return apiError(reply, 404, 'NOT_FOUND', '用户不存在');
      return ok(reply, { id: u.id, username: u.username, role: u.role });
    });

  // ============================================================
  // 考勤与日历
  // ============================================================
  app.get('/api/v1/attendance/:period', { preHandler: guard('timesheet:read') },
    async (req, reply) => {
      const rows = await repo.listAttendance(req.params.period);
      return ok(reply, rows);
    });

  app.put('/api/v1/attendance/:period/:userId',
    { preHandler: guard('user:write', ['admin', 'hr']) },
    async (req, reply) => {
      const b = req.body ?? {};
      if (b.hours === undefined) return apiError(reply, 422, 'VALIDATION', 'hours 必填');
      await repo.upsertAttendance(Number(req.params.userId), req.params.period,
        b.workdays === undefined ? null : Number(b.workdays),
        Number(b.hours), 'manual', req.api.userId);
      return ok(reply, { ok: true });
    });

  app.delete('/api/v1/attendance/:period/:userId',
    { preHandler: guard('user:write', ['admin', 'hr']) },
    async (req, reply) => {
      const done = await repo.deleteAttendance(Number(req.params.userId), req.params.period,
        req.api.userId);
      if (!done) return apiError(reply, 404, 'NOT_FOUND', '该月没有考勤记录');
      return ok(reply, { deleted: true });
    });

  app.get('/api/v1/calendar/:period', async (req, reply) => {
    const days = await repo.getCalendar();
    const inMonth = days.filter((d) => d.day.startsWith(req.params.period));
    return ok(reply, inMonth);
  });

  // ============================================================
  // 工时
  // ============================================================
  app.get('/api/v1/timesheets/:period', { preHandler: guard('timesheet:read') },
    async (req, reply) => {
      const userId = Number(req.query.userId ?? req.api.userId);
      if (userId !== req.api.userId && !['admin', 'hr', 'pm'].includes(req.api.role)) {
        return apiError(reply, 403, 'FORBIDDEN', '只能查看自己的工时');
      }
      const ts = await repo.getTimesheet(userId, req.params.period);
      const entries = await repo.getEntriesForPeriod(userId, req.params.period);
      return ok(reply, { timesheet: ts, entries });
    });

  app.get('/api/v1/timesheets/:period/history', { preHandler: guard('timesheet:read') },
    async (req, reply) => {
      const userId = Number(req.query.userId ?? req.api.userId);
      if (userId !== req.api.userId && !['admin', 'hr', 'pm'].includes(req.api.role)) {
        return apiError(reply, 403, 'FORBIDDEN', '只能查看自己的工时');
      }
      const rows = await repo.getEntriesForPeriod(userId, req.params.period);
      return ok(reply, rows);
    });

  app.put('/api/v1/timesheets/:period/day', { preHandler: guard('timesheet:write') },
    async (req, reply) => {
      const b = req.body ?? {};
      const userId = Number(b.userId ?? req.api.userId);
      if (userId !== req.api.userId) {
        return apiError(reply, 403, 'FORBIDDEN', '只能为自己填报工时');
      }
      const entries = Array.isArray(b.entries) ? b.entries.map((e) => ({
        project_id: Number(e.projectId ?? e.project_id),
        hours: Number(e.hours),
        note: e.note ?? '',
        is_rnd: e.isRnd ?? undefined,
      })) : [];
      const r = await service.saveDay(userId, req.params.period, String(b.date), entries);
      return ok(reply, r);
    });

  app.post('/api/v1/timesheets/:period/submit', { preHandler: guard('timesheet:write') },
    async (req, reply) => {
      const userId = Number(req.body?.userId ?? req.api.userId);
      if (userId !== req.api.userId) {
        return apiError(reply, 403, 'FORBIDDEN', '只能提交自己的工时');
      }
      const r = await service.submitMonth(userId, req.params.period, req.ip);
      return ok(reply, r);
    });

  app.post('/api/v1/timesheets/:period/withdraw', { preHandler: guard('timesheet:write') },
    async (req, reply) => {
      const userId = Number(req.body?.userId ?? req.api.userId);
      const r = await service.withdrawMonth(userId, req.params.period, req.ip);
      return ok(reply, r);
    });

  app.get('/api/v1/entries', { preHandler: guard('timesheet:read') }, async (req, reply) => {
    const { page, pageSize } = paginate(req);
    const params = [];
    const where = [];
    if (req.query.period) { params.push(req.query.period); where.push(`to_char(e.work_date,'YYYY-MM')=$${params.length}`); }
    if (req.query.userId) { params.push(Number(req.query.userId)); where.push(`e.user_id=$${params.length}`); }
    if (req.query.projectId) { params.push(Number(req.query.projectId)); where.push(`e.project_id=$${params.length}`); }
    if (req.query.from) { params.push(req.query.from); where.push(`e.work_date >= $${params.length}::date`); }
    if (req.query.to) { params.push(req.query.to); where.push(`e.work_date <= $${params.length}::date`); }

    const w = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const { rows: cnt } = await query(`SELECT count(*)::int AS n FROM time_entries e ${w}`, params);
    params.push(pageSize, (page - 1) * pageSize);
    const { rows } = await query(
      `SELECT e.id, to_char(e.work_date,'YYYY-MM-DD') AS work_date, e.user_id, u.username,
              e.project_id, p.code AS project_code, p.name AS project_name,
              e.hours, e.note
         FROM time_entries e
         JOIN users u ON u.id=e.user_id JOIN projects p ON p.id=e.project_id
         ${w} ORDER BY e.work_date DESC, e.id DESC
         LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    return ok(reply, { rows, page, pageSize, total: cnt[0].n });
  });

  // ============================================================
  // 审批
  // ============================================================
  app.get('/api/v1/approvals', { preHandler: guard('approval:read') }, async (req, reply) => {
    const r = await service.approvalInbox(viewerOf(req.api), req.query.period ?? '', {
      status: req.query.status,
    });
    const { page, pageSize, offset } = paginate(req);
    return ok(reply, {
      rows: r.rows.slice(offset, offset + pageSize),
      page, pageSize, total: r.rows.length,
      pendingForMe: r.pendingForMe,
    });
  });

  app.post('/api/v1/approvals/:id/decide', { preHandler: guard('approval:write') },
    async (req, reply) => {
      const b = req.body ?? {};
      const decision = String(b.decision ?? '');
      if (!['approve', 'reject', 'approved', 'rejected'].includes(decision)) {
        return apiError(reply, 422, 'VALIDATION', 'decision 应为 approve 或 reject');
      }
      const r = await service.decide(viewerOf(req.api), Number(req.params.id),
        decision.startsWith('approv') ? 'approved' : 'rejected',
        b.comment ?? '', req.ip);
      return ok(reply, r);
    });

  // ============================================================
  // 费用归集
  // ============================================================
  app.get('/api/v1/cost-entries', { preHandler: guard('costing:read') }, async (req, reply) => {
    const rows = await costingRepo.listCostEntries({
      period: req.query.period, category: req.query.category,
      projectId: req.query.projectId ? Number(req.query.projectId) : undefined,
    });
    const { page, pageSize, offset } = paginate(req);
    return ok(reply, { rows: rows.slice(offset, offset + pageSize), page, pageSize, total: rows.length });
  });

  app.post('/api/v1/cost-entries',
    { preHandler: guard('costing:write', ['admin', 'hr', 'finance']) },
    async (req, reply) => {
      const e = await costingRepo.createCostEntry(req.body ?? {}, req.api.userId);
      return ok(reply, e);
    });

  app.patch('/api/v1/cost-entries/:id',
    { preHandler: guard('costing:write', ['admin', 'hr', 'finance']) },
    async (req, reply) => {
      const e = await costingRepo.updateCostEntry(Number(req.params.id), req.body ?? {}, req.api.userId);
      if (!e) return apiError(reply, 404, 'NOT_FOUND', '费用记录不存在');
      return ok(reply, e);
    });

  app.delete('/api/v1/cost-entries/:id',
    { preHandler: guard('costing:write', ['admin', 'hr', 'finance']) },
    async (req, reply) => {
      await costingRepo.deleteCostEntry(Number(req.params.id), req.api.userId);
      return ok(reply, { deleted: true });
    });

  app.get('/api/v1/shared-expenses', { preHandler: guard('costing:read') }, async (req, reply) => {
    const rows = await costingRepo.listShared(req.query.period);
    return ok(reply, rows);
  });

  app.post('/api/v1/shared-expenses',
    { preHandler: guard('costing:write', ['admin', 'hr', 'finance']) },
    async (req, reply) => ok(reply, await costingRepo.createShared(req.body ?? {}, req.api.userId)));

  app.get('/api/v1/outsourcing', { preHandler: guard('costing:read') }, async (req, reply) => {
    const rows = await costingRepo.listOutsource(req.query.projectId ? Number(req.query.projectId) : undefined);
    return ok(reply, rows);
  });

  // 备查台账
  app.get('/api/v1/ledgers', { preHandler: guard('costing:read') }, async (req, reply) => {
    return ok(reply, ledgerCatalog());
  });

  app.get('/api/v1/ledgers/:key', { preHandler: guard('costing:read') }, async (req, reply) => {
    const rows = await costingRepo.listLedger(req.params.key, { period: req.query.period });
    return ok(reply, rows.map((r) => ({ ...r, derived: deriveValues(req.params.key, r) })));
  });

  app.post('/api/v1/ledgers/:key/rows',
    { preHandler: guard('costing:write', ['admin', 'hr', 'finance']) },
    async (req, reply) => {
      const errs = validateLedgerRow(req.params.key, req.body ?? {});
      if (errs.length) return apiError(reply, 422, 'VALIDATION', errs.join('；'), errs);
      const r = await costingRepo.createLedgerRow(req.params.key, req.body ?? {}, req.api.userId);
      return ok(reply, r);
    });

  app.patch('/api/v1/ledgers/:key/rows/:id',
    { preHandler: guard('costing:write', ['admin', 'hr', 'finance']) },
    async (req, reply) => {
      const r = await costingRepo.updateLedgerRow(req.params.key, Number(req.params.id),
        req.body ?? {}, req.api.userId);
      if (!r) return apiError(reply, 404, 'NOT_FOUND', '台账行不存在');
      return ok(reply, r);
    });

  app.delete('/api/v1/ledgers/:key/rows/:id',
    { preHandler: guard('costing:write', ['admin', 'hr', 'finance']) },
    async (req, reply) => {
      await costingRepo.deleteLedgerRow(req.params.key, Number(req.params.id), req.api.userId);
      return ok(reply, { deleted: true });
    });

  // ============================================================
  // 汇总与测算
  // ============================================================
  app.get('/api/v1/summary/:period', { preHandler: guard('summary:read') },
    async (req, reply) => {
      const r = req.query.snapshot === '1'
        ? await service.freezeSummary(viewerOf(req.api), req.params.period, req.ip)
        : await service.monthlySummary(req.params.period, { mode: req.query.mode ?? 'live' });
      return ok(reply, r);
    });

  app.get('/api/v1/deduction/:period', { preHandler: guard('summary:read') },
    async (req, reply) => {
      const scope = req.query.scope === 'year' ? 'year' : 'month';
      const result = await buildDeduction(req.params.period, scope);
      return ok(reply, result);
    });

  app.get('/api/v1/labor-allocation/:period', { preHandler: guard('summary:read') },
    async (req, reply) => ok(reply, await buildLaborPreview(req.params.period)));

  // ============================================================
  // 备查资料
  // ============================================================
  app.get('/api/v1/documents', { preHandler: guard('doc:read') }, async (req, reply) => {
    const rows = await costingRepo.listDocs(req.query.period ?? '');
    return ok(reply, {
      stages: STAGES,
      templates: DOCS.map((d) => ({ key: d.key, stage: d.stage, title: d.title })),
      generated: rows,
    });
  });

  app.get('/api/v1/documents/:key/preview', { preHandler: guard('doc:read') },
    async (req, reply) => {
      const ctx = await buildDocContext(req.query.period ?? '', req.query.scope ?? 'month');
      const buf = await generateDocx(req.params.key, ctx);
      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        .header('Content-Disposition', `attachment; filename="${req.params.key}.docx"`)
        .send(buf);
    });

  app.post('/api/v1/documents/generate', { preHandler: guard('doc:write', ['admin', 'hr', 'finance']) },
    async (req, reply) => {
      const r = await generateAllDocx(req.body?.period ?? '', req.api.userId);
      return ok(reply, r);
    });

  // ============================================================
  // IT 资产
  // ============================================================
  app.get('/api/v1/assets', { preHandler: guard('asset:read') }, async (req, reply) => {
    const isAdminRole = ['admin', 'hr'].includes(req.api.role);
    const rows = await assets.listAssets({
      status: req.query.status || undefined,
      deviceType: req.query.type || undefined,
      keyword: req.query.q || undefined,
      unassignedOnly: req.query.unassigned === '1',
      holderId: isAdminRole
        ? (req.query.holder ? Number(req.query.holder) : undefined)
        : req.api.userId,
    });
    const { page, pageSize, offset } = paginate(req);
    return ok(reply, { rows: rows.slice(offset, offset + pageSize), page, pageSize, total: rows.length });
  });

  app.get('/api/v1/assets/stats', { preHandler: guard('asset:read') }, async (req, reply) =>
    ok(reply, await assets.assetStats()));

  app.get('/api/v1/assets/:id', { preHandler: guard('asset:read') }, async (req, reply) => {
    const a = await assets.getAsset(Number(req.params.id));
    if (!a) return apiError(reply, 404, 'NOT_FOUND', '资产不存在');
    const isAdminRole = ['admin', 'hr'].includes(req.api.role);
    if (!isAdminRole && a.holder_id !== req.api.userId) {
      return apiError(reply, 403, 'FORBIDDEN', '只能查看自己名下的资产');
    }
    return ok(reply, { asset: a, assignments: await assets.listAssignments(a.id) });
  });

  app.post('/api/v1/assets', { preHandler: guard('asset:write', ['admin', 'hr']) },
    async (req, reply) => {
      const a = await assets.createAsset(req.body ?? {}, req.api.userId);
      const dup = await assets.checkFinanceNoDup(a.finance_no, a.id);
      return ok(reply, {
        asset: a,
        warnings: dup.length ? [`财务资产编号「${a.finance_no}」已被 ${dup.length} 项资产使用：${dup.join('、')}`] : [],
      });
    });

  app.patch('/api/v1/assets/:id', { preHandler: guard('asset:write', ['admin', 'hr']) },
    async (req, reply) => ok(reply, { asset: await assets.updateAsset(Number(req.params.id), req.body ?? {}, req.api.userId) }));

  app.delete('/api/v1/assets/:id', { preHandler: guard('asset:write', ['admin', 'hr']) },
    async (req, reply) => {
      await assets.deleteAsset(Number(req.params.id), req.api.userId);
      return ok(reply, { deleted: true });
    });

  app.post('/api/v1/assets/:id/return', { preHandler: guard('asset:write', ['admin', 'hr']) },
    async (req, reply) => ok(reply, {
      asset: await assets.returnAsset(Number(req.params.id), req.api.userId, req.body?.note ?? ''),
    }));

  // ============================================================
  // 静态文档
  // ============================================================
  app.get('/api/v1/openapi.json', async (req, reply) => {
    const { buildOpenApi } = await import('./openapi.js');
    return buildOpenApi();
  });
}