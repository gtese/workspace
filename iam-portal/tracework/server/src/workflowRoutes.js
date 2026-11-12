/**
 * 工时四阶段审批流程的路由。
 *
 *   draft → stage1_project → stage2_hr → stage3_finance → archived
 */
import { currentUser, loadUser } from './auth.js';
import * as wf from './workflow.js';
import * as repo from './repo.js';
import * as svc from './service.js';
import { query } from './db.js';

function isHr(me) { return ['admin', 'hr'].includes(me?.role); }
function isFinance(me) { return ['admin', 'hr', 'finance'].includes(me?.role); }

const PERIOD_RE = /^\d{4}-\d{2}$/;

export default async function workflowRoutes(app) {
  async function auth(req, reply) {
    const cu = await currentUser(req);
    if (!cu) { reply.code(401).send({ error: '未登录', code: 'UNAUTHENTICATED' }); return null; }
    const me = await loadUser(cu.id);
    if (!me || !me.is_active) { reply.code(401).send({ error: '账号停用', code: 'INACTIVE' }); return null; }
    return me;
  }

  // ============================================================
  // 一键全月填满
  // ============================================================
  app.post('/api/timesheet/:period/fill-all', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    const period = String(req.params.period);
    if (!PERIOD_RE.test(period)) return reply.code(400).send({ error: '月份格式应为 YYYY-MM' });

    const b = req.body ?? {};
    const targetUserId = Number(b.userId ?? me.id);
    if (targetUserId !== me.id && !isHr(me)) {
      return reply.code(403).send({ error: '只能为自己批量填充' });
    }
    if (!b.projectId) return reply.code(422).send({ error: '请选择项目', code: 'VALIDATION' });

    const r = await wf.fillWholeMonth({
      userId: targetUserId,
      period,
      projectId: Number(b.projectId),
      hoursPerDay: b.hoursPerDay ?? 8,
      overwrite: Boolean(b.overwrite),
    });
    return r;
  });

  // ============================================================
  // 重置（清空本月填报）
  // ============================================================
  app.post('/api/timesheet/:period/reset', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    const period = String(req.params.period);
    if (!PERIOD_RE.test(period)) return reply.code(400).send({ error: '月份格式应为 YYYY-MM' });
    const b = req.body ?? {};
    const targetUserId = Number(b.userId ?? me.id);
    if (targetUserId !== me.id && !isHr(me)) {
      return reply.code(403).send({ error: '只能清空自己的填报' });
    }
    return wf.resetSheet(targetUserId, period, me);
  });

  // ============================================================
  // 提交（走新的四阶段流程）
  // ============================================================
  app.post('/api/timesheet/:period/submit-workflow', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    const period = String(req.params.period);
    if (!PERIOD_RE.test(period)) return reply.code(400).send({ error: '月份格式应为 YYYY-MM' });
    const targetUserId = Number((req.body ?? {}).userId ?? me.id);
    if (targetUserId !== me.id && !isHr(me)) {
      return reply.code(403).send({ error: '只能提交自己的工时' });
    }
    const actor = targetUserId === me.id ? me : await loadUser(targetUserId);
    return wf.submitSheet(targetUserId, period, me, req.ip);
  });

  // ============================================================
  // 进度查询
  // ============================================================
  app.get('/api/timesheet/:period/progress', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    const period = String(req.params.period);
    const targetUserId = Number(req.query.userId ?? me.id);
    if (targetUserId !== me.id && !['admin', 'hr', 'pm', 'finance'].includes(me.role)) {
      return reply.code(403).send({ error: '无权查看他人工时进度' });
    }
    return wf.sheetProgress(targetUserId, period);
  });

  // ============================================================
  // 审批中心：按阶段列出待办
  // ============================================================
  app.get('/api/workflow/inbox', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    const period = req.query.period ? String(req.query.period) : null;

    // 阶段1：项目审批
    //
    // 权限判定以「是否被指定为该项目的审批人」为准，而不是看角色。
    // 项目审批人可能是普通研发人员（employee），若按角色过滤会导致
    // 被指定为审批人却看不到任何待办 —— 这是实际业务中的常见场景。
    //   · admin / hr：可审批全部项目
    //   · 其他所有人：只看自己被指定为审批人的项目
    let stage1 = [];
    {
      const params = [];
      let scope = '';
      if (!['admin', 'hr'].includes(me.role)) {
        params.push(me.id);
        scope = `AND (EXISTS (SELECT 1 FROM project_approvers pa
                    WHERE pa.project_id = a.project_id AND pa.user_id = $1)
                  OR p.owner_id = $1)`;
      }
      if (period) { params.push(period); }
      const { rows } = await query(
        `SELECT a.id, a.timesheet_id, a.period, a.hours::float8 AS hours,
                a.status, p.code AS project_code, p.name AS project_name,
                u.username, u.display_name,
                to_char(t.submitted_at,'YYYY-MM-DD HH24:MI') AS submitted_at_fmt,
                t.total_hours::float8 AS total_hours, t.rnd_hours::float8 AS rnd_hours
           FROM approvals a
           JOIN projects p ON p.id = a.project_id
           JOIN users u ON u.id = a.user_id
           JOIN timesheets t ON t.id = a.timesheet_id
          WHERE a.status = 'pending' AND t.status = 'stage1_project'
            ${period ? `AND a.period = $${params.length}` : ''}
            ${scope}
          ORDER BY a.period DESC, u.username, p.code`, params);
      stage1 = rows;
    }

    // 阶段2：人事确认
    let stage2 = [];
    if (isHr(me)) {
      const params = [];
      if (period) params.push(period);
      const { rows } = await query(
        `SELECT t.id AS timesheet_id, t.period, t.total_hours::float8 AS total_hours,
                t.rnd_hours::float8 AS rnd_hours, u.username, u.display_name,
                u.monthly_salary::float8 AS monthly_salary,
                to_char(t.stage_entered_at,'YYYY-MM-DD HH24:MI') AS entered_at_fmt
           FROM timesheets t JOIN users u ON u.id = t.user_id
          WHERE t.status = 'stage2_hr'
            ${period ? 'AND t.period = $1' : ''}
          ORDER BY t.period DESC, u.username`, params);
      stage2 = rows;
    }

    // 阶段3：财务确认
    let stage3 = [];
    if (isFinance(me)) {
      const params = [];
      if (period) params.push(period);
      const { rows } = await query(
        `SELECT t.id AS timesheet_id, t.period, t.total_hours::float8 AS total_hours,
                t.rnd_hours::float8 AS rnd_hours, t.attendance_hours::float8 AS attendance_hours,
                t.salary_snapshot::float8 AS salary_snapshot,
                u.username, u.display_name,
                to_char(t.stage_entered_at,'YYYY-MM-DD HH24:MI') AS entered_at_fmt
           FROM timesheets t JOIN users u ON u.id = t.user_id
          WHERE t.status = 'stage3_finance'
            ${period ? 'AND t.period = $1' : ''}
          ORDER BY t.period DESC, u.username`, params);
      stage3 = rows;
    }

    return {
      stage1, stage2, stage3,
      counts: { stage1: stage1.length, stage2: stage2.length, stage3: stage3.length },
      role: me.role,
    };
  });

  // ============================================================
  // 四阶段审批动作
  // ============================================================
  /** 阶段1：项目审批（或签） */
  app.post('/api/workflow/approvals/:id/decide', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    const b = req.body ?? {};
    const action = String(b.action ?? '');
    if (!['approve', 'reject'].includes(action)) {
      return reply.code(422).send({ error: 'action 应为 approve 或 reject' });
    }
    return wf.decideProjectApproval(Number(req.params.id), action, b.reason ?? '', me, req.ip);
  });

  /** 阶段2：人事确认 / 驳回 */
  app.post('/api/workflow/:timesheetId/hr-confirm', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    const b = req.body ?? {};
    if (b.action === 'reject') {
      return wf.rejectByHr(Number(req.params.timesheetId), me, b.reason ?? '');
    }
    return wf.confirmByHr(Number(req.params.timesheetId), me, {
      salary: b.salary, note: b.note,
    });
  });

  /** 阶段3：财务确认 / 驳回 */
  app.post('/api/workflow/:timesheetId/finance-confirm', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    const b = req.body ?? {};
    if (b.action === 'reject') {
      return wf.rejectByFinance(Number(req.params.timesheetId), me, b.reason ?? '');
    }
    return wf.confirmByFinance(Number(req.params.timesheetId), me, {
      laborCostWan: b.laborCostWan, allocRatio: b.allocRatio, note: b.note,
    });
  });

  // ============================================================
  // 归档工时列表 + 导出
  // ============================================================
  app.get('/api/archived-entries', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    // 员工只能看自己的归档数据
    const restricted = !['admin', 'hr', 'finance', 'pm'].includes(me.role);
    const rows = await wf.listArchivedEntries({
      period: req.query.period,
      periodFrom: req.query.from,
      periodTo: req.query.to,
      userId: restricted ? me.id : (req.query.userId ? Number(req.query.userId) : undefined),
      projectId: req.query.projectId ? Number(req.query.projectId) : undefined,
      keyword: req.query.q,
    });
    return { rows, summary: await wf.archivedSummary({
      period: req.query.period,
      periodFrom: req.query.from,
      periodTo: req.query.to,
      userId: restricted ? me.id : (req.query.userId ? Number(req.query.userId) : undefined),
      projectId: req.query.projectId ? Number(req.query.projectId) : undefined,
      keyword: req.query.q,
    }) };
  });

  /** 归档工时导出 CSV。 */
  app.get('/api/archived-entries/export', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    const restricted = !['admin', 'hr', 'finance', 'pm'].includes(me.role);
    const rows = await wf.listArchivedEntries({
      period: req.query.period,
      periodFrom: req.query.from,
      periodTo: req.query.to,
      userId: restricted ? me.id : (req.query.userId ? Number(req.query.userId) : undefined),
      projectId: req.query.projectId ? Number(req.query.projectId) : undefined,
      keyword: req.query.q,
    });

    const header = ['月份', '工作日期', '账号', '姓名', '项目号', '项目名称', '工时(h)', '备注', '归档时间', '归档人'];
    const esc = (v) => {
      const s = v === null || v === undefined ? '' : String(v);
      return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.map(esc).join(',')];
    for (const r of rows) {
      lines.push([r.period, r.work_date, r.username, r.display_name,
        r.project_code, r.project_name, r.hours, r.note,
        r.archived_at_fmt, r.archived_by_name ?? ''].map(esc).join(','));
    }
    // 汇总合计行
    const total = rows.reduce((n, r) => n + Number(r.hours), 0);
    lines.push(['', '', '', '', '', '合计', Math.round(total * 100) / 100, '', '', ''].map(esc).join(','));

    await repo.audit(me.id, 'archived.export', `${rows.length} 条`, req.query.period ?? null,
      { filters: { ...req.query } }, req.ip);

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition',
        `attachment; filename*=UTF-8''${encodeURIComponent(`归档工时明细_${stamp}.csv`)}`)
      .send('\uFEFF' + lines.join('\r\n') + '\r\n');
  });

  // ============================================================
  // 资产折旧折算预览（财务确认前查看）
  // ============================================================
  app.get('/api/workflow/:timesheetId/asset-allocation', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    if (!['admin', 'hr', 'finance'].includes(me.role)) {
      return reply.code(403).send({ error: '仅财务、人力资源部或管理员可查看', code: 'FORBIDDEN' });
    }
    const ts = await repo.getTimesheetById(Number(req.params.timesheetId));
    if (!ts) return reply.code(404).send({ error: '工时单不存在', code: 'NOT_FOUND' });

    const { computeAssetAllocation } = await import('./depreciation.js');
    const rnd = Number(ts.rnd_hours ?? 0);
    const att = Number(ts.attendance_hours ?? 0);
    const total = att > 0 ? att : Number(ts.total_hours ?? 0);
    const alloc = await computeAssetAllocation({
      userId: ts.user_id, rndHours: rnd, totalHours: total,
    });
    return {
      ...alloc,
      employee: await (async () => {
        const u = await repo.getUserById(ts.user_id).catch(() => null);
        return u ? { id: u.id, username: u.username, displayName: u.display_name } : null;
      })(),
      salary: Number(ts.salary_snapshot ?? 0),
    };
  });

  // ============================================================
  // 流程设置
  // ============================================================
  /** 读取流程节点配置。 */
  app.get('/api/workflow/settings', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    const { query } = await import('./db.js');
    const cfg = await wf.getWorkflowSettings({ fresh: true });
    const { rows } = await query(
      `SELECT to_char(updated_at,'YYYY-MM-DD HH24:MI') AS updated_at_fmt,
              (SELECT display_name FROM users WHERE id = updated_by) AS updated_by_name
         FROM workflow_settings WHERE id = 1`);
    // 计算当前启用链，供前端展示
    const order = ['stage1_project', 'stage2_hr', 'stage3_finance', 'archived'];
    const enabled = [];
    for (const st of order) {
      if (st === 'archived') { enabled.push(st); continue; }
      const on = st === 'stage1_project' ? cfg.enableProject
        : st === 'stage2_hr' ? cfg.enableHr : cfg.enableFinance;
      if (on) enabled.push(st);
    }
    return {
      ...cfg,
      chain: enabled,
      labels: Object.fromEntries(order.map((k) => [k, wf.STAGES[k]?.label ?? k])),
      updatedAt: rows[0]?.updated_at_fmt ?? null,
      updatedBy: rows[0]?.updated_by_name ?? null,
    };
  });

  /** 保存流程节点配置（仅管理员）。 */
  app.put('/api/workflow/settings', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    if (me.role !== 'admin') {
      return reply.code(403).send({ error: '仅系统管理员可修改流程设置', code: 'FORBIDDEN' });
    }
    const b = req.body ?? {};
    const { query } = await import('./db.js');
    const cur = await wf.getWorkflowSettings({ fresh: true });
    const val = (k, def) => (b[k] === undefined ? def : Boolean(b[k]));
    await query(
      `UPDATE workflow_settings SET enable_project=$1, enable_hr=$2, enable_finance=$3,
              updated_by=$4, updated_at=now() WHERE id = 1`,
      [val('enableProject', cur.enableProject), val('enableHr', cur.enableHr),
       val('enableFinance', cur.enableFinance), me.id]);
    wf.clearWorkflowCache();
    await repo.audit(me.id, 'workflow.settings', 'workflow', null, b, req.ip);

    const cfg = await wf.getWorkflowSettings({ fresh: true });
    const order = ['stage1_project', 'stage2_hr', 'stage3_finance', 'archived'];
    const enabled = [];
    for (const st of order) {
      if (st === 'archived') { enabled.push(st); continue; }
      const on = st === 'stage1_project' ? cfg.enableProject
        : st === 'stage2_hr' ? cfg.enableHr : cfg.enableFinance;
      if (on) enabled.push(st);
    }
    return { ...cfg, chain: enabled };
  });

  // ============================================================
  // 阶段定义（前端渲染进度条用）
  // ============================================================
  app.get('/api/workflow/stages', async (req, reply) => {
    const me = await auth(req, reply); if (!me) return;
    return {
      stages: Object.entries(wf.STAGES)
        .filter(([k]) => k !== 'rejected')
        .map(([key, v]) => ({ key, label: v.label, order: v.order, role: v.role })),
    };
  });
}