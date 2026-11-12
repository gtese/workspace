/**
 * 配置加载 — 全部通过环境变量注入，便于容器化与不同环境部署。
 */
import { readFileSync } from 'node:fs';

function env(key, def) {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
}
function bool(key, def) {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}
function int(key, def) {
  const v = parseInt(process.env[key] ?? '', 10);
  return Number.isFinite(v) ? v : def;
}
function readSecret(fileEnv, inlineEnv) {
  const f = process.env[fileEnv];
  if (f) {
    try { return readFileSync(f, 'utf8').trim(); }
    catch (e) { throw new Error(`无法读取 ${fileEnv}=${f}: ${e.message}`); }
  }
  return env(inlineEnv, '');
}

export const config = {
  env: env('NODE_ENV', 'production'),
  port: int('PORT', 3000),
  host: env('HOST', '0.0.0.0'),
  trustProxy: bool('TRUST_PROXY', true),
  logLevel: env('LOG_LEVEL', 'info'),

  db: {
    host: env('PGHOST', '127.0.0.1'),
    port: int('PGPORT', 5432),
    user: env('PGUSER', 'timesheet'),
    password: readSecret('PGPASSWORD_FILE', 'PGPASSWORD'),
    database: env('PGDATABASE', 'timesheet'),
    max: int('PGPOOL_MAX', 10),
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    ssl: bool('PGSSL', false) ? { rejectUnauthorized: bool('PGSSL_VERIFY', true) } : false,
  },

  session: {
    // 用于签发会话 JWT 的对称密钥（HS256）
    secret: readSecret('SESSION_SECRET_FILE', 'SESSION_SECRET'),
    cookieName: env('SESSION_COOKIE', 'rnd_sid'),
    // 会话有效期（分钟），默认 8 小时，与一个工作日相当
    ttlMinutes: int('SESSION_TTL_MINUTES', 480),
    cookieSecure: bool('SESSION_COOKIE_SECURE', true),
  },

  ldap: {
    enabled: bool('LDAP_ENABLED', true),
    // 域控地址，多个用逗号分隔，逗号后为可选的 ldaps://
    urls: env('LDAP_URLS', 'ldap://172.16.10.111,ldap://172.16.10.112')
      .split(',').map((s) => s.trim()).filter(Boolean),
    baseDn: env('LDAP_BASE_DN', 'DC=tri,DC=local'),
    // 域服务账号：用于同步用户与组（不作为用户登录校验）
    bindDn: env('LDAP_BIND_DN', 'sa_ldap@tri.local'),
    bindPassword: readSecret('LDAP_BIND_PASSWORD_FILE', 'LDAP_BIND_PASSWORD'),
    // 用户登录时构造 bind 名的模板，{username} 会被替换为 sAMAccountName。
    // 注意：podman-compose 会破坏环境变量里的花括号，因此更推荐使用
    // LDAP_UPN_SUFFIX（如 @tri.local），模板仅作兼容保留。
    userBindTemplate: env('LDAP_USER_BIND_TEMPLATE', ''),
    upnSuffix: env('LDAP_UPN_SUFFIX', ''),
    // 仅允许这些组内的人员登录（为空则不限制）；组名不区分大小写
    allowedGroups: env('LDAP_ALLOWED_GROUPS', 'Group_AllStaffs')
      .split(',').map((s) => s.trim()).filter(Boolean),
    adminGroups: env('LDAP_ADMIN_GROUPS', 'Group_Roots,Domain Admins')
      .split(',').map((s) => s.trim()).filter(Boolean),
    // 研发支持人员组：这些组的成员默认员工类型为「研发支持」，而非「全职研发」
    supportGroups: env('LDAP_SUPPORT_GROUPS', 'Group_Support')
      .split(',').map((s) => s.trim()).filter(Boolean),
    tlsRejectUnauthorized: bool('LDAP_TLS_VERIFY', true),
    caFile: env('LDAP_CA_FILE', ''),
    connectTimeoutMs: int('LDAP_CONNECT_TIMEOUT_MS', 8000),
    timeoutMs: int('LDAP_TIMEOUT_MS', 15000),
    syncIntervalMinutes: int('LDAP_SYNC_INTERVAL_MINUTES', 60),
  },

  // ---------------------------------------------------------------- 认证模式
  // ldap：传统「域账号 + 口令」直连 AD 校验（回滚用）
  // oidc：跳转统一身份 sso.tri.local，本系统不再接触口令
  authMode: env('AUTH_MODE', 'ldap').toLowerCase(),

  oidc: {
    issuer: env('OIDC_ISSUER', 'https://sso.tri.local/realms/tri').replace(/\/$/, ''),
    clientId: env('OIDC_CLIENT_ID', 'man-timesheet'),
    clientSecret: readSecret('OIDC_CLIENT_SECRET_FILE', 'OIDC_CLIENT_SECRET'),
    // 回调地址必须与 IdP 侧登记的白名单逐字符一致
    redirectUri: env('OIDC_REDIRECT_URI', 'https://work.tri.local/api/auth/oidc/callback'),
    // groups 必须请求：准入/财务/管理员判定仍依赖 AD 组
    scope: env('OIDC_SCOPE', 'openid profile email groups'),
    postLogoutUri: env('OIDC_POST_LOGOUT_URI', 'https://work.tri.local/'),
    // 企业根 CA（容器内挂载），用于校验 sso.tri.local 的 TLS 证书
    caFile: env('OIDC_CA_FILE', '/etc/ts-certs/tri.local_ca.crt'),
    timeoutMs: int('OIDC_TIMEOUT_MS', 10000),
  },

  app: {
    // 允许访问的来源，用于同源校验
    baseUrl: env('APP_BASE_URL', 'https://work.tri.local'),
    // 生成中的默认月薪基数留空表示 0，由 HR 在界面维护
    defaultAttendanceHours: int('DEFAULT_ATTENDANCE_HOURS', 0),
    // 审批时限（工作日）
    approvalSlaWorkdays: int('APPROVAL_SLA_WORKDAYS', 2),
    // 是否允许员工自行改自己的薪酬等敏感字段（默认否）
    selfEditSalary: bool('SELF_EDIT_SALARY', false),
  },
};

