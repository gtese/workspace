/**
 * 研发费用归集与多口径测算引擎。
 *
 * 实现四套口径，全部依据现行税收与认定规则：
 *
 *  1) 加计扣除口径（财税〔2015〕119号、国家税务总局公告2015年第97号、
 *     2021年第28号、2023年第7号）
 *     · 六类费用据实归集
 *     · 「其他相关费用」限额 = 第一至五项之和 × 10% ÷ (1-10%)
 *       （2021年28号公告起：多项研发活动**统一计算**限额，不再分项目）
 *     · 委托研发按实际发生额的 80% 计入
 *     · 委托境外研发：按实际发生额80%计入，且不超过境内符合条件研发费用的 2/3
 *     · 特殊收入 / 试制产品材料费 / 政府补助冲减，不足冲减按零
 *     · 负面清单行业（主营收入占比>50%）不得加计
 *     · 制造业等行业加计比例 100%（2023年起，原75%）
 *
 *  2) 高企认定口径（国科发火〔2016〕32号）
 *     · 「其他费用」不超过研发总费用的 20%（不同于加计扣除的10%）
 *     · 委托外部研究开发费用按实际发生额的 80% 计入
 *     · 八大指标测算
 *
 *  3) 会计准则口径（企业会计准则第6号——无形资产）
 *     · 费用化/资本化划分，账面列支金额
 *
 *  4) R&D 统计口径（规上企业研发投入统计）
 *     · 近似会计口径
 *
 * 金额单位统一为「万元」，与各类申报表一致。
 */

export const CATS = [
  { k: 'labor',  name: '一、人员人工费用',   antiName: '直接从事研发活动人员' },
  { k: 'direct', name: '二、直接投入费用' },
  { k: 'dep',    name: '三、折旧费用' },
  { k: 'amort',  name: '四、无形资产摊销' },
  { k: 'design', name: '五、新产品设计费等' },
  { k: 'other',  name: '六、其他相关费用', limit: 'other10' },
];

export const CAT_LABEL = Object.fromEntries(CATS.map((c) => [c.k, c.name]));

export function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}
export function round2(n) {
  return Math.round((num(n) + Number.EPSILON) * 100) / 100;
}
export function round4(n) {
  return Math.round((num(n) + Number.EPSILON) * 10000) / 10000;
}
function ratioPct(a, b) {
  const d = num(b);
  return d ? round2((num(a) / d) * 100) : 0;
}

/**
 * 主计算函数。
 *
 * @param {object} input
 * @param {object} input.company        企业档案
 * @param {Array}  input.projects       项目（含 cost 六类金额、entrust、rdHours）
 * @param {Array}  input.shared         公共费用（含 totalAmount/basisTotal/basisRd）
 * @param {object} input.daily          台账数据 { special:[], grant:[], capital:[] }
 * @returns 四口径测算结果
 */
