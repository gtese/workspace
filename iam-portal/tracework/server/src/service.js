/**
 * 业务服务层：填报校验、提交/审批状态机、月度汇总与分摊。
 */
import * as repo from './repo.js';
import { withTransaction } from './db.js';
import { config } from './config.js';
import {
  workdaysOfMonth, addWorkdays, validateEntryDay, buildHoursMap,
  computeAllocation, round2, parseDateKey, toDateKey, assertPeriod,
} from './domain.js';

function bad(message, code = 'BAD_REQUEST', statusCode = 400) {
  const e = new Error(message);
  e.code = code;
  e.statusCode = statusCode;
  return e;
}
function forbidden(message = '没有权限执行该操作') {
  return bad(message, 'FORBIDDEN', 403);
}
function notFound(message = '资源不存在') {
  return bad(message, 'NOT_FOUND', 404);
}

// ================================================================ 填报

/** 某员工某月的填报上下文：工作日、考勤、已填明细、工时单状态。 */
export async function fillContext(userId, period) {
  assertPeriod(period);
  const { employeeAssets } = await import('./depreciation.js');
  const [calendar, attendance, entries, timesheet, projects, assetInfo] = await Promise.all([
    repo.getCalendar(),
    repo.getAttendance(userId, period),
    repo.getEntriesForPeriod(userId, period),
    repo.getTimesheet(userId, period),
    repo.projectsForUser(userId),
    employeeAssets(userId).catch(() => null),
  ]);

  const workdays = workdaysOfMonth(period, calendar);
  const byDate = new Map();
  for (const e of entries) {
    if (!byDate.has(e.work_date)) byDate.set(e.work_date, []);
    byDate.get(e.work_date).push(e);
  }

  // 该月「需要填报」的日子 = 工作日；休息日若已有填报也一并列出
  const dayKeys = new Set(workdays);
  for (const d of byDate.keys()) dayKeys.add(d);

  const days = [...dayKeys].sort().map((date) => {
    const list = byDate.get(date) ?? [];
    const isWorkday = calendar.has(date) ? calendar.get(date) : workdays.includes(date);
    const total = list.reduce((s, e) => s + Number(e.hours), 0);
    return {
      date,
      isWorkday,
      note: calendarNote(calendar, date),
      entries: list.map((e) => ({
        id: e.id, projectId: e.project_id, projectCode: e.project_code,
        projectName: e.project_name, isRnd: e.is_rnd, hours: Number(e.hours), note: e.note,
      })),
      totalHours: round2(total),
      rndHours: round2(list.filter((e) => e.is_rnd).reduce((s, e) => s + Number(e.hours), 0)),
      nonRndHours: round2(list.filter((e) => !e.is_rnd).reduce((s, e) => s + Number(e.hours), 0)),
      saved: list.length > 0,
    };
  });

  const rndHours = round2(days.reduce((s, d) => s + d.rndHours, 0));
  const nonRndHours = round2(days.reduce((s, d) => s + d.nonRndHours, 0));
  const attendanceHours = attendance ? Number(attendance.hours) : 0;

  return {
    period,
    userId,
    status: timesheet?.status ?? 'draft',
    timesheet,
    attendance: attendance
      ? { hours: Number(attendance.hours), workdays: Number(attendance.workdays), source: attendance.source }
      : null,
    attendanceMissing: !attendance,
    workdayCount: workdays.length,
    dayHours: 8,
    days,
    projects,
    totals: {
      rndHours,
      nonRndHours,
      totalHours: round2(rndHours + nonRndHours),
      attendanceHours: round2(attendanceHours),
      diff: round2(rndHours + nonRndHours - attendanceHours),
    },
    editable: !timesheet || ['draft', 'rejected'].includes(timesheet.status),
    rejectReason: timesheet?.reject_reason ?? '',
    // 员工名下资产（只读展示）：总额、月折旧，帮助工程师了解资源占用
    assets: assetInfo
      ? {
          count: assetInfo.count,
          valueTotal: assetInfo.valueTotal,
          depMonthly: assetInfo.depMonthly,
          list: assetInfo.assets.map((a) => ({
            assetNo: a.asset_no, deviceType: a.device_type,
            brand: a.brand, model: a.model,
            amount: a.amount, depreciationMonths: a.depreciation_months,
            monthlyDep: a.monthlyDep, status: a.status,
          })),
        }
      : { count: 0, valueTotal: 0, depMonthly: 0, list: [] },
  };
}

