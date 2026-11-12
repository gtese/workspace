-- ============================================================
-- 科研项目管理平台 · 项目多审批人（or-sign / 或签）
-- ============================================================
-- 背景：
--   原实现中每个项目只有一个负责人（projects.owner_id），
--   实际业务中一个项目常有多个主管（如技术主管 + 项目经理），
--   任一主管都应能审批该项目的报工。
--
-- 设计：
--   · 新增 project_approvers 关联表，一个项目可挂多个审批人
--   · 审批采用「或签」：任一位审批人处理即生效，其余人不再重复处理
--   · 保留 projects.owner_id 作为「项目主负责人」（用于展示、责任归属），
--     审批权限统一以 project_approvers 为准
--   · 若项目未配置审批人，则回退到 owner_id；两者都为空时，
--     由 HR/管理员兜底审批（避免报工无人可批而卡死）
--
-- 幂等：可重复执行。
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS project_approvers (
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_proj_approver_user ON project_approvers(user_id);

-- 把已有的 owner_id 迁移为审批人（幂等）
INSERT INTO project_approvers (project_id, user_id)
SELECT id, owner_id FROM projects WHERE owner_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- 审批单记录「实际处理人」，便于审计追溯是谁批的
ALTER TABLE approvals ADD COLUMN IF NOT EXISTS decided_by BIGINT REFERENCES users(id) ON DELETE SET NULL;

COMMIT;