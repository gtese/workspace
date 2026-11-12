-- ============================================================
-- 演示数据：基础配置（项目 / 人员 / 考勤 / 成员）
-- ============================================================
-- 场景：2026-10 某芯片研发部门的月度工时填报
--   · 4 个研发项目 + 1 个非研发归集项（外部培训）
--   · 12 位研发人员（含 2 位兼职研发承担管理职能）
--   · HR 已录入当月考勤（17 个工作日 × 8 小时 = 136 小时）
--
-- 作息说明：2026-10 法定节假日为 10/1–10/8，10/10 调休上班。
--   故当月工作日为 17 天：10/9、10/12–10/16、10/19–10/23、10/26–10/30
--
-- 幂等：脚本开头清空全部业务数据，可安全重复执行。
-- 依赖：先执行 003a_demo_base.sql，再执行 003b_demo_entries.sql
-- ============================================================

BEGIN;

-- ------------------------------------------------------------
-- 0. 清空业务数据（保留 AD 用户与节假日日历）
-- ------------------------------------------------------------
DELETE FROM allocation_runs;
DELETE FROM approvals;
DELETE FROM timesheets;
DELETE FROM time_entries;
DELETE FROM attendance;
DELETE FROM project_members;
DELETE FROM projects;

-- 重置用户业务属性，稍后统一赋值
UPDATE users SET
  monthly_salary   = 0,
  employee_no      = NULL,
  manager_id       = NULL,
  attendance_hours = NULL,
  employee_type    = 'fulltime_rnd'::employee_type,
  role = CASE WHEN role = 'admin'::user_role
              THEN 'admin'::user_role
              ELSE 'employee'::user_role END;

-- ------------------------------------------------------------
-- 1. 研发项目
-- ------------------------------------------------------------
INSERT INTO projects (code, name, description, is_rnd, is_active, start_date) VALUES
  ('RD-2026-001', '高性能AI芯片研发',
   '面向边缘推理的高能效 AI 加速芯片，含架构设计、RTL 实现与验证',        TRUE,  TRUE, '2026-01-06'),
  ('RD-2026-002', '车规级MCU开发',
   '符合 AEC-Q100 Grade 1 的 32 位车规微控制器，含功能安全设计',          TRUE,  TRUE, '2026-02-02'),
  ('RD-2026-003', '芯片测试平台建设',
   'ATE 测试程序开发与测试板卡设计，提升量产测试覆盖率',                  TRUE,  TRUE, '2026-03-02'),
  ('RD-2026-004', '工艺PDK开发',
   '面向 22nm 工艺的 PDK 与标准单元库开发，配套 DRC/LVS 规则',           TRUE,  TRUE, '2026-04-01'),
  ('TRN-2026-001', '非研发 · 外部技术培训',
   '员工参加外部机构培训，属非研发活动，对应薪酬不计入研发费用',          FALSE, TRUE, '2026-01-01');

-- ------------------------------------------------------------
-- 2. 角色与研发类型
-- ------------------------------------------------------------
-- 人力资源部
UPDATE users SET role = 'hr'::user_role, employee_type = 'support'::employee_type
 WHERE username = 'lancunqing';

-- 项目负责人
UPDATE users SET role = 'pm'::user_role
 WHERE username IN ('liusen', 'panhongyang', 'zhoutao');

-- 兼职研发（承担部分管理职能）—— 这类人员的管理工时属非研发，需单独归集
UPDATE users SET employee_type = 'parttime_rnd'::employee_type
 WHERE username IN ('lujian', 'zhangyong');

