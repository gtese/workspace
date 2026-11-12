/**
 * 工时审批四阶段流转。
 *
 *   draft → stage1_project → stage2_hr → stage3_finance → archived
 *
 * 特点：
 *   · 项目审批按「项目」粒度（每个项目一位审批人，或签）
 *   · 人事/财务按「整张工时单」粒度
 *   · 驳回逐级退回上一阶段
 *   · 每次流转写 timesheet_stage_logs，可完整追溯
 */
import { query, withTransaction } from './db.js';
import * as repo from './repo.js';
import * as svc from './service.js';

export const STAGES = {
  draft:           { order: 0, label: '填报中',     role: null },
  stage1_project:  { order: 1, label: '项目审批',   role: 'pm' },
  stage2_hr:       { order: 2, label: '人事确认',   role: 'hr' },
  stage3_finance:  { order: 3, label: '财务确认',   role: 'finance' },
  archived:        { order: 4, label: '已归档',     role: null },
  rejected:        { order: 0, label: '已驳回',     role: null },
};

// ---------------------------------------------------------------- 流程配置
/** 节点开关配置的缓存（10 秒），避免每次流转都查库。 */
let _cfgCache = null;
let _cfgCacheAt = 0;

/** 读取流程节点开关。 */
export async function getWorkflowSettings({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && _cfgCache && now - _cfgCacheAt < 10_000) return _cfgCache;
  try {
    const { rows } = await query(
      'SELECT enable_project, enable_hr, enable_finance FROM workflow_settings WHERE id = 1');
    const r = rows[0] ?? { enable_project: true, enable_hr: true, enable_finance: true };
    _cfgCache = {
      enableProject: r.enable_project,
      enableHr: r.enable_hr,
      enableFinance: r.enable_finance,
    };
    _cfgCacheAt = now;
    return _cfgCache;
  } catch {
    // 表未建或查询失败时退化为「全开」，保证流程可用
    return { enableProject: true, enableHr: true, enableFinance: true };
  }
}

/** 清除配置缓存（保存设置后调用）。 */
export function clearWorkflowCache() { _cfgCache = null; _cfgCacheAt = 0; }

/**
 * 判断某节点是否启用。
 */
function nodeEnabled(stage, cfg) {
  if (stage === 'stage1_project') return cfg.enableProject;
  if (stage === 'stage2_hr') return cfg.enableHr;
  if (stage === 'stage3_finance') return cfg.enableFinance;
  return true;
}

/**
 * 从给定阶段开始，找到下一个「启用」的阶段。
 *
 * 关闭的节点会被自动跳过，例如关闭人事节点时：
 *   stage1_project → stage3_finance
 * 若全部关闭，则直达 archived。
 *
 * @returns {{next: string, skipped: string[]}}
 */
export async function nextEnabledStage(current) {
  const cfg = await getWorkflowSettings();
  const order = ['stage1_project', 'stage2_hr', 'stage3_finance', 'archived'];
  const startIdx = order.indexOf(current);
  const skipped = [];
  for (let i = startIdx; i < order.length; i++) {
    const st = order[i];
    if (st === 'archived' || nodeEnabled(st, cfg)) {
      return { next: st, skipped };
    }
    skipped.push(st);
  }
  return { next: 'archived', skipped };
}

/** 返回当前启用链的起始阶段（提交后第一个要走的节点）。 */
export async function firstStage() {
  const { next } = await nextEnabledStage('stage1_project');
  return next;
}

const PREV = {
  stage1_project: 'draft',
  stage2_hr: 'stage1_project',
  stage3_finance: 'stage2_hr',
  archived: 'stage3_finance',
  draft: 'stage1_project',
  rejected: 'stage1_project',
};

function bad(msg, code = 'BAD_REQUEST', status = 400) {
  const e = new Error(msg); e.code = code; e.statusCode = status; return e;
}