/** 启动期校验，缺少关键配置时直接失败，避免带病运行。 */
export function validateConfig() {
  const problems = [];
  if (!config.session.secret || config.session.secret.length < 32) {
    problems.push('SESSION_SECRET 必须提供且长度 >= 32 字符');
  }
  if (!config.db.password) problems.push('PGPASSWORD 或 PGPASSWORD_FILE 必须提供');
  // 认证模式只允许这两种，避免拼错后静默降级
  if (!['ldap', 'oidc'].includes(config.authMode)) {
    problems.push(`AUTH_MODE 只能是 ldap 或 oidc，当前为「${config.authMode}」`);
  }

  if (config.authMode === 'oidc') {
    // OIDC 模式下必须配齐，缺任何一项直接失败，绝不降级为免登录
    if (!config.oidc.issuer) problems.push('OIDC_ISSUER 必须提供');
    if (!config.oidc.clientId) problems.push('OIDC_CLIENT_ID 必须提供');
    if (!config.oidc.clientSecret) problems.push('OIDC_CLIENT_SECRET 必须提供');
    if (!config.oidc.redirectUri) problems.push('OIDC_REDIRECT_URI 必须提供');
    if (!/^https:\/\//.test(config.oidc.redirectUri)) {
      problems.push('OIDC_REDIRECT_URI 必须是 https 地址');
    }
  }

  // LDAP 模式才需要 bind 账号（OIDC 模式下这些可以不配）
  if (config.authMode === 'ldap' && config.ldap.enabled) {
    if (!config.ldap.bindDn) problems.push('LDAP_BIND_DN 必须提供');
    if (!config.ldap.bindPassword) problems.push('LDAP_BIND_PASSWORD 必须提供');
    if (config.ldap.urls.length === 0) problems.push('LDAP_URLS 至少需要一个地址');
  }
  if (problems.length) {
    throw new Error('配置校验失败:\n  - ' + problems.join('\n  - '));
  }
}