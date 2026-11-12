/**
 * 数据访问层：把 SQL 集中在这里，路由层只关心业务语义。
 */
import { query, withTransaction } from './db.js';

// ---------------------------------------------------------------- 日历
export async function getCalendar() {
  // 由 SQL 直接产出 'YYYY-MM-DD' 文本，杜绝驱动的时区解释：
  // 若让 pg 把 DATE 转成 Date，取 UTC 日期会得到前一天，导致工作日整体错位。
  const { rows } = await query(
    "SELECT to_char(day, 'YYYY-MM-DD') AS day_key, is_workday FROM calendar_days");
  const m = new Map();
  for (const r of rows) m.set(r.day_key, r.is_workday);
  return m;
}

export async function upsertCalendarDay(day, isWorkday, note, actorId) {
  await query(
    `INSERT INTO calendar_days (day, is_workday, note) VALUES ($1,$2,$3)
     ON CONFLICT (day) DO UPDATE SET is_workday = EXCLUDED.is_workday, note = EXCLUDED.note`,
    [day, isWorkday, note ?? '']);
  await audit(actorId, 'calendar.update', day, null, { isWorkday, note });
}

// ---------------------------------------------------------------- 用户
export async function listUsers({ activeOnly = true, role, search } = {}) {
  // 注意：本查询对 users 做了自连接（取上级姓名），所有列引用必须带 u. 前缀，
  // 否则 is_active / role 等同名列会触发 42702「列引用不明确」。
  const where = [];
  const params = [];
  if (activeOnly) {
    where.push('u.is_active = TRUE');
    // 双保险：即使 is_active 被手工改回，已同步为 deleted 的用户也不进列表
    where.push("u.ad_status <> 'deleted'");
  }
  if (role) { params.push(role); where.push(`u.role = $${params.length}::user_role`); }
  if (search) {
    params.push(`%${search}%`);
    where.push(`(u.username ILIKE $${params.length} OR u.display_name ILIKE $${params.length} OR u.employee_no ILIKE $${params.length})`);
  }
  const { rows } = await query(
    `SELECT u.id, u.username, u.display_name, u.email, u.department, u.title, u.role,
            u.employee_no, u.employee_type, u.manager_id, u.monthly_salary,
            u.attendance_hours, u.is_active, u.ad_status, u.ad_groups, u.last_login_at,
            m.display_name AS manager_name
       FROM users u LEFT JOIN users m ON m.id = u.manager_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY u.employee_no NULLS LAST, u.username`,
    params);
  return rows;
}

