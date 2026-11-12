/**
 * 开放 API：密钥管理与统一认证。
 *
 * 支持两种认证方式（同一套权限模型）：
 *
 *   1. API Key（推荐给外部系统）
 *        Authorization: Bearer twk_xxxxxxxxxxxxxxxxxxxx
 *      —— 长期有效，可设权限范围与过期时间，管理员可随时吊销
 *
 *   2. 账号密码换 JWT（适合人工调试 / 脚本）
 *        POST /api/v1/auth/token { username, password }
 *      —— 用 AD 账号密码换取短期 token（默认 2 小时）
 *
 * 两者解析后都得到同一个 ApiIdentity：
 *   { userId, username, role, scopes, via: 'apikey'|'jwt' }
 *
 * API Key 以「归属用户」身份执行，数据可见范围与该用户在系统内一致，
 * 不会因为用 Key 调用就获得超出该用户角色的权限。
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { query, withTransaction } from './db.js';
import { config } from './config.js';
import { loadUser, ROLE_RANK } from './auth.js';

// ---------------------------------------------------------------- 权限范围
/**
 * 权限范围定义。格式：`<领域>:<操作>`，`*` 表示全部。
 * 角色权限与 scope 同时校验：scope 决定「这个 Key 能做什么」，
 * 角色决定「这个用户能做什么」，两者取交集。
 */
export const SCOPES = {
  'timesheet:read':   '读取工时明细、工时单、审批记录',
  'timesheet:write':  '填报工时、提交/撤回报工',
  'approval:read':    '读取审批单',
  'approval:write':   '审批通过/驳回',
  'project:read':     '读取项目与成员、审批人',
  'project:write':    '新建/修改/删除项目，配置成员与审批人',
  'costing:read':     '读取费用归集、公共费用、委外、台账',
  'costing:write':    '维护费用、公共费用、委外、台账',
  'summary:read':     '读取月度汇总与多口径测算',
  'summary:write':    '生成分摊/测算快照',
  'doc:read':         '读取备查资料清单与预览',
  'doc:write':        '生成备查资料',
  'asset:read':       '读取 IT 资产',
  'asset:write':      '维护 IT 资产',
  'user:read':        '读取用户列表',
  'user:write':       '修改用户档案与角色',
  'admin':            '系统管理（同步 AD、审计日志、API Key 管理）',
  '*':                '全部权限（等同于所有者角色的全部能力）',
};

export const SCOPE_KEYS = Object.keys(SCOPES);

export function hasScope(identity, scope) {
  const list = identity?.scopes ?? [];
  if (list.includes('*')) return true;
  if (list.includes(scope)) return true;
  // 领域通配：costing:* 覆盖 costing:read / costing:write
  const domain = scope.split(':')[0];
  if (list.includes(`${domain}:*`)) return true;
  return false;
}

/** 角色 → 允许的最大 scope 集合（避免 Key 越权） */
export function maxScopesForRole(role) {
  if (role === 'admin') return ['*'];
  if (role === 'hr') {
    return ['timesheet:*', 'approval:*', 'project:*', 'costing:*', 'summary:*',
      'doc:*', 'asset:*', 'user:read'];
  }
  if (role === 'finance') {
    return ['costing:*', 'summary:*', 'doc:*', 'timesheet:read', 'approval:*', 'project:*'];
  }
  if (role === 'pm') {
    return ['timesheet:*', 'approval:*', 'project:read', 'summary:read'];
  }
  return ['timesheet:*', 'approval:read'];
}

export function scopeAllowedForRole(role, scope) {
  const max = maxScopesForRole(role);
  if (max.includes('*')) return true;
  if (max.includes(scope)) return true;
  const domain = scope.split(':')[0];
  return max.includes(`${domain}:*`);
}

// ---------------------------------------------------------------- 密钥生成
const KEY_PREFIX = 'twk_';

export function hashKey(key) {
  return createHash('sha256').update(key).digest('hex');
}

