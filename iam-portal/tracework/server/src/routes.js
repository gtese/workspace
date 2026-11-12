/**
 * 路由定义。所有写操作都做鉴权 + 审计。
 */
import { z } from 'zod';
import * as repo from './repo.js';
import * as svc from './service.js';
import { currentUser, loadUser, isAdmin, isHr, deriveRole, setSessionCookie, clearSessionCookie } from './auth.js';
import { authenticateUser, groupMatches, groupNames } from './ldap.js';
import { config } from './config.js';
import { currentPeriod, PERIOD_RE } from './domain.js';
import { syncAdUsers } from './jobs/syncAd.js';

// ---------------------------------------------------------------- 校验
const periodSchema = z.string().regex(PERIOD_RE, '月份格式应为 YYYY-MM');
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');

const entrySchema = z.object({
  project_id: z.coerce.number().int().positive(),
  hours: z.coerce.number().min(0).max(24),
  note: z.string().max(500).optional().default(''),
});

const saveDaySchema = z.object({
  period: periodSchema,
  date: dateSchema,
  entries: z.array(entrySchema).max(20),
});

const loginSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(256),
});

function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const e = new Error('请求参数不合法：' + r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；'));
    e.statusCode = 400;
    e.code = 'VALIDATION';
    throw e;
  }
  return r.data;
}

