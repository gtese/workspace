/**
 * 研发费用归集与备查体系的路由。
 *
 * 权限模型：
 *   · 财务（finance/hr/admin）—— 费用归集、公共费用、委外、测算、台账、文档
 *   · 人事（hr/admin）—— 人员名册、科技人员标识、薪酬与工时
 *   · 项目负责人（pm）—— 查看本项目相关数据
 *   · 研发人员（employee）—— 只能看与自己相关的（工时、本人名册行）
 */
import { z } from 'zod';
import { currentUser, loadUser, isAdmin, isHr } from './auth.js';
import * as cr from './costingRepo.js';
import * as repo from './repo.js';
import { computeDeduction, complianceCheck, CATS, allocateLaborCost } from './costing.js';
import { LEDGER_MAP, ledgerCatalog, blankLedgerRow, validateLedgerRow, deriveValues } from './ledgers.js';
import { currentPeriod } from './domain.js';
import { buildDocContext, generateDocx, generateAllDocx, DOCS, STAGES, findDoc } from './docService.js';
import { buildDocx } from './docs.js';
import { query } from './db.js';

const periodSchema = z.string().regex(/^\d{4}-\d{2}$/, '月份格式应为 YYYY-MM');
const yearSchema = z.string().regex(/^\d{4}$/, '年度格式应为 YYYY');

