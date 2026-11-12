/**
 * LDAP / Active Directory 集成。
 *
 * 两种连接模式：
 *  1. 服务账号连接（bindDn）—— 用于同步用户目录、读取组、按 sAMAccountName 查找 DN。
 *  2. 用户凭据连接 —— 登录时用「该用户自己的账号密码」向域控发起 bind，
 *     只有域控返回成功才算认证通过。系统不保存、不缓存任何用户密码。
 *
 * 连接地址按顺序做故障转移：优先尝试上一个成功的地址，失败后轮询其余地址。
 */
import { Client } from 'ldapts';
import { readFileSync } from 'node:fs';
import { config } from './config.js';

let preferredUrlIndex = 0;

function tlsOptions() {
  const opts = { rejectUnauthorized: config.ldap.tlsRejectUnauthorized };
  if (config.ldap.caFile) {
    try { opts.ca = [readFileSync(config.ldap.caFile, 'utf8')]; }
    catch (e) { throw new Error(`无法读取 LDAP_CA_FILE: ${e.message}`); }
  }
  return opts;
}

function orderedUrls() {
  const urls = config.ldap.urls;
  if (urls.length <= 1) return urls;
  return [...urls.slice(preferredUrlIndex), ...urls.slice(0, preferredUrlIndex)];
}

/** 用给定凭据新建一个 LDAP 客户端并完成 bind，失败时自动切换下一个域控。 */
async function connect({ dn, password }) {
  const urls = orderedUrls();
  let lastErr;
  for (let i = 0; i < urls.length; i++) {
    const url = urls[i];
    const client = new Client({
      url,
      timeout: config.ldap.timeoutMs,
      connectTimeout: config.ldap.connectTimeoutMs,
      tlsOptions: url.startsWith('ldaps://') ? tlsOptions() : undefined,
    });
    try {
      await client.bind(dn, password);
      // 记录可用地址，下次优先使用
      preferredUrlIndex = config.ldap.urls.indexOf(url);
      return client;
    } catch (err) {
      lastErr = err;
      try { await client.unbind(); } catch { /* 忽略 */ }
      // 凭据错误是确定性失败，无需换域控重试
      if (isInvalidCredential(err)) throw err;
    }
  }
  throw lastErr ?? new Error('无可用 LDAP 服务器');
}

/** AD 对密码错误的返回码：49 (invalidCredentials)。 */
export function isInvalidCredential(err) {
  if (!err) return false;
  if (Number(err.code) === 49) return true;
  return err.name === 'InvalidCredentialsError';
}

/**
 * 把 AD 的 bind 失败归类成用户可读的提示。
 *
 * AD 在 invalidCredentials(49) 的 errorMessage 里用 "data XXXX" 进一步说明原因，
 * 例如 data 52e = 用户名或密码错误，data 532 = 密码过期，data 775 = 账号锁定。
 * 注意：绝不能在整个 message 上做宽泛的子串匹配 —— AD 消息里包含
 * "DSID-0C090530" 这类诊断地址，其中恰好含有 530/532 等数字，会造成误判。
 */
export function classifyLdapError(err) {
  const msg = String(err?.message ?? '');

  if (isInvalidCredential(err)) {
    // 只从 "data 52e"/"data 775" 这类明确的字段里取原因码
    const m = /data\s+([0-9a-fA-F]{3,4})/i.exec(msg);
    const data = m ? m[1].toLowerCase() : '';
    switch (data) {
      case '525': return { code: 'NO_SUCH_USER', message: '用户名或密码错误' };
      case '52e': return { code: 'BAD_CREDENTIALS', message: '用户名或密码错误' };
      case '530': return { code: 'LOGON_TIME', message: '当前时段不允许登录，请联系 IT' };
      case '531': return { code: 'WORKSTATION', message: '不允许从该工作站登录，请联系 IT' };
      case '532': return { code: 'PASSWORD_EXPIRED', message: '密码已过期，请先修改密码后再登录' };
      case '533': return { code: 'ACCOUNT_DISABLED', message: '账号已禁用，请联系 IT' };
      case '701': return { code: 'ACCOUNT_EXPIRED', message: '账号已过期，请联系 IT' };
      case '773': return { code: 'PASSWORD_MUST_CHANGE', message: '需先修改密码后才能登录' };
      case '775': return { code: 'ACCOUNT_LOCKED', message: '账号已被锁定，请联系 IT 解锁' };
      default:    return { code: 'BAD_CREDENTIALS', message: '用户名或密码错误' };
    }
  }

  if (err?.name === 'ConnectionError' || Number(err?.code) === 1 && /bind must be completed/i.test(msg)) {
    return { code: 'LDAP_UNREACHABLE', message: '无法连接域控服务，请稍后重试或联系 IT' };
  }
  if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|connectTimeout|ConnectionError|socket hang up|EHOSTUNREACH/i.test(msg)) {
    return { code: 'LDAP_UNREACHABLE', message: '无法连接域控服务，请稍后重试或联系 IT' };
  }
  return { code: 'LDAP_ERROR', message: '认证服务异常，请联系 IT' };
}

