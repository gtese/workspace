'use strict';
/**
 * ============================================================
 * IdP 身份 → 知识平台用户档案映射 —— 复制为 server/src/oidcIdentity.js
 * ============================================================
 * 本系统的角色与部门推导逻辑已经在 ldap.js 里（mapRole / resolveDepartment）。
 * 改造时不要重写这些规则，而是**复用**它们：把 OIDC 拿到的 groups 数组
 * 包装成 ldap.js 期望的格式，再走同一个 upsertProfile。
 *
 * 角色取「AD 组推导」与「IdP 角色」的**较高者**，原因：
 *   - AD 组推导（Group_KBReviewers / Group_KBReviewer_<部门>）是过渡期兜底；
 *   - IdP 角色 kb:admin / kb:reviewer 是目标态；
 *   - 两者同时存在时不取低，避免切换期间有人"被降权"。
 */
const ldapmod = require('./ldap');

const ROLE_RANK = { employee: 0, submitter: 1, reviewer: 2, admin: 3 };

/** 把 AD 组 CN 数组包装成 ldap.js 能吃的 groups 结构 */
function asGroups(cns) {
  return (cns || []).map((cn) => ({ cn, dn: `CN=${cn},${cn ? '' : ''}` }));
}

/** IdP 角色 → 本系统角色（realm_access.roles 里的业务角色） */
function roleFromIdp(roles = []) {
  const set = new Set(roles.map((r) => r.toLowerCase()));
  if (set.has('kb:admin')) return 'admin';
  if (set.has('kb:reviewer')) return 'reviewer';
  return null;
}

/**
 * 由 OIDC 身份构建 profile（与 ldap.js authenticate() 返回的 profile 同构）。
 * @param {{sub,username,name,email}} claims  ID Token 校验后的 claims
 * @param {{groups:string[], roles:string[]}} idp      userinfo 的 groups + access_token 的 realm_access.roles
 * @param {string[]} allowedGroups                     准入组
 */
function buildProfile(claims, idp, allowedGroups = []) {
  const username = String(claims.preferred_username || '').toLowerCase();
  const groups = idp.groups || [];
  const lower = groups.map((g) => g.toLowerCase());

  // 准入：与改造前 LDAP_ALLOWED_GROUPS 等价的语义
  if (allowedGroups.length) {
    const ok = allowedGroups.some((w) => lower.includes(String(w).toLowerCase()));
    if (!ok) return { ok: false, reason: 'not_allowed', message: '您的账号不在本系统授权范围内' };
  }

  // 复用 ldap.js 的部门解析与角色映射（不复制规则）
  // ldap.js 里这两个函数是文件内私有，改造时一并导出（见 README §3.2）
  const dept = ldapmod.resolveDepartmentFromGroups ? ldapmod.resolveDepartmentFromGroups(groups)
                                                   : { name: '', key: '' };
  const byAd = ldapmod.mapRoleFromGroups ? ldapmod.mapRoleFromGroups(groups) : 'employee';
  const byIdp = roleFromIdp(idp.roles) || 'employee';
  const role = (ROLE_RANK[byIdp] ?? 0) >= (ROLE_RANK[byAd] ?? 0) ? byIdp : byAd;

  return {
    ok: true,
    profile: {
      username,
      displayName: claims.name || claims.preferred_username || username,
      email: claims.email || null,
      adDn: null,                 // OIDC 不再暴露 DN（保留列以兼容历史）
      department: dept.name,
      departmentKey: dept.key,
      title: null,                // AD 无 title 属性；如需可由 IdP 增加 claim
      role,
      groups: asGroups(groups),   // 供 upsertProfile 落 user_groups（部门可见范围要用）
      oidcSub: claims.sub,        // 新字段：写入 users.oidc_sub
    },
  };
}

module.exports = { buildProfile, roleFromIdp };
