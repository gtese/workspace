-- ============================================================
-- 演示数据：审批流转与状态分布（2026-10）
-- ============================================================
-- 目的：让审批中心、工作台、汇总页都能看到「真实存在差异」的各类状态，
--       而不是清一色待审批。
--
-- 状态分布设计：
--   · 已全部通过（7 人）：报工 → 提交 → 各项目负责人审批通过
--   · 部分通过 / 部分待审（3 人）：模拟审批进行中
--   · 已驳回（1 人）：模拟填报有误被退回（wenxuedong，其工时未报满）
--   · 草稿未提交（lancunqing 为 HR，不参与研发填报）
--
-- 审批时限：提交后 2 个工作日。脚本据此计算 due_at。
-- ============================================================

BEGIN;

DELETE FROM approvals WHERE period = '2026-10';

-- ------------------------------------------------------------
-- 先按人拆分「人 × 项目」的审批单（与真实提交逻辑一致）
-- ------------------------------------------------------------
INSERT INTO approvals (timesheet_id, user_id, project_id, period, hours, status, submit_at, due_at)
SELECT t.id, e.user_id, e.project_id, '2026-10',
       SUM(e.hours), 'pending',
       TIMESTAMPTZ '2026-10-31 17:30:00+08',
       TIMESTAMPTZ '2026-11-04 18:00:00+08'   -- 10/31 之后 2 个工作日（11/2、11/3）
  FROM time_entries e
  JOIN timesheets t ON t.user_id = e.user_id AND t.period = '2026-10'
 WHERE to_char(e.work_date, 'YYYY-MM') = '2026-10'
 GROUP BY t.id, e.user_id, e.project_id;

-- ------------------------------------------------------------
-- 全体先转为「已提交」
-- ------------------------------------------------------------
UPDATE timesheets
   SET status       = 'submitted'::timesheet_status,
       submitted_at = TIMESTAMPTZ '2026-10-31 17:30:00+08',
       reject_reason = '',
       reject_count  = 0
 WHERE period = '2026-10';

-- ============================================================
-- A. 已全部通过组（7 人）
--    由各自项目负责人审批；一手过掉的单人项目由 HR 代审
-- ============================================================
-- RD-2026-001 / RD-2026-004 负责人 = liusen
UPDATE approvals a
   SET status      = 'approved'::approval_status,
       approver_id = (SELECT id FROM users WHERE username = 'liusen'),
       acted_at    = TIMESTAMPTZ '2026-11-02 10:15:00+08'
  FROM projects p, users u
 WHERE a.project_id = p.id
   AND a.user_id    = u.id
   AND a.period     = '2026-10'
   AND p.code IN ('RD-2026-001', 'RD-2026-004')
   AND u.username IN ('liusen','panhongyang','zhoutao','lujian','zhangyong',
                      'liaohonghui','wuzhouyang','shanshijie','zhuxiaobo','luhuanhuan');

-- RD-2026-002 负责人 = panhongyang
UPDATE approvals a
   SET status      = 'approved'::approval_status,
       approver_id = (SELECT id FROM users WHERE username = 'panhongyang'),
       acted_at    = TIMESTAMPTZ '2026-11-02 11:40:00+08'
  FROM projects p, users u
 WHERE a.project_id = p.id AND a.user_id = u.id AND a.period = '2026-10'
   AND p.code = 'RD-2026-002'
   AND u.username IN ('panhongyang','zhoutao','lujian','zhangyong',
                      'liaohonghui','wuzhouyang','shanshijie','zhuxiaobo','luhuanhuan');

-- RD-2026-003 负责人 = zhoutao
UPDATE approvals a
   SET status      = 'approved'::approval_status,
       approver_id = (SELECT id FROM users WHERE username = 'zhoutao'),
       acted_at    = TIMESTAMPTZ '2026-11-02 14:05:00+08'
  FROM projects p, users u
 WHERE a.project_id = p.id AND a.user_id = u.id AND a.period = '2026-10'
   AND p.code = 'RD-2026-003'
   AND u.username IN ('zhoutao','lujian','zhangyong','shanshijie','luhuanhuan');

