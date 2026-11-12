/**
 * 资产折旧与工时折算。
 *
 * 计算口径（按业务确认）：
 *
 *   项目设备每月折旧额 = 设备月度折旧金额 × 月度研发工时 ÷ 月度总工时
 *
 * 其中：
 *   · 设备月度折旧金额 = 资产金额 ÷ 折旧年限（月）
 *   · 月度研发工时     = 该员工当月研发工时（审批确认后）
 *   · 月度总工时       = 该员工当月考勤工时；无考勤时用工时单合计
 *
 * 资产按「使用人」归属：员工名下的资产，按其研发工时占比分摊折旧。
 */
import { query } from './db.js';

/**
 * 单件资产的月折旧额（元）。
 * @param {number} amount   资产金额（元）
 * @param {number} months   折旧年限（月）
 */
export function monthlyDepreciation(amount, months) {
  const a = Number(amount) || 0;
  const m = Number(months) || 36;
  if (m <= 0 || a <= 0) return 0;
  return a / m;
}

/**
 * 查询某员工名下资产及折旧明细。
 * @returns {{assets: Array, valueTotal: number, depMonthly: number}}
 */
export async function employeeAssets(userId) {
  const { rows } = await query(
    `SELECT id, asset_no, device_type, brand, model, sn,
            COALESCE(amount, 0)::float8 AS amount,
            COALESCE(depreciation_months, 36) AS depreciation_months,
            status, to_char(purchase_date,'YYYY-MM-DD') AS purchase_date,
            to_char(assign_date,'YYYY-MM-DD') AS assign_date
       FROM assets
      WHERE holder_id = $1
      ORDER BY device_type, asset_no`, [userId]);

  const assets = rows.map((r) => {
    const dep = monthlyDepreciation(r.amount, r.depreciation_months);
    return {
      ...r,
      monthlyDep: Math.round(dep * 100) / 100,
    };
  });

  const valueTotal = assets.reduce((n, a) => n + Number(a.amount), 0);
  const depMonthly = assets.reduce((n, a) => n + a.monthlyDep, 0);

  return {
    assets,
    valueTotal: Math.round(valueTotal * 100) / 100,
    depMonthly: Math.round(depMonthly * 100) / 100,
    count: assets.length,
  };
}

/**
 * 计算某员工某月的资产折旧折算。
 *
 * @param {object} p
 * @param {number} p.userId
 * @param {number} p.rndHours        月度研发工时
 * @param {number} p.totalHours      月度总工时（考勤或工时单合计）
 * @returns 投影结果（不写库）
 */
export async function computeAssetAllocation({ userId, rndHours, totalHours }) {
  const own = await employeeAssets(userId);
  const rnd = Number(rndHours) || 0;
  const total = Number(totalHours) || 0;

  // 研发工时占比；总工时为 0 时不做分摊
  const ratio = total > 0 ? Math.min(1, rnd / total) : 0;

  // 逐件资产分摊
  const detail = own.assets.map((a) => {
    const alloc = Math.round(a.monthlyDep * ratio * 100) / 100;
    return {
      assetNo: a.asset_no,
      deviceType: a.device_type,
      brand: a.brand,
      model: a.model,
      amount: a.amount,
      depreciationMonths: a.depreciation_months,
      monthlyDep: a.monthlyDep,
      allocated: alloc,
    };
  });

  const depTotal = own.depMonthly;
  const allocTotal = Math.round(depTotal * ratio * 100) / 100;

  return {
    count: own.count,
    valueTotal: own.valueTotal,      // 名下资产总价值（元）
    depMonthly: depTotal,            // 月折旧合计（元）
    rndHours: Math.round(rnd * 100) / 100,
    totalHours: Math.round(total * 100) / 100,
    ratio: Math.round(ratio * 10000) / 10000,   // 研发工时占比
    allocYuan: allocTotal,           // 当月摊入研发的折旧（元）
    allocWan: Math.round(allocTotal / 10000 * 10000) / 10000,  // 万元
    detail,
  };
}

/**
 * 公司全部资产汇总（供财务总览）。
 */
export async function companyAssetSummary() {
  const { rows } = await query(`
    SELECT count(*)::int AS total,
           COALESCE(sum(amount), 0)::float8 AS value_total,
           COALESCE(sum(amount / NULLIF(depreciation_months, 0)), 0)::float8 AS dep_monthly
      FROM assets
     WHERE status <> '报废'`);
  const r = rows[0] ?? { total: 0, value_total: 0, dep_monthly: 0 };
  return {
    count: r.total,
    valueTotal: Math.round(r.value_total * 100) / 100,
    depMonthly: Math.round(r.dep_monthly * 100) / 100,
    depYearly: Math.round(r.dep_monthly * 12 * 100) / 100,
  };
}