const USER_ATTRS = [
  'sAMAccountName', 'cn', 'displayName', 'mail', 'department', 'title',
  'distinguishedName', 'memberOf', 'userAccountControl', 'employeeID',
  'physicalDeliveryOfficeName', 'manager', 'whenChanged',
];

/**
 * 构造用户 bind 用的域后缀（UPN suffix）。
 *
 * 不用「模板字符串」而用后缀，是为了绕开 podman-compose 对花括号的解析 bug：
 * 形如 {username}@tri.local 的环境变量经 compose 传递后会变成 {@tri.local} 之类的脏数据。
 * 这里优先使用 LDAP_UPN_SUFFIX，其次从 LDAP_BIND_DN 推导，最后从 BASE_DN 推导。
 */
export function upnSuffix() {
  const explicit = config.ldap.upnSuffix;
  if (explicit) return explicit.startsWith('@') ? explicit : '@' + explicit;

  // sa_ldap@tri.local -> @tri.local
  const bindDn = String(config.ldap.bindDn ?? '');
  const at = bindDn.lastIndexOf('@');
  if (at > 0) return bindDn.slice(at);

  // DC=tri,DC=local -> @tri.local
  const dcs = [...String(config.ldap.baseDn).matchAll(/DC=([^,]+)/gi)].map((m) => m[1]);
  if (dcs.length) return '@' + dcs.join('.');

  return '';
}

/**
 * 把用户名规范成 bind 用的 UPN。同时兼容历史遗留的模板配置：
 * 若 LDAP_USER_BIND_TEMPLATE 存在且包含一个干净的 {username}，仍然尊重它。
 */
export function buildUserUpn(username) {
  const tpl = String(config.ldap.userBindTemplate ?? '');
  const clean = tpl.replace(/\{username\}/gi, '\u0000');
  // 只接受「恰好一处占位符、且不含多余花括号」的模板
  if (clean.includes('\u0000') && !/[{}]/.test(clean)) {
    return clean.replace('\u0000', username);
  }
  return username + upnSuffix();
}

/**
 * 校验用户凭据。成功返回该用户在 AD 中的属性快照；失败抛出可分类的错误。
 */
export async function authenticateUser(username, password) {
  if (!username || !password) {
    const e = new Error('用户名与密码不能为空');
    e.code = 'EMPTY_CREDENTIALS';
    throw e;
  }
  const dn = buildUserUpn(username);
  let client;
  try {
    client = await connect({ dn, password });
  } catch (err) {
    const c = classifyLdapError(err);
    const e = new Error(c.message);
    e.code = c.code;
    throw e;
  }

  try {
    // 用服务账号读取该用户的详细信息（用户自身 bind 权限通常不足以枚举属性）
    const attrs = await lookupUserBySam(client, username).catch(() => null);
    if (attrs) return attrs;
    // 服务账号不可用时，退回用用户连接自身 DN 读取
    return await readUserByDn(client, dn);
  } finally {
    try { await client.unbind(); } catch { /* 忽略 */ }
  }
}

function decodeUac(uac) {
  const v = Number(uac ?? 512);
  return {
    disabled: (v & 0x0002) !== 0,
    locked: (v & 0x0010) !== 0,
    passwordNeverExpires: (v & 0x10000) !== 0,
  };
}

