/**
 * 研发费用归集相关的数据访问层。
 */

import { query, withTransaction } from './db.js';
import { audit } from './repo.js';

// ---------------------------------------------------------------- 企业档案
export async function getCompany() {
  const { rows } = await query('SELECT * FROM company_profile WHERE id = 1');
  return rows[0] ?? null;
}

export async function updateCompany(patch, actorId) {
  const allowed = [
    'name', 'credit_code', 'industry', 'establish_date', 'address', 'legal_person',
    'rd_institution', 'rd_leader', 'rd_leader_phone', 'finance_officer', 'contact',
    'negative_industry', 'negative_ratio', 'deduct_rate',
    'total_revenue', 'total_revenue_3y', 'rd_expense_3y', 'rd_expense_year', 'rd_domestic_3y',
    'high_tech_income', 'total_staff', 'tech_staff', 'innovation_score',
    'last_audit', 'audit_firm',
  ];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    params.push(v === '' ? null : v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) return getCompany();
  const { rows } = await query(
    `UPDATE company_profile SET ${sets.join(', ')}, updated_at = now() WHERE id = 1 RETURNING *`,
    params);
  await audit(actorId, 'company.update', 'company_profile', null, patch);
  return rows[0];
}

// ---------------------------------------------------------------- 费用明细
export async function listCostEntries({ period, projectId, category, from, to } = {}) {
  const where = [];
  const params = [];
  if (period) { params.push(period); where.push(`c.period = $${params.length}`); }
  if (from) { params.push(from); where.push(`c.period >= $${params.length}`); }
  if (to) { params.push(to); where.push(`c.period <= $${params.length}`); }
  if (projectId) { params.push(projectId); where.push(`c.project_id = $${params.length}`); }
  if (category) { params.push(category); where.push(`c.category = $${params.length}::cost_category`); }
  const { rows } = await query(
    `SELECT c.*, p.code AS project_code, p.name AS project_name,
            to_char(c.occurred_on,'YYYY-MM-DD') AS occurred_on
       FROM cost_entries c
       LEFT JOIN projects p ON p.id = c.project_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY c.period DESC, c.category, c.id DESC`, params);
  return rows;
}

