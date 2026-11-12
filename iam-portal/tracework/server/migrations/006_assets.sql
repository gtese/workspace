-- ============================================================
-- IT 资产管理模块
-- ============================================================
-- 来源：TraceIC-IT资产管理表.xlsx（47 条资产）
--
-- 设计要点：
--   · 资产「使用人」必须挂接 AD 账号（user_id 外键），
--     保证与系统中的真实人员一致，不出现手打的自由文本姓名
--   · 支持「外部借用」：无 AD 账号的借用方单独记录在 borrower_external
--   · 借用历史独立成表，保留完整流转轨迹（谁在何时借走/归还）
--   · 资产编号、序列号唯一，避免重复录入
--
-- 幂等：可重复执行。
-- ============================================================

BEGIN;

-- ============================================================
-- 1. 资产主表
-- ============================================================
CREATE TABLE IF NOT EXISTS assets (
  id                 BIGSERIAL PRIMARY KEY,
  asset_no           TEXT NOT NULL UNIQUE,            -- 资产IT编号 Tri-Asset-IT001
  finance_no         TEXT,                            -- 财务资产编号 CS-02-0009
  device_type        TEXT NOT NULL DEFAULT '',        -- 笔记本/服务器/存储/防火墙/交换机/打印机
  brand              TEXT NOT NULL DEFAULT '',
  model              TEXT NOT NULL DEFAULT '',
  sn                 TEXT,                             -- 序列号（允许为空，部分自攒机器无 SN）
  location           TEXT NOT NULL DEFAULT '',        -- 存放位置
  supplier           TEXT NOT NULL DEFAULT '',        -- 供应商名称
  purchase_date      DATE,
  note               TEXT NOT NULL DEFAULT '',        -- 备注
  status             TEXT NOT NULL DEFAULT '在库',     -- 在用 / 在库 / 维修 / 报废 / 外借
  -- 使用人（挂接 AD 账号）
  holder_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  assign_date        DATE,                            -- 领用日期
  -- 外部借用（无 AD 账号时使用）
  borrower_external  TEXT,                            -- 外部借用方姓名
  borrower_contact   TEXT,                            -- 外部借用方联系方式
  created_by         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_asset_status CHECK (status IN ('在用','在库','外借','维修','报废','调拨')),
  -- 使用人与外部借用方不能同时存在
  CONSTRAINT chk_asset_holder_exclusive CHECK (NOT (holder_id IS NOT NULL AND borrower_external IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_assets_sn ON assets(sn) WHERE sn IS NOT NULL AND sn <> '';
CREATE INDEX IF NOT EXISTS idx_assets_holder ON assets(holder_id);
CREATE INDEX IF NOT EXISTS idx_assets_status ON assets(status);
CREATE INDEX IF NOT EXISTS idx_assets_type   ON assets(device_type);

-- ============================================================
-- 2. 借用/归还流转记录
-- ============================================================
CREATE TABLE IF NOT EXISTS asset_assignments (
  id               BIGSERIAL PRIMARY KEY,
  asset_id         BIGINT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  -- 借用人（AD 账号 或 外部人员，二选一）
  holder_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  holder_external  TEXT,
  assigned_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  returned_at      TIMESTAMPTZ,                    -- 为空表示尚未归还
  operator_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,  -- 经手人
  note             TEXT NOT NULL DEFAULT '',
  CONSTRAINT chk_assign_holder CHECK (holder_id IS NOT NULL OR holder_external IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_assign_asset ON asset_assignments(asset_id);
CREATE INDEX IF NOT EXISTS idx_assign_open  ON asset_assignments(asset_id) WHERE returned_at IS NULL;

DROP TRIGGER IF EXISTS trg_assets_touch ON assets;
CREATE TRIGGER trg_assets_touch BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;