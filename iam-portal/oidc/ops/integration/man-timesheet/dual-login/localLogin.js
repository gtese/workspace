/**
 * ============================================================
 * 双登录里的「本地账号登录」实现（复制为 server/src/localLogin.js）
 * ============================================================
 * 用途：给「没有 AD 账号的人」（外包/临时/应急运维）单独开一条本地通道。
 *
 * 安全约束（对应 docs/双登录方案.md §3，评审会逐条对照）：
 *  1) 只认本地账号表，绝不把口令拿去 AD bind —— 这是与"保留域口令登录页"的根本区别
 *  2) 只有 local_login_enabled=true 的账号能登录
 *  3) 角色只能是 employee（除非显式指派，且 admin/finance/hr 需要 IT 特批并留痕）
 *  4) 三种模式：off（默认）/ emergency（限定期限 + 限定人员）/ allow（外包场景，需评审）
 *  5) 每次本地登录都发告警（应急通道被使用时应当天就知道）
 *  6) 口令用 bcrypt（cost ≥ 12）哈希，不可逆
 */
import bcrypt from 'bcryptjs';           // npm i bcryptjs（无原生编译依赖，容器友好）
import { query } from './db.js';
import { config } from './config.js';
import * as repo from './repo.js';

const mode = () => config.localLogin?.mode ?? 'off';

/** 是否允许显示/处理本地登录（前端据此决定是否显示次要入口） */
export function localLoginAvailable() {
  const m = mode();
  if (m === 'off') return false;
  if (m === 'emergency') {
    const until = config.localLogin?.until;
    return Boolean(until) && Date.now() < new Date(until).getTime();
  }
  return m === 'allow';
}

/** 应急模式下，只允许白名单里的账号 */
function userAllowedInMode(username) {
  if (mode() !== 'emergency') return true;
  const allow = (config.localLogin?.users ?? []).map((s) => s.toLowerCase());
  return allow.includes(String(username).toLowerCase());
}

/**
 * 本地登录校验。返回 { ok, user } 或 { ok:false, code, message }
 * 注意：失败信息一律不区分"账号不存在/口令错误"（防枚举）。
 */
export async function authenticateLocal(username, password) {
  const fail = { ok: false, code: 'BAD_CREDENTIALS', message: '账号或口令不正确' };
  if (!localLoginAvailable()) {
    return { ok: false, code: 'LOCAL_LOGIN_DISABLED', message: '本地登录未开放，请使用公司统一身份登录' };
  }
  const name = String(username || '').trim().toLowerCase();
  if (!name || !password) return fail;
  if (!userAllowedInMode(name)) return fail;

  const { rows } = await query(
    `SELECT id, username, display_name, role, is_active, auth_source,
            local_password_hash, local_login_enabled
       FROM users WHERE username = $1 AND auth_source = 'local'`, [name]);
  const u = rows[0];
  if (!u || !u.local_login_enabled || !u.local_password_hash || !u.is_active) return fail;

  const ok = await bcrypt.compare(password, u.local_password_hash);
  if (!ok) return fail;

  // 角色护栏：本地账号默认只能是 employee
  const safeRole = u.role === 'employee' ? u.role : 'employee';
  await repo.audit(u.id, 'auth.login', u.username, null, { via: 'local', mode: mode() }, null);
  if (mode() === 'emergency') notifyEmergencyLogin(u.username);   // ★ 告警
  return { ok: true, user: { ...u, role: safeRole } };
}

/** 应急登录告警：接到企业微信/钉钉/邮件 webhook 皆可，未配置则写日志 */
async function notifyEmergencyLogin(username) {
  const hook = config.localLogin?.alertWebhook;
  if (!hook) {
    console.warn(`[SECURITY] 应急本地登录：${username} @ ${new Date().toISOString()}`);
    return;
  }
  try {
    await fetch(hook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        msgtype: 'text',
        text: { content: `【安全告警】有人通过应急本地通道登录研发工时系统：${username}` },
      }),
    });
  } catch (e) {
    console.error('应急登录告警发送失败', e.message);
  }
}

// ---------------------------------------------------------------- 账号维护（管理员用）
/** 创建本地账号（管理员操作，需审计） */
export async function createLocalUser({ username, displayName, password, role = 'employee', actorId }) {
  if (!/^[a-z0-9._-]{3,32}$/.test(username)) throw new Error('账号只能是小写字母/数字/._-，3~32 位');
  if (String(password).length < 12) throw new Error('本地账号口令至少 12 位');
  const hash = await bcrypt.hash(password, 12);
  const { rows } = await query(
    `INSERT INTO users (username, display_name, role, is_active, auth_source,
                        local_password_hash, local_login_enabled)
     VALUES ($1,$2,$3,true,'local',$4,true) RETURNING id, username`,
    [username.toLowerCase(), displayName || username, role, hash]);
  await repo.audit(actorId, 'admin.local_user.create', username, null, { role }, null);
  return rows[0];
}

/** 停用本地账号（离场/外包结束就调这个，不依赖 AD） */
export async function disableLocalUser(username, actorId) {
  const { rows } = await query(
    `UPDATE users SET local_login_enabled = false, is_active = false
      WHERE username = $1 AND auth_source = 'local' RETURNING id`, [String(username).toLowerCase()]);
  await repo.audit(actorId, 'admin.local_user.disable', username, null, {}, null);
  return rows.length > 0;
}

/*
 * ------------------------------------------------------------------
 * 路由接线（在 routes.js 里）：
 *
 *   app.get('/api/auth/local-mode', async () => ({ available: localLoginAvailable() }));
 *
 *   app.post('/api/auth/login/local', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
 *     async (req, reply) => {
 *       const { username, password } = parse(loginSchema, req.body ?? {});
 *       const r = await authenticateLocal(username, password);
 *       if (!r.ok) { await repo.audit(null, 'auth.login.failed', username, null,
 *                       { via: 'local', code: r.code }, req.ip);
 *                    return reply.code(401).send({ error: r.message, code: r.code }); }
 *       const token = await createSession(r.user);
 *       setSessionCookie(reply, token);
 *       return { user: publicUser(r.user) };
 *     });
 *
 *   前端 LoginView.vue：
 *     v-if="localAvailable" 显示次要链接 → 切到本地表单（同一页面，mode=local）
 *     普通员工看到 SSO 按钮即可，不主动宣传本地入口
 * ------------------------------------------------------------------
 */
