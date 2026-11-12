-- ============================================================
-- OIDC 主体绑定
-- ============================================================
-- 接入统一身份（sso.tri.local / Keycloak）后，用户的稳定标识是 IdP 的 `sub`。
-- AD 账号名（sAMAccountName）仍是业务主键，因此：
--   · 首次登录按 username 匹配已有用户，并写入 oidc_sub
--   · 之后按 oidc_sub 查找，用户名变更也能对上
--
-- 注意：oidc_sub 允许为空（历史用户、API Key 场景），
-- 但一旦有值必须唯一，防止两个账号绑定到同一 IdP 主体。
--
-- 幂等：可重复执行。
-- ============================================================

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_sub TEXT;

COMMENT ON COLUMN users.oidc_sub IS '统一身份（Keycloak）主体标识 sub，登录时自动绑定';

-- 唯一索引：仅对非空值生效，避免多个 NULL 冲突
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_oidc_sub
  ON users(oidc_sub) WHERE oidc_sub IS NOT NULL;

COMMIT;