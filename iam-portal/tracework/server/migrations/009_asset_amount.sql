-- ============================================================
-- 资产金额 + 修复 note 列约束
-- ============================================================
-- 1. 新增「资产金额」字段（元，含税购置价）
-- 2. 把 note 的 NOT NULL 约束去掉，改为允许空串
--    原因：前端编辑时若备注为空，会传 null；后端原样写入触发
--    「null value in column note」错误，表现为「清除领用人后报错」。
--    这里同时在代码层做了兜底（空值转空串），数据库层再放宽一层。
--
-- 幂等：可重复执行。
-- ============================================================

BEGIN;

-- 1. 资产金额（元）
ALTER TABLE assets ADD COLUMN IF NOT EXISTS amount NUMERIC(14,2);

COMMENT ON COLUMN assets.amount IS '资产金额（元，含税购置价）';

-- 2. note 允许 NULL 并统一空值为空串
ALTER TABLE assets ALTER COLUMN note SET DEFAULT '';
ALTER TABLE assets ALTER COLUMN note DROP NOT NULL;
UPDATE assets SET note = '' WHERE note IS NULL;

COMMIT;