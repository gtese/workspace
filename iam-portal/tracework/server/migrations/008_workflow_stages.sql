-- ============================================================
-- 工时审批四阶段流转
-- ============================================================
-- 流程：
--   draft（工程师填报）
--     ↓ 提交
--   stage1_项目审批 —— 项目管理者审批（**按项目粒度**，或签）
--     ↓ 全部项目通过
--   stage2_人事确认 —— 人事确认工时并维护月薪
--     ↓
--   stage3_财务确认 —— 财务确认人工费用与分摊比例
--     ↓
--   archived（归档）—— 进入归档工时列表，可导出
--
-- 驳回：逐级退回上一阶段
--   项目审批驳回 → draft（工程师改）
--   人事驳回     → stage1（回到项目审批）
--   财务驳回     → stage2（回到人事）
--
-- 幂等：可重复执行。
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. 扩展 timesheet_status 枚举
-- ------------------------------------------------------------
DO $$ BEGIN
  ALTER TYPE timesheet_status ADD VALUE IF NOT EXISTS 'stage1_project';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE timesheet_status ADD VALUE IF NOT EXISTS 'stage2_hr';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE timesheet_status ADD VALUE IF NOT EXISTS 'stage3_finance';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE timesheet_status ADD VALUE IF NOT EXISTS 'archived';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMIT;

-- 枚举扩充后需要在独立事务里才能使用新值
BEGIN;

-- ------------------------------------------------------------
-- 2. 工时单增加阶段流转字段
-- ------------------------------------------------------------
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS stage_entered_at TIMESTAMPTZ;

-- 人事确认的月薪快照（审批时点的值，后续改薪酬不影响已归档数据）
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS salary_snapshot NUMERIC(14,2);

-- 财务确认的人工费用（万元）与分摊比例
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS labor_cost_wan NUMERIC(16,4);
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS alloc_ratio NUMERIC(9,4);

-- 各阶段处理人
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS hr_confirmed_by   BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS hr_confirmed_at   TIMESTAMPTZ;
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS fin_confirmed_by  BIGINT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS fin_confirmed_at  TIMESTAMPTZ;
ALTER TABLE timesheets ADD COLUMN IF NOT EXISTS archived_at       TIMESTAMPTZ;

-- ------------------------------------------------------------
-- 3. 审批流转日志（完整审计轨迹）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS timesheet_stage_logs (
  id            BIGSERIAL PRIMARY KEY,
  timesheet_id  BIGINT NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  from_status   TEXT NOT NULL,
  to_status     TEXT NOT NULL,
  actor_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_name    TEXT NOT NULL DEFAULT '',
  action        TEXT NOT NULL,                    -- submit/approve/reject/withdraw/archive
  note          TEXT NOT NULL DEFAULT '',
  detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ts_logs_sheet ON timesheet_stage_logs(timesheet_id, at DESC);

-- ------------------------------------------------------------
-- 4. 历史数据迁移
-- ------------------------------------------------------------
-- 旧的 submitted 等价于 stage1_project；旧的 approved 等价于 archived
UPDATE timesheets SET status = 'stage1_project' WHERE status = 'submitted';
UPDATE timesheets SET status = 'archived', archived_at = approved_at
 WHERE status = 'approved';

COMMIT;