export default async function routes(app) {
  // ---------------------------------------------------------------- 认证
  // 口令登录仅在 AUTH_MODE=ldap 时注册。
  // OIDC 模式下该路由不存在（404），确保没有绕过统一身份的旁路。
  if (config.authMode !== 'oidc') {
  app.post('/api/auth/login', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = parse(loginSchema, req.body ?? {});
    const username = body.username.trim().toLowerCase().replace(/@.*$/, '');

    let ad;
    try {
      ad = await authenticateUser(username, body.password);
    } catch (err) {
      app.log.warn({ username, code: err.code }, '登录失败');
      await repo.audit(null, 'auth.login.failed', username, null, { code: err.code }, req.ip);
      return reply.code(401).send({ error: err.message, code: err.code });
    }

    // 组准入判断
    if (config.ldap.allowedGroups.length && !groupMatches(ad.groups, config.ldap.allowedGroups)) {
      await repo.audit(null, 'auth.login.denied', username, null,
        { reason: 'not_in_allowed_groups', groups: groupNames(ad.groups) }, req.ip);
      return reply.code(403).send({
        error: '您的账号不在本系统授权范围内，请联系 IT 或人力资源部',
        code: 'NOT_AUTHORIZED',
      });
    }

    let user = await repo.getUserByUsername(username);
    if (!user) {
      user = await repo.upsertUserFromAd(ad, deriveRole(ad.groups));
    } else if (!user.is_active) {
      return reply.code(403).send({ error: '该账号已停用，请联系人力资源部', code: 'INACTIVE' });
    } else {
      // 每次登录刷新 AD 属性（姓名/部门/组），但不动业务属性
      user = await repo.upsertUserFromAd(ad, user.role);
    }

    const { createSession } = await import('./auth.js');
    const token = await createSession(user);
    setSessionCookie(reply, token);
    await repo.touchLogin(user.id);
    await repo.audit(user.id, 'auth.login', username, null, {}, req.ip);

    return {
      user: publicUser(user),
      expiresInMinutes: config.session.ttlMinutes,
    };
  });
  }

  /**
   * 浏览器会话换取临时 API Token。
   *
   * 目的：系统管理页面的「API 密钥」区块需要调用 /api/v1/api-keys，
   * 而 v1 接口要求 Bearer 认证。这里用已登录的 Cookie 会话签发一个
   * 短期 token（10 分钟），避免在前端保存长期凭据。
   * 有效期短、只能由已登录会话换取，风险可控。
   */
  app.post('/api/auth/api-token', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const { issueApiToken } = await import('./apiAuth.js');
    const r = await issueApiToken(me, 10);
    return { accessToken: r.token, expiresIn: r.expiresIn };
  });

  // 本地登出：仅在 ldap 模式注册。
  // OIDC 模式下由 oidcRoutes.js 提供，会同时结束统一身份会话。
  if (config.authMode !== 'oidc') {
    app.post('/api/auth/logout', async (req, reply) => {
      const me = await currentUser(req);
      clearSessionCookie(reply);
      if (me) await repo.audit(me.id, 'auth.logout', me.username, null, {}, req.ip);
      return { ok: true };
    });
  }

  app.get('/api/auth/me', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const [full, pending] = await Promise.all([
      loadUser(me.id),
      repo.pendingCountForApprover(me.id, null),
    ]);
    // canApprove 除角色外，还要看是否被指定为某项目的审批人：
    // 项目审批人可能是普通研发人员（employee），必须能看到待办。
    let isApprover = ['pm', 'hr', 'finance', 'admin'].includes(full.role);
    if (!isApprover) {
      const ids = await repo.projectIdsForApprover(full.id);
      isApprover = ids.length > 0;
    }
    return {
      user: publicUser(full),
      permissions: {
        canFill: true,
        canApprove: isApprover,
        // 任何人都能查看「我提交的审批」进度（与「待我审批」是两回事）
        canViewMyApprovals: true,
        canAdmin: full.role === 'admin',
        canHr: ['hr', 'admin'].includes(full.role),
        // 财务岗可访问研发费用归集、台账、测算与备查资料
        canFinance: ['finance', 'hr', 'admin'].includes(full.role),
      },
      pendingApprovals: pending,
    };
  });

  /**
   * 我的工时审批进度列表。
   *
   * 每个员工都应能看到「自己提交的审批」走到哪一步了 —— 这不同于
   * 「待我审批」（那是审批人的事）。两者是不同的语义：
   *   · 待我审批 inbox  → 我需要处理的（pm/hr/finance）
   *   · 我的审批 mine   → 我提交的、别人在处理我的（所有人）
   */
  app.get('/api/my-timesheets', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const period = req.query.period ? String(req.query.period) : null;
    const { query } = await import('./db.js');

    const params = [me.id];
    let periodCond = '';
    if (period) { params.push(period); periodCond = `AND t.period = $${params.length}`; }

    const { rows } = await query(
      `SELECT t.id, t.period, t.status, t.total_hours::float8 AS total_hours,
              t.rnd_hours::float8 AS rnd_hours,
              t.reject_reason,
              to_char(t.submitted_at,'YYYY-MM-DD HH24:MI') AS submitted_at_fmt,
              to_char(t.archived_at,'YYYY-MM-DD HH24:MI') AS archived_at_fmt,
              t.labor_cost_wan::float8 AS labor_cost_wan
         FROM timesheets t
        WHERE t.user_id = $1 ${periodCond}
        ORDER BY t.period DESC`, params);

    // 逐单补充项目审批明细与流转轨迹
    const out = [];
    for (const t of rows) {
      const [appr, logs] = await Promise.all([
        query(
          `SELECT a.id, p.code AS project_code, p.name AS project_name,
                  a.hours::float8 AS hours, a.status, a.reason,
                  u.display_name AS approver_name,
                  to_char(a.acted_at,'YYYY-MM-DD HH24:MI') AS acted_at_fmt
             FROM approvals a
             JOIN projects p ON p.id = a.project_id
             LEFT JOIN users u ON u.id = a.approver_id
            WHERE a.timesheet_id = $1 ORDER BY p.code`, [t.id]),
        query(
          `SELECT from_status, to_status, action, note, actor_name,
                  to_char(at,'YYYY-MM-DD HH24:MI') AS at_fmt
             FROM timesheet_stage_logs WHERE timesheet_id = $1
            ORDER BY at`, [t.id]),
      ]);
      out.push({
        ...t,
        stageLabel: {
          draft: '填报中', stage1_project: '项目审批', stage2_hr: '人事确认',
          stage3_finance: '财务确认', archived: '已归档', rejected: '已驳回',
        }[t.status] ?? t.status,
        stageOrder: {
          draft: 0, stage1_project: 1, stage2_hr: 2, stage3_finance: 3, archived: 4,
        }[t.status] ?? 0,
        approvals: appr.rows,
        logs: logs.rows,
      });
    }

    // 统计：待到哪一步
    const summary = {
      total: out.length,
      inProgress: out.filter((x) => ['stage1_project', 'stage2_hr', 'stage3_finance'].includes(x.status)).length,
      archived: out.filter((x) => x.status === 'archived').length,
      draft: out.filter((x) => x.status === 'draft').length,
    };
    return { rows: out, summary };
  });

  /**
   * 系统版本信息。
   * 用途：随时核对「部署环境运行的到底是哪个版本」，避免代码已更新但镜像未重建。
   */
  app.get('/api/version', async (req, reply) => {
    const { readFileSync } = await import('node:fs');
    let pkgVersion = 'unknown';
    try {
      const pkgPath = new URL('../package.json', import.meta.url);
      pkgVersion = JSON.parse(readFileSync(pkgPath, 'utf8')).version ?? 'unknown';
    } catch { /* ignore */ }

    // 注意：routes.js 顶层未导入 query，需动态引入
    const { query: dbQuery } = await import('./db.js');
    const { rows } = await dbQuery(
      'SELECT name FROM schema_migrations ORDER BY name').catch(() => ({ rows: [] }));

    return {
      service: 'TraceWork',
      version: pkgVersion,
      migrations: rows.map((r) => r.name),
      migrationCount: rows.length,
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    };
  });

  // ---------------------------------------------------------------- 公共元数据
  app.get('/api/meta', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const [projects, calendarRows] = await Promise.all([
      repo.listProjects(),
      repo.getCalendar(),
    ]);
    const calendar = {};
    for (const [k, v] of calendarRows) if (!v) calendar[k] = false;

    return {
      projects: projects.map((p) => ({
        id: p.id, code: p.code, name: p.name, isRnd: p.is_rnd,
        isActive: p.is_active, ownerId: p.owner_id, ownerName: p.owner_name,
      })),
      holidays: calendar,
      currentPeriod: currentPeriod(),
      serverTime: new Date().toISOString(),
      approvalSlaWorkdays: config.app.approvalSlaWorkdays,
    };
  });

  app.get('/api/calendar/:period', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const period = parse(periodSchema, req.params.period);
    const calendar = await repo.getCalendar();
    const workdays = (await import('./domain.js')).workdaysOfMonth(period, calendar);
    return { period, workdays, count: workdays.length };
  });

  // ---------------------------------------------------------------- 填报
  app.get('/api/timesheet/:period/context', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const period = parse(periodSchema, req.params.period);
    const targetId = req.query.user_id && isHr(me) ? Number(req.query.user_id) : me.id;
    return svc.fillContext(targetId, period);
  });

  app.put('/api/timesheet/:period/day', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const period = parse(periodSchema, req.params.period);
    const body = parse(saveDaySchema, { ...(req.body ?? {}), period });
    const targetId = body.user_id && isHr(me) ? Number(body.user_id) : me.id;
    if (targetId !== me.id) {
      // HR 代填需记录
      await repo.audit(me.id, 'timesheet.proxy_save', String(targetId), period, { date: body.date }, req.ip);
    }
    return svc.saveDay(targetId, period, body.date, body.entries);
  });

  /**
   * 提交报工（兼容旧前端路径）。
   *
   * 统一走四阶段工作流：draft → stage1_project → stage2_hr → stage3_finance → archived。
   * 保留此路由是为了不让旧客户端失效，但内部逻辑与新接口完全一致，
   * 避免出现「用旧接口提交导致状态停在 submitted、新审批中心看不到」的问题。
   */
  app.post('/api/timesheet/:period/submit', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const period = parse(periodSchema, req.params.period);
    const { submitSheet } = await import('./workflow.js');
    return submitSheet(me.id, period, me, req.ip);
  });

  app.post('/api/timesheet/:period/withdraw', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const period = parse(periodSchema, req.params.period);
    return svc.withdrawMonth(me.id, period, req.ip);
  });

  app.get('/api/timesheet/:period/history', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const period = parse(periodSchema, req.params.period);
    const targetId = req.query.user_id && isHr(me) ? Number(req.query.user_id) : me.id;
    const rows = await repo.getEntriesForPeriod(targetId, period);
    return { rows };
  });

  // ---------------------------------------------------------------- 个人总览
  app.get('/api/dashboard', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const period = req.query.period ? parse(periodSchema, req.query.period) : currentPeriod();

    const [ctx, myApprovals, pending, progress] = await Promise.all([
      svc.fillContext(me.id, period),
      repo.listApprovals(period, { userId: me.id }),
      repo.pendingCountForApprover(me.id, period),
      repo.approvalsProgress(period),
    ]);

    return {
      period,
      fill: {
        status: ctx.status,
        rndHours: ctx.totals.rndHours,
        nonRndHours: ctx.totals.nonRndHours,
        totalHours: ctx.totals.totalHours,
        attendanceHours: ctx.totals.attendanceHours,
        diff: ctx.totals.diff,
        attendanceMissing: ctx.attendanceMissing,
        editable: ctx.editable,
        daysFilled: ctx.days.filter((d) => d.saved).length,
        workdayCount: ctx.workdayCount,
      },
      myApprovals: myApprovals.map((a) => ({
        projectCode: a.project_code, projectName: a.project_name,
        hours: Number(a.hours), status: a.status, reason: a.reason,
        dueAt: a.due_at, submitAt: a.submit_at,
      })),
      pendingForMe: pending,
      progress,
    };
  });

  // ---------------------------------------------------------------- 审批
  app.get('/api/approvals', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const period = req.query.period ? parse(periodSchema, req.query.period) : currentPeriod();
    const status = req.query.status;
    return svc.approvalInbox(me, period, { status });
  });

  app.post('/api/approvals/:id/decide', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const id = Number(req.params.id);
    const action = (req.body?.action ?? '').toString();
    if (!['approve', 'reject'].includes(action)) {
      return reply.code(400).send({ error: 'action 必须为 approve 或 reject' });
    }
    const reason = (req.body?.reason ?? '').toString().slice(0, 1000);
    if (action === 'reject' && !reason.trim()) {
      return reply.code(400).send({ error: '驳回时必须填写原因' });
    }
    // 统一走四阶段流程：审批通过后按规则推进到人事/财务阶段，
    // 否则工时单会停在 stage1_project 永不前进
    const { decideProjectApproval } = await import('./workflow.js');
    return decideProjectApproval(id, action, reason, me, req.ip);
  });

  app.post('/api/approvals/bulk', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const period = parse(periodSchema, req.body?.period);
    const userId = Number(req.body?.user_id);
    const action = (req.body?.action ?? '').toString();
    if (!['approve', 'reject'].includes(action)) {
      return reply.code(400).send({ error: 'action 必须为 approve 或 reject' });
    }
    return { results: await svc.bulkDecide(me, period, userId, action,
      (req.body?.reason ?? '').toString().slice(0, 1000), req.ip) };
  });

  // ---------------------------------------------------------------- 汇总与分摊
  app.get('/api/summary/:period', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    // 财务需要核对工时与人工费用口径，因此同样开放查看权限
    if (!['admin', 'hr', 'pm', 'finance'].includes(me.role)) {
      return reply.code(403).send({ error: '您没有查看月度汇总的权限' });
    }
    const period = parse(periodSchema, req.params.period);
    const mode = req.query.mode === 'snapshot' ? 'snapshot' : 'live';
    return svc.monthlySummary(period, { mode });
  });

  app.post('/api/summary/:period/freeze', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const period = parse(periodSchema, req.params.period);
    return svc.freezeSummary(me, period, req.ip);
  });

  // ---------------------------------------------------------------- 管理：用户
  app.get('/api/admin/users', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    const rows = await repo.listUsers({
      activeOnly: req.query.all !== '1',
      role: req.query.role,
      search: req.query.q,
    });
    return { rows: rows.map(publicUser) };
  });

  app.patch('/api/admin/users/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isAdmin(me)) return reply.code(403).send({ error: '仅管理员可修改用户档案' });
    const id = Number(req.params.id);
    const built = buildUserPatch(req.body ?? {});
    if (built.error) return reply.code(400).send({ error: built.error });
    if (!Object.keys(built.patch).length) {
      return reply.code(400).send({ error: '没有需要更新的字段' });
    }
    const row = await repo.updateUser(id, built.patch, me.id);
    return { user: publicUser(row) };
  });

  /**
   * 批量更新用户档案。
   * 用途：科技人员批量认定、批量调整研发类型、批量启用/停用等。
   * 只允许「所有选中人员使用同一组字段值」的批量操作，避免误覆盖个体差异。
   */
  app.post('/api/admin/users/bulk-update', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isAdmin(me)) return reply.code(403).send({ error: '仅管理员可批量修改用户档案' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return reply.code(400).send({ error: '请至少选择一位人员' });
    if (ids.length > 500) return reply.code(400).send({ error: '一次最多处理 500 人' });

    const built = buildUserPatch(req.body?.patch ?? {});
    if (built.error) return reply.code(400).send({ error: built.error });
    if (!Object.keys(built.patch).length) {
      return reply.code(400).send({ error: '没有需要更新的字段' });
    }
    // 防止把自己踢出管理员
    if (built.patch.role && built.patch.role !== 'admin' && ids.includes(me.id)) {
      return reply.code(400).send({ error: '不能修改自己的管理员角色，请由其他管理员操作' });
    }

    const results = { updated: 0, failed: [] };
    for (const id of ids) {
      try {
        await repo.updateUser(id, built.patch, me.id);
        results.updated++;
      } catch (e) {
        results.failed.push({ id, error: e.message });
      }
    }
    await repo.audit(me.id, 'user.bulk_update', ids.join(','), null,
      { count: results.updated, fields: Object.keys(built.patch) }, req.ip);
    return results;
  });

  app.post('/api/admin/sync-ad', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isAdmin(me)) return reply.code(403).send({ error: '仅管理员可同步 AD' });
    const stats = await syncAdUsers({
      dryRun: req.query.dry_run === '1',
      trigger: 'manual',
    });
    await repo.audit(me.id, 'ad.sync.manual', 'users', null, stats, req.ip);
    // 同步会级联清理审批人，这里回传「已无审批人」的项目，便于管理员及时补配
    const { projectsWithoutApprover } = await import('./jobs/syncAd.js');
    const orphans = await projectsWithoutApprover();
    return {
      stats,
      projectsWithoutApprover: orphans.map((p) => ({ code: p.code, name: p.name })),
    };
  });

  // ---------------------------------------------------------------- 管理：项目
  app.get('/api/admin/projects', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    const rows = await repo.listProjects({ activeOnly: false });
    // 附带审批人，前端项目列表与编辑框直接使用
    const map = await repo.listApproversByProject(rows.map((p) => p.id));
    return {
      rows: rows.map((p) => {
        const approvers = (map.get(p.id) ?? []).map((u) => ({
          id: u.id, name: u.display_name, employeeNo: u.employee_no,
        }));
        return { ...projectDto(p), approvers, approverCount: approvers.length };
      }),
    };
  });

  app.post('/api/admin/projects', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    const b = req.body ?? {};
    if (!b.code || !b.name) return reply.code(400).send({ error: '项目号与名称必填' });
    if (!/^[A-Za-z0-9_-]{2,32}$/.test(b.code)) {
      return reply.code(400).send({ error: '项目号只能包含字母、数字、下划线和短横线' });
    }
    const exists = await repo.getProjectByCode(b.code);
    if (exists) return reply.code(409).send({ error: '该项目号已存在' });
    const row = await repo.createProject({
      code: b.code, name: String(b.name), description: String(b.description ?? ''),
      owner_id: b.owner_id ? Number(b.owner_id) : null, is_rnd: b.is_rnd !== false,
      start_date: b.start_date || null, end_date: b.end_date || null,
    }, me.id);
    return { project: row };
  });

  app.patch('/api/admin/projects/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const patch = {};
    for (const k of ['code', 'name', 'description']) if (k in b) patch[k] = String(b[k]);
    if ('owner_id' in b) patch.owner_id = b.owner_id ? Number(b.owner_id) : null;
    if ('is_rnd' in b) patch.is_rnd = Boolean(b.is_rnd);
    if ('is_active' in b) patch.is_active = Boolean(b.is_active);
    if ('start_date' in b) patch.start_date = b.start_date || null;
    if ('end_date' in b) patch.end_date = b.end_date || null;
    return { project: await repo.updateProject(id, patch, me.id) };
  });

  app.get('/api/admin/projects/:id/members', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    return { rows: await repo.getProjectMembers(Number(req.params.id)) };
  });

  /**
   * 删除项目。
   * 仅当项目无任何业务数据引用时才允许；否则返回 409 并提示改用停用。
   */
  app.delete('/api/admin/projects/:id', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    const ok = await repo.deleteProject(Number(req.params.id), me.id);
    if (!ok) return reply.code(404).send({ error: '项目不存在' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- 管理：项目审批人
  app.get('/api/admin/projects/:id/approvers', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    return { rows: await repo.getProjectApprovers(Number(req.params.id)) };
  });

  /** 设置项目审批人（整表替换）。一个项目可挂多个主管，审批为「或签」。 */
  app.put('/api/admin/projects/:id/approvers', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    const projectId = Number(req.params.id);
    const ids = Array.isArray(req.body?.user_ids)
      ? req.body.user_ids.map(Number).filter(Number.isFinite) : [];
    if (ids.length > 20) return reply.code(400).send({ error: '单个项目的审批人不宜超过 20 人' });
    await repo.setProjectApprovers(projectId, ids, me.id);
    return { ok: true, count: ids.length };
  });

  app.put('/api/admin/projects/:id/members', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    const ids = Array.isArray(req.body?.user_ids)
      ? req.body.user_ids.map(Number).filter(Number.isFinite) : [];
    await repo.setProjectMembers(Number(req.params.id), ids, me.id);
    return { ok: true, count: ids.length };
  });

  // ---------------------------------------------------------------- 管理：考勤
  app.get('/api/admin/attendance/:period', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    const period = parse(periodSchema, req.params.period);
    const rows = await repo.listAttendance(period);
    return {
      rows: rows.map((r) => ({
        userId: r.user_id, username: r.username, name: r.display_name,
        employeeNo: r.employee_no, employeeType: r.employee_type,
        workdays: Number(r.workdays), hours: Number(r.hours), source: r.source,
        salary: Number(r.monthly_salary),
      })),
    };
  });

  app.put('/api/admin/attendance/:period/:userId', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    const period = parse(periodSchema, req.params.period);
    const userId = Number(req.params.userId);
    const hours = Number(req.body?.hours);
    const workdays = Number(req.body?.workdays ?? 0);
    if (!Number.isFinite(hours)) return reply.code(400).send({ error: 'hours 必须为数字' });
    return svc.setAttendance(me, userId, period, hours, workdays, req.ip);
  });

  /** 清除某人某月的考勤记录（误录纠正）。 */
  app.delete('/api/admin/attendance/:period/:userId', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '仅人力资源部或管理员可维护考勤' });
    const period = parse(periodSchema, req.params.period);
    const ok = await repo.deleteAttendance(Number(req.params.userId), period, me.id);
    if (!ok) return reply.code(404).send({ error: '该月没有考勤记录' });
    return { ok: true };
  });

  /**
   * 批量设置考勤（同一月份，多人使用同一考勤工时/出勤天数）。
   * 替代前端逐人循环请求 —— 200 人原本要发 200 次请求，现在一次完成。
   * ids 为空表示「全部在职人员」，用于一键铺满标准考勤。
   */
  app.post('/api/admin/attendance/:period/bulk', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '仅人力资源部或管理员可维护考勤' });
    const period = parse(periodSchema, req.params.period);
    const hours = Number(req.body?.hours);
    const workdays = Number(req.body?.workdays ?? 0);
    if (!Number.isFinite(hours) || hours < 0 || hours > 1000) {
      return reply.code(400).send({ error: '考勤工时必须是 0~1000 之间的数字' });
    }
    if (!Number.isFinite(workdays) || workdays < 0 || workdays > 31) {
      return reply.code(400).send({ error: '出勤天数必须是 0~31 之间的数字' });
    }

    // 与日历校验：出勤天数不应超过当月实际工作日数，
    // 否则会导致「一键填满」后工时与考勤对不上（例：11 月有 21 个工作日，
    // 若按 22 天 × 8h = 176h 录入，员工填满 21 天后会差 8 小时）。
    const calendarAll = await repo.getCalendar();
    const realWorkdays = (await import('./domain.js')).workdaysOfMonth(period, calendarAll);
    const warnings = [];
    if (workdays > realWorkdays.length) {
      warnings.push(
        `出勤天数 ${workdays} 天超过当月实际工作日 ${realWorkdays.length} 天，`
        + `可能导致工时与考勤不一致`);
    }
    if (Math.abs(hours - realWorkdays.length * 8) > 0.01) {
      warnings.push(
        `考勤工时 ${hours}h 与标准工时 ${realWorkdays.length * 8}h`
        + `（${realWorkdays.length} 个工作日 × 8h）不一致`);
    }

    let ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) {
      const all = await repo.listUsers({ activeOnly: true });
      ids = all.map((u) => u.id);
    }
    if (!ids.length) return reply.code(422).send({ error: '没有可设置考勤的人员' });
    if (ids.length > 1000) return reply.code(400).send({ error: '一次最多处理 1000 人' });

    for (const id of ids) {
      await svc.setAttendance(me, id, period, hours, workdays, req.ip);
    }
    await repo.audit(me.id, 'attendance.bulk_set', period, period,
      { count: ids.length, hours, workdays }, req.ip);
    return { updated: ids.length, hours, workdays, warnings, expectedWorkdays: realWorkdays.length };
  });

  // ---------------------------------------------------------------- 管理：审计
  app.get('/api/admin/audit', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    return {
      rows: await repo.listAudit({
        limit: Number(req.query.limit ?? 200),
        period: req.query.period || undefined,
      }),
    };
  });

  // ---------------------------------------------------------------- 管理：节假日日历
  app.get('/api/admin/calendar', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    const { query } = await import('./db.js');
    // 按年份分组返回：当前年份优先，避免多年数据混在一起时
    // 用户先看到的是明年的日历而误以为数据错乱。
    const { rows } = await query(
      `SELECT to_char(day,'YYYY-MM-DD') AS day, is_workday, note,
              extract(year from day)::int AS year
         FROM calendar_days ORDER BY day DESC`);
    const thisYear = new Date().getFullYear();
    const list = rows.map((r) => ({
      day: r.day, isWorkday: r.is_workday, note: r.note, year: r.year,
    }));
    return {
      rows: list,
      years: [...new Set(list.map((r) => r.year))].sort((a, b) => b - a),
      currentYear: thisYear,
    };
  });

  app.post('/api/admin/calendar', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    const b = req.body ?? {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.day ?? ''))) {
      return reply.code(400).send({ error: '日期格式应为 YYYY-MM-DD' });
    }
    await repo.upsertCalendarDay(b.day, Boolean(b.isWorkday), String(b.note ?? ''), me.id);
    return { ok: true };
  });

  app.delete('/api/admin/calendar/:day', async (req, reply) => {
    const me = await requireUser(req, reply);
    if (!me) return;
    if (!isHr(me)) return reply.code(403).send({ error: '没有权限' });
    const day = String(req.params.day);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      return reply.code(400).send({ error: '日期格式应为 YYYY-MM-DD' });
    }
    const ok = await repo.deleteCalendarDay(day, me.id);
    if (!ok) return reply.code(404).send({ error: '该日期没有日历记录' });
    return { ok: true };
  });

  // ---------------------------------------------------------------- 健康检查
  app.get('/api/health', async () => ({ ok: true, time: new Date().toISOString() }));
}

