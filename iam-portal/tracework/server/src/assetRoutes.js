/**
 * IT 资产模块路由。
 *
 * 权限：
 *   · admin / hr —— 资产管理员，可增删改、借还、批量操作、导出全部
 *   · 其他用户   —— 只能查看与自己相关的资产（自己名下 / 自己借的），可导出自己的
 */
import { currentUser, loadUser } from './auth.js';
import * as asm from './assets.js';
import * as repo from './repo.js';

function isAssetAdmin(me) {
  return ['admin', 'hr'].includes(me?.role);
}

export default async function assetRoutes(app) {
  async function auth(req, reply) {
    const cu = await currentUser(req);
    if (!cu) { reply.code(401).send({ error: '未登录或会话已过期', code: 'UNAUTHENTICATED' }); return null; }
    const me = await loadUser(cu.id);
    if (!me || !me.is_active) { reply.code(401).send({ error: '账号已停用', code: 'INACTIVE' }); return null; }
    return me;
  }

  /** 统计概览。 */
  app.get('/api/assets/stats', async (req, reply) => {
    const me = await auth(req, reply);
    if (!me) return;
    return { ...(await asm.assetStats()), canAdmin: isAssetAdmin(me) };
  });

  /** 资产列表。非管理员强制只返回自己的资产。 */
  app.get('/api/assets', async (req, reply) => {
    const me = await auth(req, reply);
    if (!me) return;
    const admin = isAssetAdmin(me);
    const opts = {
      status: req.query.status || undefined,
      deviceType: req.query.type || undefined,
      keyword: req.query.q || undefined,
    };
    if (!admin) {
      opts.holderId = me.id;                       // 员工只能看自己名下的
    } else if (req.query.holder) {
      opts.holderId = Number(req.query.holder);
    }
    if (req.query.unassigned === '1') opts.unassignedOnly = true;
    const rows = await asm.listAssets(opts);
    return { rows, canAdmin: admin };
  });

  /** 资产详情 + 借还历史。 */
  app.get('/api/assets/:id', async (req, reply) => {
    const me = await auth(req, reply);
    if (!me) return;
    const id = Number(req.params.id);
    const a = await asm.getAsset(id);
    if (!a) return reply.code(404).send({ error: '资产不存在' });
    if (!isAssetAdmin(me) && a.holder_id !== me.id) {
      return reply.code(403).send({ error: '您只能查看自己名下的资产' });
    }
    return { asset: a, assignments: await asm.listAssignments(id) };
  });

  /** 可选的资产管理员候选人（用于"使用人"下拉，返回全部在职用户）。 */
  app.get('/api/assets/holders/candidates', async (req, reply) => {
    const me = await auth(req, reply);
    if (!me) return;
    if (!isAssetAdmin(me)) return reply.code(403).send({ error: '没有权限' });
    const users = await repo.listUsers({ activeOnly: true });
    return {
      rows: users.map((u) => ({
        id: u.id, username: u.username, displayName: u.display_name,
        department: u.department, employeeNo: u.employee_no,
      })),
    };
  });

  /** 按 AD 账号模糊搜索使用人（支持输入 "liusen" 或 "刘森"）。 */
  app.get('/api/assets/users/search', async (req, reply) => {
    const me = await auth(req, reply);
    if (!me) return;
    if (!isAssetAdmin(me)) return reply.code(403).send({ error: '没有权限' });
    const q = String(req.query.q ?? '').trim();
    if (!q) return { rows: [] };
    const users = await repo.listUsers({ activeOnly: true, search: q });
    return {
      rows: users.slice(0, 20).map((u) => ({
        id: u.id, username: u.username, displayName: u.display_name, department: u.department,
      })),
    };
  });

  /** 新建资产。 */
  app.post('/api/assets', async (req, reply) => {
    const me = await auth(req, reply);
    if (!me) return;
    if (!isAssetAdmin(me)) return reply.code(403).send({ error: '仅资产管理员可新增资产' });
    const asset = await asm.createAsset(req.body ?? {}, me.id);
    const dup = await asm.checkFinanceNoDup(asset.finance_no, asset.id);
    return {
      asset,
      warnings: dup.length
        ? [`财务资产编号「${asset.finance_no}」已被 ${dup.length} 项资产使用：${dup.join('、')}`]
        : [],
    };
  });

  /** 修改资产。 */
  app.patch('/api/assets/:id', async (req, reply) => {
    const me = await auth(req, reply);
    if (!me) return;
    if (!isAssetAdmin(me)) return reply.code(403).send({ error: '仅资产管理员可修改资产' });
    const asset = await asm.updateAsset(Number(req.params.id), req.body ?? {}, me.id);
    const dup = await asm.checkFinanceNoDup(asset.finance_no, asset.id);
    return {
      asset,
      warnings: dup.length
        ? [`财务资产编号「${asset.finance_no}」已被 ${dup.length} 项资产使用：${dup.join('、')}`]
        : [],
    };
  });

  /** 删除资产。 */
  app.delete('/api/assets/:id', async (req, reply) => {
    const me = await auth(req, reply);
    if (!me) return;
    if (!isAssetAdmin(me)) return reply.code(403).send({ error: '仅资产管理员可删除资产' });
    await asm.deleteAsset(Number(req.params.id), me.id);
    return { ok: true };
  });

  /** 归还资产。 */
  app.post('/api/assets/:id/return', async (req, reply) => {
    const me = await auth(req, reply);
    if (!me) return;
    if (!isAssetAdmin(me)) return reply.code(403).send({ error: '仅资产管理员可办理归还' });
    return { asset: await asm.returnAsset(Number(req.params.id), me.id, req.body?.note ?? '') };
  });

  /** 批量改状态。 */
  app.post('/api/assets/bulk-status', async (req, reply) => {
    const me = await auth(req, reply);
    if (!me) return;
    if (!isAssetAdmin(me)) return reply.code(403).send({ error: '没有权限' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return reply.code(400).send({ error: '请至少选择一件资产' });
    return asm.bulkSetStatus(ids, String(req.body?.status ?? ''), me.id);
  });

  /** 批量删除。 */
  app.post('/api/assets/bulk-delete', async (req, reply) => {
    const me = await auth(req, reply);
    if (!me) return;
    if (!isAssetAdmin(me)) return reply.code(403).send({ error: '没有权限' });
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isFinite) : [];
    if (!ids.length) return reply.code(400).send({ error: '请至少选择一件资产' });
    return asm.bulkDeleteAssets(ids, me.id);
  });

  /** 导出 CSV。非管理员只能导出自己名下的。 */
  app.get('/api/assets/export', async (req, reply) => {
    const me = await auth(req, reply);
    if (!me) return;
    const admin = isAssetAdmin(me);
    const opts = {
      status: req.query.status || undefined,
      deviceType: req.query.type || undefined,
      keyword: req.query.q || undefined,
    };
    if (!admin) opts.holderId = me.id;
    else if (req.query.holder) opts.holderId = Number(req.query.holder);
    if (req.query.unassigned === '1') opts.unassignedOnly = true;

    const rows = await asm.listAssets(opts);
    const csv = asm.toCsv(rows);
    await repo.audit(me.id, 'asset.export', `${rows.length} 条`, null, { filters: opts }, req.ip);

    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const filename = encodeURIComponent(`IT资产清单_${stamp}.csv`);
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename*=UTF-8''${filename}`)
      .send(csv);
  });

  /** 元数据：状态/类型选项。 */
  app.get('/api/assets/meta', async (req, reply) => {
    const me = await auth(req, reply);
    if (!me) return;
    return { statuses: asm.ASSET_STATUS, deviceTypes: asm.DEVICE_TYPES, canAdmin: isAssetAdmin(me) };
  });
}