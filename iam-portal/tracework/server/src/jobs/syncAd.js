/**
 * AD 用户目录同步。
 *
 * === 三种状态的判定 ===
 *
 *   1) AD 中存在且启用      -> ad_status='active'   , is_active=true
 *   2) AD 中存在但已禁用    -> ad_status='disabled' , is_active=false
 *      （userAccountControl & 0x0002 ACCOUNTDISABLE）
 *   3) AD 中已不存在        -> ad_status='deleted'  , is_active=false
 *      （用户被删除，或已移出允许登录的 AD 组）
 *
 * 关键设计修正（相对旧实现）：
 *
 *   旧实现把第 3 种情况也笼统记为 is_active=false，与「手工停用」无法区分；
 *   而且只有通过允许组过滤的人才会进入 seen 集合 —— 一旦某人被移出允许组，
 *   它既不会被更新、也不会被标记删除，造成「AD 里已经删了，系统里还活着」。
 *
 *   现在：只要 AD 查询成功返回，就视为一次完整快照。
 *   凡不在快照内的本地已同步用户，一律标记 deleted。
 *
 * === 不物理删除的原因 ===
 *   工时、审批、费用、分摊快照都通过外键引用 users。
 *   物理删除会破坏历史可追溯性（审计与研发费用留存要求）。
 *   因此采用软删除：从各选择列表消失、禁止登录，但记录保留。
 *
 * === 级联处理 ===
 *   用户被禁用/删除后自动：
 *     · 从项目成员中移除
 *     · 从项目审批人中移除（因此不会出现「审批人是离职人员」）
 *  移除后若某项目没有审批人，则由 HR / 管理员兜底审批。
 */
import { query, withTransaction } from '../db.js';
import { config } from '../config.js';
import { fetchAllUsers, groupNames, groupMatches } from '../ldap.js';
import { deriveRole, deriveEmployeeType } from '../auth.js';

/**
 * 执行一次 AD 同步。
 * @param {object} opts
 * @param {boolean} opts.dryRun  只统计不写库
 * @param {string}  opts.trigger 触发来源 scheduled|manual|startup
 */
export async function syncAdUsers({ dryRun = false, trigger = 'manual' } = {}) {
  let runId = null;
  if (!dryRun) {
    const r = await query('INSERT INTO ad_sync_runs (trigger) VALUES ($1) RETURNING id', [trigger]);
    runId = r.rows[0].id;
  }

  try {
    const out = await doSync({ dryRun });
    if (!dryRun && runId) {
      await query(
        `UPDATE ad_sync_runs
            SET finished_at = now(), ok = TRUE, stats = $2::jsonb,
                disabled_users = $3, deleted_users = $4, restored_users = $5
          WHERE id = $1`,
        [runId, JSON.stringify(out.counts), out.disabled, out.deleted, out.restored]);
    }
    return out.counts;
  } catch (err) {
    if (!dryRun && runId) {
      await query(
        'UPDATE ad_sync_runs SET finished_at = now(), ok = FALSE, error = $2 WHERE id = $1',
        [runId, err.message]);
    }
    throw err;
  }
}