export async function createCostEntry(data, actorId) {
  const { rows } = await query(
    `INSERT INTO cost_entries
       (period, project_id, category, sub_item, amount, direction, occurred_on,
        voucher_no, counterparty, summary, source, created_by)
     VALUES ($1,$2,$3::cost_category,$4,$5,$6::txn_direction,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [data.period, data.project_id ?? null, data.category, data.sub_item ?? '',
     data.amount ?? 0, data.direction ?? 'out', data.occurred_on ?? null,
     data.voucher_no ?? null, data.counterparty ?? null, data.summary ?? '',
     data.source ?? 'manual', actorId ?? null]);
  await audit(actorId, 'cost.create', String(rows[0].id), data.period,
    { category: data.category, amount: data.amount });
  return rows[0];
}

export async function updateCostEntry(id, patch, actorId) {
  const allowed = ['period', 'project_id', 'sub_item', 'amount', 'direction',
    'occurred_on', 'voucher_no', 'counterparty', 'summary'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    params.push(v === '' ? null : v);
    sets.push(k === 'direction' ? `${k} = $${params.length}::txn_direction` : `${k} = $${params.length}`);
  }
  if (!sets.length) return null;
  params.push(id);
  const { rows } = await query(
    `UPDATE cost_entries SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  await audit(actorId, 'cost.update', String(id), null, patch);
  return rows[0] ?? null;
}

export async function deleteCostEntry(id, actorId) {
  const { rows } = await query('DELETE FROM cost_entries WHERE id = $1 RETURNING period', [id]);
  await audit(actorId, 'cost.delete', String(id), rows[0]?.period ?? null, {});
  return rows.length > 0;
}

/** 按项目 × 类别汇总（用于费用归集表与辅助账）。 */
export async function costSummaryByProject(period) {
  const { rows } = await query(
    `SELECT c.project_id, p.code AS project_code, p.name AS project_name,
            c.category,
            SUM(CASE WHEN c.direction = 'out' THEN c.amount ELSE -c.amount END) AS amount
       FROM cost_entries c
       LEFT JOIN projects p ON p.id = c.project_id
      WHERE c.period = $1
      GROUP BY c.project_id, p.code, p.name, c.category`, [period]);
  return rows;
}

/** 按年度区间汇总（多口径测算用）。 */
export async function costSummaryRange(fromPeriod, toPeriod) {
  const { rows } = await query(
    `SELECT p.id AS project_id, p.code, p.name, p.is_rnd, p.form,
            c.category,
            SUM(CASE WHEN c.direction = 'out' THEN c.amount ELSE -c.amount END) AS amount
       FROM cost_entries c
       JOIN projects p ON p.id = c.project_id
      WHERE c.period BETWEEN $1 AND $2
      GROUP BY p.id, p.code, p.name, p.is_rnd, p.form, c.category`, [fromPeriod, toPeriod]);
  return rows;
}

/**
 * 写入由工时自动归集的人工费用。
 * 使用 source_ref 唯一索引保证幂等：同一 人×项目×月份 只生成一条。
 */
export async function upsertLaborCost(rows, period, actorId) {
  let inserted = 0, updated = 0;
  await withTransaction(async (c) => {
    for (const r of rows) {
      const ref = `time_labor:${period}:${r.userId}:${r.projectId}`;
      const res = await c.query(
        `INSERT INTO cost_entries
           (period, project_id, category, sub_item, amount, direction, occurred_on,
            summary, source, source_ref, created_by)
         VALUES ($1,$2,'labor'::cost_category,$3,$4,'out'::txn_direction,NULL,$5,'time_labor',$6,$7)
         ON CONFLICT ON CONSTRAINT uq_cost_source_ref DO UPDATE
           SET amount = EXCLUDED.amount, summary = EXCLUDED.summary, updated_at = now()
         RETURNING (xmax = 0) AS is_insert`,
        [period, r.projectId, r.projectCode, r.amountWan,
         `由工时系统自动归集：${r.userName} ${period} 研发工时 ${r.hours}h`, ref, actorId ?? null]);
      if (res.rows[0]?.is_insert) inserted++; else updated++;
    }
  });
  return { inserted, updated };
}

// ---------------------------------------------------------------- 公共费用
export async function listShared(period) {
  if (period) {
    const { rows } = await query(
      'SELECT * FROM shared_expenses WHERE period = $1 ORDER BY category, id', [period]);
    return rows;
  }
  const { rows } = await query('SELECT * FROM shared_expenses ORDER BY period DESC, id');
  return rows;
}

export async function listSharedRange(fromPeriod, toPeriod) {
  const { rows } = await query(
    `SELECT * FROM shared_expenses WHERE period BETWEEN $1 AND $2 ORDER BY period, id`,
    [fromPeriod, toPeriod]);
  return rows;
}

export async function createShared(data, actorId) {
  const { rows } = await query(
    `INSERT INTO shared_expenses
       (period, item, category, total_amount, basis_total, basis_rd, basis_unit, basis_note, note, created_by)
     VALUES ($1,$2,$3::cost_category,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [data.period, data.item, data.category ?? 'other', data.total_amount ?? 0,
     data.basis_total ?? 0, data.basis_rd ?? 0, data.basis_unit ?? '',
     data.basis_note ?? '', data.note ?? '', actorId ?? null]);
  await audit(actorId, 'shared.create', String(rows[0].id), data.period, { item: data.item });
  return rows[0];
}

export async function updateShared(id, patch, actorId) {
  const allowed = ['period', 'item', 'category', 'total_amount', 'basis_total',
    'basis_rd', 'basis_unit', 'basis_note', 'note'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    params.push(v === '' ? null : v);
    sets.push(k === 'category' ? `${k} = $${params.length}::cost_category` : `${k} = $${params.length}`);
  }
  if (!sets.length) return null;
  params.push(id);
  const { rows } = await query(
    `UPDATE shared_expenses SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  await audit(actorId, 'shared.update', String(id), null, patch);
  return rows[0] ?? null;
}

export async function deleteShared(id, actorId) {
  const { rows } = await query('DELETE FROM shared_expenses WHERE id = $1 RETURNING period', [id]);
  await audit(actorId, 'shared.delete', String(id), rows[0]?.period ?? null, {});
  return rows.length > 0;
}

// ---------------------------------------------------------------- 委外/合作
export async function listOutsource(projectId) {
  if (projectId) {
    const { rows } = await query(
      `SELECT o.*, p.code AS project_code, to_char(o.reg_date,'YYYY-MM-DD') AS reg_date
         FROM outsource_contracts o LEFT JOIN projects p ON p.id = o.project_id
        WHERE o.project_id = $1 ORDER BY o.id`, [projectId]);
    return rows;
  }
  const { rows } = await query(
    `SELECT o.*, p.code AS project_code, to_char(o.reg_date,'YYYY-MM-DD') AS reg_date
       FROM outsource_contracts o LEFT JOIN projects p ON p.id = o.project_id
      ORDER BY o.id`);
  return rows;
}

export async function createOutsource(data, actorId) {
  const { rows } = await query(
    `INSERT INTO outsource_contracts
       (project_id, kind, party, content, amount, actual_amount, is_domestic, is_related,
        tech_reg_no, reg_date, our_input, other_input, ownership, acceptance, pay_match, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
    [data.project_id ?? null, data.kind ?? '委托研发', data.party ?? '', data.content ?? '',
     data.amount ?? 0, data.actual_amount ?? 0, data.is_domestic !== false,
     Boolean(data.is_related), data.tech_reg_no ?? null, data.reg_date || null,
     data.our_input ?? 0, data.other_input ?? 0, data.ownership ?? null,
     data.acceptance ?? null, data.pay_match ?? null, data.note ?? '']);
  await audit(actorId, 'outsource.create', String(rows[0].id), null, { party: data.party });
  return rows[0];
}

export async function updateOutsource(id, patch, actorId) {
  const allowed = ['project_id', 'kind', 'party', 'content', 'amount', 'actual_amount',
    'is_domestic', 'is_related', 'tech_reg_no', 'reg_date', 'our_input', 'other_input',
    'ownership', 'acceptance', 'pay_match', 'note'];
  const sets = [];
  const params = [];
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.includes(k)) continue;
    params.push(v === '' ? null : v);
    sets.push(`${k} = $${params.length}`);
  }
  if (!sets.length) return null;
  params.push(id);
  const { rows } = await query(
    `UPDATE outsource_contracts SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
  await audit(actorId, 'outsource.update', String(id), null, patch);
  return rows[0] ?? null;
}

export async function deleteOutsource(id, actorId) {
  const { rows } = await query('DELETE FROM outsource_contracts WHERE id = $1 RETURNING id', [id]);
  await audit(actorId, 'outsource.delete', String(id), null, {});
  return rows.length > 0;
}

// ---------------------------------------------------------------- 备查台账
export async function listLedger(ledgerKey, { period } = {}) {
  const params = [ledgerKey];
  let sql = 'SELECT * FROM ledger_rows WHERE ledger_key = $1';
  if (period) { params.push(period); sql += ` AND period = $${params.length}`; }
  sql += ' ORDER BY seq, id';
  const { rows } = await query(sql, params);
  return rows;
}

export async function listAllLedgers({ period } = {}) {
  const params = [];
  let sql = 'SELECT ledger_key, count(*)::int AS n FROM ledger_rows';
  if (period) { params.push(period); sql += ` WHERE period = $${params.length}`; }
  sql += ' GROUP BY ledger_key';
  const { rows } = await query(sql, params);
  const out = {};
  for (const r of rows) out[r.ledger_key] = r.n;
  return out;
}

export async function createLedgerRow(ledgerKey, data, actorId, period) {
  const { rows } = await query(
    `INSERT INTO ledger_rows (ledger_key, period, project_id, data, seq, created_by)
     VALUES ($1,$2,$3,$4::jsonb,
             COALESCE((SELECT max(seq)+1 FROM ledger_rows WHERE ledger_key=$1), 0), $5)
     RETURNING *`,
    [ledgerKey, period ?? null, data.project_id ?? null, JSON.stringify(data.fields ?? data), actorId ?? null]);
  return rows[0];
}

export async function updateLedgerRow(id, fields, actorId) {
  const { rows } = await query(
    `UPDATE ledger_rows SET data = $2::jsonb WHERE id = $1 RETURNING *`,
    [id, JSON.stringify(fields)]);
  return rows[0] ?? null;
}

export async function deleteLedgerRow(id, actorId) {
  const { rows } = await query('DELETE FROM ledger_rows WHERE id = $1 RETURNING ledger_key', [id]);
  return rows.length > 0;
}

/** 批量替换某类台账的全部行（用于整表保存）。 */
export async function replaceLedger(ledgerKey, rows, actorId, period) {
  await withTransaction(async (c) => {
    await c.query('DELETE FROM ledger_rows WHERE ledger_key = $1 AND ($2::text IS NULL OR period = $2)',
      [ledgerKey, period ?? null]);
    let seq = 0;
    for (const r of rows) {
      await c.query(
        `INSERT INTO ledger_rows (ledger_key, period, project_id, data, seq, created_by)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6)`,
        [ledgerKey, period ?? r.period ?? null, r.project_id ?? null,
         JSON.stringify(r.fields ?? r), seq++, actorId ?? null]);
    }
  });
  await audit(actorId, 'ledger.replace', ledgerKey, period ?? null, { count: rows.length });
  return rows.length;
}

// ---------------------------------------------------------------- 测算快照
export async function saveDeductionRun(period, scope, payload, actorId) {
  const { rows } = await query(
    `INSERT INTO deduction_runs
       (period, scope, payload, anti_rd_base, deduction, hi_rd, accounting_rd, stat_rd, created_by)
     VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (period, scope) DO UPDATE
       SET payload = EXCLUDED.payload, anti_rd_base = EXCLUDED.anti_rd_base,
           deduction = EXCLUDED.deduction, hi_rd = EXCLUDED.hi_rd,
           accounting_rd = EXCLUDED.accounting_rd, stat_rd = EXCLUDED.stat_rd,
           created_by = EXCLUDED.created_by, created_at = now()
     RETURNING *`,
    [period, scope, JSON.stringify(payload), payload.antiRD ?? 0, payload.deduction ?? 0,
     payload.hiRD ?? 0, payload.accRD ?? 0, payload.statRD ?? 0, actorId ?? null]);
  await audit(actorId, 'deduction.freeze', period, null, { scope });
  return rows[0];
}

export async function getDeductionRun(period, scope = 'year') {
  const { rows } = await query(
    'SELECT * FROM deduction_runs WHERE period = $1 AND scope = $2', [period, scope]);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------- 文档
export async function listDocs(period) {
  const { rows } = await query(
    'SELECT doc_key, status, generated_at, generated_by FROM generated_docs WHERE period = $1', [period]);
  const out = {};
  for (const r of rows) out[r.doc_key] = r;
  return out;
}

export async function upsertDoc(docKey, period, status, payload, actorId) {
  const { rows } = await query(
    `INSERT INTO generated_docs (doc_key, period, status, payload, generated_at, generated_by)
     VALUES ($1,$2,$3::doc_status,$4::jsonb, now(), $5)
     ON CONFLICT (doc_key, period) DO UPDATE
       SET status = EXCLUDED.status, payload = EXCLUDED.payload,
           generated_at = now(), generated_by = EXCLUDED.generated_by, updated_at = now()
     RETURNING *`,
    [docKey, period, status, JSON.stringify(payload ?? {}), actorId ?? null]);
  return rows[0];
}