/**
 * 工时业务核心：合规校验、工时单状态机、薪酬分摊、勾稽。
 * 所有金额计算集中在此，保证「页面展示」与「导出财务」口径一致。
 */

/** 判定某日是否为工作日：优先查日历表覆盖，其次按周一~周五。 */
export function isWeekend(d) {
  const wd = d.getUTCDay();
  return wd === 0 || wd === 6;
}

export function toDateKey(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function parseDateKey(s) {
  const [y, m, d] = String(s).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

/** 列出某月全部日期（UTC 基准）。 */
export function monthDays(period) {
  const [y, m] = period.split('-').map(Number);
  const out = [];
  const d = new Date(Date.UTC(y, m - 1, 1));
  while (d.getUTCMonth() === m - 1) {
    out.push(toDateKey(d));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/**
 * 计算某月的工作日。
 * @param {string} period 'YYYY-MM'
 * @param {Map<string,boolean>} calendar day -> is_workday 覆盖表
 */
export function workdaysOfMonth(period, calendar = new Map()) {
  const out = [];
  for (const key of monthDays(period)) {
    if (calendar.has(key)) {
      if (calendar.get(key)) out.push(key);
    } else if (!isWeekend(parseDateKey(key))) {
      out.push(key);
    }
  }
  return out;
}

/** 从指定日期向后推 n 个工作日（用于审批时限）。 */
export function addWorkdays(fromDate, n, calendar = new Map()) {
  const d = new Date(fromDate.getTime());
  let left = n;
  let guard = 0;
  while (left > 0 && guard++ < 400) {
    d.setUTCDate(d.getUTCDate() + 1);
    const key = toDateKey(d);
    const isWork = calendar.has(key) ? calendar.get(key) : !isWeekend(d);
    if (isWork) left--;
  }
  return d;
}

/**
 * 校验单日填报是否合规。
 * @returns {{ok:boolean, errors:string[], warnings:string[]}}
 */
export function validateEntryDay({ dateKey, entries, attendanceHours, isWorkday, allowNonWorkday = false }) {
  const errors = [];
  const warnings = [];
  const total = entries.reduce((s, e) => s + Number(e.hours || 0), 0);

  for (const e of entries) {
    const h = Number(e.hours || 0);
    if (!(h > 0)) errors.push(`${dateKey} 的工时必须大于 0`);
    if (h > 24) errors.push(`${dateKey} 单条工时不得超过 24 小时`);
    if (Math.abs(h * 2 - Math.round(h * 2)) > 1e-9) {
      errors.push(`${dateKey} 的工时必须以 0.5 小时为单位（当前 ${h}）`);
    }
  }

  if (!isWorkday && total > 0 && !allowNonWorkday) {
    warnings.push(`${dateKey} 是休息日/节假日，请确认加班填报是否符合规定`);
  }

  if (attendanceHours != null && attendanceHours > 0 && total > attendanceHours + 1e-9) {
    errors.push(`${dateKey} 各项目合计 ${fmt(total)}h 超过当日考勤工时 ${fmt(attendanceHours)}h`);
  }
  return { ok: errors.length === 0, errors, warnings, total };
}

export function fmt(n) {
  return Number(Number(n).toFixed(2)).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * 核心分摊计算。
 *
 * 口径（与《研发项目工时分配管理办法》一致）：
 *   1. 每位员工当月薪酬按「各项目工时 ÷ 该员工当月总工时」分摊到项目；
 *   2. 非研发工时（如培训）对应薪酬不计入研发费用，单独列示；
 *   3. 某项目当月分摊薪酬 = Σ_员工 (员工薪酬 × 该项目工时 ÷ 员工当月总工时)。
 *      注意：这等价于按人加权，而非简单的「全公司总工时占比」，更符合实际归集口径。
 *
 * @param {Array} employees [{id, name, employeeNo, salary, rndTotal, nonRndTotal, attendance}]
 * @param {Map<number, Map<number, number>>} hoursByEmpProj empId -> projectId -> hours
 * @param {Array} projects   [{id, code, name}]
 */
export function computeAllocation(employees, hoursByEmpProj, projects) {
  const projAgg = new Map();
  for (const p of projects) {
    projAgg.set(p.id, { id: p.id, code: p.code, name: p.name, hours: 0, headCount: 0, alloc: 0 });
  }

  let totalHours = 0;
  let totalRndSalary = 0;
  let totalNonRndSalary = 0;
  let salaryTotal = 0;
  const empRows = [];

  for (const emp of employees) {
    const hours = hoursByEmpProj.get(emp.id) ?? new Map();
    let empRnd = 0;
    for (const h of hours.values()) empRnd += Number(h);
    const nonRnd = Number(emp.nonRndTotal ?? 0);
    const empTotalHours = empRnd + nonRnd;
    const salary = Number(emp.salary ?? 0);
    salaryTotal += salary;

    // 非研发薪酬 = 薪酬 × 非研发工时 ÷ 当月总工时
    const nonRndSalary = empTotalHours > 0 ? round2(salary * nonRnd / empTotalHours) : 0;
    const rndSalary = round2(salary - nonRndSalary);

    totalNonRndSalary += nonRndSalary;
    totalHours += empRnd;

    // 研发薪酬按各项目研发工时占比分摊
    for (const [pid, h] of hours.entries()) {
      const agg = projAgg.get(pid);
      if (!agg) continue;
      agg.hours += Number(h);
    }
    for (const [pid, h] of hours.entries()) {
      const agg = projAgg.get(pid);
      if (!agg) continue;
      if (empRnd > 0) agg.alloc += salary * (Number(h) / empTotalHours);
    }
    // 统计参与人数（在该项目有工时的员工数）
    for (const pid of hours.keys()) {
      const agg = projAgg.get(pid);
      if (agg) agg.headCount += 1;
    }

    totalRndSalary += rndSalary;

    // 员工考勤核对
    const attendance = Number(emp.attendance ?? 0);
    const diff = empTotalHours - attendance;
    empRows.push({
      id: emp.id,
      employeeNo: emp.employeeNo,
      name: emp.name,
      employeeType: emp.employeeType,
      rndHours: round2(empRnd),
      nonRndHours: round2(nonRnd),
      totalHours: round2(empTotalHours),
      attendanceHours: round2(attendance),
      diff: round2(diff),
      abnormal: attendance > 0 && Math.abs(diff) > 0.01,
      salary: round2(salary),
      nonRndSalary,
      rndSalary,
      projectCount: hours.size,
    });
  }

  const projRows = [];
  for (const p of projects) {
    const agg = projAgg.get(p.id);
    projRows.push({
      id: agg.id,
      code: agg.code,
      name: agg.name,
      headCount: agg.headCount,
      hours: round2(agg.hours),
      alloc: round2(agg.alloc),
      ratio: totalHours > 0 ? agg.hours / totalHours : 0,
    });
  }

  const allocTotal = round2(projRows.reduce((s, r) => s + r.alloc, 0));
  const tieDiff = round2(allocTotal + totalNonRndSalary - salaryTotal);

  return {
    projRows,
    empRows,
    totalHours: round2(totalHours),
    salaryTotal: round2(salaryTotal),
    allocTotal,
    nonRndSalaryTotal: round2(totalNonRndSalary),
    rndSalaryTotal: round2(totalRndSalary),
    // 允许 0.01 元级别的四舍五入差异
    tieOk: Math.abs(tieDiff) <= 0.05,
    tieDiff,
  };
}

/** 把扁平的行数据组装成 empId -> Map(projectId -> hours)。 */
export function buildHoursMap(rows) {
  const m = new Map();
  for (const r of rows) {
    if (!m.has(r.user_id)) m.set(r.user_id, new Map());
    const inner = m.get(r.user_id);
    inner.set(r.project_id, (inner.get(r.project_id) ?? 0) + Number(r.hours));
  }
  return m;
}

export const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
export function assertPeriod(p) {
  if (!PERIOD_RE.test(String(p ?? ''))) {
    const e = new Error('月份格式应为 YYYY-MM');
    e.statusCode = 400;
    e.code = 'BAD_PERIOD';
    throw e;
  }
  return p;
}
export function currentPeriod(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}