// ---------------------------------------------------------------- 辅助
/**
 * 把请求体转换为用户档案补丁。
 * 抽出来供单条编辑与批量编辑共用，保证两条路径的校验规则完全一致。
 */
function buildUserPatch(body) {
  const patch = {};
  if ('role' in body) {
    if (!['admin', 'hr', 'pm', 'employee', 'finance'].includes(body.role)) {
      return { error: 'role 不合法' };
    }
    patch.role = body.role;
  }
  for (const k of ['employee_no', 'employee_type', 'display_name', 'department', 'title',
                   'education', 'major', 'post', 'rd_duty', 'certify_note']) {
    if (k in body) patch[k] = body[k] === null ? null : String(body[k]);
  }
  if ('manager_id' in body) patch.manager_id = body.manager_id ? Number(body.manager_id) : null;
  if ('monthly_salary' in body) {
    const v = Number(body.monthly_salary);
    if (!Number.isFinite(v) || v < 0) return { error: '薪酬必须为非负数' };
    patch.monthly_salary = v;
  }
  if ('attendance_hours' in body) {
    patch.attendance_hours = body.attendance_hours === null ? null : Number(body.attendance_hours);
  }
  if ('is_active' in body) patch.is_active = Boolean(body.is_active);
  if ('is_tech_staff' in body) patch.is_tech_staff = Boolean(body.is_tech_staff);
  if ('is_rd_staff' in body) patch.is_rd_staff = Boolean(body.is_rd_staff);
  if ('join_date' in body) patch.join_date = body.join_date || null;
  return { patch };
}