function toArray(v) {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function mapEntry(entry) {
  const uac = decodeUac(entry.userAccountControl);
  return {
    username: String(entry.sAMAccountName ?? '').toLowerCase(),
    displayName: String(entry.displayName ?? entry.cn ?? entry.sAMAccountName ?? ''),
    email: entry.mail ? String(entry.mail) : null,
    department: entry.department ? String(entry.department) : null,
    title: entry.title ? String(entry.title) : null,
    employeeNo: entry.employeeID ? String(entry.employeeID) : null,
    office: entry.physicalDeliveryOfficeName ? String(entry.physicalDeliveryOfficeName) : null,
    dn: String(entry.distinguishedName ?? ''),
    managerDn: entry.manager ? String(entry.manager) : null,
    groups: toArray(entry.memberOf).map(String),
    disabled: uac.disabled,
    locked: uac.locked,
  };
}

/**
 * 查询单个用户属性。优先使用服务账号（权限足够枚举属性），
 * 若服务账号不可用则回退到调用方提供的 userClient。
 */
export async function lookupUserBySam(userClient, username) {
  const filter = `(&(objectCategory=person)(objectClass=user)(sAMAccountName=${escapeFilter(username)}))`;
  const opts = { scope: 'sub', filter, attributes: USER_ATTRS, sizeLimit: 2 };

  // 优先：服务账号
  let client = null;
  try {
    client = await serviceClient();
    const { searchEntries } = await client.search(config.ldap.baseDn, opts);
    if (searchEntries.length) return mapEntry(searchEntries[0]);
  } catch {
    // 服务账号不可用，落到下面的回退分支
  }

  // 回退：用调用方（已 bind 的用户连接）自己查
  if (userClient) {
    try {
      const { searchEntries } = await userClient.search(config.ldap.baseDn, opts);
      if (searchEntries.length) return mapEntry(searchEntries[0]);
    } catch { /* 忽略，交由上层兜底 */ }
  }
  return null;
}

/** 用用户自身连接按其 DN 读取属性（服务账号不可用时的兜底）。 */
export async function readUserByDn(client, dn) {
  try {
    const { searchEntries } = await client.search(dn, {
      scope: 'base',
      filter: '(objectClass=*)',
      attributes: USER_ATTRS,
    });
    if (!searchEntries.length) return null;
    return mapEntry(searchEntries[0]);
  } catch {
    // 至少返回用户名，后续由同步任务补齐
    const name = String(dn).split(',')[0].replace(/^CN=/i, '');
    return { username: name.toLowerCase(), displayName: name, email: null, department: null,
      title: null, employeeNo: null, office: null, dn, managerDn: null, groups: [], disabled: false, locked: false };
  }
}

/** RFC4515 转义，避免过滤器注入。 */
export function escapeFilter(s) {
  return String(s).replace(/[\\*()\0]/g, (c) => ({
    '\\': '\\5c', '*': '\\2a', '(': '\\28', ')': '\\29', '\0': '\\00',
  }[c]));
}

let _serviceClient = null;
/** 获取（或复用）一个已 bind 的服务账号连接。 */
export async function serviceClient() {
  if (_serviceClient) return _serviceClient;
  const client = await connect({
    dn: config.ldap.bindDn,
    password: config.ldap.bindPassword,
  });
  _serviceClient = client;
  return client;
}

/** 丢弃当前服务账号连接，下次调用时重新建立（用于连接失效后的重试）。 */
export async function resetServiceClient() {
  const c = _serviceClient;
  _serviceClient = null;
  if (c) { try { await c.unbind(); } catch { /* 忽略 */ } }
}

/** 以服务账号执行一次查询，连接失效时自动重建并重试一次。 */
export async function withServiceClient(fn) {
  try {
    return await fn(await serviceClient());
  } catch (err) {
    // 连接不可用 / 未 bind / 网络中断时，重建连接重试一次
    const msg = String(err?.message ?? '');
    if (/bind must be completed|ConnectionError|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT/i.test(msg)) {
      await resetServiceClient();
      return fn(await serviceClient());
    }
    throw err;
  }
}

export async function closeServiceClient() {
  if (_serviceClient) {
    try { await _serviceClient.unbind(); } catch { /* 忽略 */ }
    _serviceClient = null;
  }
}

/**
 * 拉取全部启用的 AD 用户（供同步任务使用）。
 *
 * 说明：ldapts 在服务端未返回分页 cookie 时，会在一次 search 里返回全部条目
 * （AD 默认 MaxPageSize 为 1000，通常足够）。这里只在确实拿到 pageCookie 时
 * 才继续翻页，避免用空 cookie 重复请求导致 "bind must be completed" 之类的错误。
 */
export async function fetchAllUsers() {
  const out = [];
  const filter = '(&(objectCategory=person)(objectClass=user)(!(sAMAccountName=*$)))';

  await withServiceClient(async (client) => {
    let cookie;
    for (let page = 0; page < 50; page++) {
      const res = await client.search(config.ldap.baseDn, {
        scope: 'sub',
        filter,
        attributes: USER_ATTRS,
        paged: cookie ? { pageSize: 500, cookie } : { pageSize: 500 },
      });
      for (const e of res.searchEntries) out.push(mapEntry(e));

      const next = res.pageCookie;
      if (!next || next.length === 0) break;
      cookie = next;
    }
  });
  return out;
}

/** 拉取全部组及其成员 DN。 */
export async function fetchAllGroups() {
  return withServiceClient(async (client) => {
    const { searchEntries } = await client.search(config.ldap.baseDn, {
      scope: 'sub',
      filter: '(objectClass=group)',
      attributes: ['cn', 'distinguishedName', 'member', 'description'],
    });
    return searchEntries.map((e) => ({
      name: String(e.cn ?? ''),
      dn: String(e.distinguishedName ?? ''),
      description: e.description ? String(e.description) : '',
      members: toArray(e.member).map(String),
    }));
  });
}

/** 判断用户所属组是否命中给定组名列表（大小写不敏感，接受 DN 或 CN 形态）。 */
export function groupMatches(userGroups, wantedGroups) {
  if (!wantedGroups || wantedGroups.length === 0) return false;
  const wanted = wantedGroups.map((g) => g.toLowerCase());
  for (const dn of userGroups) {
    const cn = extractCn(dn);
    if (cn && wanted.includes(cn.toLowerCase())) return true;
    if (wanted.includes(String(dn).toLowerCase())) return true;
  }
  return false;
}

export function extractCn(dn) {
  if (!dn) return '';
  const m = /(?:^|,)\s*CN=([^,]+)/i.exec(String(dn));
  return m ? m[1].trim() : '';
}

export function groupNames(dns) {
  return toArray(dns).map(extractCn).filter(Boolean);
}