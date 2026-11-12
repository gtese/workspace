/**
 * 会话管理：登录成功后签发 HS256 JWT，写入 HttpOnly Cookie。
 * 权限来自本地 users.role（由 AD 组自动推导 + 管理员手工调整）。
 */
import { SignJWT, jwtVerify } from 'jose';
import { config } from './config.js';
import { query } from './db.js';
import { groupMatches } from './ldap.js';

const secretKey = new TextEncoder().encode(config.session.secret);

export async function createSession(user) {
  return new SignJWT({
    sub: String(user.id),
    username: user.username,
    role: user.role,
    name: user.display_name,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuedAt()
    .setIssuer('rnd-timesheet')
    .setAudience('rnd-timesheet-web')
    .setExpirationTime(`${config.session.ttlMinutes}m`)
    .sign(secretKey);
}

export async function verifySession(token) {
  try {
    const { payload } = await jwtVerify(token, secretKey, {
      issuer: 'rnd-timesheet',
      audience: 'rnd-timesheet-web',
      algorithms: ['HS256'],
    });
    return payload;
  } catch {
    return null;
  }
}

export function setSessionCookie(reply, token) {
  const maxAge = config.session.ttlMinutes * 60;
  reply.setCookie(config.session.cookieName, token, {
    path: '/',
    httpOnly: true,
    sameSite: 'lax',
    secure: config.session.cookieSecure,
    maxAge,
  });
}

export function clearSessionCookie(reply) {
  reply.setCookie(config.session.cookieName, '', {
    path: '/', httpOnly: true, sameSite: 'lax',
    secure: config.session.cookieSecure, maxAge: 0,
  });
}

/** 解析请求身份；不查库，只解 JWT，再由各接口按需查最新角色。 */
export async function currentUser(req) {
  const token = req.cookies?.[config.session.cookieName];
  if (!token) return null;
  const payload = await verifySession(token);
  if (!payload) return null;
  return {
    id: Number(payload.sub),
    username: payload.username,
    role: payload.role,
    name: payload.name,
  };
}

/** 从数据库读取最新用户档案（用于权限与业务属性判断）。 */
export async function loadUser(id) {
  const { rows } = await query(
    `SELECT id, username, display_name, email, department, title, role,
            employee_no, employee_type, manager_id, monthly_salary,
            attendance_hours, is_active, ad_groups
       FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}

// ---------- 权限判定 ----------
export const ROLE_RANK = { employee: 1, pm: 2, finance: 3, hr: 3, admin: 4 };

export function hasRole(user, ...roles) {
  return roles.includes(user?.role);
}
export function isAdmin(user) { return user?.role === 'admin'; }
export function isHr(user) { return user?.role === 'hr' || user?.role === 'admin'; }
export function isPm(user) { return ['pm', 'hr', 'finance', 'admin'].includes(user?.role); }
/** 财务岗：可维护研发费用、台账、测算与备查资料。 */
export function isFinance(user) { return ['finance', 'hr', 'admin'].includes(user?.role); }

/**
 * 由 AD 组推导角色。仅用于「新建用户时的初始角色」，
 * 之后管理员在系统内调整的角色不会被同步任务覆盖。
 */
export function deriveRole(adGroups) {
  if (groupMatches(adGroups, config.ldap.adminGroups)) return 'admin';
  return 'employee';
}

/**
 * 由 AD 组推导「研发类型」（员工类型）。
 *
 * 优先级：
 *   1. 管理员组（Group_Roots 等） → fulltime_rnd
 *   2. Group_Support 成员        → support（研发支持人员）
 *   3. 其余                      → fulltime_rnd（全职研发）
 *
 * 管理员优先的原因：linyiyao 同在 Group_Roots 与 Group_Support，
 * 若按 Support 处理会把系统管理员标成支持人员，影响研发工时分摊口径。
 */
export function deriveEmployeeType(adGroups) {
  if (groupMatches(adGroups, config.ldap.adminGroups)) return 'fulltime_rnd';
  if (config.ldap.supportGroups?.length
      && groupMatches(adGroups, config.ldap.supportGroups)) return 'support';
  return 'fulltime_rnd';
}