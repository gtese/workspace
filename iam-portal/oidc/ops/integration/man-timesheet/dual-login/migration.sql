-- 双登录（本地账号通道）所需数据库变更 —— 幂等
ALTER TABLE users ADD COLUMN IF NOT EXISTS local_password_hash TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS local_login_enabled BOOLEAN NOT NULL DEFAULT false;

-- 历史用户默认 auth_source='ldap'（若尚未加过该列，见 20261101_oidc_sub.sql）
UPDATE users SET auth_source = 'ldap' WHERE auth_source IS NULL;

-- 本地账号必须有口令哈希；AD 用户不应有
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_local_pwd_ck;
ALTER TABLE users ADD CONSTRAINT users_local_pwd_ck
  CHECK ((auth_source = 'local' AND local_password_hash IS NOT NULL)
      OR (auth_source <> 'local' AND local_password_hash IS NULL));

-- 审计按来源过滤的索引
CREATE INDEX IF NOT EXISTS audit_auth_via_idx
  ON audit_log (created_at DESC) WHERE action LIKE 'auth.%';
