-- 知识平台接入 OIDC 所需变更（幂等）
ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_sub TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS users_oidc_sub_uniq ON users (oidc_sub) WHERE oidc_sub IS NOT NULL;

-- 记录登录来源，便于切换期核对（可选但推荐）
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_source TEXT DEFAULT 'ldap';
COMMENT ON COLUMN users.oidc_sub IS 'Keycloak 用户 UUID（ID Token 的 sub）';
