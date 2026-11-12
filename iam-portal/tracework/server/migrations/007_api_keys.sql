-- ============================================================
-- 开放 API：API Key 与调用审计
-- ============================================================
-- 设计要点：
--   · Key 只存储 **SHA-256 哈希**，明文仅在创建时返回一次
--     （即使数据库泄露也无法还原密钥）
--   · 支持权限范围（scopes），按领域授予最小权限
--   · 支持过期时间与启用/停用，可随时吊销
--   · 记录最后使用时间与调用次数，便于发现异常
--   · API 调用与浏览器会话分离，互不影响
--
-- 幂等：可重复执行。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS api_keys (
  id              BIGSERIAL PRIMARY KEY,
  name            TEXT NOT NULL,                     -- 用途说明，如「BI 报表系统」
  key_prefix      TEXT NOT NULL,                     -- 前缀（明文前 12 字符），便于识别
  key_hash        TEXT NOT NULL UNIQUE,              -- SHA-256(完整密钥)
  -- 归属：以某个用户身份执行（继承其数据可见范围）
  owner_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scopes          TEXT[] NOT NULL DEFAULT '{}',       -- 权限范围
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at      TIMESTAMPTZ,                       -- 为空表示不过期
  last_used_at    TIMESTAMPTZ,
  call_count      BIGINT NOT NULL DEFAULT 0,
  rate_limit_per_min INT NOT NULL DEFAULT 600,       -- 每分钟调用上限
  created_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at      TIMESTAMPTZ,
  revoked_by      BIGINT REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_api_keys_owner  ON api_keys(owner_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(is_active) WHERE is_active;

-- 每次 API 调用的审计（可按需清理，不影响业务）
CREATE TABLE IF NOT EXISTS api_request_logs (
  id           BIGSERIAL PRIMARY KEY,
  at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  api_key_id   BIGINT REFERENCES api_keys(id) ON DELETE SET NULL,
  key_name     TEXT,
  user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  method       TEXT NOT NULL,
  path         TEXT NOT NULL,
  status       INT,
  duration_ms  INT,
  ip           TEXT,
  error_code   TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_logs_at  ON api_request_logs(at DESC);
CREATE INDEX IF NOT EXISTS idx_api_logs_key ON api_request_logs(api_key_id, at DESC);

COMMIT;