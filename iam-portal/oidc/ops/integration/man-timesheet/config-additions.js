/**
 * 追加到 server/src/config.js 的 config 对象
 * ------------------------------------------------------------
 *  - authMode：'ldap' | 'oidc'。切换期默认 ldap，便于一键回滚。
 *  - oidc.*  ：统一身份（Keycloak）连接参数
 *  - ldap.allowedGroups 继续沿用（准入组），但内容改为从 userinfo 的 groups 里匹配
 */
export const configAdditions = {
  authMode: env('AUTH_MODE', 'ldap'),          // ← 切到 oidc

  oidc: {
    issuer: env('OIDC_ISSUER', 'https://sso.tri.local/realms/tri'),
    clientId: env('OIDC_CLIENT_ID', 'man-timesheet'),
    clientSecret: readSecret('OIDC_CLIENT_SECRET_FILE', 'OIDC_CLIENT_SECRET'),
    redirectUri: env('OIDC_REDIRECT_URI', 'https://man.tri.local/api/auth/oidc/callback'),
    postLogoutUri: env('OIDC_POST_LOGOUT_URI', 'https://man.tri.local/login?logout=1'),
    // groups 必须带：本系统靠 AD 组做准入与角色推导
    scope: env('OIDC_SCOPE', 'openid profile email roles groups'),
    // 校验 IdP 证书用（内网企业根 CA）
    caFile: env('OIDC_CA_FILE', '/etc/ts-certs/tri.local_ca.crt'),
  },
};

// 启动自检：AUTH_MODE=oidc 时缺少以下项直接拒绝启动（避免"看起来正常但登不进"）
// if (config.authMode === 'oidc') {
//   if (!config.oidc.clientSecret) problems.push('AUTH_MODE=oidc 时必须提供 OIDC_CLIENT_SECRET');
//   if (!config.oidc.redirectUri.startsWith('https://')) problems.push('OIDC_REDIRECT_URI 必须是 https');
// }
