/**
 * IT 资产管理的业务逻辑。
 */
import { query, withTransaction } from './db.js';
import { audit } from './repo.js';

export const ASSET_STATUS = ['在用', '在库', '外借', '维修', '报废', '调拨'];
export const DEVICE_TYPES = ['笔记本', '台式机', '服务器', '存储', '交换机', '路由器',
  '防火墙', '打印机', '显示器', '配件', '其他'];

export const ASSET_EXPORT_COLUMNS = [
  { k: 'asset_no', t: '资产IT编号' },
  { k: 'finance_no', t: '财务资产编号' },
  { k: 'device_type', t: '设备类型' },
  { k: 'brand', t: '品牌' },
  { k: 'model', t: '型号' },
  { k: 'sn', t: '序列号(SN)' },
  { k: 'holder_name', t: '使用保管人' },
  { k: 'holder_account', t: 'AD账号' },
  { k: 'borrower_external', t: '外部借用方' },
  { k: 'status', t: '领用状态' },
  { k: 'assign_date', t: '领用日期' },
  { k: 'location', t: '存放位置' },
  { k: 'supplier', t: '供应商名称' },
  { k: 'purchase_date', t: '购买日期' },
  { k: 'amount', t: '资产金额(元)' },
  { k: 'depreciation_months', t: '折旧年限(月)' },
  { k: 'note', t: '备注' },
  { k: 'updated_at', t: '最后更新时间' },
];

// ---------------------------------------------------------------- 查询
export async function listAssets({ status, deviceType, holderId, keyword, unassignedOnly } = {}) {
  const where = [];
  const params = [];
  if (status) { params.push(status); where.push(`a.status = $${params.length}`); }
  if (deviceType) { params.push(deviceType); where.push(`a.device_type = $${params.length}`); }
  if (holderId) { params.push(holderId); where.push(`a.holder_id = $${params.length}`); }
  if (unassignedOnly) where.push('a.holder_id IS NULL AND a.borrower_external IS NULL');
  if (keyword) {
    params.push(`%${keyword}%`);
    where.push(`(a.asset_no ILIKE $${params.length} OR a.sn ILIKE $${params.length}
      OR a.finance_no ILIKE $${params.length} OR a.model ILIKE $${params.length}
      OR u.display_name ILIKE $${params.length} OR a.borrower_external ILIKE $${params.length})`);
  }
  const { rows } = await query(
    `SELECT a.*,
            u.username AS holder_account, u.display_name AS holder_name, u.department AS holder_dept,
            to_char(a.purchase_date,'YYYY-MM-DD') AS purchase_date,
            to_char(a.assign_date,'YYYY-MM-DD') AS assign_date,
            to_char(a.updated_at,'YYYY-MM-DD HH24:MI') AS updated_at
       FROM assets a
       LEFT JOIN users u ON u.id = a.holder_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY a.device_type, a.asset_no`, params);
  return rows;
}

export async function getAsset(id) {
  const { rows } = await query(
    `SELECT a.*, u.username AS holder_account, u.display_name AS holder_name,
            to_char(a.purchase_date,'YYYY-MM-DD') AS purchase_date,
            to_char(a.assign_date,'YYYY-MM-DD') AS assign_date
       FROM assets a LEFT JOIN users u ON u.id = a.holder_id
      WHERE a.id = $1`, [id]);
  return rows[0] ?? null;
}

/** 某员工名下的资产（普通员工只能看自己的）。 */
export async function assetsOfUser(userId) {
  return listAssets({ holderId: userId });
}

/** 借还历史。 */
export async function listAssignments(assetId) {
  const where = [];
  const params = [];
  if (assetId) { params.push(assetId); where.push('aa.asset_id = $1'); }
  const { rows } = await query(
    `SELECT aa.*, a.asset_no,
            u.username AS holder_account, u.display_name AS holder_name,
            op.display_name AS operator_name,
            to_char(aa.assigned_at,'YYYY-MM-DD HH24:MI') AS assigned_at_fmt,
            to_char(aa.returned_at,'YYYY-MM-DD HH24:MI') AS returned_at_fmt
       FROM asset_assignments aa
       JOIN assets a ON a.id = aa.asset_id
       LEFT JOIN users u ON u.id = aa.holder_id
       LEFT JOIN users op ON op.id = aa.operator_id
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY aa.assigned_at DESC`, params);
  return rows;
}