-- ------------------------------------------------------------
-- 3. 工号与职工薪酬（含五险一金口径）
-- ------------------------------------------------------------
-- 说明：只有「从事研发活动的人员」才有职工薪酬进入研发费用分摊。
--       lancunqing 是人力资源部（support），其薪酬不参与研发费用归集，
--       因此在本场景中不设置月薪与研发工时 —— 否则会造成勾稽不平
--       （有薪酬但无工时，分摊无处归集）。
UPDATE users u
   SET employee_no = v.emp_no,
       monthly_salary = v.salary,
       attendance_hours = 136
  FROM (VALUES
    ('liusen',      'E1001', 38000),
    ('panhongyang', 'E1002', 34000),
    ('zhoutao',     'E1003', 32000),
    ('lujian',      'E1005', 42000),
    ('zhangyong',   'E1006', 40000),
    ('liaohonghui', 'E1007', 28000),
    ('wuzhouyang',  'E1008', 30000),
    ('shanshijie',  'E1009', 24000),
    ('zhuxiaobo',   'E1010', 22000),
    ('luhuanhuan',  'E1011', 26000),
    ('wenxuedong',  'E1012', 25000)
  ) AS v(un, emp_no, salary)
 WHERE u.username = v.un;

-- HR 保留工号与考勤口径，但不计入研发薪酬分摊
UPDATE users SET employee_no = 'E1004', attendance_hours = 136, monthly_salary = 0
 WHERE username = 'lancunqing';

-- ------------------------------------------------------------
-- 4. 项目负责人
-- ------------------------------------------------------------
UPDATE projects SET owner_id = (SELECT id FROM users WHERE username = 'liusen')
 WHERE code IN ('RD-2026-001', 'RD-2026-004');
UPDATE projects SET owner_id = (SELECT id FROM users WHERE username = 'panhongyang')
 WHERE code = 'RD-2026-002';
UPDATE projects SET owner_id = (SELECT id FROM users WHERE username = 'zhoutao')
 WHERE code = 'RD-2026-003';

-- ------------------------------------------------------------
-- 5. 项目成员范围
--    说明：项目的成员表为空时表示「全员可报工」；这里显式限定核心成员，
--          使非成员在填报页看不到该项目，验证成员范围控制生效。
--          培训项（TRN-2026-001）不设成员，全员可选。
-- ------------------------------------------------------------
INSERT INTO project_members (project_id, user_id)
SELECT p.id, u.id
  FROM projects p, users u
 WHERE (p.code = 'RD-2026-001'
        AND u.username IN ('liusen','lujian','liaohonghui','wuzhouyang','panhongyang',
                           'shanshijie','zhuxiaobo','luhuanhuan','wenxuedong'))
    OR (p.code = 'RD-2026-002'
        AND u.username IN ('panhongyang','lujian','zhangyong','wuzhouyang',
                           'zhuxiaobo','luhuanhuan'))
    OR (p.code = 'RD-2026-003'
        AND u.username IN ('zhoutao','zhangyong','shanshijie','luhuanhuan','wenxuedong'))
    OR (p.code = 'RD-2026-004'
        AND u.username IN ('liusen','liaohonghui','shanshijie','wuzhouyang'))
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- 6. 月度考勤（2026-10：17 个工作日 × 8 小时 = 136 小时）
--    兼职研发人员因承担管理职能，考勤口径仍按标准工时
-- ------------------------------------------------------------
INSERT INTO attendance (user_id, period, workdays, hours, source)
SELECT u.id, '2026-10', 17, 136, 'manual'
  FROM users u
 WHERE u.username IN ('liusen','panhongyang','zhoutao','lancunqing','lujian','zhangyong',
                      'liaohonghui','wuzhouyang','shanshijie','zhuxiaobo','luhuanhuan','wenxuedong')
ON CONFLICT (user_id, period) DO UPDATE
   SET workdays = EXCLUDED.workdays,
       hours    = EXCLUDED.hours,
       source   = EXCLUDED.source;

COMMIT;

-- ------------------------------------------------------------
-- 验证
-- ------------------------------------------------------------


SELECT
  (SELECT count(*) FROM projects)   AS 项目数,
  (SELECT count(*) FROM users WHERE monthly_salary > 0) AS 有薪酬人员,
  (SELECT count(*) FROM attendance WHERE period = '2026-10') AS 考勤记录,
  (SELECT count(*) FROM users WHERE role = 'pm') AS 项目负责人,
  (SELECT count(*) FROM users WHERE role = 'hr') AS 人力资源部;