export async function getUserById(id) {
  const { rows } = await query('SELECT * FROM users WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function getUserByUsername(username) {
  const { rows } = await query('SELECT * FROM users WHERE username = $1', [String(username).toLowerCase()]);
  return rows[0] ?? null;
}

/**
 * 登录时刷新用户档案。
 *
 * 注意：不得因登录而"复活"已被同步标记为 deleted 的用户 ——
 * 因此 ON CONFLICT 分支**不修改 ad_status / is_active**，
 * 这两个字段只由 AD 同步任务与管理员操作决定。
 * 首次插入时按 AD 的 disabled 标志设置初始状态。
 */
export async function upsertUserFromAd(ad, defaultRole) {
  const { rows } = await query(
    `INSERT INTO users (username, display_name, email, ad_dn, department, title,
                        role, is_active, ad_status, ad_groups, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
     ON CONFLICT (username) DO UPDATE
       SET display_name = EXCLUDED.display_name, email = EXCLUDED.email, ad_dn = EXCLUDED.ad_dn,
           department = EXCLUDED.department, title = EXCLUDED.title,
           ad_groups = EXCLUDED.ad_groups, synced_at = now()
       -- 刻意不更新 ad_status 与 is_active：保留同步任务/管理员判定的结果
     RETURNING *`,
    [ad.username, ad.displayName, ad.email, ad.dn, ad.department, ad.title,
     defaultRole, !ad.disabled, ad.disabled ? 'disabled' : 'active',
     ad.groups.map((g) => g.split(',')[0].replace(/^CN=/i, ''))]);
  return rows[0];
}

// ---------------------------------------------------------------- OIDC
/** 按统一身份主体查找用户（OIDC 登录时优先使用）。 */
export async function getUserByOidcSub(sub) {
  if (!sub) return null;
  const { rows } = await query('SELECT * FROM users WHERE oidc_sub = $1', [String(sub)]);
  return rows[0] ?? null;
}

/**
 * 绑定 OIDC 主体到本地用户。
 *
 * 冲突处理：若该 sub 已绑定到**另一个**用户（同一 IdP 主体对应两个本地账号），
 * 不覆盖，返回 false，由调用方记录告警 —— 这种情况必须人工核对，
 * 静默改绑会导致身份串号。
 */
export async function bindOidcSubject(userId, sub) {
  if (!userId || !sub) return false;
  const owner = await getUserByOidcSub(sub);
  if (owner && owner.id !== userId) return false;
  if (owner && owner.id === userId) return true;
  const { rowCount } = await query(
    'UPDATE users SET oidc_sub = $2 WHERE id = $1 AND (oidc_sub IS NULL OR oidc_sub = $2)',
    [userId, String(sub)]);
  return rowCount > 0;
}

/**
 * OIDC 登录时刷新用户档案（含研发类型）。
 *
 * 与 upsertUserFromAd 的区别：
 *   · 额外同步 employee_type（研发/支持），因为 OIDC 模式下 AD 定时同步可能关闭，
 *     若不在这里更新，研发类型将永远停留在首次入库的值；
 *   · 同样不覆盖 role / is_active / ad_status 等业务与同步判定的字段。
 */
export async function upsertUserFromOidc(profile, defaultRole, employeeType) {
  const { rows } = await query(
    `INSERT INTO users (username, display_name, email, role, employee_type,
                        is_active, ad_status, ad_groups, synced_at)
     VALUES ($1,$2,$3,$4,$5,TRUE,'active',$6, now())
     ON CONFLICT (username) DO UPDATE
       SET display_name = EXCLUDED.display_name,
           email = EXCLUDED.email,
           ad_groups = EXCLUDED.ad_groups,
           employee_type = EXCLUDED.employee_type,
           synced_at = now()
     RETURNING *`,
    [profile.username, profile.displayName, profile.email,
     defaultRole, employeeType, profile.groups]);
  return rows[0];
}

export async function updateUser(id, patch, actorId) {
  const allowed = ['role', 'employee_no', 'employee_type', 'manager_id', 'monthly_salary',
                   'attendance_hours', 'is_active', 'display_name', 'department', 'title',
                   'education', 'major', 'post', 'rd_duty', 'certify_note',
                   'is_tech_staff', 'is_rd_staff', 'join_date'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) return getUserById(id);
  params.push(id);
  const { rows } = await query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  await audit(actorId, 'user.update', String(id), null, patch);
  return rows[0];
}

export async function touchLogin(id) {
  await query('UPDATE users SET last_login_at = now() WHERE id = $1', [id]);
}

// ---------------------------------------------------------------- 项目
export async function listProjects({ activeOnly = false, rndOnly = false } = {}) {
  const where = [];
  if (activeOnly) where.push('p.is_active = TRUE');
  if (rndOnly) where.push('p.is_rnd = TRUE');
  const { rows } = await query(
    `SELECT p.*, o.display_name AS owner_name,
            (SELECT count(*) FROM project_members pm WHERE pm.project_id = p.id) AS member_count
       FROM projects p LEFT JOIN users o ON o.id = p.owner_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY p.is_rnd DESC, p.code`,
    where.length ? [] : []);
  return rows;
}

export async function getProject(id) {
  const { rows } = await query('SELECT * FROM projects WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function getProjectByCode(code) {
  const { rows } = await query('SELECT * FROM projects WHERE code = $1', [code]);
  return rows[0] ?? null;
}

export async function createProject(data, actorId) {
  const { rows } = await query(
    `INSERT INTO projects (code, name, description, owner_id, is_rnd, start_date, end_date, is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7, COALESCE($8, TRUE)) RETURNING *`,
    [data.code, data.name, data.description ?? '', data.owner_id ?? null,
     data.is_rnd !== false, data.start_date ?? null, data.end_date ?? null, data.is_active]);
  await audit(actorId, 'project.create', data.code, null, data);
  return rows[0];
}

export async function updateProject(id, patch, actorId) {
  const allowed = ['code', 'name', 'description', 'owner_id', 'is_rnd', 'is_active', 'start_date', 'end_date'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    params.push(v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) return getProject(id);
  params.push(id);
  const { rows } = await query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  await audit(actorId, 'project.update', String(id), null, patch);
  return rows[0];
}

export async function setProjectMembers(projectId, userIds, actorId) {
  return withTransaction(async (c) => {
    await c.query('DELETE FROM project_members WHERE project_id = $1', [projectId]);
    for (const uid of userIds) {
      await c.query('INSERT INTO project_members (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [projectId, uid]);
    }
    await c.query(
      `INSERT INTO audit_logs (actor_id, action, target, detail) VALUES ($1,'project.members',$2,$3::jsonb)`,
      [actorId ?? null, String(projectId), JSON.stringify({ userIds })]);
    return userIds;
  });
}

// ---------------------------------------------------------------- 项目审批人（多主管，或签）
/** 批量查询：projectId -> 审批人列表 */
export async function listApproversByProject(projectIds) {
  if (!Array.isArray(projectIds) || !projectIds.length) return new Map();
  const { rows } = await query(
    `SELECT pa.project_id, u.id, u.username, u.display_name, u.employee_no
       FROM project_approvers pa JOIN users u ON u.id = pa.user_id
      WHERE pa.project_id = ANY($1::bigint[])
      ORDER BY u.display_name`, [projectIds]);
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.project_id)) m.set(r.project_id, []);
    m.get(r.project_id).push(r);
  }
  return m;
}

/** 某项目是否可由该用户审批（或签：在审批人列表内即可）。 */
export async function isProjectApprover(projectId, userId) {
  const { rows } = await query(
    'SELECT 1 FROM project_approvers WHERE project_id = $1 AND user_id = $2',
    [projectId, userId]);
  return rows.length > 0;
}

/** 某用户作为审批人负责的全部项目 id。 */
export async function projectIdsForApprover(userId) {
  const { rows } = await query(
    'SELECT project_id FROM project_approvers WHERE user_id = $1', [userId]);
  return rows.map((r) => Number(r.project_id));
}

/** 设置项目审批人（整表替换）。 */
export async function setProjectApprovers(projectId, userIds, actorId) {
  return withTransaction(async (c) => {
    await c.query('DELETE FROM project_approvers WHERE project_id = $1', [projectId]);
    for (const uid of userIds) {
      await c.query(
        'INSERT INTO project_approvers (project_id, user_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
        [projectId, uid]);
    }
    await c.query(
      `INSERT INTO audit_logs (actor_id, action, target, detail)
       VALUES ($1,'project.approvers',$2,$3::jsonb)`,
      [actorId ?? null, String(projectId), JSON.stringify({ userIds })]);
    return userIds;
  });
}

export async function getProjectApprovers(projectId) {
  const { rows } = await query(
    `SELECT pa.user_id, u.username, u.display_name, u.employee_no, u.role
       FROM project_approvers pa JOIN users u ON u.id = pa.user_id
      WHERE pa.project_id = $1 ORDER BY u.display_name`, [projectId]);
  return rows;
}

export async function getProjectMembers(projectId) {
  const { rows } = await query(
    `SELECT pm.user_id, u.username, u.display_name, u.employee_no
       FROM project_members pm JOIN users u ON u.id = pm.user_id
      WHERE pm.project_id = $1 ORDER BY u.display_name`, [projectId]);
  return rows;
}

/** 某员工可报工的项目：显式成员 + 全员的通用研发项目（无成员限制时）。 */
export async function projectsForUser(userId) {
  const { rows } = await query(
    `SELECT p.* FROM projects p
      WHERE p.is_active = TRUE
        AND (EXISTS (SELECT 1 FROM project_members pm WHERE pm.project_id = p.id AND pm.user_id = $1)
             OR NOT EXISTS (SELECT 1 FROM project_members pm2 WHERE pm2.project_id = p.id))
      ORDER BY p.is_rnd DESC, p.code`, [userId]);
  return rows;
}

// ---------------------------------------------------------------- 考勤
export async function getAttendance(userId, period) {
  const { rows } = await query('SELECT * FROM attendance WHERE user_id = $1 AND period = $2', [userId, period]);
  return rows[0] ?? null;
}

export async function listAttendance(period) {
  const { rows } = await query(
    `SELECT a.*, u.username, u.display_name, u.employee_no, u.employee_type, u.monthly_salary
       FROM attendance a JOIN users u ON u.id = a.user_id
      WHERE a.period = $1 ORDER BY u.display_name`, [period]);
  return rows;
}

export async function upsertAttendance(userId, period, workdays, hours, source, actorId) {
  const { rows } = await query(
    `INSERT INTO attendance (user_id, period, workdays, hours, source, imported_by)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, period) DO UPDATE
       SET workdays = EXCLUDED.workdays, hours = EXCLUDED.hours,
           source = EXCLUDED.source, imported_by = EXCLUDED.imported_by, updated_at = now()
     RETURNING *`,
    [userId, period, workdays, hours, source, actorId ?? null]);
  return rows[0];
}

/** 删除某员工某月的考勤记录（清除误录）。 */
export async function deleteAttendance(userId, period, actorId) {
  const { rows } = await query(
    'DELETE FROM attendance WHERE user_id = $1 AND period = $2 RETURNING *',
    [userId, period]);
  if (rows.length) {
    await audit(actorId, 'attendance.delete', String(userId), period, {});
  }
  return rows.length > 0;
}

/** 删除节假日日历条目。 */
export async function deleteCalendarDay(day, actorId) {
  const { rows } = await query('DELETE FROM calendar_days WHERE day = $1 RETURNING day', [day]);
  if (rows.length) {
    await audit(actorId, 'calendar.delete', day, null, {});
  }
  return rows.length > 0;
}

/**
 * 删除项目。
 *
 * 安全策略：只有当项目**没有任何业务数据引用**时才允许物理删除，
 * 否则拒绝并要求改用「停用」—— 避免破坏工时、费用、台账的历史关联。
 */
export async function deleteProject(id, actorId) {
  const { rows: refs } = await query(
    `SELECT
       (SELECT count(*) FROM time_entries       WHERE project_id = $1) AS entries,
       (SELECT count(*) FROM cost_entries       WHERE project_id = $1) AS costs,
       (SELECT count(*) FROM approvals          WHERE project_id = $1) AS approvals,
       (SELECT count(*) FROM ledger_rows        WHERE project_id = $1) AS ledgers,
       (SELECT count(*) FROM outsource_contracts WHERE project_id = $1) AS outsource`,
    [id]);
  const r = refs[0];
  const total = Number(r.entries) + Number(r.costs) + Number(r.approvals)
    + Number(r.ledgers) + Number(r.outsource);
  if (total > 0) {
    const detail = [];
    if (Number(r.entries)) detail.push(`工时 ${r.entries} 条`);
    if (Number(r.costs)) detail.push(`费用 ${r.costs} 条`);
    if (Number(r.approvals)) detail.push(`审批 ${r.approvals} 条`);
    if (Number(r.ledgers)) detail.push(`台账 ${r.ledgers} 条`);
    if (Number(r.outsource)) detail.push(`委外 ${r.outsource} 条`);
    const e = new Error(`该项目已有业务数据（${detail.join('、')}），不能删除。请改用「停用」。`);
    e.statusCode = 409;
    e.code = 'HAS_REFERENCES';
    throw e;
  }
  const { rows } = await query('DELETE FROM projects WHERE id = $1 RETURNING code', [id]);
  if (rows.length) await audit(actorId, 'project.delete', rows[0].code, null, {});
  return rows.length > 0;
}

// ---------------------------------------------------------------- 工时明细
export async function getEntries(userId, from, to) {
  const { rows } = await query(
    `SELECT e.id, to_char(e.work_date,'YYYY-MM-DD') AS work_date, e.project_id, e.hours, e.note,
            p.code AS project_code, p.name AS project_name, p.is_rnd
       FROM time_entries e JOIN projects p ON p.id = e.project_id
      WHERE e.user_id = $1 AND e.work_date BETWEEN $2 AND $3
      ORDER BY e.work_date, p.code`, [userId, from, to]);
  return rows;
}

/**
 * 读取某员工某月的工时明细。
 *
 * client 参数至关重要：在事务内必须传入事务连接，
 * 否则会从连接池取另一条连接读到**事务提交前的旧快照**，
 * 导致「删除填报后工时单合计不更新」这类数据不一致。
 */
/** 按工时单主键查询（审批流转用）。 */
export async function getTimesheetById(id) {
  const { rows } = await query('SELECT * FROM timesheets WHERE id = $1', [id]);
  return rows[0] ?? null;
}

export async function getEntriesForPeriod(userId, period, client = null) {
  const c = client ?? { query };
  const { rows } = await c.query(
    `SELECT e.id, to_char(e.work_date,'YYYY-MM-DD') AS work_date, e.project_id, e.hours, e.note,
            p.code AS project_code, p.name AS project_name, p.is_rnd
       FROM time_entries e JOIN projects p ON p.id = e.project_id
      WHERE e.user_id = $1 AND to_char(e.work_date,'YYYY-MM') = $2
      ORDER BY e.work_date, p.code`, [userId, period]);
  return rows;
}

/** 批量替换某一天的填报（事务内先删后插）。 */
export async function replaceDayEntries(client, userId, workDate, entries) {
  const c = client ?? { query };
  await c.query('DELETE FROM time_entries WHERE user_id = $1 AND work_date = $2', [userId, workDate]);
  for (const e of entries) {
    if (!e.hours || Number(e.hours) <= 0) continue;
    await c.query(
      `INSERT INTO time_entries (user_id, work_date, project_id, hours, note)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, work_date, project_id)
       DO UPDATE SET hours = EXCLUDED.hours, note = EXCLUDED.note, updated_at = now()`,
      [userId, workDate, e.project_id, e.hours, e.note ?? '']);
  }
}

/** 整月工时（所有人），用于汇总/分摊。 */
export async function monthEntriesAll(period) {
  const { rows } = await query(
    `SELECT e.user_id, e.project_id, p.is_rnd, SUM(e.hours) AS hours
       FROM time_entries e JOIN projects p ON p.id = e.project_id
      WHERE to_char(e.work_date,'YYYY-MM') = $1
      GROUP BY e.user_id, e.project_id, p.is_rnd`, [period]);
  return rows;
}

// ---------------------------------------------------------------- 工时单
export async function getTimesheet(userId, period) {
  const { rows } = await query(
    `SELECT t.*, u.display_name, u.username, u.employee_no
       FROM timesheets t JOIN users u ON u.id = t.user_id
      WHERE t.user_id = $1 AND t.period = $2`, [userId, period]);
  return rows[0] ?? null;
}

export async function listTimesheets(period, { status, userId } = {}) {
  const where = ['t.period = $1'];
  const params = [period];
  if (status) { params.push(status); where.push(`t.status = $${params.length}::timesheet_status`); }
  if (userId) { params.push(userId); where.push(`t.user_id = $${params.length}`); }
  const { rows } = await query(
    `SELECT t.*, u.username, u.display_name, u.employee_no, u.employee_type
       FROM timesheets t JOIN users u ON u.id = t.user_id
      WHERE ${where.join(' AND ')}
      ORDER BY u.display_name`, params);
  return rows;
}

export async function upsertTimesheet(client, userId, period, totals) {
  const c = client ?? { query };
  // 注意：status 是 timesheet_status 枚举类型。COALESCE 里的 'draft' 字面量
  // 会被推断为 text，必须显式 CAST 才能赋值给枚举列，否则报 42804。
  const { rows } = await c.query(
    `INSERT INTO timesheets (user_id, period, rnd_hours, non_rnd_hours, total_hours, attendance_hours, status)
     VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7::timesheet_status, 'draft'::timesheet_status))
     ON CONFLICT (user_id, period) DO UPDATE
       SET rnd_hours = EXCLUDED.rnd_hours, non_rnd_hours = EXCLUDED.non_rnd_hours,
           total_hours = EXCLUDED.total_hours, attendance_hours = EXCLUDED.attendance_hours,
           updated_at = now()
     RETURNING *`,
    [userId, period, totals.rndHours, totals.nonRndHours, totals.totalHours, totals.attendanceHours,
     totals.status ?? null]);
  return rows[0];
}

/**
 * 更新工时单状态。
 *
 * 重要：client 参数必须传入。若在事务中调用而使用全局连接池，
 * 会在另一个连接上等待本事务已持有的行锁，造成自死锁（请求挂起直到超时）。
 */
export async function setTimesheetStatus(id, status, extra = {}, client = null) {
  const c = client ?? { query };
  // status 是枚举列，必须显式 cast 参数，否则 text -> timesheet_status 报 42804
  const sets = ['status = $2::timesheet_status'];
  const params = [id, status];
  if (status === 'submitted') sets.push('submitted_at = now()');
  if (status === 'approved') { sets.push('approved_at = now()'); }
  if ('approvedBy' in extra) { params.push(extra.approvedBy); sets.push(`approved_by = $${params.length}`); }
  if ('rejectReason' in extra) { params.push(extra.rejectReason); sets.push(`reject_reason = $${params.length}`); }
  if (extra.bumpReject) sets.push('reject_count = reject_count + 1');
  const { rows } = await c.query(
    `UPDATE timesheets SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  return rows[0];
}

// ---------------------------------------------------------------- 审批
export async function createApprovals(client, timesheetId, userId, period, perProject, dueAt) {
  const c = client ?? { query };
  await c.query('DELETE FROM approvals WHERE timesheet_id = $1', [timesheetId]);
  const out = [];
  for (const [projectId, hours] of perProject.entries()) {
    const { rows } = await c.query(
      `INSERT INTO approvals (timesheet_id, user_id, project_id, period, hours, status, due_at)
       VALUES ($1,$2,$3,$4,$5,'pending',$6) RETURNING *`,
      [timesheetId, userId, projectId, period, hours, dueAt]);
    out.push(rows[0]);
  }
  return out;
}

export async function listApprovals(period, { status, approverId, userId, projectIds } = {}) {
  const where = ['a.period = $1'];
  const params = [period];
  if (status) { params.push(status); where.push(`a.status = $${params.length}::approval_status`); }
  if (userId) { params.push(userId); where.push(`a.user_id = $${params.length}`); }
  if (approverId) { params.push(approverId); where.push(`a.approver_id = $${params.length}`); }
  if (projectIds && projectIds.length) { params.push(projectIds); where.push(`a.project_id = ANY($${params.length})`); }
  const { rows } = await query(
    `SELECT a.*, u.username, u.display_name, u.employee_no, u.employee_type,
            p.code AS project_code, p.name AS project_name,
            ap.display_name AS approver_name
       FROM approvals a
       JOIN users u ON u.id = a.user_id
       JOIN projects p ON p.id = a.project_id
       LEFT JOIN users ap ON ap.id = a.approver_id
      WHERE ${where.join(' AND ')}
      ORDER BY u.display_name, p.code`, params);
  return rows;
}

export async function getApproval(id) {
  const { rows } = await query('SELECT * FROM approvals WHERE id = $1', [id]);
  return rows[0] ?? null;
}

/** 审批单落定。client 传入时在事务内执行，避免与事务持有的锁冲突。 */
export async function decideApproval(id, status, approverId, reason, client = null) {
  const c = client ?? { query };
  const { rows } = await c.query(
    `UPDATE approvals SET status = $2::approval_status, approver_id = $3, acted_at = now(), reason = $4
      WHERE id = $1 RETURNING *`,
    [id, status, approverId, reason ?? '']);
  return rows[0] ?? null;
}

/** 查询某工时单下所有审批单状态（供事务内联动主状态）。 */
export async function approvalStatuses(timesheetId, client = null) {
  const c = client ?? { query };
  const { rows } = await c.query(
    'SELECT status FROM approvals WHERE timesheet_id = $1', [timesheetId]);
  return rows.map((r) => r.status);
}

/**
 * 待我审批的数量。
 *
 * 注意：不能按 approvals.approver_id 查 —— 待审单的 approver_id 是空的
 * （还没人处理）。正确逻辑是「该审批单所属项目的审批人列表里包含我」，
 * 或我是 admin/hr（可审批全部）。
 */
export async function pendingCountForApprover(approverId, period) {
  const { rows } = await query(
    `SELECT count(*)::int AS n
       FROM approvals a
       JOIN timesheets t ON t.id = a.timesheet_id
       JOIN users u ON u.id = $1
      WHERE a.status = 'pending'
        AND t.status = 'stage1_project'
        AND ($2::text IS NULL OR a.period = $2)
        AND (
          u.role IN ('admin', 'hr')
          OR EXISTS (SELECT 1 FROM project_approvers pa
                      WHERE pa.project_id = a.project_id AND pa.user_id = $1)
          OR EXISTS (SELECT 1 FROM projects p
                      WHERE p.id = a.project_id AND p.owner_id = $1)
        )`,
    [approverId, period ?? null]);
  return rows[0]?.n ?? 0;
}

export async function approvalsProgress(period) {
  const { rows } = await query(
    `SELECT status, count(*)::int AS n FROM approvals WHERE period = $1 GROUP BY status`, [period]);
  const out = { pending: 0, approved: 0, rejected: 0 };
  for (const r of rows) out[r.status] = r.n;
  return out;
}

// ---------------------------------------------------------------- 分摊快照
export async function saveAllocationRun(period, result, actorId) {
  const { rows } = await query(
    `INSERT INTO allocation_runs (period, total_hours, salary_total, alloc_total, non_rnd_salary, tie_diff, payload, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
     ON CONFLICT (period) DO UPDATE
       SET total_hours=EXCLUDED.total_hours, salary_total=EXCLUDED.salary_total,
           alloc_total=EXCLUDED.alloc_total, non_rnd_salary=EXCLUDED.non_rnd_salary,
           tie_diff=EXCLUDED.tie_diff, payload=EXCLUDED.payload,
           created_by=EXCLUDED.created_by, created_at=now()
     RETURNING *`,
    [period, result.totalHours, result.salaryTotal, result.allocTotal,
     result.nonRndSalaryTotal, result.tieDiff, JSON.stringify(result), actorId ?? null]);
  return rows[0];
}

export async function getAllocationRun(period) {
  const { rows } = await query('SELECT * FROM allocation_runs WHERE period = $1', [period]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- 审计
/**
 * 写审计日志。
 *
 * 审计失败绝不应打断业务流程（例如瞬时数据库抖动不应让一次正常的
 * 登录失败响应变成 500）。因此这里吞掉异常并仅打印告警。
 */
export async function audit(actorId, action, target, period, detail, ip) {
  try {
    const { rows } = await query('SELECT display_name FROM users WHERE id = $1', [actorId ?? -1]);
    await query(
      `INSERT INTO audit_logs (actor_id, actor_name, action, target, period, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7)`,
      [actorId ?? null, rows[0]?.display_name ?? 'system', action, target ?? '', period ?? null,
       JSON.stringify(detail ?? {}), ip ?? null]);
  } catch (err) {
    console.warn(`[audit] 写入失败（已忽略）action=${action} target=${target}: ${err.message}`);
  }
}

export async function listAudit({ limit = 200, period, actorId } = {}) {
  const where = [];
  const params = [];
  if (period) { params.push(period); where.push(`period = $${params.length}`); }
  if (actorId) { params.push(actorId); where.push(`actor_id = $${params.length}`); }
  params.push(Math.min(limit, 1000));
  const { rows } = await query(
    `SELECT * FROM audit_logs ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY at DESC LIMIT $${params.length}`, params);
  return rows;
}

export { withTransaction };