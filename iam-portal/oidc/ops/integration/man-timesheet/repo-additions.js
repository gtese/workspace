/**
 * 追加到 server/src/repo.js 的三个小函数（对账 + 绑定 oidc_sub）
 */
import { query } from './db.js';

/** 按 Keycloak 的 sub 找用户（已迁移过的用户走这条快路） */
export async function getUserByOidcSub(sub) {
  const { rows } = await query('SELECT * FROM users WHERE oidc_sub = $1', [sub]);
  return rows[0] ?? null;
}

/**
 * 首次登录时把 Keycloak sub 绑到本地用户。
 * 若该用户已经有别的 sub（换人/重建 IdP），保留旧值并只记日志，由人工处理——
 * 绝不静默覆盖，否则会把一个人的历史数据挂到另一个人身上。
 */
export async function bindOidcSubject(userId, sub) {
  const { rows } = await query(
    `UPDATE users SET oidc_sub = $2, auth_source = 'oidc'
      WHERE id = $1 AND (oidc_sub IS NULL OR oidc_sub = $2)
      RETURNING id, username, oidc_sub`, [userId, sub]);
  if (!rows.length) {
    const { rows: cur } = await query('SELECT username, oidc_sub FROM users WHERE id = $1', [userId]);
    throw Object.assign(new Error(`用户 ${cur[0]?.username} 已绑定到另一个 OIDC 主体`), { code: 'SUB_CONFLICT' });
  }
  return rows[0];
}