function calendarNote(calendar, date) {
  // 日历表只存 is_workday，说明文字在单独查询里代价高，这里返回派生说明
  if (calendar.has(date) && !calendar.get(date)) return '节假日';
  if (calendar.has(date) && calendar.get(date)) {
    const d = parseDateKey(date);
    return (d.getUTCDay() === 0 || d.getUTCDay() === 6) ? '调休上班' : '';
  }
  return '';
}

/** 保存某一天的填报（含完整校验）。 */
export async function saveDay(userId, period, dateKey, entries) {
  assertPeriod(period);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateKey)) throw bad('日期格式应为 YYYY-MM-DD');
  if (dateKey.slice(0, 7) !== period) throw bad('填报日期与所选月份不一致');

  const ts = await repo.getTimesheet(userId, period);
  if (ts && !['draft', 'rejected'].includes(ts.status)) {
    throw bad(ts.status === 'submitted' ? '本月工时已提交，如需修改请先撤回或联系审批人驳回'
      : '本月工时已审批通过，不可再修改', 'LOCKED', 409);
  }

  const [calendar, attendance, allowed] = await Promise.all([
    repo.getCalendar(),
    repo.getAttendance(userId, period),
    repo.projectsForUser(userId),
  ]);

  const allowedIds = new Set(allowed.map((p) => p.id));
  for (const e of entries) {
    if (!allowedIds.has(Number(e.project_id))) {
      throw bad(`项目 ${e.project_id} 不在您可报工的范围内`, 'PROJECT_NOT_ALLOWED', 403);
    }
  }

  // 当日可用考勤工时：按 当月考勤工时 / 当月工作日数 折算
  const workdays = workdaysOfMonth(period, calendar);
  let dayLimit = null;
  if (attendance && Number(attendance.workdays) > 0) {
    dayLimit = round2(Number(attendance.hours) / Number(attendance.workdays));
  }
  const isWorkday = calendar.has(dateKey) ? calendar.get(dateKey) : workdays.includes(dateKey);

  const check = validateEntryDay({
    dateKey,
    entries,
    attendanceHours: dayLimit,
    isWorkday,
    allowNonWorkday: true, // 休息日填报销假，交由审批人判断
  });
  if (!check.ok) {
    const err = bad(check.errors.join('；'), 'VALIDATION_FAILED', 422);
    err.details = check.errors;
    throw err;
  }

  await withTransaction(async (c) => {
    await repo.replaceDayEntries(c, userId, dateKey, entries);
    const totals = await recomputeTotals(c, userId, period, calendar, attendance);
    // 当月没有任何工时明细时不创建工时单 —— 避免清空数据后残留 0 工时的空单
    const existing = await repo.getTimesheet(userId, period);
    if (totals.totalHours > 0 || existing) {
      await repo.upsertTimesheet(c, userId, period, totals);
    }
  });

  return { ok: true, warnings: check.warnings, totalHours: check.total };
}

/** 重新计算某月合计并写回工时单（不改变状态）。 */
/**
 * 重算某月合计并写回工时单（供工作流模块复用）。
 * 必须在事务内调用，client 为事务连接。
 */
export async function recomputeAndSave(client, userId, period) {
  const [calendar, attendance] = await Promise.all([
    repo.getCalendar(), repo.getAttendance(userId, period),
  ]);
  const totals = await recomputeTotals(client, userId, period, calendar, attendance);
  const existing = await repo.getTimesheet(userId, period);
  if (totals.totalHours > 0 || existing) {
    await repo.upsertTimesheet(client, userId, period, totals);
  }
  return totals;
}

async function recomputeTotals(client, userId, period, calendar, attendance) {
  // 必须使用事务连接读取，否则读到提交前快照 -> 合计与实际明细不一致
  const entries = await repo.getEntriesForPeriod(userId, period, client);
  let rnd = 0, non = 0;
  for (const e of entries) {
    if (e.is_rnd) rnd += Number(e.hours); else non += Number(e.hours);
  }
  const workdays = workdaysOfMonth(period, calendar);
  let attHours = attendance ? Number(attendance.hours) : 0;
  if (!attendance && config.app.defaultAttendanceHours > 0) {
    attHours = config.app.defaultAttendanceHours;
  } else if (!attendance) {
    attHours = workdays.length * 8;
  }
  return {
    rndHours: round2(rnd),
    nonRndHours: round2(non),
    totalHours: round2(rnd + non),
    attendanceHours: round2(attHours),
  };
}

/** 批量保存整月（前端一次提交多日）。 */
export async function saveMonth(userId, period, days) {
  const results = [];
  for (const d of days) {
    results.push(await saveDay(userId, period, d.date, d.entries ?? []));
  }
  return results;
}

/** 提交本月报工：生成审批单，状态转为 submitted。 */
export async function submitMonth(userId, period, actorIp) {
  assertPeriod(period);
  const ts = await repo.getTimesheet(userId, period);

  // 幂等性：已提交时，如果审批单齐全就拒绝重复提交；
  // 若审批单缺失（历史上事务中断等异常情形），则补建审批单使其自愈。
  if (ts && ts.status === 'submitted') {
    const existing = await repo.listApprovals(period, { userId });
    const perProject = await perProjectHours(userId, period);
    const missing = [...perProject.keys()].filter(
      (pid) => !existing.some((a) => a.project_id === pid));

    if (missing.length === 0 && existing.length > 0) {
      throw bad('本月报工已提交，请勿重复提交', 'ALREADY_SUBMITTED', 409);
    }

    // 自愈：补齐缺失的审批单
    const calendar = await repo.getCalendar();
    const due = addWorkdays(new Date(), config.app.approvalSlaWorkdays, calendar);
    await withTransaction(async (c) => {
      await repo.createApprovals(c, ts.id, userId, period, perProject, due);
    });
    await repo.audit(userId, 'timesheet.submit.repair', period, period,
      { repairedProjects: missing.length }, actorIp);
    return { timesheet: ts, dueAt: due, repaired: true };
  }

  if (ts && ts.status === 'approved') throw bad('本月报工已审批通过', 'ALREADY_APPROVED', 409);

  const [calendar, attendance, entries] = await Promise.all([
    repo.getCalendar(),
    repo.getAttendance(userId, period),
    repo.getEntriesForPeriod(userId, period),
  ]);

  if (entries.length === 0) throw bad('本月尚无填报记录，无法提交', 'EMPTY', 422);

  const totals = await recomputeTotals(null, userId, period, calendar, attendance);
  if (totals.totalHours <= 0) throw bad('本月填报工时为 0，无法提交', 'EMPTY', 422);

  const perProject = new Map();
  for (const e of entries) {
    perProject.set(e.project_id, round2((perProject.get(e.project_id) ?? 0) + Number(e.hours)));
  }

  const now = new Date();
  const due = addWorkdays(now, config.app.approvalSlaWorkdays, calendar);

  const out = await withTransaction(async (c) => {
    const sheet = await repo.upsertTimesheet(c, userId, period, totals);
    await repo.setTimesheetStatus(sheet.id, 'submitted', {}, c);
    await repo.createApprovals(c, sheet.id, userId, period, perProject, due);
    return sheet;
  });

  await repo.audit(userId, 'timesheet.submit', period, period,
    { totalHours: totals.totalHours, projects: perProject.size }, actorIp);

  // 提示：若某些项目没有任何审批人，报工会无人可批（仅 HR/管理员能兜底）。
  // 不阻断提交，但明确告知，避免报工长期挂起。
  const approversMap = await repo.listApproversByProject([...perProject.keys()]);
  const allProjects = await repo.listProjects({ activeOnly: true });
  const orphan = [...perProject.keys()].filter((pid) => {
    const hasApprover = (approversMap.get(Number(pid)) ?? []).length > 0;
    const p = allProjects.find((x) => x.id === Number(pid));
    return !hasApprover && !p?.owner_id;
  });

  return {
    timesheet: out,
    dueAt: due,
    warnings: orphan.length
      ? [`有 ${orphan.length} 个项目未配置审批人，将由人力资源部/管理员审批`]
      : [],
  };
}

/** 撤回已提交的报工（员工本人在未审批前可撤回）。 */
export async function withdrawMonth(userId, period, actorIp) {
  const ts = await repo.getTimesheet(userId, period);
  if (!ts) throw notFound('本月尚无工时单');
  if (ts.status !== 'submitted') throw bad('仅「已提交」状态的工时单可以撤回', 'BAD_STATE', 409);

  const approvals = await repo.listApprovals(period, { userId });
  if (approvals.some((a) => a.status !== 'pending')) {
    throw bad('已有项目完成审批，无法撤回', 'ALREADY_PARTIAL', 409);
  }

  await withTransaction(async (c) => {
    await c.query(`DELETE FROM approvals WHERE timesheet_id = $1 AND status = 'pending'`, [ts.id]);
    await repo.setTimesheetStatus(ts.id, 'draft', {}, c);
  });
  await repo.audit(userId, 'timesheet.withdraw', period, period, {}, actorIp);
  return { ok: true };
}

// ================================================================ 审批

/**
 * 审批人可处理的审批单。
 *
 * 权限模型（或签）：
 *   · admin / hr：可处理全部审批单（兜底）
 *   · 其他人：只能处理「自己作为审批人的项目」的单子
 *     审批人以 project_approvers 为准；若项目未配置审批人，
 *     回退到 projects.owner_id（兼容历史数据）
 */
export async function approvalInbox(viewer, period, { status } = {}) {
  assertPeriod(period);
  let projectIds = null;

  if (!['admin', 'hr'].includes(viewer.role)) {
    projectIds = await repo.projectIdsForApprover(viewer.id);
    // 兼容：owner_id 指向自己但尚未迁入审批人表的项目
    const all = await repo.listProjects({ activeOnly: true });
    for (const p of all) {
      if (p.owner_id === viewer.id && !projectIds.includes(p.id)) projectIds.push(p.id);
    }
    if (!projectIds.length) {
      return { rows: [], progress: await repo.approvalsProgress(period), scoped: true };
    }
  }

  const rows = await repo.listApprovals(period, { status, projectIds });
  const progress = await repo.approvalsProgress(period);
  const result = { rows, progress, scoped: projectIds !== null };

  // 标注每条审批单「我能否审批」，前端据此决定按钮是否可用
  const myProjectIds = new Set(projectIds ?? []);
  result.rows = rows.map((r) => ({
    ...r,
    can_decide: ['admin', 'hr'].includes(viewer.role) || myProjectIds.has(Number(r.project_id)),
  }));

  // 该项目还有哪些审批人（便于界面提示“还有谁能批”）
  const approversMap = await repo.listApproversByProject([...new Set(rows.map((r) => Number(r.project_id)))]);
  result.approversByProject = {};
  for (const [pid, list] of approversMap) {
    result.approversByProject[pid] = list.map((u) => u.display_name);
  }
  return result;
}

/** 审批单条：通过 / 驳回。 */
export async function decide(viewer, approvalId, action, reason, actorIp) {
  const appr = await repo.getApproval(approvalId);
  if (!appr) throw notFound('审批单不存在');
  if (appr.status !== 'pending') throw bad('该审批单已处理', 'ALREADY_DECIDED', 409);

  // 权限：admin/hr 可批全部；其他人必须是该项目的审批人（或签：任一即可）
  if (!['admin', 'hr'].includes(viewer.role)) {
    let allowed = await repo.isProjectApprover(appr.project_id, viewer.id);
    if (!allowed) {
      // 兼容历史：项目 owner_id 仍视为审批人
      const project = await repo.getProject(appr.project_id);
      allowed = Boolean(project && project.owner_id === viewer.id);
    }
    if (!allowed) throw forbidden('您不是该项目的审批人');
  }

  const status = action === 'approve' ? 'approved' : 'rejected';
  const out = await withTransaction(async (c) => {
    const updated = await repo.decideApproval(approvalId, status, viewer.id, reason ?? '', c);

    // 该工时单下所有审批单都完成后，联动主状态
    const statuses = await repo.approvalStatuses(appr.timesheet_id, c);
    if (statuses.length > 0 && statuses.every((s) => s === 'approved')) {
      await repo.setTimesheetStatus(appr.timesheet_id, 'approved', { approvedBy: viewer.id }, c);
    } else if (statuses.includes('rejected')) {
      await repo.setTimesheetStatus(appr.timesheet_id, 'rejected',
        { rejectReason: reason ?? '填报有误，请核实后重新提交', bumpReject: true }, c);
    }
    return updated;
  });

  await repo.audit(viewer.id, `approval.${action}`, String(approvalId), appr.period,
    { userId: appr.user_id, projectId: appr.project_id, hours: appr.hours, reason }, actorIp);
  return out;
}

/** HR 批量审批某人某月的全部待审单。 */
export async function bulkDecide(viewer, period, userId, action, reason, actorIp) {
  if (!['admin', 'hr'].includes(viewer.role)) throw forbidden('仅人力资源部或管理员可批量审批');
  assertPeriod(period);
  const rows = await repo.listApprovals(period, { userId, status: 'pending' });
  const out = [];
  for (const r of rows) {
    out.push(await decide(viewer, r.id, action, reason, actorIp));
  }
  return out;
}

// ================================================================ 汇总与分摊

/**
 * 月度汇总与薪酬分摊。mode='live' 用当前实时数据，mode='snapshot' 用已冻结快照。
 */
export async function monthlySummary(period, { mode = 'live' } = {}) {
  assertPeriod(period);

  if (mode === 'snapshot') {
    const run = await repo.getAllocationRun(period);
    if (!run) throw notFound('该月份尚未生成分摊快照');
    return { ...run.payload, snapshotAt: run.created_at, frozen: true };
  }

  const [users, projects, entries, attendanceRows, progress, calendar] = await Promise.all([
    repo.listUsers({ activeOnly: false }),
    repo.listProjects(),
    repo.monthEntriesAll(period),
    repo.listAttendance(period),
    repo.approvalsProgress(period),
    repo.getCalendar(),
  ]);

  const attendanceByUser = new Map(attendanceRows.map((a) => [a.user_id, a]));
  const workdays = workdaysOfMonth(period, calendar);

  // 按人聚合工时（只统计研发项目用于分摊；非研发单列）
  const rndProjects = projects.filter((p) => p.is_rnd);
  const hoursByEmpProj = new Map();
  const nonRndByUser = new Map();
  for (const e of entries) {
    if (e.is_rnd) {
      if (!hoursByEmpProj.has(e.user_id)) hoursByEmpProj.set(e.user_id, new Map());
      const inner = hoursByEmpProj.get(e.user_id);
      inner.set(e.project_id, (inner.get(e.project_id) ?? 0) + Number(e.hours));
    } else {
      nonRndByUser.set(e.user_id, (nonRndByUser.get(e.user_id) ?? 0) + Number(e.hours));
    }
  }

  // 只有「有填报或有薪酬」的员工进入分摊表
  const employees = users
    .filter((u) => hoursByEmpProj.has(u.id) || nonRndByUser.has(u.id) || Number(u.monthly_salary) > 0)
    .map((u) => {
      const att = attendanceByUser.get(u.id);
      return {
        id: u.id,
        name: u.display_name,
        employeeNo: u.employee_no,
        employeeType: u.employee_type,
        salary: Number(u.monthly_salary),
        nonRndTotal: nonRndByUser.get(u.id) ?? 0,
        attendance: att ? Number(att.hours) : (u.attendance_hours != null
          ? Number(u.attendance_hours) : workdays.length * 8),
        attendanceSource: att ? att.source : 'default',
      };
    });

  const result = computeAllocation(employees, hoursByEmpProj, rndProjects);

  const allApproved = progress.pending === 0 && progress.rejected === 0 && progress.approved > 0;
  return {
    ...result,
    period,
    workdays: workdays.length,
    progress,
    allApproved,
    frozen: false,
    readyForFinance: allApproved && result.tieOk,
  };
}

/** 冻结当月分摊快照（供提交财务后留档）。 */
export async function freezeSummary(viewer, period, actorIp) {
  // 财务是向财务系统/审计提交分摊结果的执行方，因此同样可生成快照
  if (!['admin', 'hr', 'finance'].includes(viewer.role)) {
    throw forbidden('仅财务、人力资源部或管理员可生成分摊快照');
  }
  const summary = await monthlySummary(period, { mode: 'live' });
  const run = await repo.saveAllocationRun(period, summary, viewer.id);
  await repo.audit(viewer.id, 'allocation.freeze', period, period,
    { allocTotal: summary.allocTotal, tieOk: summary.tieOk }, actorIp);
  return { ...summary, snapshotAt: run.created_at, frozen: true };
}

// ================================================================ HR 考勤

/** HR 设置某员工某月考勤。 */
export async function setAttendance(viewer, userId, period, hours, workdays, actorIp) {
  if (!['admin', 'hr'].includes(viewer.role)) throw forbidden('仅人力资源部或管理员可维护考勤');
  assertPeriod(period);
  if (hours < 0 || hours > 1000) throw bad('考勤工时不合理');
  const row = await repo.upsertAttendance(userId, period, workdays, hours, 'manual', viewer.id);
  await repo.audit(viewer.id, 'attendance.set', String(userId), period, { hours, workdays }, actorIp);
  return row;
}

/** 按项目汇总某人某月的工时（用于审批拆分）。 */
export async function perProjectHours(userId, period) {
  const entries = await repo.getEntriesForPeriod(userId, period);
  const m = new Map();
  for (const e of entries) {
    m.set(e.project_id, round2((m.get(e.project_id) ?? 0) + Number(e.hours)));
  }
  return m;
}

export { buildHoursMap, toDateKey };