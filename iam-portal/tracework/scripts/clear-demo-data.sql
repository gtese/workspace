-- ============================================================
-- 清除演示/测试数据，恢复为「干净可用」初始状态
-- ============================================================
-- 执行前已备份：/var/backups/tracework/pre-clear-*.sql.gz
--
-- 删除范围：
--   · 全部工时业务数据（工时明细、工时单、审批单）
--   · 全部考勤记录
--   · 全部费用数据（费用明细、公共费用、委外合同、备查台账）
--   · 全部分摊/测算快照与文档生成记录
--   · 演示项目（全部 9 个）
--   · 示例公司档案
--
-- 保留：
--   · AD 用户（含角色配置）
--   · 法定节假日日历（系统基础数据，非演示数据）
--   · IT 资产（真实数据，非演示数据）
--   · 审计日志（历史操作记录，保留可追溯）
--
-- 同时清除员工上的演示业务属性：
--   · 月薪（monthly_salary）
--   · 工号（employee_no）
--   · 标准考勤工时（attendance_hours）
--   · 研发类型恢复默认值（fulltime_rnd）
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 1. 删除工时业务数据
-- ------------------------------------------------------------
DELETE FROM approvals;        -- 审批单（依赖 timesheets）
DELETE FROM timesheets;       -- 工时单
DELETE FROM time_entries;     -- 工时明细
DELETE FROM attendance;       -- 考勤记录

-- ------------------------------------------------------------
-- 2. 删除费用与备查数据
-- ------------------------------------------------------------
DELETE FROM cost_entries;         -- 费用明细（含工时自动归集的人工费用）
DELETE FROM shared_expenses;      -- 公共费用
DELETE FROM outsource_contracts;  -- 委外/合作研发
DELETE FROM ledger_rows;          -- 15 类备查台账
DELETE FROM allocation_runs;      -- 工时分摊快照
DELETE FROM deduction_runs;       -- 多口径测算快照
DELETE FROM generated_docs;       -- 备查资料生成记录

-- ------------------------------------------------------------
-- 3. 删除项目及其关联
-- ------------------------------------------------------------
DELETE FROM project_members;      -- 项目成员
DELETE FROM project_approvers;    -- 项目审批人
DELETE FROM projects;             -- 项目

-- ------------------------------------------------------------
-- 4. 清空公司档案（保留单例行，字段归零）
-- ------------------------------------------------------------
UPDATE company_profile SET
  name = '',
  credit_code = NULL,
  industry = NULL,
  establish_date = NULL,
  address = NULL,
  legal_person = NULL,
  rd_institution = NULL,
  rd_leader = NULL,
  rd_leader_phone = NULL,
  finance_officer = NULL,
  contact = NULL,
  negative_industry = FALSE,
  negative_ratio = 0,
  deduct_rate = 100,
  total_revenue = 0,
  total_revenue_3y = 0,
  rd_expense_3y = 0,
  rd_expense_year = 0,
  rd_domestic_3y = 0,
  high_tech_income = 0,
  total_staff = 0,
  tech_staff = 0,
  innovation_score = 0,
  last_audit = NULL,
  audit_firm = NULL,
  updated_at = now()
WHERE id = 1;

-- ------------------------------------------------------------
-- 5. 清除员工上的演示业务属性
-- ------------------------------------------------------------
UPDATE users SET
  monthly_salary   = 0,               -- 月薪归零
  employee_no      = NULL,            -- 移除工号
  attendance_hours = NULL,            -- 清除演示用的标准考勤工时
  -- 注意：employee_type 不在这里重置。它由 AD 组自动推导
  -- （Group_Roots → fulltime_rnd，Group_Support → support），
  -- 重置会破坏 AD 同步结果。如需重算，触发一次 AD 同步即可。
  is_tech_staff    = FALSE,           -- 科技人员标记重置
  is_rd_staff      = TRUE,
  education        = NULL,
  major            = NULL,
  post             = NULL,
  rd_duty          = NULL,
  join_date        = NULL,
  certify_note     = NULL,
  manager_id       = NULL;            -- 清除上级关系（演示数据）

COMMIT;