export function computeDeduction(input) {
  const company = input.company ?? {};
  const projects = (input.projects ?? []).filter(
    (p) => String(p.name ?? '').trim() || String(p.code ?? '').trim());
  const shared = input.shared ?? [];
  const daily = input.daily ?? {};

  // ---------- 1. 按项目归集六类费用 ----------
  const rows = projects.map((p) => {
    const cost = {};
    for (const c of CATS) cost[c.k] = round2(p.cost?.[c.k]);

    const entrustAmt = round2(p.entrust?.amount);
    const entrust80 = round2(entrustAmt * 0.8);
    const base5 = round2(CATS.filter((c) => c.k !== 'other').reduce((s, c) => s + cost[c.k], 0));
    const sum6 = round2(base5 + cost.other);

    // 加计口径：按项目看其他费用限额（最终以全年度统一限额为准）
    const otherCapPj = round2(base5 * 10 / 90);
    const otherAllowedPj = round2(Math.min(cost.other, otherCapPj));
    const antiTotalPj = round2(base5 + otherAllowedPj + entrust80);

    // 高企口径：其他费用 ≤ 20%
    const hiSum6 = sum6;
    const hiTotalPj = round2(hiSum6 + entrustAmt);
    const hiOtherCap = round2(hiTotalPj * 0.2);
    const hiOtherAllowed = round2(Math.min(cost.other, hiOtherCap));

    return {
      code: p.code, name: p.name,
      cost, entrustAmt, entrust80, base5, sum6,
      otherCapPj, otherAllowedPj, antiTotalPj,
      hiTotalPj, hiOtherAllowed,
      rdHours: num(p.rdHours),
      isDomestic: p.entrust?.domestic !== false,
    };
  });

  const T = (k) => round2(rows.reduce((s, r) => s + num(r[k]), 0));
  const tCost = {};
  for (const c of CATS) tCost[c.k] = round2(rows.reduce((s, r) => s + num(r.cost[c.k]), 0));

  const allBase5 = round2(CATS.filter((c) => c.k !== 'other').reduce((s, c) => s + tCost[c.k], 0));
  const allOtherCap = round2(allBase5 * 10 / 90);
  const allOtherAllowed = round2(Math.min(tCost.other, allOtherCap));

  // ---------- 2. 委托研发（境内 80%；境外 80% 且受 2/3 限额） ----------
  const entrustFull = round2(rows.reduce((s, r) => s + r.entrustAmt, 0));
  const entrustDom80 = round2(rows.filter((r) => r.isDomestic).reduce((s, r) => s + r.entrust80, 0));
  const entrustFor80 = round2(rows.filter((r) => !r.isDomestic).reduce((s, r) => s + r.entrust80, 0));

  const domesticBase = round2(allBase5 + allOtherAllowed + entrustDom80);
  const overseaCap = round2(domesticBase * 2 / 3);
  const entrustForAllowed = round2(Math.min(entrustFor80, overseaCap));
  const overseaExcess = round2(Math.max(0, entrustFor80 - entrustForAllowed));
  const antiEntrust = round2(entrustDom80 + entrustForAllowed);

  const antiRDBase0 = round2(allBase5 + allOtherAllowed + antiEntrust);

  // ---------- 3. 台账带来的加计口径调整 ----------
  const arr = (k) => (Array.isArray(daily[k]) ? daily[k] : []);

  // ① 特殊收入（下脚料/残次品/中间试制品）冲减
  const specialIncome = round2(arr('special')
    .filter((r) => r.type && r.type !== '试制产品对外销售')
    .reduce((s, r) => s + num(r.income), 0));
  // ② 研发直接形成产品对外销售，对应材料费用不得加计
  const productMaterial = round2(arr('special')
    .filter((r) => r.type === '试制产品对外销售')
    .reduce((s, r) => s + num(r.materialCost), 0));
  // ③ 政府补助直接冲减研发费用且未确认应税收入的，按冲减后余额加计
  const grantOffset = round2(arr('grant')
    .filter((r) => r.offset === '是' && r.taxTreat !== '确认为应税收入')
    .reduce((s, r) => s + num(r.amount), 0));

  const deductAdjust = round2(specialIncome + productMaterial + grantOffset);
  const antiRDBase = round2(Math.max(0, antiRDBase0 - deductAdjust));  // 不足冲减按零

  // ---------- 4. 高企口径（其他费用 ≤ 20%） ----------
  const hiSum6 = round2(Object.values(tCost).reduce((a, b) => a + b, 0));
  const hiTotalWithEntrust = round2(hiSum6 + entrustFull);
  const hi20Cap = round2(hiTotalWithEntrust * 0.2);
  const hiOtherAllowed = round2(Math.min(tCost.other, hi20Cap));
  const hiBase5 = round2(CATS.filter((c) => c.k !== 'other').reduce((s, c) => s + tCost[c.k], 0));
  const hiRD = round2(hiBase5 + hiOtherAllowed + round2(entrustFull * 0.8));

  // ---------- 5. 会计口径 / 统计口径 ----------
  const accRD = round2(hiSum6 + entrustFull);
  const statRD = accRD;

  // ---------- 6. 资本化（形成无形资产按成本 200% 税前摊销） ----------
  const capRows = arr('capital').filter((r) => (r.conclusion ?? '') === '资本化');
  const capitalAmt = round2(capRows.reduce((s, r) => s + num(r.amount), 0));
  const capLife = capRows.length ? (num(capRows[0].life) || 10) : 0;
  const capitalTaxAmort = (capitalAmt && capLife) ? round2(capitalAmt * 2 / capLife) : 0;

  // ---------- 7. 加计扣除与节税 ----------
  const deductRate = num(company.deduct_rate ?? company.deductRate) / 100 || 1;
  const negativeBlocked = Boolean(company.negative_industry ?? company.negative)
    && num(company.negative_ratio ?? company.negativeRatio) > 50;

  const deduction = negativeBlocked ? 0 : round2(antiRDBase * deductRate);
  const taxSave25 = round2(deduction * 0.25);          // 法定税率 25%
  const taxSave15 = round2(deduction * 0.15);          // 高企优惠税率 15%

  // ---------- 8. 高企八大指标 ----------
  const c = company;
  const rev = num(c.total_revenue ?? c.totalRevenue);
  const rdRatio = ratioPct(c.rd_expense_3y ?? c.rdExpense3y, c.total_revenue_3y ?? c.totalRevenue3y);
  const rdRatioYear = ratioPct(c.rd_expense_year ?? c.rdExpenseYear, rev);
  const domRatio = ratioPct(c.rd_domestic_3y ?? c.rdDomestic3y, c.rd_expense_3y ?? c.rdExpense3y);
  const hiIncomeRatio = ratioPct(c.high_tech_income ?? c.highTechIncome, rev);
  const staffRatio = ratioPct(c.tech_staff ?? c.techStaff, c.total_staff ?? c.totalStaff);
  // 研发费用占销售收入比例的档位：≤5000万→5%，≤2亿→4%，>2亿→3%
  const rdThreshold = rev <= 5000 ? 5 : (rev <= 20000 ? 4 : 3);
  const innovationScore = num(c.innovation_score ?? c.innovationScore);

  const indicators = [
    { key: 'techStaff',  name: '科技人员占比',              val: staffRatio,     need: 10,        unit: '%',  ok: staffRatio >= 10 },
    { key: 'rdRatio',    name: '研发费用占销售收入比例（近三年）', val: rdRatio,  need: rdThreshold, unit: '%', ok: rdRatio >= rdThreshold },
    { key: 'rdRatioYear', name: '研发费用占销售收入比例（最近一年）', val: rdRatioYear, need: rdThreshold, unit: '%', ok: rdRatioYear >= rdThreshold },
    { key: 'domestic',   name: '境内研发费用占比',          val: domRatio,       need: 60,        unit: '%',  ok: domRatio >= 60 },
    { key: 'hiIncome',   name: '高新技术产品(服务)收入占比', val: hiIncomeRatio,  need: 60,        unit: '%',  ok: hiIncomeRatio >= 60 },
    { key: 'innovation', name: '创新能力评价得分',          val: innovationScore, need: 71,       unit: '分', ok: innovationScore >= 71 },
  ];

  return {
    rows,
    tCost,
    // 加计扣除
    allBase5, allOtherCap, allOtherAllowed,
    entrustFull, entrustDom80, entrustFor80, overseaCap, entrustForAllowed, overseaExcess,
    antiEntrust, antiRDBase0, antiRDBase,
    specialIncome, productMaterial, grantOffset, deductAdjust,
    negativeBlocked, deductRate, deduction, taxSave25, taxSave15,
    // 资本化
    capitalAmt, capLife, capitalTaxAmort,
    // 四口径
    antiRD: antiRDBase, hiRD, accRD, statRD,
    hi20Cap, hiOtherAllowed, hiSum6, hiTotalWithEntrust,
    // 高企指标
    indicators,
    rdThreshold,
  };
}