function projectDto(p) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description ?? '',
    ownerId: p.owner_id,
    ownerName: p.owner_name ?? null,
    isRnd: p.is_rnd,
    isActive: p.is_active,
    memberCount: p.member_count === undefined ? 0 : Number(p.member_count),
    startDate: p.start_date,
    endDate: p.end_date,
  };
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name ?? u.displayName,
    email: u.email,
    department: u.department,
    title: u.title,
    role: u.role,
    employeeNo: u.employee_no,
    employeeType: u.employee_type,
    managerId: u.manager_id,
    managerName: u.manager_name ?? null,
    monthlySalary: u.monthly_salary === undefined ? undefined : Number(u.monthly_salary),
    attendanceHours: u.attendance_hours === null || u.attendance_hours === undefined
      ? null : Number(u.attendance_hours),
    isActive: u.is_active,
    adStatus: u.ad_status ?? 'unknown',
    adGroups: u.ad_groups,
    lastLoginAt: u.last_login_at,
    education: u.education ?? null,
    major: u.major ?? null,
    post: u.post ?? null,
    rdDuty: u.rd_duty ?? null,
    joinDate: u.join_date ? String(u.join_date).slice(0, 10) : null,
    isTechStaff: Boolean(u.is_tech_staff),
    isRdStaff: u.is_rd_staff !== false,
    certifyNote: u.certify_note ?? null,
  };
}

async function requireUser(req, reply) {
  const me = await currentUser(req);
  if (!me) {
    reply.code(401).send({ error: '未登录或会话已过期', code: 'UNAUTHENTICATED' });
    return null;
  }
  const full = await loadUser(me.id);
  if (!full || !full.is_active) {
    reply.code(401).send({ error: '账号已停用', code: 'INACTIVE' });
    return null;
  }
  return full;
}