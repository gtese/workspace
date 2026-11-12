/**
 * 费用测算与人工费用分摊的上下文构建。
 *
 * 这两个函数原本是 costingRoutes 内部的闭包，v1 API 也需要相同逻辑，
 * 因此抽出来共享，避免两处实现漂移。
 */
import * as repo from './repo.js';
import * as cr from './costingRepo.js';
import { computeDeduction, complianceCheck, allocateLaborCost, CATS } from './costing.js';
import { listLedger } from './costingRepo.js';

export async function buildDeduction(period, scope) {
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

export async function buildLaborPreview(period) {
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