/**
 * 校验归集数据的合规性，返回问题清单。
 * 用于「合规自检」页与提交前置检查。
 */
export function complianceCheck(input, result) {
  const issues = [];
  const company = input.company ?? {};
  const projects = input.projects ?? [];
  const daily = input.daily ?? {};
  const arr = (k) => (Array.isArray(daily[k]) ? daily[k] : []);

  // 1. 人员工时占比（非全时研发人员当期研发工时占比不得低于 50%）
  for (const p of arr('roster')) {
    const t = num(p.totalHours), rd = num(p.rdHours);
    if (!p.name) continue;
    if (p.empType === '劳务派遣') {
      issues.push({ level: 'error', area: '人员名册',
        msg: `${p.name}：劳务派遣人员原则上不得认定为研发人员` });
    } else if (t > 0 && rd > 0 && rd / t < 0.5) {
      issues.push({ level: 'error', area: '人员名册',
        msg: `${p.name}：研发工时占比 ${(rd / t * 100).toFixed(1)}%，低于 50% 不得认定` });
    } else if (!t || !rd) {
      issues.push({ level: 'warn', area: '人员名册', msg: `${p.name}：工时数据不完整` });
    }
  }

  // 2. 其他相关费用限额（加计扣除 10%）
  if (result.tCost.other > result.allOtherCap + 0.01) {
    issues.push({ level: 'warn', area: '费用归集',
      msg: `其他相关费用 ${result.tCost.other} 万元超过加计扣除限额 ${result.allOtherCap} 万元，超出部分（${result.otherExcess ?? round2(result.tCost.other - result.allOtherCap)} 万元）不得加计` });
  }
  // 3. 高企 20% 限额
  if (result.tCost.other > result.hi20Cap + 0.01) {
    issues.push({ level: 'warn', area: '费用归集',
      msg: `其他费用 ${result.tCost.other} 万元超过高企口径限额 ${result.hi20Cap} 万元` });
  }
  // 4. 负面清单行业
  if (result.negativeBlocked) {
    issues.push({ level: 'error', area: '主体资格',
      msg: '属于负面清单行业且该类收入占比超 50%，不得享受加计扣除' });
  }
  // 5. 委托境外 2/3 限额
  if (result.overseaExcess > 0.01) {
    issues.push({ level: 'warn', area: '委托研发',
      msg: `委托境外研发超限额 ${result.overseaExcess} 万元（不得超过境内符合条件研发费用的 2/3），超出部分不得加计` });
  }
  // 6. 委外研发登记与关联方
  for (const o of arr('outsource')) {
    if (o.party && o.amount > 0 && !o.techReg) {
      issues.push({ level: 'warn', area: '委外研发',
        msg: `受托单位「${o.party}」缺少科技行政主管部门登记号，未登记可能不得享受优惠` });
    }
  }
  // 7. 项目七要素完整性
  for (const p of projects) {
    if (!p.name) continue;
    const missing = [];
    if (!p.objective) missing.push('研发目标');
    if (!p.techRoute) missing.push('技术路线');
    if (!p.innovation) missing.push('创新点');
    if (!p.leader) missing.push('项目负责人');
    if (missing.length) {
      issues.push({ level: 'warn', area: '项目立项',
        msg: `项目 ${p.code || p.name} 缺少：${missing.join('、')}` });
    }
  }
  // 8. 资本化五条件
  for (const r of arr('capital')) {
    const conds = ['c1', 'c2', 'c3', 'c4', 'c5'].map((k) => r[k]);
    if (conds.some((x) => x === '待论证')) {
      issues.push({ level: 'info', area: '资本化',
        msg: `项目 ${r.projCode || '-'} 存在「待论证」的资本化条件，须逐项论述并留痕` });
    }
  }
  // 9. 人员人工费用是否由工时系统自动归集
  if (result.tCost.labor <= 0) {
    issues.push({ level: 'warn', area: '费用归集',
      msg: '尚未归集人员人工费用，请在「工时 → 人工费用」页执行自动归集' });
  }
  // 10. 企业档案完整性
  if (!company.name) {
    issues.push({ level: 'error', area: '企业档案', msg: '尚未填写企业名称' });
  }

  const counts = issues.reduce((a, i) => { a[i.level] = (a[i.level] ?? 0) + 1; return a; },
    { error: 0, warn: 0, info: 0 });
  return { issues, counts, pass: counts.error === 0 };
}