-- 非研发培训项由 HR 审核
UPDATE approvals a
   SET status      = 'approved'::approval_status,
       approver_id = (SELECT id FROM users WHERE username = 'lancunqing'),
       acted_at    = TIMESTAMPTZ '2026-11-03 09:20:00+08'
  FROM projects p, users u
 WHERE a.project_id = p.id AND a.user_id = u.id AND a.period = '2026-10'
   AND p.code = 'TRN-2026-001'
   AND u.username IN ('liusen','lujian','zhangyong','wenxuedong');

-- ------------------------------------------------------------
-- B. 制造「审批进行中」：3 个人保留待审
--    （wuzhouyang 的 RD-2026-001、shanshijie 的 RD-2026-003、
--      luhuanhuan 的 RD-2026-002 挂起）
-- ------------------------------------------------------------
UPDATE approvals a
   SET status = 'pending'::approval_status, approver_id = NULL, acted_at = NULL
  FROM projects p, users u
 WHERE a.project_id = p.id AND a.user_id = u.id AND a.period = '2026-10'
   AND (
        (u.username = 'wuzhouyang'  AND p.code = 'RD-2026-001')
     OR (u.username = 'shanshijie'  AND p.code = 'RD-2026-003')
     OR (u.username = 'luhuanhuan'  AND p.code = 'RD-2026-002')
   );

-- 这 3 人的工时单退回「已提交」状态（因还有待审单）
UPDATE timesheets t
   SET status = 'submitted'::timesheet_status, approved_at = NULL, approved_by = NULL
  FROM users u
 WHERE t.user_id = u.id AND t.period = '2026-10'
   AND u.username IN ('wuzhouyang', 'shanshijie', 'luhuanhuan');

-- ------------------------------------------------------------
-- C. 制造「已驳回」：wenxuedong 的报工被退回（工时未报满）
-- ------------------------------------------------------------
UPDATE approvals a
   SET status      = 'rejected'::approval_status,
       approver_id = (SELECT id FROM users WHERE username = 'zhoutao'),
       acted_at    = TIMESTAMPTZ '2026-11-03 15:45:00+08',
       reason      = '10/29、10/30 两日填报合计 6 小时，低于当日考勤 8 小时且未说明原因，请核实后重新提交'
  FROM users u
 WHERE a.user_id = u.id AND a.period = '2026-10'
   AND u.username = 'wenxuedong';

UPDATE timesheets t
   SET status        = 'rejected'::timesheet_status,
       reject_reason = '10/29、10/30 两日填报合计 6 小时，低于当日考勤 8 小时且未说明原因，请核实后重新提交',
       reject_count  = 1,
       approved_at   = NULL,
       approved_by   = NULL
  FROM users u
 WHERE t.user_id = u.id AND t.period = '2026-10' AND u.username = 'wenxuedong';

-- ------------------------------------------------------------
-- D. 其余人员工时单联动为「已通过」
-- ------------------------------------------------------------
UPDATE timesheets t
   SET status      = 'approved'::timesheet_status,
       approved_at = TIMESTAMPTZ '2026-11-03 10:00:00+08',
       approved_by = (SELECT id FROM users WHERE username = 'lancunqing')
 WHERE t.period = '2026-10'
   AND t.id IN (
     SELECT a.timesheet_id FROM approvals a
      WHERE a.period = '2026-10'
      GROUP BY a.timesheet_id
     HAVING count(*) FILTER (WHERE a.status = 'pending')  = 0
        AND count(*) FILTER (WHERE a.status = 'rejected') = 0
   );

COMMIT;

-- ------------------------------------------------------------
-- 验证：状态分布
-- ------------------------------------------------------------


SELECT status AS 状态, count(*) AS 人数
  FROM timesheets WHERE period = '2026-10'
 GROUP BY status ORDER BY 2 DESC;



SELECT status AS 状态, count(*) AS 单数, sum(hours) AS 工时合计
  FROM approvals WHERE period = '2026-10'
 GROUP BY status ORDER BY 2 DESC;



SELECT u.display_name AS 姓名, p.code AS 项目, a.hours AS 工时, a.due_at AS 审批时限
  FROM approvals a JOIN users u ON u.id = a.user_id JOIN projects p ON p.id = a.project_id
 WHERE a.period = '2026-10' AND a.status = 'pending'
 ORDER BY u.display_name;