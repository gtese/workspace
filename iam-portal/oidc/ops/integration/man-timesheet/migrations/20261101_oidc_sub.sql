-- ============================================================
-- man-timesheet：接入统一身份（OIDC）所需的数据库变更
-- 执行：node src/migrate.js 或 psql -f migrations/20261101_oidc_sub.sql
-- 幂等：可重复执行
-- ============================================================

-- 1) 用户表增加 Keycloak 主体标识（UUID，永不变）
ALTER TABLE users ADD COLUMN IF NOT EXISTS oidc_sub TEXT;

-- 2) 一个人的 oidc_sub 唯一（允许多行 NULL：未接入 OIDC 的历史用户）
CREATE UNIQUE INDEX IF NOT EXISTS users_oidc_sub_uniq
  ON users (oidc_sub) WHERE oidc_sub IS NOT NULL;

-- 3) 记录身份来源，便于切换期排查（ldap = 旧路径，oidc = 新路径）
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_source TEXT DEFAULT 'ldap';
COMMENT ON COLUMN users.auth_source IS '登录方式来源：ldap（历史）/ oidc（统一身份）';

-- 4) 首次登录按 username 对账时，如果同一 username 有多行（不应发生），先查出来人工处理：
--    SELECT username, count(*) FROM users GROUP BY 1 HAVING count(*) > 1;

COMMENT ON COLUMN users.oidc_sub IS 'Keycloak 用户 UUID（ID Token 的 sub），登录后按此关联';