// ---------------------------------------------------------------- 日志
async function logStage(c, { timesheetId, from, to, actor, action, note = '', detail = {} }) {
  await c.query(
    `INSERT INTO timesheet_stage_logs
       (timesheet_id, from_status, to_status, actor_id, actor_name, action, note, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [timesheetId, from, to, actor?.id ?? null, actor?.display_name ?? actor?.username ?? 'system',
     action, note, JSON.stringify(detail)]);
}

async function setStatus(c, timesheetId, status, extra = {}) {
  const sets = ["status = $2", "stage_entered_at = now()"];
  const params = [timesheetId, status];
  let i = 2;
  for (const [col, val] of Object.entries(extra)) {
    params.push(val);
    sets.push(`${col} = $${++i}`);
  }
  await c.query(`UPDATE timesheets SET ${sets.join(', ')} WHERE id = $1`, params);
}

// ---------------------------------------------------------------- 一键全月填满
/**
 * 把给定时段内的所有工作日填满指定项目。
 * @param {object} opts
 * @param {number} opts.userId
 * @param {string} opts.period
 * @param {number} opts.projectId
 * @param {number} opts.hoursPerDay 默认 8
 * @param {boolean} opts.overwrite 是否覆盖已有填报（默认 false）
 * @param {number} opts.capHours 每日上限（满勤小时），默认按考勤
 */
export async function fillWholeMonth({ userId, period, projectId, hoursPerDay = 8, overwrite = false, capHours }) {
  const ts = await repo.getTimesheet(userId, period);
  if (ts && !['draft', 'rejected'].includes(ts.status)) {
    throw bad('本月工时已提交审批，无法批量填充', 'LOCKED', 409);
  }

  const calendar = await repo.getCalendar();
  const workdays = workdaysOfMonth(period, calendar);
  if (!workdays.length) throw bad('该月份没有工作日', 'NO_WORKDAYS', 422);

  const existing = await repo.getEntriesForPeriod(userId, period);
  const byDate = new Map();
  for (const e of existing) {
    const d = String(e.work_date).slice(0, 10);
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(e);
  }

  // 每日上限：优先按考勤工时折算，但不得超过 8h（标准工作日的物理上限）
  //
  // 重要：考勤工时可能由 HR 按「工作日 × 8」录入，而工作日数以日历为准。
  // 若两者不一致（例如 HR 按 22 天录 176h，但本月实际只有 21 个工作日），
  // 176 ÷ 21 = 8.5h，若无 8h 上限就会把每个工作日填成 8.5h，
  // 总量虽然对得上 168h+，但单日工时会超 8 小时，不符合实际。
  let dailyCap = capHours;
  if (!dailyCap) {
    const att = await repo.getAttendance(userId, period);
    const attHours = att ? Number(att.hours) : workdays.length * 8;
    const perDay = attHours / workdays.length;
    // 上限 = 每日折算工时，但不低于 1h、不超过 8h
    dailyCap = Math.max(1, Math.min(8, Math.round(perDay * 2) / 2));
  }
  const hours = Math.min(Number(hoursPerDay) || 8, dailyCap);

  const filled = [];
  const skipped = [];
  for (const day of workdays) {
    const cur = byDate.get(day) ?? [];
    const curTotal = cur.reduce((n, e) => n + Number(e.hours), 0);
    if (curTotal > 0 && !overwrite) { skipped.push(day); continue; }
    const remain = Math.max(0, dailyCap - (overwrite ? 0 : curTotal));
    if (remain <= 0) { skipped.push(day); continue; }
    filled.push({ day, hours: Math.min(hours, remain) });
  }

  if (!filled.length) {
    return { filled: 0, skipped: skipped.length, hours: 0, days: [] };
  }

  await withTransaction(async (c) => {
    for (const f of filled) {
      await c.query(
        'DELETE FROM time_entries WHERE user_id = $1 AND work_date = $2',
        [userId, f.day]);
      await c.query(
        `INSERT INTO time_entries (user_id, work_date, project_id, hours, note)
         VALUES ($1,$2,$3,$4,'一键填充')`,
        [userId, f.day, projectId, f.hours]);
    }
    // 重算合计（会创建/更新工时单）
    await svc.recomputeAndSave(c, userId, period);
    // 事务内读取，确保拿到刚创建的工时单 id
    const { rows: created } = await c.query(
      'SELECT id, status FROM timesheets WHERE user_id = $1 AND period = $2', [userId, period]);
    if (created.length) {
      await logStage(c, {
        timesheetId: created[0].id,
        from: created[0].status, to: created[0].status,
        actor: null, action: 'fill_month',
        detail: { projectId, hours, filled: filled.length, skipped: skipped.length },
      });
    }
  });

  const totalHours = Math.round(filled.reduce((n, f) => n + f.hours, 0) * 100) / 100;
  return { filled: filled.length, skipped: skipped.length, hours: totalHours, days: filled.map((f) => f.day) };
}

/** 当月工作日（含调休，排除周末与法定假日）。 */
export function workdaysOfMonth(period, calendarRows) {
  const [y, m] = period.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  // calendarRows: [{ day_key | day, is_workday }] 或 Map
  const map = new Map();
  if (Array.isArray(calendarRows)) {
    for (const r of calendarRows) {
      const k = r.day_key ?? r.day ?? r[0];
      const v = r.is_workday ?? r[1];
      map.set(String(k), Boolean(v));
    }
  } else if (calendarRows instanceof Map) {
    for (const [k, v] of calendarRows) map.set(String(k), Boolean(v));
  }
  const out = [];
  for (let d = 1; d <= days; d++) {
    const key = `${period}-${String(d).padStart(2, '0')}`;
    const dow = new Date(y, m - 1, d).getDay();
    let isWork = dow !== 0 && dow !== 6;
    if (map.has(key)) isWork = map.get(key);
    if (isWork) out.push(key);
  }
  return out;
}

// ---------------------------------------------------------------- 提交
/** 工程师提交：draft/rejected → stage1_project，按项目生成审批单。 */
export async function submitSheet(userId, period, actor, ip) {
  const ts = await repo.getTimesheet(userId, period);
  if (!ts) throw bad('本月无填报记录，无法提交', 'EMPTY', 422);
  if (!['draft', 'rejected'].includes(ts.status)) {
    throw bad(`当前状态「${STAGES[ts.status]?.label ?? ts.status}」不可提交`, 'LOCKED', 409);
  }
  const entries = await repo.getEntriesForPeriod(userId, period);
  if (!entries.length) throw bad('本月无填报记录，无法提交', 'EMPTY', 422);

  // 按项目聚合生成审批单
  const perProject = new Map();
  for (const e of entries) {
    perProject.set(e.project_id, (perProject.get(e.project_id) ?? 0) + Number(e.hours));
  }

  const calendar = await repo.getCalendar();
  const due = addWorkdays(new Date(), 3, calendar);

  // 依据流程配置决定提交后第一个要走的节点（关闭的节点自动跳过）
  const cfg = await getWorkflowSettings();
  const { next: firstNode, skipped } = await nextEnabledStage('stage1_project');

  await withTransaction(async (c) => {
    // 清理旧审批单（驳回后重新提交）
    await c.query('DELETE FROM approvals WHERE timesheet_id = $1', [ts.id]);

    if (firstNode === 'stage1_project') {
      // 需要项目审批：按项目生成审批单
      await repo.createApprovals(c, ts.id, userId, period, perProject, due);
    }

    await setStatus(c, ts.id, firstNode, { submitted_at: new Date() });
    await logStage(c, {
      timesheetId: ts.id, from: ts.status, to: firstNode,
      actor, action: 'submit',
      detail: {
        projects: perProject.size,
        hours: entries.reduce((n, e) => n + Number(e.hours), 0),
        skippedStages: skipped,
      },
    });

    // 若所有节点都关闭，提交即归档
    if (firstNode === 'archived') {
      await c.query(
        `UPDATE timesheets SET archived_at = now(), approved_at = now()
          WHERE id = $1`, [ts.id]);
    }
  });

  if (skipped.length) {
    await logStage({ query }, {
      timesheetId: ts.id, from: ts.status, to: firstNode,
      actor: null, action: 'skip_nodes',
      detail: { skipped, config: cfg },
    }).catch(() => {});
  }

  await repo.audit(actor.id, 'timesheet.submit', String(userId), period,
    { projects: perProject.size, firstNode, skipped }, ip);
  return { status: firstNode, projects: perProject.size, skippedStages: skipped };
}

// ---------------------------------------------------------------- 项目审批
/** 项目审批（或签）。全部项目通过后自动进入人事阶段。 */
export async function decideProjectApproval(approvalId, action, reason, actor, ip) {
  const appr = await repo.getApproval(approvalId);
  if (!appr) throw bad('审批单不存在', 'NOT_FOUND', 404);
  if (appr.status !== 'pending') throw bad('该审批单已处理', 'ALREADY_DECIDED', 409);

  const ts = await repo.getTimesheetById(appr.timesheet_id);
  if (!ts || ts.status !== 'stage1_project') {
    throw bad('该工时单当前不在项目审批阶段', 'WRONG_STAGE', 409);
  }
  // 权限：admin/hr 全部可批；pm 必须是该项目审批人
  const canAll = ['admin', 'hr'].includes(actor.role);
  if (!canAll) {
    const okPm = await repo.isProjectApprover(appr.project_id, actor.id);
    const project = await repo.getProject(appr.project_id);
    if (!okPm && project?.owner_id !== actor.id) {
      throw bad('您不是该项目的审批人', 'FORBIDDEN', 403);
    }
  }

  // 事务外先算好下一节点（可能跳过被关闭的节点）
  const { next: afterProject, skipped: skippedAfter } =
    await nextEnabledStage('stage2_hr');

  return withTransaction(async (c) => {
    await c.query(
      `UPDATE approvals SET status = $2, approver_id = $3, acted_at = now(),
              reason = $4 WHERE id = $1`,
      [approvalId, action === 'approve' ? 'approved' : 'rejected', actor.id, reason ?? '']);

    if (action === 'reject') {
      // 驳回 → 退回工程师（draft），整单所有待审单作废
      await c.query(
        "UPDATE approvals SET status = 'rejected', acted_at = now() WHERE timesheet_id = $1 AND status = 'pending'",
        [appr.timesheet_id]);
      await setStatus(c, appr.timesheet_id, 'draft', { reject_reason: reason ?? '' });
      await logStage(c, {
        timesheetId: appr.timesheet_id, from: 'stage1_project', to: 'draft',
        actor, action: 'reject', note: reason ?? '',
        detail: { projectId: appr.project_id, stage: 'project' },
      });
      await repo.audit(actor.id, 'approval.reject', String(appr.timesheet_id), appr.period,
        { project: appr.project_id, reason }, ip);
      return { status: 'draft', rejected: true };
    }

    // 检查是否所有项目都已通过
    const { rows: left } = await c.query(
      "SELECT count(*)::int AS n FROM approvals WHERE timesheet_id = $1 AND status = 'pending'",
      [appr.timesheet_id]);
    if (left[0].n === 0) {
      // 全部项目通过 → 进入下一个启用的节点（关闭的节点会自动跳过）
      await setStatus(c, appr.timesheet_id, afterProject);
      if (afterProject === 'archived') {
        await c.query(
          'UPDATE timesheets SET archived_at = now(), approved_at = now() WHERE id = $1',
          [appr.timesheet_id]);
      }
      await logStage(c, {
        timesheetId: appr.timesheet_id, from: 'stage1_project', to: afterProject,
        actor, action: 'approve',
        note: '全部项目审批通过' + (skippedAfter.length ? `（跳过 ${skippedAfter.map((x) => STAGES[x]?.label ?? x).join('、')}）` : ''),
        detail: { skippedStages: skippedAfter },
      });
      await repo.audit(actor.id, 'approval.approve', String(appr.timesheet_id), appr.period,
        { project: appr.project_id, to: afterProject }, ip);
      return { status: afterProject, allApproved: true, skippedStages: skippedAfter };
    }
    await repo.audit(actor.id, 'approval.approve', String(appr.timesheet_id), appr.period,
      { project: appr.project_id }, ip);
    return { status: 'stage1_project', allApproved: false, remaining: left[0].n };
  });
}

// ---------------------------------------------------------------- 人事确认
/**
 * 人事确认：确认工时并维护月薪（写入快照）。
 * @param {object} opts { salary } —— 若提供则同步更新 users.monthly_salary
 */
export async function confirmByHr(timesheetId, actor, { salary, note } = {}) {
  // 先校验权限，再校验状态：否则无权限者能从状态检查的错误信息里推断出单据状态
  if (!['admin', 'hr'].includes(actor.role)) {
    throw bad('仅人力资源部或管理员可确认', 'FORBIDDEN', 403);
  }
  const ts = await repo.getTimesheetById(timesheetId);
  if (!ts) throw bad('工时单不存在', 'NOT_FOUND', 404);
  if (ts.status !== 'stage2_hr') {
    throw bad(`当前状态「${STAGES[ts.status]?.label ?? ts.status}」不在人事确认阶段`, 'WRONG_STAGE', 409);
  }

  // 事务外先算好下一节点（财务可能被关闭，此时直接归档）
  const { next: afterHr, skipped: skipHr } = await nextEnabledStage('stage3_finance');

  return withTransaction(async (c) => {
    let finalSalary = salary;
    if (finalSalary !== undefined && finalSalary !== null && finalSalary !== '') {
      finalSalary = Number(finalSalary);
      if (!(finalSalary >= 0)) throw bad('月薪必须为非负数字', 'VALIDATION', 422);
      await c.query('UPDATE users SET monthly_salary = $2 WHERE id = $1', [ts.user_id, finalSalary]);
    } else {
      const { rows } = await c.query('SELECT monthly_salary FROM users WHERE id = $1', [ts.user_id]);
      finalSalary = Number(rows[0]?.monthly_salary ?? 0);
    }

    await setStatus(c, timesheetId, afterHr, {
      hr_confirmed_by: actor.id, hr_confirmed_at: new Date(),
      salary_snapshot: finalSalary,
    });
    if (afterHr === 'archived') {
      await c.query(
        'UPDATE timesheets SET archived_at = now(), approved_at = now() WHERE id = $1',
        [timesheetId]);
    }
    await logStage(c, {
      timesheetId, from: 'stage2_hr', to: afterHr, actor,
      action: 'approve',
      note: (note ?? '') + (skipHr.length ? `（跳过 ${skipHr.map((x) => STAGES[x]?.label ?? x).join('、')}）` : ''),
      detail: { salary: finalSalary, totalHours: Number(ts.total_hours), skippedStages: skipHr },
    });
  }).then(() => ({ status: afterHr, skippedStages: skipHr }));
}

/** 人事驳回 → 退回项目审批阶段。 */
export async function rejectByHr(timesheetId, actor, reason) {
  if (!['admin', 'hr'].includes(actor.role)) throw bad('仅人力资源部或管理员可驳回', 'FORBIDDEN', 403);
  const ts = await repo.getTimesheetById(timesheetId);
  if (!ts) throw bad('工时单不存在', 'NOT_FOUND', 404);
  if (ts.status !== 'stage2_hr') throw bad('该工时单不在人事确认阶段', 'WRONG_STAGE', 409);

  return withTransaction(async (c) => {
    // 退回项目审批：把所有审批单重置为待审
    await c.query(
      "UPDATE approvals SET status = 'pending', approver_id = NULL, acted_at = NULL, reason = '' WHERE timesheet_id = $1",
      [timesheetId]);
    await setStatus(c, timesheetId, 'stage1_project', { reject_reason: reason ?? '' });
    await logStage(c, {
      timesheetId, from: 'stage2_hr', to: 'stage1_project', actor,
      action: 'reject', note: reason ?? '', detail: { stage: 'hr' },
    });
  }).then(() => ({ status: 'stage1_project', rejected: true }));
}

// ---------------------------------------------------------------- 财务确认
/**
 * 财务确认：确认人工费用与分摊比例，随后归档。
 * 未提供 laborCostWan 时按「月薪 × 出勤比例」自动计算并写入费用明细。
 */
export async function confirmByFinance(timesheetId, actor, {
  laborCostWan, allocRatio, note,
} = {}) {
  // 先校验权限，再校验状态
  if (!['admin', 'hr', 'finance'].includes(actor.role)) {
    throw bad('仅财务、人力资源部或管理员可确认', 'FORBIDDEN', 403);
  }
  const ts = await repo.getTimesheetById(timesheetId);
  if (!ts) throw bad('工时单不存在', 'NOT_FOUND', 404);
  if (ts.status !== 'stage3_finance') {
    throw bad(`当前状态「${STAGES[ts.status]?.label ?? ts.status}」不在财务确认阶段`, 'WRONG_STAGE', 409);
  }

  const salary = Number(ts.salary_snapshot ?? 0);
  const total = Number(ts.total_hours ?? 0);
  const rnd = Number(ts.rnd_hours ?? 0);
  const attendance = Number(ts.attendance_hours ?? 0) || 1;

  // 默认人工费用（万元）= 月薪 × (研发工时 / 考勤工时) / 10000
  let cost = laborCostWan;
  if (cost === undefined || cost === null || cost === '') {
    cost = Math.round((salary * (rnd / attendance)) / 10000 * 10000) / 10000;
  } else {
    cost = Number(cost);
    if (!(cost >= 0)) throw bad('人工费用必须为非负数字', 'VALIDATION', 422);
  }
  const ratio = allocRatio === undefined || allocRatio === null || allocRatio === ''
    ? (attendance > 0 ? Math.round((total / attendance) * 10000) / 10000 : 1)
    : Number(allocRatio);

  // ---- 资产折旧折算 ----
  // 项目设备每月折旧额 = 设备月度折旧金额 × 月度研发工时 ÷ 月度总工时
  const { computeAssetAllocation } = await import('./depreciation.js');
  const assetAlloc = await computeAssetAllocation({
    userId: ts.user_id,
    rndHours: rnd,
    totalHours: attendance > 0 ? attendance : total,
  }).catch(() => null);

  return withTransaction(async (c) => {
    await setStatus(c, timesheetId, 'archived', {
      fin_confirmed_by: actor.id, fin_confirmed_at: new Date(),
      labor_cost_wan: cost, alloc_ratio: ratio, archived_at: new Date(),
      approved_at: new Date(), approved_by: actor.id,
      asset_value_total: assetAlloc?.valueTotal ?? null,
      asset_dep_month: assetAlloc?.depMonthly ?? null,
      asset_alloc_wan: assetAlloc?.allocWan ?? null,
      asset_alloc_detail: assetAlloc ? JSON.stringify(assetAlloc.detail) : null,
    });
    await logStage(c, {
      timesheetId, from: 'stage3_finance', to: 'archived', actor,
      action: 'archive', note: note ?? '',
      detail: {
        salary, rndHours: rnd, totalHours: total,
        laborCostWan: cost, allocRatio: ratio,
        asset: assetAlloc
          ? {
              valueTotal: assetAlloc.valueTotal,
              depMonthly: assetAlloc.depMonthly,
              ratio: assetAlloc.ratio,
              allocWan: assetAlloc.allocWan,
              count: assetAlloc.count,
            }
          : null,
      },
    });
  }).then(() => ({
    status: 'archived', laborCostWan: cost, allocRatio: ratio,
    asset: assetAlloc
      ? {
          count: assetAlloc.count, valueTotal: assetAlloc.valueTotal,
          depMonthly: assetAlloc.depMonthly, ratio: assetAlloc.ratio,
          allocYuan: assetAlloc.allocYuan, allocWan: assetAlloc.allocWan,
          detail: assetAlloc.detail,
        }
      : null,
  }));
}

/** 财务驳回 → 退回人事确认阶段。 */
export async function rejectByFinance(timesheetId, actor, reason) {
  if (!['admin', 'hr', 'finance'].includes(actor.role)) {
    throw bad('仅财务、人力资源部或管理员可驳回', 'FORBIDDEN', 403);
  }
  const ts = await repo.getTimesheetById(timesheetId);
  if (!ts) throw bad('工时单不存在', 'NOT_FOUND', 404);
  if (ts.status !== 'stage3_finance') throw bad('该工时单不在财务确认阶段', 'WRONG_STAGE', 409);

  return withTransaction(async (c) => {
    await setStatus(c, timesheetId, 'stage2_hr', { reject_reason: reason ?? '' });
    await logStage(c, {
      timesheetId, from: 'stage3_finance', to: 'stage2_hr', actor,
      action: 'reject', note: reason ?? '', detail: { stage: 'finance' },
    });
  }).then(() => ({ status: 'stage2_hr', rejected: true }));
}

// ---------------------------------------------------------------- 重置
/** 清空本月所有填报（仅 draft/rejected 状态可操作）。 */
export async function resetSheet(userId, period, actor) {
  const ts = await repo.getTimesheet(userId, period);
  if (!ts) return { cleared: 0 };
  if (!['draft', 'rejected'].includes(ts.status)) {
    throw bad('本月工时已提交审批，无法清空', 'LOCKED', 409);
  }
  return withTransaction(async (c) => {
    const { rowCount } = await c.query(
      "DELETE FROM time_entries WHERE user_id = $1 AND to_char(work_date,'YYYY-MM') = $2",
      [userId, period]);
    await svc.recomputeAndSave(c, userId, period);
    // 已无任何明细时删除工时单，避免残留空单
    const { rows } = await c.query(
      'SELECT total_hours FROM timesheets WHERE user_id = $1 AND period = $2', [userId, period]);
    if (rows[0] && Number(rows[0].total_hours) === 0) {
      await c.query('DELETE FROM timesheets WHERE user_id = $1 AND period = $2', [userId, period]);
    }
    await repo.audit(actor.id, 'timesheet.reset', String(userId), period, { cleared: rowCount });
    return { cleared: rowCount };
  });
}

// ---------------------------------------------------------------- 归档查询
/**
 * 归档工时明细查询（给「审批通过后的工时列表」用）。
 * 返回逐日逐项目的明细行。
 */
export async function listArchivedEntries({
  period, periodFrom, periodTo, userId, projectId, keyword, limit = 2000,
} = {}) {
  const params = [];
  const where = ["t.status = 'archived'"];
  if (period) { params.push(period); where.push(`t.period = $${params.length}`); }
  if (periodFrom) { params.push(periodFrom); where.push(`t.period >= $${params.length}`); }
  if (periodTo) { params.push(periodTo); where.push(`t.period <= $${params.length}`); }
  if (userId) { params.push(Number(userId)); where.push(`t.user_id = $${params.length}`); }
  if (projectId) { params.push(Number(projectId)); where.push(`e.project_id = $${params.length}`); }
  if (keyword) {
    params.push(`%${keyword}%`);
    where.push(`(u.username ILIKE $${params.length} OR u.display_name ILIKE $${params.length}
      OR p.code ILIKE $${params.length} OR p.name ILIKE $${params.length})`);
  }
  params.push(Math.min(Number(limit) || 2000, 50000));

  const { rows } = await query(
    `SELECT e.id,
            t.period,
            to_char(e.work_date,'YYYY-MM-DD') AS work_date,
            u.id AS user_id, u.username, u.display_name,
            p.id AS project_id, p.code AS project_code, p.name AS project_name,
            e.hours::float8 AS hours, e.note,
            t.archived_at,
            to_char(t.archived_at,'YYYY-MM-DD HH24:MI') AS archived_at_fmt,
            ap.display_name AS archived_by_name
       FROM time_entries e
       JOIN timesheets t ON t.user_id = e.user_id AND t.period = to_char(e.work_date,'YYYY-MM')
       JOIN users u ON u.id = e.user_id
       JOIN projects p ON p.id = e.project_id
       LEFT JOIN users ap ON ap.id = t.approved_by
      WHERE ${where.join(' AND ')}
      ORDER BY e.work_date DESC, u.username, p.code
      LIMIT $${params.length}`, params);
  return rows;
}

/** 归档列表统计。 */
export async function archivedSummary(opts = {}) {
  const rows = await listArchivedEntries(opts);
  const byMonth = new Map();
  const byProject = new Map();
  const byUser = new Map();
  let total = 0;
  for (const r of rows) {
    total += Number(r.hours);
    byMonth.set(r.period, (byMonth.get(r.period) ?? 0) + Number(r.hours));
    const pk = `${r.project_code} ${r.project_name}`;
    byProject.set(pk, (byProject.get(pk) ?? 0) + Number(r.hours));
    const uk = `${r.display_name}(${r.username})`;
    byUser.set(uk, (byUser.get(uk) ?? 0) + Number(r.hours));
  }
  const toArr = (m) => [...m.entries()].map(([k, v]) => ({ name: k, hours: Math.round(v * 100) / 100 }))
    .sort((a, b) => b.hours - a.hours);
  return {
    count: rows.length,
    totalHours: Math.round(total * 100) / 100,
    byMonth: toArr(byMonth),
    byProject: toArr(byProject),
    byUser: toArr(byUser),
  };
}

// ---------------------------------------------------------------- 我的工时单状态
/** 某员工某月工时单的四阶段进度（供填充页展示）。 */
export async function sheetProgress(userId, period) {
  const ts = await repo.getTimesheet(userId, period);
  const logs = ts ? await query(
    `SELECT from_status, to_status, action, note, actor_name,
            to_char(at,'YYYY-MM-DD HH24:MI') AS at_fmt
       FROM timesheet_stage_logs WHERE timesheet_id = $1 ORDER BY at`, [ts.id]) : { rows: [] };
  const approvals = ts ? await query(
    `SELECT a.id, a.project_id, p.code AS project_code, p.name AS project_name,
            a.hours::float8 AS hours, a.status, a.reason,
            u.display_name AS approver_name,
            to_char(a.acted_at,'YYYY-MM-DD HH24:MI') AS acted_at_fmt
       FROM approvals a JOIN projects p ON p.id = a.project_id
       LEFT JOIN users u ON u.id = a.approver_id
      WHERE a.timesheet_id = $1 ORDER BY p.code`, [ts.id]) : { rows: [] };

  const status = ts?.status ?? 'draft';
  const order = STAGES[status]?.order ?? 0;
  return {
    status,
    label: STAGES[status]?.label ?? status,
    stageOrder: order,
    stages: Object.entries(STAGES)
      .filter(([k]) => k !== 'rejected')
      .map(([k, v]) => ({
        key: k, label: v.label, order: v.order,
        done: order > v.order,
        current: status === k,
      })),
    approvals: approvals.rows,
    logs: logs.rows,
    salarySnapshot: ts?.salary_snapshot ?? null,
    laborCostWan: ts?.labor_cost_wan ?? null,
    allocRatio: ts?.alloc_ratio ?? null,
    rejectReason: ts?.reject_reason ?? '',
  };
}

function addWorkdays(from, n, calendar) {
  const map = new Map();
  for (const r of calendar) map.set(m(r), Boolean(r.is_workday ?? r[1]));
  let d = new Date(from);
  let left = n;
  let guard = 0;
  while (left > 0 && guard++ < 365) {
    d.setDate(d.getDate() + 1);
    const key = toKey(d);
    const dow = d.getDay();
    let isWork = dow !== 0 && dow !== 6;
    if (map.has(key)) isWork = map.get(key);
    if (isWork) left--;
  }
  return d;
}
function m(r) { return String(r.day_key ?? r.day ?? r[0]).slice(0, 10); }
function toKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}