/**
 * 人员人工费用归集：把工时系统的人员薪酬按项目工时占比分摊。
 *
 * 这是「工时 → 人工费用 → 辅助账」链路的核心：
 *   员工薪酬 × 该项目研发工时 ÷ 该员工当月总工时 = 该项目应归集人工费用
 *
 * 注意：此处与工时系统的薪酬分摊保持同一口径，但单位换算为「万元」，
 * 且只归集**研发工时**部分（非研发工时不进入研发费用）。
 *
 * @param {Array} employees [{id, name, salary(元), rndHours(项目工时映射), totalHours}]
 * @param {Array} projects  [{id, code}]
 * @returns {{rows:Array, total:number}}
 */
export function allocateLaborCost(employees, projects) {
  const byProj = new Map();
  for (const p of projects) byProj.set(p.code, { code: p.code, name: p.name, amount: 0, hours: 0 });

  let total = 0;
  const rows = [];
  for (const e of employees) {
    const salary = num(e.salary);          // 元
    const totalHours = num(e.totalHours);
    const hoursMap = e.rndHours ?? {};
    let rndHours = 0;
    for (const h of Object.values(hoursMap)) rndHours += num(h);
    if (totalHours <= 0 || rndHours <= 0 || salary <= 0) {
      rows.push({ userId: e.id, name: e.name, salary, totalHours, rndHours,
        rndLaborCost: 0, detail: [], skipped: true });
      continue;
    }
    const rndLaborCost = salary * rndHours / totalHours;   // 元
    const detail = [];
    for (const [code, h] of Object.entries(hoursMap)) {
      const amt = salary * num(h) / totalHours;            // 元
      if (amt <= 0) continue;
      const rec = byProj.get(code);
      if (rec) { rec.amount += amt; rec.hours += num(h); }
      detail.push({ code, hours: num(h), amountYuan: round2(amt), amountWan: round2(amt / 10000) });
    }
    rows.push({
      userId: e.id, name: e.name, salary, totalHours, rndHours,
      rndRate: round4(rndHours / totalHours),
      rndLaborCost: round2(rndLaborCost),
      rndLaborCostWan: round2(rndLaborCost / 10000),
      detail,
    });
    total += rndLaborCost;
  }

  const projectRows = [...byProj.values()]
    .map((r) => ({ ...r, amount: round2(r.amount), amountWan: round2(r.amount / 10000) }))
    .filter((r) => r.amount > 0);

  return {
    rows,
    projectRows,
    totalYuan: round2(total),
    totalWan: round2(total / 10000),
  };
}