async function doSync({ dryRun }) {
  const adUsers = await fetchAllUsers();

  const counts = {
    total: adUsers.length,
    created: 0, updated: 0, disabled: 0, deleted: 0, restored: 0,
    skipped: 0, cascaded: 0,
  };
  const disabled = [];
  const deleted = [];
  const restored = [];
  const seen = new Set();

  for (const u of adUsers) {
    if (!u.username) { counts.skipped++; continue; }

    const groups = groupNames(u.groups);
    const inAllowed = !config.ldap.allowedGroups.length
      || groupMatches(u.groups, config.ldap.allowedGroups);

    // 不在允许组内的 AD 用户不纳入系统，也不计入 seen（下文会按 deleted 处理）
    if (!inAllowed) { counts.skipped++; continue; }

    seen.add(u.username);

    const adStatus = u.disabled ? 'disabled' : 'active';
    const isActive = adStatus === 'active';

    const existing = await query(
      'SELECT id, role, is_active, ad_status FROM users WHERE username = $1', [u.username]);

    if (existing.rowCount === 0) {
      if (dryRun) { counts.created++; continue; }
      const role = deriveRole(u.groups);
      const empType = deriveEmployeeType(u.groups);
      await query(
        `INSERT INTO users (username, display_name, email, ad_dn, department, title,
                            role, employee_type, is_active, ad_status, ad_groups,
                            synced_at, attendance_hours)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now(), $12)
         ON CONFLICT (username) DO NOTHING`,
        [u.username, u.displayName, u.email, u.dn, u.department, u.title,
         role, empType, isActive, adStatus, groups, config.app.defaultAttendanceHours || null]);
      counts.created++;
      continue;
    }

    const row = existing.rows[0];
    const newRole = row.role === 'employee' ? deriveRole(u.groups) : row.role;
    // 研发类型：按 AD 组实时推导。管理员组优先，其次 Group_Support → support。
    // 这样 AD 里调整组之后，系统内的研发/支持身份会自动跟随。
    const newEmpType = deriveEmployeeType(u.groups);

    if (dryRun) {
      counts.updated++;
      if (adStatus === 'disabled' && row.ad_status !== 'disabled' && row.ad_status !== 'deleted') counts.disabled++;
      if (adStatus === 'active' && row.ad_status !== 'active') counts.restored++;
      continue;
    }

    await query(
      `UPDATE users SET display_name=$2, email=$3, ad_dn=$4, department=$5, title=$6,
                        ad_groups=$7, synced_at=now(), ad_status=$8,
                        is_active=$9, role=$10, employee_type=$11
        WHERE username=$1`,
      [u.username, u.displayName, u.email, u.dn, u.department, u.title,
       groups, adStatus, isActive, newRole, newEmpType]);
    counts.updated++;

    if (adStatus === 'disabled' && row.ad_status !== 'disabled' && row.ad_status !== 'deleted') {
      counts.disabled++; disabled.push(u.username);
    }
    if (adStatus === 'active' && row.ad_status !== 'active') {
      counts.restored++; restored.push(u.username);
    }
  }

  // AD 快照中不存在的本地用户 -> deleted（只处理曾同步过的，避免误伤本地账号）
  const { rows: toDelete } = await query(
    `SELECT id, username FROM users
      WHERE ad_status <> 'deleted'
        AND synced_at IS NOT NULL
        AND NOT (username = ANY($1::text[]))`,
    [[...seen]]);

  if (toDelete.length) {
    if (!dryRun) {
      await withTransaction(async (c) => {
        for (const u of toDelete) {
          await c.query(
            "UPDATE users SET ad_status='deleted', is_active=FALSE, synced_at=now() WHERE id=$1",
            [u.id]);
        }
      });
    }
    counts.deleted += toDelete.length;
    deleted.push(...toDelete.map((r) => r.username));
  }

  // 级联清理
  if (!dryRun) counts.cascaded = await cascadeInactiveUsers();

  return { counts, disabled, deleted, restored };
}

/**
 * 把「已禁用或已删除」的用户从项目成员、项目审批人中移除。
 * 移除后若项目失去全部审批人，由 HR/管理员兜底审批。
 */
export async function cascadeInactiveUsers() {
  return withTransaction(async (c) => {
    const { rows: invalid } = await c.query(
      `SELECT id, username FROM users
        WHERE ad_status IN ('disabled','deleted') OR is_active = FALSE`);
    if (!invalid.length) return 0;
    const ids = invalid.map((r) => r.id);

    const m = await c.query(
      'DELETE FROM project_members WHERE user_id = ANY($1::bigint[])', [ids]);
    const a = await c.query(
      'DELETE FROM project_approvers WHERE user_id = ANY($1::bigint[])', [ids]);

    const total = (m.rowCount ?? 0) + (a.rowCount ?? 0);
    if (total > 0) {
      await c.query(
        `INSERT INTO audit_logs (actor_name, action, target, detail)
         VALUES ('system', 'ad.cascade_inactive', 'users', $1::jsonb)`,
        [JSON.stringify({
          users: invalid.map((r) => r.username),
          removedFromMembers: m.rowCount ?? 0,
          removedFromApprovers: a.rowCount ?? 0,
        })]);
    }
    return total;
  });
}

/** 查找「没有任何审批人」的在研项目，供界面告警。 */
export async function projectsWithoutApprover() {
  const { rows } = await query(
    `SELECT p.id, p.code, p.name
       FROM projects p
      WHERE p.is_active
        AND NOT EXISTS (SELECT 1 FROM project_approvers pa WHERE pa.project_id = p.id)
      ORDER BY p.code`);
  return rows;
}

/** 把同步结果写入审计日志。 */
export async function recordSyncAudit(stats) {
  await withTransaction(async (c) => {
    await c.query(
      `INSERT INTO audit_logs (actor_name, action, target, detail)
       VALUES ('system', 'ad.sync', 'users', $1::jsonb)`,
      [JSON.stringify(stats)]);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { closeServiceClient } = await import('../ldap.js');
  const { closePool } = await import('../db.js');
  try {
    console.log('[sync] 开始同步 AD 用户 ...');
    const stats = await syncAdUsers({
      dryRun: process.argv.includes('--dry-run'),
      trigger: 'manual',
    });
    console.log('[sync] 结果:', stats);
    console.log('[sync] 无审批人的项目:', (await projectsWithoutApprover()).map((p) => p.code).join(', ') || '(无)');
    await recordSyncAudit(stats);
    await closeServiceClient();
    await closePool();
  } catch (err) {
    console.error('[sync] 失败:', err.message);
    process.exit(1);
  }
}