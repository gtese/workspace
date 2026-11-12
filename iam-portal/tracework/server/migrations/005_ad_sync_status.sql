-- ============================================================
-- AD 同步增强：区分「禁用」与「已删除」
-- ============================================================
-- 原实现：
--   · AD 禁用        -> is_active = false（正确）
--   · AD 中不存在    -> 也只标记 is_active = false，
--                      与「手动停用」无法区分，且仍可能出现在部分列表中
--
-- 本迁移引入 ad_status 显式表达 AD 侧真实状态：
--   active    。AD 中存在且启用
--   disabled  。AD 中存在但已禁用（userAccountControl & 0x2）
--   deleted   。AD 中已不存在（被删除/移出允许组）
--   unknown   。从未同步过（本地手工创建，如系统初始化账号）
--
-- 语义：
--   · deleted/disabled 均视为不可登录、不可被选
--   · 但**不物理删除**记录，保留历史工时、审批、费用数据以符合审计要求
--   · is_active 与 ad_status 保持一致（兼容既有查询逻辑）
--
-- 幂等：可重复执行。
-- ============================================================

BEGIN;

ALTER TABLE users ADD COLUMN IF NOT EXISTS ad_status TEXT NOT NULL DEFAULT 'unknown';

DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT chk_ad_status
    CHECK (ad_status IN ('active', 'disabled', 'deleted', 'unknown'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- 初次回填：依据现有 is_active 与是否同步过推断
UPDATE users
   SET ad_status = CASE
     WHEN synced_at IS NULL THEN 'unknown'
     WHEN is_active THEN 'active'
     ELSE 'disabled'
   END
 WHERE ad_status = 'unknown';

CREATE INDEX IF NOT EXISTS idx_users_ad_status ON users(ad_status);

-- 记录每次同步的概要，便于运维追溯（谁被禁用/删除了）
CREATE TABLE IF NOT EXISTS ad_sync_runs (
  id           BIGSERIAL PRIMARY KEY,
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  trigger      TEXT NOT NULL DEFAULT 'scheduled',   -- scheduled | manual | startup
  stats        JSONB NOT NULL DEFAULT '{}'::jsonb,
  disabled_users TEXT[] NOT NULL DEFAULT '{}',
  deleted_users  TEXT[] NOT NULL DEFAULT '{}',
  restored_users TEXT[] NOT NULL DEFAULT '{}',
  ok           BOOLEAN NOT NULL DEFAULT FALSE,
  error        TEXT
);

COMMIT;