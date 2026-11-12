-- ============================================================
-- 流程节点配置
-- ============================================================
-- 工时的审批流程由三个可选节点组成：
--   stage1_project  项目审批（项目审批人 / 或签）
--   stage2_hr       人事确认（确认工时与月薪）
--   stage3_finance  财务确认（确认人工费用与分摊比例，然后归档）
--
-- 管理员可逐个开关。**关闭的节点会被自动跳过**：
--   · 三个都开   draft → 项目审批 → 人事 → 财务 → 归档
--   · 关闭人事   draft → 项目审批 → 财务 → 归档
--   · 关闭项目   draft → 人事 → 财务 → 归档
--   · 全部关闭   draft → 直接归档
--
-- 全局统一配置（单例行），不做按项目配置。
--
-- 幂等：可重复执行。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS workflow_settings (
  id              SMALLINT PRIMARY KEY DEFAULT 1,
  enable_project  BOOLEAN NOT NULL DEFAULT TRUE,   -- 项目审批节点
  enable_hr       BOOLEAN NOT NULL DEFAULT TRUE,   -- 人事确认节点
  enable_finance  BOOLEAN NOT NULL DEFAULT TRUE,   -- 财务确认节点
  updated_by      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_workflow_settings_single_row CHECK (id = 1)
);

INSERT INTO workflow_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMIT;