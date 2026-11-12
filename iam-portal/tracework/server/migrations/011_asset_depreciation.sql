-- ============================================================
-- 资产折旧与工时折算
-- ============================================================
-- 1. 资产金额默认 10000 元，折旧年限默认 36 个月
--    存量资产批量填充（当前都是空值）
--
-- 2. 资产折旧分摊到工时单：
--    项目设备每月折旧额 = 设备月度折旧金额 × 月度研发工时 ÷ 月度总工时
--
--    其中「设备月度折旧金额」= 资产金额 ÷ 折旧年限（月）
--    「月度研发工时」= 该员工当月经审批确认的研发工时
--    「月度总工时」= 该员工当月考勤工时（无考勤时用工时单合计）
--
--    按人归属：员工名下资产 → 该员工的研发工时占比 分摊
--
-- 幂等：可重复执行。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. 资产折旧字段
-- ------------------------------------------------------------
ALTER TABLE assets ADD COLUMN IF NOT EXISTS depreciation_months INT DEFAULT 36;

-- 设置默认值：新建资产自动带 10000 元 / 36 个月
ALTER TABLE assets ALTER COLUMN amount SET DEFAULT 10000;
ALTER TABLE assets ALTER COLUMN depreciation_months SET DEFAULT 36;

-- 存量资产批量填充（仅填充空值，不覆盖已有数据）
UPDATE assets SET amount = 10000 WHERE amount IS NULL;
UPDATE assets SET depreciation_months = 36 WHERE depreciation_months IS NULL OR depreciation_months <= 0;

COMMENT ON COLUMN assets.amount IS '资产金额（元，含税购置价）';
COMMENT ON COLUMN assets.depreciation_months IS '折旧年限（月）';

-- ------------------------------------------------------------
-- 2. 工时单的资产折旧分摊结果
-- ------------------------------------------------------------
-- 记录财务确认时计算出的资产折旧折算，便于追溯与复算
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS asset_value_total NUMERIC(16,2);   -- 名下资产总额
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS asset_dep_month   NUMERIC(16,4);   -- 资产月度折旧额
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS asset_alloc_wan   NUMERIC(16,4);   -- 摊入研发的折旧（万元）
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS asset_alloc_detail JSONB;          -- 逐件明细

COMMENT ON COLUMN timesheets.asset_value_total IS '员工名下资产总价值（元）';
COMMENT ON COLUMN timesheets.asset_dep_month IS '名下资产月度折旧合计（元）';
COMMENT ON COLUMN timesheets.asset_alloc_wan IS '按研发工时占比摊入的折旧（万元）';

COMMIT;