/** 统计概览。 */
export async function assetStats() {
  const { rows } = await query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE status='在用')::int AS in_use,
      count(*) FILTER (WHERE status='在库')::int AS in_stock,
      count(*) FILTER (WHERE status='外借')::int AS lent,
      count(*) FILTER (WHERE status='维修')::int AS repairing,
      count(*) FILTER (WHERE status='报废')::int AS scrapped,
      count(*) FILTER (WHERE holder_id IS NULL AND borrower_external IS NULL)::int AS unassigned,
      count(DISTINCT device_type)::int AS type_count
    FROM assets;
  `);
  const byType = await query(`
    SELECT device_type AS type, count(*)::int AS n
      FROM assets GROUP BY device_type ORDER BY n DESC`);
  return { ...rows[0], byType: byType.rows };
}

// ---------------------------------------------------------------- 写入
function bad(msg, code = 'BAD_REQUEST', status = 400) {
  const e = new Error(msg); e.code = code; e.statusCode = status; return e;
}

/**
 * 解析使用人：优先 AD 账号（holder_account），其次 user_id，
 * 二者都为空且提供 external 时走外部借用。
 */
async function resolveHolder(data) {
  if (data.holder_account) {
    const { rows } = await query(
      'SELECT id, username, display_name FROM users WHERE username = $1',
      [String(data.holder_account).toLowerCase()]);
    if (!rows.length) throw bad(`AD 账号「${data.holder_account}」在系统中不存在`, 'HOLDER_NOT_FOUND', 422);
    return { holderId: rows[0].id, external: null };
  }
  if (data.holder_id) {
    const { rows } = await query('SELECT id FROM users WHERE id = $1', [data.holder_id]);
    if (!rows.length) throw bad('指定的使用人不存在', 'HOLDER_NOT_FOUND', 422);
    return { holderId: rows[0].id, external: null };
  }
  if (data.borrower_external) {
    return { holderId: null, external: String(data.borrower_external).trim() };
  }
  return { holderId: null, external: null };
}

/** 根据使用人推导状态：有 AD 使用人 -> 在用；有外部借用 -> 外借；否则 在库。 */
function deriveStatus(holderId, external, current) {
  if (current && ['维修', '报废', '调拨'].includes(current)) return current;
  if (holderId) return '在用';
  if (external) return '外借';
  return '在库';
}

/**
 * 检查财务资产编号是否已被其他资产占用。
 * 注意：历史数据中存在多台设备共用一个财务编号的情况（如 3 台交换机共用一个采购单号），
 * 因此这里只做**提示**，不作为硬性约束阻断录入。
 */
export async function checkFinanceNoDup(financeNo, excludeId = null) {
  if (!financeNo) return [];
  const { rows } = await query(
    `SELECT asset_no FROM assets
      WHERE finance_no = $1 AND ($2::bigint IS NULL OR id <> $2::bigint)
      ORDER BY asset_no`, [financeNo, excludeId]);
  return rows.map((r) => r.asset_no);
}

export async function createAsset(data, actorId) {
  if (!String(data.asset_no ?? '').trim()) throw bad('资产编号必填', 'VALIDATION', 422);
  const h = await resolveHolder(data);
  const status = deriveStatus(h.holderId, h.external, data.status);

  return withTransaction(async (c) => {
    const { rows } = await c.query(
      `INSERT INTO assets (asset_no, finance_no, device_type, brand, model, sn, location, supplier,
                           purchase_date, note, status, holder_id, assign_date, borrower_external,
                           created_by, amount, depreciation_months)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
       RETURNING *`,
      [String(data.asset_no).trim(), data.finance_no || null,
       data.device_type || '其他', data.brand || '', data.model || '',
       data.sn ? String(data.sn).trim() : null, data.location || '',
       data.supplier || '', data.purchase_date || null, data.note ?? '',
       status, h.holderId, data.assign_date || null, h.external, actorId ?? null,
       data.amount === '' || data.amount === undefined ? 10000 : Number(data.amount),
       data.depreciation_months === '' || data.depreciation_months === undefined
         ? 36 : Number(data.depreciation_months)]);
    const asset = rows[0];
    // 建初始领用记录
    if (h.holderId || h.external) {
      await c.query(
        `INSERT INTO asset_assignments (asset_id, holder_id, holder_external, assigned_at, operator_id, note)
         VALUES ($1,$2,$3, COALESCE($4::date::timestamptz, now()), $5, '初始领用')`,
        [asset.id, h.holderId, h.external, data.assign_date || null, actorId ?? null]);
    }
    await audit(actorId, 'asset.create', asset.asset_no, null,
      { device_type: asset.device_type, holder: h.holderId ?? h.external });
    return asset;
  });
}

export async function updateAsset(id, data, actorId) {
  const existing = await getAsset(id);
  if (!existing) throw bad('资产不存在', 'NOT_FOUND', 404);

  const sets = [];
  const params = [];
  const simple = ['asset_no', 'finance_no', 'device_type', 'brand', 'model', 'sn',
    'location', 'supplier', 'purchase_date', 'note', 'assign_date', 'amount',
    'depreciation_months'];
  // 这些列在数据库里是 NOT NULL，空值必须写空串而非 null，
  // 否则前端传 null 时会触发 23502（清除领用人后保存报错即由此引起）
  const TEXT_COLS = new Set(['device_type', 'brand', 'model', 'location', 'supplier', 'note']);
  for (const k of simple) {
    if (k in data) {
      let v = data[k];
      if (TEXT_COLS.has(k)) {
        v = v === null || v === undefined ? '' : String(v);
      } else {
        v = v === '' || v === undefined ? null : v;
      }
      params.push(v);
      sets.push(`${k} = $${params.length}`);
    }
  }

  // 使用人变更：需要处理借还流转
  let holderChanged = false;
  let newHolderId = existing.holder_id;
  let newExternal = existing.borrower_external;

  if ('holder_account' in data || 'holder_id' in data || 'borrower_external' in data) {
    const h = await resolveHolder(data);
    holderChanged = (h.holderId !== existing.holder_id) || ((h.external ?? null) !== (existing.borrower_external ?? null));
    newHolderId = h.holderId;
    newExternal = h.external;
    params.push(h.holderId); sets.push(`holder_id = $${params.length}`);
    params.push(h.external); sets.push(`borrower_external = $${params.length}`);
  }

  // 状态：显式传入优先；否则按使用人推导
  if ('status' in data) {
    params.push(data.status); sets.push(`status = $${params.length}`);
  } else if (holderChanged) {
    params.push(deriveStatus(newHolderId, newExternal, null));
    sets.push(`status = $${params.length}`);
  }

  if (!sets.length) return existing;
  params.push(id);

  return withTransaction(async (c) => {
    const { rows } = await c.query(
      `UPDATE assets SET ${sets.join(', ')} WHERE id = $${params.length} RETURNING *`, params);
    const updated = rows[0];

    if (holderChanged) {
      // 关闭旧的未归还记录
      await c.query(
        `UPDATE asset_assignments SET returned_at = now()
          WHERE asset_id = $1 AND returned_at IS NULL`, [id]);
      // 新建领用记录
      if (newHolderId || newExternal) {
        await c.query(
          `INSERT INTO asset_assignments (asset_id, holder_id, holder_external, operator_id, note)
           VALUES ($1,$2,$3,$4,'变更使用人')`,
          [id, newHolderId, newExternal, actorId ?? null]);
      }
    }
    await audit(actorId, 'asset.update', updated.asset_no, null,
      { fields: Object.keys(data), holderChanged });
    return updated;
  });
}

export async function deleteAsset(id, actorId) {
  const existing = await getAsset(id);
  if (!existing) throw bad('资产不存在', 'NOT_FOUND', 404);
  await query('DELETE FROM assets WHERE id = $1', [id]);
  await audit(actorId, 'asset.delete', existing.asset_no, null, {});
  return true;
}

/** 借出：给资产指定使用人（AD 账号或外部人员）。 */
export async function assignAsset(id, data, actorId) {
  return updateAsset(id, data, actorId);
}

/** 归还：清空使用人，状态置为在库。 */
export async function returnAsset(id, actorId, note = '') {
  const existing = await getAsset(id);
  if (!existing) throw bad('资产不存在', 'NOT_FOUND', 404);
  if (!existing.holder_id && !existing.borrower_external) {
    throw bad('该资产当前没有使用人，无需归还', 'NOT_ASSIGNED', 409);
  }
  return withTransaction(async (c) => {
    const { rows } = await c.query(
      `UPDATE assets SET holder_id = NULL, borrower_external = NULL,
              status = CASE WHEN status IN ('维修','报废','调拨') THEN status ELSE '在库' END
        WHERE id = $1 RETURNING *`, [id]);
    await c.query(
      `UPDATE asset_assignments SET returned_at = now(), note = CASE WHEN $2 <> '' THEN $2 ELSE note END
        WHERE asset_id = $1 AND returned_at IS NULL`, [id, note || '']);
    await audit(actorId, 'asset.return', existing.asset_no, null, { note });
    return rows[0];
  });
}

/** 批量状态变更（维修/报废等）。 */
export async function bulkSetStatus(ids, status, actorId) {
  if (!ASSET_STATUS.includes(status)) throw bad('状态值不合法', 'VALIDATION', 422);
  if (!ids.length) throw bad('请至少选择一件资产', 'VALIDATION', 422);
  const { rowCount } = await query(
    'UPDATE assets SET status = $2 WHERE id = ANY($1::bigint[])', [ids, status]);
  await audit(actorId, 'asset.bulk_status', ids.join(','), null, { status, count: rowCount });
  return { updated: rowCount };
}

export async function bulkDeleteAssets(ids, actorId) {
  if (!ids.length) throw bad('请至少选择一件资产', 'VALIDATION', 422);
  const { rowCount } = await query(
    'DELETE FROM assets WHERE id = ANY($1::bigint[])', [ids]);
  await audit(actorId, 'asset.bulk_delete', ids.join(','), null, { count: rowCount });
  return { deleted: rowCount };
}

// ---------------------------------------------------------------- 导出
function csvCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(rows) {
  const header = ASSET_EXPORT_COLUMNS.map((c) => csvCell(c.t)).join(',');
  const body = rows.map((r) =>
    ASSET_EXPORT_COLUMNS.map((c) => csvCell(r[c.k])).join(','));
  // 加 UTF-8 BOM，保证 Excel 打开中文不乱码
  return '\uFEFF' + [header, ...body].join('\r\n') + '\r\n';
}