function parse(schema, data) {
  const r = schema.safeParse(data);
  if (!r.success) {
    const e = new Error('请求参数不合法：' + r.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；'));
    e.statusCode = 400; e.code = 'VALIDATION';
    throw e;
  }
  return r.data;
}

/** 财务岗：可以维护费用与测算。 */
function requireFinance(me) {
  if (!['admin', 'hr', 'finance'].includes(me.role)) {
    const e = new Error('仅财务或人力资源部可执行该操作');
    e.statusCode = 403; e.code = 'FORBIDDEN';
    throw e;
  }
}
/** 只读视角：财务、HR、管理员、项目负责人。 */
function requireViewer(me) {
  if (!['admin', 'hr', 'finance', 'pm'].includes(me.role)) {
    const e = new Error('您没有查看研发费用数据的权限');
    e.statusCode = 403; e.code = 'FORBIDDEN';
    throw e;
  }
}

const n = (v) => { const x = Number(v); return Number.isFinite(x) ? x : 0; };

export default async function costingRoutes(app) {
  async function auth(req, reply, check) {
    const cu = await currentUser(req);
    if (!cu) { reply.code(401).send({ error: '未登录或会话已过期', code: 'UNAUTHENTICATED' }); return null; }
    const me = await loadUser(cu.id);
    if (!me || !me.is_active) { reply.code(401).send({ error: '账号已停用', code: 'INACTIVE' }); return null; }
    if (check) { try { check(me); } catch (e) { reply.code(e.statusCode ?? 403).send({ error: e.message, code: e.code }); return null; } }
    return me;
  }

  // ================================================================
  // 企业档案
  // ================================================================
  app.get('/api/costing/company', async (req, reply) => {
    const me = await auth(req, reply, requireViewer);
    if (!me) return;
    return { company: await cr.getCompany() };
  });

  app.put('/api/costing/company', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const b = req.body ?? {};
    const patch = {};
    for (const k of ['name', 'credit_code', 'industry', 'address', 'legal_person',
      'rd_institution', 'rd_leader', 'rd_leader_phone', 'finance_officer', 'contact',
      'last_audit', 'audit_firm']) {
      if (k in b) patch[k] = String(b[k] ?? '');
    }
    if ('establish_date' in b) patch.establish_date = b.establish_date || null;
    if ('negative_industry' in b) patch.negative_industry = Boolean(b.negative_industry);
    for (const k of ['negative_ratio', 'deduct_rate', 'total_revenue', 'total_revenue_3y',
      'rd_expense_3y', 'rd_expense_year', 'rd_domestic_3y', 'high_tech_income', 'innovation_score']) {
      if (k in b) patch[k] = n(b[k]);
    }
    for (const k of ['total_staff', 'tech_staff']) {
      if (k in b) patch[k] = Math.max(0, Math.round(n(b[k])));
    }
    return { company: await cr.updateCompany(patch, me.id) };
  });

  // ================================================================
  // 费用明细
  // ================================================================
  app.get('/api/costing/entries', async (req, reply) => {
    const me = await auth(req, reply, requireViewer);
    if (!me) return;
    return {
      rows: await cr.listCostEntries({
        period: req.query.period || undefined,
        from: req.query.from || undefined,
        to: req.query.to || undefined,
        projectId: req.query.project_id ? Number(req.query.project_id) : undefined,
        category: req.query.category || undefined,
      }),
    };
  });

  app.post('/api/costing/entries', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const b = req.body ?? {};
    parse(periodSchema, String(b.period ?? ''));
    if (!CATS.some((c) => c.k === b.category)) {
      return reply.code(400).send({ error: `category 必须为 ${CATS.map((c) => c.k).join('/')}` });
    }
    return { entry: await cr.createCostEntry({
      period: b.period, project_id: b.project_id ? Number(b.project_id) : null,
      category: b.category, sub_item: b.sub_item, amount: n(b.amount),
      direction: b.direction === 'in' ? 'in' : 'out',
      occurred_on: b.occurred_on || null, voucher_no: b.voucher_no,
      counterparty: b.counterparty, summary: b.summary,
    }, me.id) };
  });

  app.patch('/api/costing/entries/:id', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const b = { ...(req.body ?? {}) };
    if ('amount' in b) b.amount = n(b.amount);
    if ('project_id' in b) b.project_id = b.project_id ? Number(b.project_id) : null;
    const row = await cr.updateCostEntry(Number(req.params.id), b, me.id);
    if (!row) return reply.code(404).send({ error: '费用记录不存在' });
    return { entry: row };
  });

  app.delete('/api/costing/entries/:id', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const ok = await cr.deleteCostEntry(Number(req.params.id), me.id);
    if (!ok) return reply.code(404).send({ error: '费用记录不存在' });
    return { ok: true };
  });

  /** 批量删除费用明细。自动归集产生的记录（source=time_labor）不可删除，避免口径失真。 */
  app.post('/api/costing/entries/bulk-delete', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return reply.code(400).send({ error: '请至少选择一条记录' });
    if (ids.length > 500) return reply.code(400).send({ error: '一次最多删除 500 条' });

    let deleted = 0;
    const blocked = [];
    for (const id of ids) {
      const { rows } = await query('SELECT source FROM cost_entries WHERE id = $1', [id]);
      if (!rows.length) continue;
      if (rows[0].source === 'time_labor') { blocked.push(id); continue; }
      const { rowCount } = await query('DELETE FROM cost_entries WHERE id = $1', [id]);
      if (rowCount) deleted++;
    }
    await repo.audit(me.id, 'cost.bulk_delete', ids.join(','), null,
      { requested: ids.length, deleted, blocked: blocked.length }, req.ip);
    return { deleted, blocked: blocked.length,
      message: blocked.length ? `${blocked.length} 条由工时自动归集的记录已跳过（请调整工时后重新归集）` : '' };
  });

  // ================================================================
  // 公共费用
  // ================================================================
  app.get('/api/costing/shared', async (req, reply) => {
    const me = await auth(req, reply, requireViewer);
    if (!me) return;
    const rows = req.query.from && req.query.to
      ? await cr.listSharedRange(String(req.query.from), String(req.query.to))
      : await cr.listShared(req.query.period || undefined);
    // 附带分摊率与分摊额
    return {
      rows: rows.map((r) => {
        const total = n(r.total_amount), bt = n(r.basis_total), br = n(r.basis_rd);
        const rate = bt > 0 ? br / bt : 0;
        return { ...r, rate, alloc: Math.round(total * rate * 100) / 100 };
      }),
    };
  });

  app.post('/api/costing/shared', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const b = req.body ?? {};
    parse(periodSchema, String(b.period ?? ''));
    if (!String(b.item ?? '').trim()) return reply.code(400).send({ error: '费用项目名称必填' });
    if (n(b.basis_rd) > n(b.basis_total) && n(b.basis_total) > 0) {
      return reply.code(400).send({ error: '研发使用量不得大于分摊基数合计' });
    }
    return { row: await cr.createShared({
      period: b.period, item: b.item, category: b.category ?? 'other',
      total_amount: n(b.total_amount), basis_total: n(b.basis_total), basis_rd: n(b.basis_rd),
      basis_unit: b.basis_unit, basis_note: b.basis_note, note: b.note,
    }, me.id) };
  });

  app.patch('/api/costing/shared/:id', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const b = { ...(req.body ?? {}) };
    for (const k of ['total_amount', 'basis_total', 'basis_rd']) if (k in b) b[k] = n(b[k]);
    const row = await cr.updateShared(Number(req.params.id), b, me.id);
    if (!row) return reply.code(404).send({ error: '记录不存在' });
    return { row };
  });

  app.delete('/api/costing/shared/:id', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const ok = await cr.deleteShared(Number(req.params.id), me.id);
    if (!ok) return reply.code(404).send({ error: '记录不存在' });
    return { ok: true };
  });

  // ================================================================
  // 委外 / 合作研发
  // ================================================================
  app.get('/api/costing/outsource', async (req, reply) => {
    const me = await auth(req, reply, requireViewer);
    if (!me) return;
    return { rows: await cr.listOutsource(req.query.project_id ? Number(req.query.project_id) : undefined) };
  });

  app.post('/api/costing/outsource', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const b = req.body ?? {};
    if (!String(b.party ?? '').trim()) return reply.code(400).send({ error: '受托/合作单位必填' });
    return { row: await cr.createOutsource({
      project_id: b.project_id ? Number(b.project_id) : null,
      kind: b.kind ?? '委托研发', party: b.party, content: b.content,
      amount: n(b.amount), actual_amount: n(b.actual_amount),
      is_domestic: b.is_domestic !== false, is_related: Boolean(b.is_related),
      tech_reg_no: b.tech_reg_no, reg_date: b.reg_date || null,
      our_input: n(b.our_input), other_input: n(b.other_input),
      ownership: b.ownership, acceptance: b.acceptance, pay_match: b.pay_match, note: b.note,
    }, me.id) };
  });

  app.patch('/api/costing/outsource/:id', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const b = { ...(req.body ?? {}) };
    for (const k of ['amount', 'actual_amount', 'our_input', 'other_input']) if (k in b) b[k] = n(b[k]);
    if ('project_id' in b) b.project_id = b.project_id ? Number(b.project_id) : null;
    const row = await cr.updateOutsource(Number(req.params.id), b, me.id);
    if (!row) return reply.code(404).send({ error: '记录不存在' });
    return { row };
  });

  app.delete('/api/costing/outsource/:id', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const ok = await cr.deleteOutsource(Number(req.params.id), me.id);
    if (!ok) return reply.code(404).send({ error: '记录不存在' });
    return { ok: true };
  });

  // ================================================================
  // 工时 → 人工费用 自动归集
  // ================================================================
  /**
   * 预览：按当月工时与薪酬，计算应归集到各项目的人员人工费用。
   * 不写库，供财务核对。
   */
  app.get('/api/costing/labor/preview', async (req, reply) => {
    const me = await auth(req, reply, requireViewer);
    if (!me) return;
    const period = parse(periodSchema, String(req.query.period ?? currentPeriod()));
    return buildLaborPreview(period);
  });

  /** 执行归集：把预览结果写入 cost_entries（幂等）。 */
  app.post('/api/costing/labor/apply', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const period = parse(periodSchema, String(req.body?.period ?? currentPeriod()));
    const preview = await buildLaborPreview(period);
    if (!preview.projectRows.length) {
      return reply.code(422).send({
        error: '当月没有可归集的研发工时或薪酬数据，请先确认工时填报与人员薪酬',
        code: 'EMPTY',
      });
    }
    // 展开为「人 × 项目」明细
    const rows = [];
    for (const r of preview.employees) {
      for (const d of r.detail) {
        rows.push({
          userId: r.userId, userName: r.name, projectId: d.projectId,
          projectCode: d.code, hours: d.hours, amountWan: d.amountWan,
        });
      }
    }
    const stats = await cr.upsertLaborCost(rows, period, me.id);
    await repo.audit(me.id, 'costing.labor.apply', period, period,
      { ...stats, totalWan: preview.totalWan }, req.ip);
    return { stats, totalWan: preview.totalWan, period };
  });

  /**
   * 构造人工费用归集预览。
   * 数据来源：工时明细（time_entries）+ 人员薪酬（users.monthly_salary）
   */
  async function buildLaborPreview(period) {
    const [entries, users, projects] = await Promise.all([
      repo.monthEntriesAll(period),
      repo.listUsers({ activeOnly: false }),
      repo.listProjects(),
    ]);
    const projById = new Map(projects.map((p) => [p.id, p]));
    const projByCode = new Map(projects.map((p) => [p.code, p]));

    // 按人聚合：项目工时 + 总工时（研发 + 非研发）
    const perUser = new Map();
    for (const e of entries) {
      if (!perUser.has(e.user_id)) {
        perUser.set(e.user_id, { rnd: new Map(), nonRnd: 0 });
      }
      const rec = perUser.get(e.user_id);
      if (e.is_rnd) rec.rnd.set(e.project_id, (rec.rnd.get(e.project_id) ?? 0) + Number(e.hours));
      else rec.nonRnd += Number(e.hours);
    }

    const employees = [];
    for (const u of users) {
      const rec = perUser.get(u.id);
      if (!rec) continue;
      let rndTotal = 0;
      const hoursMap = {};
      for (const [pid, h] of rec.rnd) {
        rndTotal += h;
        const p = projById.get(pid);
        if (p) hoursMap[p.code] = h;
      }
      const totalHours = rndTotal + rec.nonRnd;
      const salary = Number(u.monthly_salary ?? 0);
      if (totalHours <= 0) continue;

      const detail = [];
      for (const [pid, h] of rec.rnd) {
        const p = projById.get(pid);
        if (!p) continue;
        const amtYuan = salary * h / totalHours;
        detail.push({
          projectId: pid, code: p.code, name: p.name, hours: h,
          amountYuan: Math.round(amtYuan * 100) / 100,
          amountWan: Math.round(amtYuan / 10000 * 100) / 100,
        });
      }
      employees.push({
        userId: u.id, name: u.display_name, employeeNo: u.employee_no,
        salary, rndHours: rndTotal, nonRndHours: rec.nonRnd, totalHours,
        rate: totalHours ? rndTotal / totalHours : 0,
        laborYuan: salary * rndTotal / totalHours,
        laborWan: Math.round(salary * rndTotal / totalHours / 10000 * 100) / 100,
        detail,
        skipped: salary <= 0,
      });
    }

    // 按项目汇总
    const byProj = new Map();
    for (const e of employees) {
      for (const d of e.detail) {
        if (!byProj.has(d.projectId)) {
          byProj.set(d.projectId, { projectId: d.projectId, code: d.code, name: d.name, hours: 0, amountWan: 0, headCount: 0 });
        }
        const r = byProj.get(d.projectId);
        r.hours += d.hours; r.amountWan += d.amountWan; r.headCount += 1;
      }
    }
    const projectRows = [...byProj.values()].map((r) => ({
      ...r,
      hours: Math.round(r.hours * 100) / 100,
      amountWan: Math.round(r.amountWan * 100) / 100,
    })).sort((a, b) => a.code.localeCompare(b.code));

    const totalWan = Math.round(projectRows.reduce((s, r) => s + r.amountWan, 0) * 100) / 100;
    const skipped = employees.filter((e) => e.skipped);

    return {
      period,
      employees: employees.sort((a, b) => (a.employeeNo ?? '').localeCompare(b.employeeNo ?? '')),
      projectRows,
      totalWan,
      skippedCount: skipped.length,
      skippedNames: skipped.map((s) => s.name),
      warnings: skipped.length
        ? [`${skipped.length} 位人员未设置月薪，其工时无法折算为人工费用：${skipped.map((s) => s.name).join('、')}`]
        : [],
    };
  }

  // ================================================================
  // 多口径测算
  // ================================================================
  app.get('/api/costing/deduction', async (req, reply) => {
    const me = await auth(req, reply, requireViewer);
    if (!me) return;
    const scope = req.query.scope === 'month' ? 'month' : 'year';
    const period = scope === 'month'
      ? parse(periodSchema, String(req.query.period ?? currentPeriod()))
      : parse(yearSchema, String(req.query.period ?? new Date().getFullYear()));

    if (req.query.mode === 'snapshot') {
      const run = await cr.getDeductionRun(period, scope);
      if (!run) return reply.code(404).send({ error: '该期间尚未生成测算快照' });
      return { ...run.payload, snapshotAt: run.created_at, frozen: true, scope, period };
    }
    return { ...(await buildDeduction(period, scope)), scope, period };
  });

  app.post('/api/costing/deduction/freeze', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const scope = req.body?.scope === 'month' ? 'month' : 'year';
    const period = scope === 'month'
      ? parse(periodSchema, String(req.body?.period ?? currentPeriod()))
      : parse(yearSchema, String(req.body?.period ?? new Date().getFullYear()));
    const result = await buildDeduction(period, scope);
    const run = await cr.saveDeductionRun(period, scope, result, me.id);
    return { ...result, snapshotAt: run.created_at, frozen: true };
  });

  /**
   * 构造多口径测算输入并调用引擎。
   * 会计年度口径：取该年 01-12 月的费用与台账。
   */
  async function buildDeduction(period, scope) {
    const from = scope === 'month' ? period : `${period}-01`;
    const to = scope === 'month' ? period : `${period}-12`;

    const [company, costRows, projects, sharedRows, outsourceRows, ledgers] = await Promise.all([
      cr.getCompany(),
      cr.costSummaryRange(from, to),
      repo.listProjects(),
      cr.listSharedRange(from, to),
      cr.listOutsource(),
      Promise.all([
        cr.listLedger('special', {}),
        cr.listLedger('grant', {}),
        cr.listLedger('capital', {}),
        cr.listLedger('outsource', {}),
        cr.listLedger('roster', {}),
      ]),
    ]);

    // 组织成「项目 × 六类费用」
    const byProject = new Map();
    for (const p of projects) {
      byProject.set(p.id, {
        id: p.id, code: p.code, name: p.name, isRnd: p.is_rnd, form: p.form,
        cost: { labor: 0, direct: 0, dep: 0, amort: 0, design: 0, other: 0 },
        rdHours: 0, entrust: { amount: 0, domestic: true },
      });
    }
    for (const r of costRows) {
      if (!r.is_rnd) continue;                       // 非研发项目不进入研发费用
      const rec = byProject.get(r.project_id);
      if (!rec) continue;
      rec.cost[r.category] = (rec.cost[r.category] ?? 0) + Number(r.amount);
    }
    // 委托研发金额并入项目。
    // 注意：委外合同可以不指定具体项目（加计扣除的委托研发限额是按企业整体计算的，
    // 并非必须挂到某个研发项目）。这类记录归入一个虚拟归集项，避免被静默丢弃。
    const ORPHAN = '__ENTRUST__';
    const ensureOrphan = () => {
      if (!byProject.has(ORPHAN)) {
        byProject.set(ORPHAN, {
          id: ORPHAN, code: 'WD-未分项目', name: '委托研发（未指定项目）',
          isRnd: true, form: '委托研发',
          cost: { labor: 0, direct: 0, dep: 0, amort: 0, design: 0, other: 0 },
          rdHours: 0, entrust: { amount: 0, domestic: true },
        });
      }
      return byProject.get(ORPHAN);
    };
    for (const o of outsourceRows) {
      if (o.kind !== '委托研发') continue;
      const amt = Number(o.actual_amount || o.amount || 0);
      if (amt <= 0) continue;
      const rec = o.project_id ? byProject.get(o.project_id) : null;
      const target = rec ?? ensureOrphan();
      target.entrust.amount += amt;
      target.entrust.domestic = o.is_domestic !== false;
    }

    // 研发工时（用于公共费用与显示）
    const entries = await repo.monthEntriesAll(from.slice(0, 7));
    const hoursByProj = new Map();
    if (scope === 'month') {
      for (const e of entries) {
        if (!e.is_rnd) continue;
        hoursByProj.set(e.project_id, (hoursByProj.get(e.project_id) ?? 0) + Number(e.hours));
      }
    } else {
      for (let m = 1; m <= 12; m++) {
        const p = `${period}-${String(m).padStart(2, '0')}`;
        // eslint-disable-next-line no-await-in-loop
        const rows = await repo.monthEntriesAll(p);
        for (const e of rows) {
          if (!e.is_rnd) continue;
          hoursByProj.set(e.project_id, (hoursByProj.get(e.project_id) ?? 0) + Number(e.hours));
        }
      }
    }
    for (const [pid, h] of hoursByProj) {
      const rec = byProject.get(pid);
      if (rec) rec.rdHours = h;
    }

    // 公共费用按研发工时占比分摊到项目，计入对应费用类别
    const totalRdHours = [...hoursByProj.values()].reduce((a, b) => a + b, 0);
    const sharedAlloc = [];
    for (const s of sharedRows) {
      const total = Number(s.total_amount), bt = Number(s.basis_total), br = Number(s.basis_rd);
      const rate = bt > 0 ? br / bt : 0;
      const alloc = total * rate;
      sharedAlloc.push({
        period: s.period, item: s.item, category: s.category,
        totalAmount: total, basisTotal: bt, basisRd: br, rate, alloc: Math.round(alloc * 100) / 100,
      });
      // 分摊到项目（按研发工时占比）
      if (totalRdHours > 0) {
        for (const [pid, h] of hoursByProj) {
          const rec = byProject.get(pid);
          if (!rec) continue;
          rec.cost[s.category] = (rec.cost[s.category] ?? 0) + alloc * (h / totalRdHours);
        }
      }
    }

    const projectList = [...byProject.values()].map((p) => ({
      ...p,
      cost: Object.fromEntries(Object.entries(p.cost).map(([k, v]) => [k, Math.round(v * 100) / 100])),
    }));

    const daily = {
      special: ledgers[0].map((r) => r.data),
      grant: ledgers[1].map((r) => r.data),
      capital: ledgers[2].map((r) => r.data),
      outsource: ledgers[3].map((r) => r.data),
      roster: ledgers[4].map((r) => r.data),
    };

    const result = computeDeduction({
      company,
      projects: projectList,
      shared: sharedRows.map((s) => ({ total: s.total_amount, basisTotal: s.basis_total, basisRd: s.basis_rd })),
      daily,
    });

    const check = complianceCheck({ company, projects: projectList, daily }, result);

    return {
      ...result,
      sharedAlloc,
      projectList,
      compliance: check,
      input: {
        scope, from, to,
        projectCount: projectList.length,
        costEntryCount: costRows.length,
        sharedCount: sharedRows.length,
        outsourceCount: outsourceRows.length,
        totalRdHours: Math.round(totalRdHours * 100) / 100,
      },
    };
  }

  // ================================================================
  // 备查台账
  // ================================================================
  app.get('/api/costing/ledgers', async (req, reply) => {
    const me = await auth(req, reply, requireViewer);
    if (!me) return;
    const counts = await cr.listAllLedgers({ period: req.query.period || undefined });
    return {
      catalog: ledgerCatalog().map((l) => ({ ...l, count: counts[l.key] ?? 0 })),
    };
  });

  app.get('/api/costing/ledgers/:key', async (req, reply) => {
    const me = await auth(req, reply, requireViewer);
    if (!me) return;
    const key = String(req.params.key);
    const def = LEDGER_MAP[key];
    if (!def) return reply.code(404).send({ error: '台账类型不存在' });
    const rows = await cr.listLedger(key, { period: req.query.period || undefined });
    return {
      key,
      name: def.name,
      desc: def.desc,
      note: def.note,
      cols: def.cols,
      deriveCols: (def.derive ?? []).map((d) => ({ t: d.t, w: d.w })),
      blank: blankLedgerRow(key),
      rows: rows.map((r) => ({
        id: r.id, seq: r.seq, period: r.period, projectId: r.project_id,
        fields: r.data,
        derived: deriveValues(key, r.data),
        issues: validateLedgerRow(key, r.data),
      })),
    };
  });

  app.post('/api/costing/ledgers/:key/rows', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const key = String(req.params.key);
    if (!LEDGER_MAP[key]) return reply.code(404).send({ error: '台账类型不存在' });
    const fields = req.body?.fields ?? {};
    const issues = validateLedgerRow(key, fields);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) return reply.code(422).send({ error: errors.map((e) => e.msg).join('；'), details: issues });
    const row = await cr.createLedgerRow(key, { fields }, me.id, req.body?.period || null);
    return { row: { id: row.id, fields: row.data, derived: deriveValues(key, row.data), issues } };
  });

  app.patch('/api/costing/ledgers/:key/rows/:id', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const key = String(req.params.key);
    if (!LEDGER_MAP[key]) return reply.code(404).send({ error: '台账类型不存在' });
    const fields = req.body?.fields ?? {};
    const issues = validateLedgerRow(key, fields);
    const errors = issues.filter((i) => i.level === 'error');
    if (errors.length) return reply.code(422).send({ error: errors.map((e) => e.msg).join('；'), details: issues });
    const row = await cr.updateLedgerRow(Number(req.params.id), fields, me.id);
    if (!row) return reply.code(404).send({ error: '记录不存在' });
    return { row: { id: row.id, fields: row.data, derived: deriveValues(key, row.data), issues } };
  });

  app.delete('/api/costing/ledgers/:key/rows/:id', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const ok = await cr.deleteLedgerRow(Number(req.params.id), me.id);
    if (!ok) return reply.code(404).send({ error: '记录不存在' });
    return { ok: true };
  });

  /** 批量删除台账行（前端多选后一次性删除）。 */
  app.post('/api/costing/ledgers/:key/rows/bulk-delete', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const key = String(req.params.key);
    if (!LEDGER_MAP[key]) return reply.code(404).send({ error: '台账类型不存在' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return reply.code(400).send({ error: '请至少选择一行' });
    if (ids.length > 500) return reply.code(400).send({ error: '一次最多删除 500 行' });

    let deleted = 0;
    for (const id of ids) {
      // 只删除本类台账下的行，防止跨类型误删
      const { rows } = await query(
        'DELETE FROM ledger_rows WHERE id = $1 AND ledger_key = $2 RETURNING id', [id, key]);
      if (rows.length) deleted++;
    }
    await repo.audit(me.id, 'ledger.bulk_delete', key, null, { requested: ids.length, deleted }, req.ip);
    return { deleted, requested: ids.length };
  });

  /** 整表替换（前端批量保存）。 */
  app.put('/api/costing/ledgers/:key', async (req, reply) => {
    const me = await auth(req, reply, requireFinance);
    if (!me) return;
    const key = String(req.params.key);
    if (!LEDGER_MAP[key]) return reply.code(404).send({ error: '台账类型不存在' });
    const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
    const allIssues = [];
    rows.forEach((r, i) => {
      const issues = validateLedgerRow(key, r.fields ?? r);
      for (const it of issues) {
        if (it.level === 'error') allIssues.push({ row: i + 1, msg: it.msg });
      }
    });
    if (allIssues.length) {
      return reply.code(422).send({
        error: '存在校验错误：' + allIssues.map((a) => `第${a.row}行 ${a.msg}`).join('；'),
        details: allIssues,
      });
    }
    const count = await cr.replaceLedger(key, rows.map((r) => ({ fields: r.fields ?? r })), me.id, req.body?.period || null);
    return { ok: true, count };
  });

  /** 合规自检（独立接口，便于「合规自检」页调用）。 */
  app.get('/api/costing/compliance', async (req, reply) => {
    const me = await auth(req, reply, requireViewer);
    if (!me) return;
    const scope = req.query.scope === 'month' ? 'month' : 'year';
    const period = scope === 'month'
      ? parse(periodSchema, String(req.query.period ?? currentPeriod()))
      : parse(yearSchema, String(req.query.period ?? new Date().getFullYear()));
    const r = await buildDeduction(period, scope);
    return { period, scope, ...r.compliance };
  });

  // ================================================================
  // 备查资料文档生成（Word）
  // ================================================================
  app.get('/api/costing/docs', async (req, reply) => {
    const me = await auth(req, reply, requireViewer);
    if (!me) return;
    const period = String(req.query.period ?? new Date().getFullYear());
    const generated = await cr.listDocs(period);
    return {
      period,
      stages: STAGES.map((s) => ({
        id: s.id, name: s.name, desc: s.desc,
        docs: DOCS.filter((d) => d.stage === s.id).map((d) => ({
          key: d.key, name: d.name,
          status: generated[d.key]?.status ?? 'missing',
          generatedAt: generated[d.key]?.generated_at ?? null,
        })),
      })),
      total: DOCS.length,
      readyCount: Object.values(generated).filter((g) => g.status === 'ready').length,
    };
  });

  /** 下载单份文档（.docx）。 */
  app.get('/api/costing/docs/:key/download', async (req, reply) => {
    const me = await auth(req, reply, requireViewer);
    if (!me) return;
    const key = String(req.params.key);
    const scope = req.query.scope === 'month' ? 'month' : 'year';
    const period = scope === 'month'
      ? parse(periodSchema, String(req.query.period ?? currentPeriod()))
      : parse(yearSchema, String(req.query.period ?? new Date().getFullYear()));
    const { buffer, name } = await generateDocx(key, period, scope);
    await cr.upsertDoc(key, period, 'ready', { bytes: buffer.length }, me.id);
    await repo.audit(me.id, 'doc.generate', key, period, { scope, bytes: buffer.length }, req.ip);
    const filename = encodeURIComponent(`${name}_${period}.docx`);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
      .header('Content-Length', String(buffer.length))
      .send(buffer);
  });

  /** 下载全部文档合集（.docx）。 */
  app.get('/api/costing/docs/download-all', async (req, reply) => {
    const me = await auth(req, reply, requireViewer);
    if (!me) return;
    const scope = req.query.scope === 'month' ? 'month' : 'year';
    const period = scope === 'month'
      ? parse(periodSchema, String(req.query.period ?? currentPeriod()))
      : parse(yearSchema, String(req.query.period ?? new Date().getFullYear()));
    const { buffer, name } = await generateAllDocx(period, scope);
    for (const d of DOCS) {
      // eslint-disable-next-line no-await-in-loop
      await cr.upsertDoc(d.key, period, 'ready', {}, me.id);
    }
    await repo.audit(me.id, 'doc.generate.all', 'all', period, { bytes: buffer.length }, req.ip);
    const filename = encodeURIComponent(`${name}.docx`);
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
      .header('Content-Length', String(buffer.length))
      .send(buffer);
  });

  /** 预览文档的纯文本（前端预览用，不下载）。 */
  app.get('/api/costing/docs/:key/preview', async (req, reply) => {
    const me = await auth(req, reply, requireViewer);
    if (!me) return;
    const key = String(req.params.key);
    const doc = findDoc(key);
    if (!doc) return reply.code(404).send({ error: '文档不存在' });
    const scope = req.query.scope === 'month' ? 'month' : 'year';
    const period = scope === 'month'
      ? parse(periodSchema, String(req.query.period ?? currentPeriod()))
      : parse(yearSchema, String(req.query.period ?? new Date().getFullYear()));
    const ctx = await buildDocContext(period, scope);
    const xml = buildDocx(doc.build(ctx));
    return { key, name: doc.name, stage: doc.stage, xml, bytes: Buffer.byteLength(xml) };
  });
}