export function generateKey() {
  // 32 字节随机 -> 43 字符 base64url，足够熵（256 bit）
  const raw = randomBytes(32).toString('base64url');
  return KEY_PREFIX + raw;
}

// ---------------------------------------------------------------- 密钥 CRUD
export async function createApiKey({ name, ownerId, scopes, expiresAt, rateLimitPerMin }, actorId) {
  const owner = await loadUser(ownerId);
  if (!owner) {
    const e = new Error('归属用户不存在'); e.statusCode = 422; e.code = 'OWNER_NOT_FOUND'; throw e;
  }
  // 校验 scope 不超出该用户角色允许范围
  const invalid = scopes.filter((s) => !SCOPE_KEYS.includes(s));
  if (invalid.length) {
    const e = new Error(`无效的权限范围：${invalid.join(', ')}`);
    e.statusCode = 422; e.code = 'INVALID_SCOPE'; throw e;
  }
  const overreach = scopes.filter((s) => !scopeAllowedForRole(owner.role, s));
  if (overreach.length) {
    const e = new Error(
      `归属用户（角色 ${owner.role}）无权授予以下范围：${overreach.join(', ')}`);
    e.statusCode = 422; e.code = 'SCOPE_OVERREACH'; throw e;
  }

  const key = generateKey();
  const { rows } = await query(
    `INSERT INTO api_keys (name, key_prefix, key_hash, owner_id, scopes, expires_at,
                           rate_limit_per_min, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [name, key.slice(0, 12), hashKey(key), ownerId, scopes,
     expiresAt || null, rateLimitPerMin ?? 600, actorId ?? null]);

  // 明文只在此刻返回一次
  return { ...rows[0], key };
}

export async function listApiKeys() {
  const { rows } = await query(
    `SELECT k.*, u.username AS owner_username, u.display_name AS owner_name,
            c.display_name AS created_by_name,
            to_char(k.expires_at,'YYYY-MM-DD HH24:MI') AS expires_at_fmt,
            to_char(k.created_at,'YYYY-MM-DD HH24:MI') AS created_at_fmt,
            to_char(k.last_used_at,'YYYY-MM-DD HH24:MI') AS last_used_at_fmt
       FROM api_keys k
       JOIN users u ON u.id = k.owner_id
       LEFT JOIN users c ON c.id = k.created_by
      ORDER BY k.is_active DESC, k.created_at DESC`);
  return rows;
}

export async function revokeApiKey(id, actorId) {
  const { rows } = await query(
    `UPDATE api_keys SET is_active = FALSE, revoked_at = now(), revoked_by = $2
      WHERE id = $1 AND is_active = TRUE RETURNING *`, [id, actorId ?? null]);
  if (!rows.length) {
    const e = new Error('密钥不存在或已吊销'); e.statusCode = 404; e.code = 'NOT_FOUND'; throw e;
  }
  return rows[0];
}

export async function deleteApiKey(id) {
  const { rowCount } = await query('DELETE FROM api_keys WHERE id = $1', [id]);
  if (!rowCount) {
    const e = new Error('密钥不存在'); e.statusCode = 404; e.code = 'NOT_FOUND'; throw e;
  }
  return true;
}

// ---------------------------------------------------------------- 认证
/**
 * 用 API Key 认证。返回 ApiIdentity 或 null。
 * 使用哈希查找（不比较明文），并检查启用状态与过期时间。
 */
export async function authenticateApiKey(key) {
  if (!key || !key.startsWith(KEY_PREFIX)) return null;
  const { rows } = await query(
    `SELECT k.*, u.username, u.role, u.is_active AS user_active, u.display_name
       FROM api_keys k JOIN users u ON u.id = k.owner_id
      WHERE k.key_hash = $1`, [hashKey(key)]);
  if (!rows.length) return null;
  const k = rows[0];
  if (!k.is_active) return { error: 'KEY_REVOKED' };
  if (k.expires_at && new Date(k.expires_at) < new Date()) return { error: 'KEY_EXPIRED' };
  if (!k.user_active) return { error: 'OWNER_INACTIVE' };

  // 异步更新使用统计（不阻塞请求）
  query('UPDATE api_keys SET last_used_at = now(), call_count = call_count + 1 WHERE id = $1',
    [k.id]).catch(() => {});

  return {
    via: 'apikey',
    apiKeyId: k.id,
    keyName: k.name,
    userId: k.owner_id,
    username: k.username,
    role: k.role,
    displayName: k.display_name,
    scopes: k.scopes,
    rateLimitPerMin: k.rate_limit_per_min,
  };
}

// ---------------------------------------------------------------- JWT（API 专用）
const apiSecret = new TextEncoder().encode(`${config.session.secret}:api`);

export async function issueApiToken(user, ttlMinutes = 120) {
  const token = await new SignJWT({
    sub: String(user.id),
    username: user.username,
    role: user.role,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer('tracework-api')
    .setAudience('tracework-api')
    .setExpirationTime(`${ttlMinutes}m`)
    .sign(apiSecret);
  return { token, expiresIn: ttlMinutes * 60 };
}

export async function verifyApiToken(token) {
  try {
    const { payload } = await jwtVerify(token, apiSecret, {
      issuer: 'tracework-api',
      audience: 'tracework-api',
      algorithms: ['HS256'],
    });
    return { sub: payload.sub, username: payload.username, role: payload.role };
  } catch {
    return null;
  }
}

/** 从 JWT 构造身份，scope 按角色全量授予。 */
export async function identityFromJwt(payload) {
  const user = await loadUser(Number(payload.sub));
  if (!user || !user.is_active) return null;
  return {
    via: 'jwt',
    userId: user.id,
    username: user.username,
    role: user.role,
    displayName: user.display_name,
    scopes: ['*'],          // JWT 视为用户本人，权限由其角色决定
    rateLimitPerMin: 1200,
  };
}

/**
 * 统一入口：解析 Authorization 头，返回 ApiIdentity。
 * @returns {Promise<{identity?:object, error?:string}>}
 */
export async function resolveApiIdentity(req) {
  const h = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  if (!m) return { error: 'NO_CREDENTIAL' };
  const token = m[1].trim();

  if (token.startsWith(KEY_PREFIX)) {
    const r = await authenticateApiKey(token);
    if (!r) return { error: 'INVALID_KEY' };
    if (r.error) return { error: r.error };
    return { identity: r };
  }
  const payload = await verifyApiToken(token);
  if (!payload) return { error: 'INVALID_TOKEN' };
  const identity = await identityFromJwt(payload);
  if (!identity) return { error: 'USER_INACTIVE' };
  return { identity };
}

/** 记录一次 API 调用。失败不影响业务。 */
export async function logApiRequest(identity, req, status, durationMs, errorCode) {
  try {
    await query(
      `INSERT INTO api_request_logs
         (api_key_id, key_name, user_id, method, path, status, duration_ms, ip, error_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [identity?.apiKeyId ?? null, identity?.keyName ?? null, identity?.userId ?? null,
       req.method, String(req.url).split('?')[0], status, Math.round(durationMs),
       req.ip ?? null, errorCode ?? null]);
  } catch { /* 忽略 */ }
}

export async function listApiLogs({ limit = 100, keyId } = {}) {
  const params = [];
  let where = '';
  if (keyId) { params.push(keyId); where = `WHERE l.api_key_id = $${params.length}`; }
  params.push(Math.min(limit, 1000));
  const { rows } = await query(
    `SELECT l.*, u.username, to_char(l.at,'YYYY-MM-DD HH24:MI:SS') AS at_fmt
       FROM api_request_logs l LEFT JOIN users u ON u.id = l.user_id
       ${where} ORDER BY l.at DESC LIMIT $${params.length}`, params);
  return rows;
}

/** 清理旧日志（保留最近 N 天）。 */
export async function purgeApiLogs(days = 30) {
  const { rowCount } = await query(
    "DELETE FROM api_request_logs WHERE at < now() - ($1 || ' days')::interval",
    [String(days)]);
  return rowCount;
}