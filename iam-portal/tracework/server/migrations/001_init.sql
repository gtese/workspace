-- 研发工时填报与分摊系统 — 初始化数据库结构
-- PostgreSQL 14+
-- 版本：1.0.0

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- 枚举
-- ============================================================
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'hr', 'pm', 'employee');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE timesheet_status AS ENUM ('draft', 'submitted', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE approval_status AS ENUM ('pending', 'approved', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE employee_type AS ENUM ('fulltime_rnd', 'parttime_rnd', 'support', 'intern', 'external');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- 用户（由 AD 同步而来，本地仅保存角色与业务属性）
-- ============================================================
CREATE TABLE IF NOT EXISTS users (
  id              BIGSERIAL PRIMARY KEY,
  username        TEXT        NOT NULL UNIQUE,          -- sAMAccountName
  display_name    TEXT        NOT NULL DEFAULT '',
  email           TEXT,
  ad_dn           TEXT,
  department      TEXT,
  title           TEXT,
  role            user_role   NOT NULL DEFAULT 'employee',
  employee_no     TEXT UNIQUE,                          -- 员工编号 E1001
  employee_type   employee_type NOT NULL DEFAULT 'fulltime_rnd',
  manager_id      BIGINT      REFERENCES users(id) ON DELETE SET NULL,
  monthly_salary  NUMERIC(14,2) NOT NULL DEFAULT 0,     -- 应付职工薪酬总额
  attendance_hours NUMERIC(8,2),                        -- 默认月标准考勤工时（可被月度考勤覆盖）
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  ad_groups       TEXT[]      NOT NULL DEFAULT '{}',
  last_login_at   TIMESTAMPTZ,
  synced_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_role   ON users(role) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_users_active ON users(is_active);

-- ============================================================
-- 项目
-- ============================================================
CREATE TABLE IF NOT EXISTS projects (
  id            BIGSERIAL PRIMARY KEY,
  code          TEXT        NOT NULL UNIQUE,            -- RD-2026-001
  name          TEXT        NOT NULL,
  description   TEXT        NOT NULL DEFAULT '',
  owner_id      BIGINT      REFERENCES users(id) ON DELETE SET NULL, -- 项目负责人
  is_rnd        BOOLEAN     NOT NULL DEFAULT TRUE,      -- FALSE 表示非研发归集项（培训等）
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  start_date    DATE,
  end_date      DATE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_project_code CHECK (code ~ '^[A-Za-z0-9_\-]{2,32}$')
);
CREATE INDEX IF NOT EXISTS idx_projects_active ON projects(is_active);

-- 项目成员（谁可以往这个项目报工）
CREATE TABLE IF NOT EXISTS project_members (
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     BIGINT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);

-- ============================================================
-- 法定节假日 / 调休工作日日历
-- ============================================================
CREATE TABLE IF NOT EXISTS calendar_days (
  day        DATE PRIMARY KEY,
  is_workday BOOLEAN NOT NULL,
  note       TEXT NOT NULL DEFAULT ''
);

-- ============================================================
-- 月度考勤（HR 导入或录入）
-- ============================================================
CREATE TABLE IF NOT EXISTS attendance (
  id           BIGSERIAL PRIMARY KEY,
  user_id      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period       CHAR(7) NOT NULL,                        -- 'YYYY-MM'
  workdays     NUMERIC(6,2) NOT NULL DEFAULT 0,         -- 当月应出勤天数
  hours        NUMERIC(8,2) NOT NULL DEFAULT 0,         -- 当月考勤工时
  source       TEXT NOT NULL DEFAULT 'manual',          -- manual | import | default
  imported_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, period),
  CONSTRAINT chk_att_period CHECK (period ~ '^\d{4}-\d{2}$')
);

-- ============================================================
-- 工时明细（逐日逐项目）
-- ============================================================
CREATE TABLE IF NOT EXISTS time_entries (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date   DATE   NOT NULL,
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  hours       NUMERIC(5,2) NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_date, project_id),
  CONSTRAINT chk_entry_hours CHECK (hours > 0 AND hours <= 24),
  CONSTRAINT chk_entry_step  CHECK ((hours * 2) = floor(hours * 2))
);
CREATE INDEX IF NOT EXISTS idx_entries_user_date ON time_entries(user_id, work_date);
CREATE INDEX IF NOT EXISTS idx_entries_project   ON time_entries(project_id);
-- 按月查询很常见，但 date_trunc('month', ...) 不是 IMMUTABLE，无法直接建表达式索引。
-- 改为对 work_date 建普通索引（范围扫描同样能命中），并按 (user_id, work_date) 覆盖月度查询。
CREATE INDEX IF NOT EXISTS idx_entries_work_date ON time_entries(work_date);

-- ============================================================
-- 月度工时单（提交/审批单元）
-- ============================================================
CREATE TABLE IF NOT EXISTS timesheets (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period        CHAR(7) NOT NULL,
  status        timesheet_status NOT NULL DEFAULT 'draft',
  rnd_hours     NUMERIC(9,2) NOT NULL DEFAULT 0,
  non_rnd_hours NUMERIC(9,2) NOT NULL DEFAULT 0,
  total_hours   NUMERIC(9,2) NOT NULL DEFAULT 0,
  attendance_hours NUMERIC(9,2) NOT NULL DEFAULT 0,
  submitted_at  TIMESTAMPTZ,
  approved_at   TIMESTAMPTZ,
  approved_by   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reject_reason TEXT NOT NULL DEFAULT '',
  reject_count  INT  NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, period),
  CONSTRAINT chk_ts_period CHECK (period ~ '^\d{4}-\d{2}$')
);
CREATE INDEX IF NOT EXISTS idx_ts_period_status ON timesheets(period, status);

-- ============================================================
-- 审批记录（按 人 × 项目 拆分，与原型一致）
-- ============================================================
CREATE TABLE IF NOT EXISTS approvals (
  id            BIGSERIAL PRIMARY KEY,
  timesheet_id  BIGINT NOT NULL REFERENCES timesheets(id) ON DELETE CASCADE,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  period        CHAR(7) NOT NULL,
  hours         NUMERIC(9,2) NOT NULL,
  status        approval_status NOT NULL DEFAULT 'pending',
  approver_id   BIGINT REFERENCES users(id) ON DELETE SET NULL,
  submit_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  due_at        TIMESTAMPTZ,
  acted_at      TIMESTAMPTZ,
  reason        TEXT NOT NULL DEFAULT '',
  UNIQUE (timesheet_id, project_id)
);
CREATE INDEX IF NOT EXISTS idx_appr_status  ON approvals(status);
CREATE INDEX IF NOT EXISTS idx_appr_period  ON approvals(period);
CREATE INDEX IF NOT EXISTS idx_appr_approver ON approvals(approver_id, status);

-- ============================================================
-- 月度分摊结果快照（提交财务后冻结，保证可追溯）
-- ============================================================
CREATE TABLE IF NOT EXISTS allocation_runs (
  id             BIGSERIAL PRIMARY KEY,
  period         CHAR(7) NOT NULL UNIQUE,
  total_hours    NUMERIC(12,2) NOT NULL DEFAULT 0,
  salary_total   NUMERIC(16,2) NOT NULL DEFAULT 0,
  alloc_total    NUMERIC(16,2) NOT NULL DEFAULT 0,
  non_rnd_salary NUMERIC(16,2) NOT NULL DEFAULT 0,
  tie_diff       NUMERIC(16,2) NOT NULL DEFAULT 0,
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 审计日志
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id          BIGSERIAL PRIMARY KEY,
  at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_id    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_name  TEXT NOT NULL DEFAULT '',
  action      TEXT NOT NULL,
  target      TEXT NOT NULL DEFAULT '',
  period      CHAR(7),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at     ON audit_logs(at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_logs(actor_id);

-- ============================================================
-- 触发器：updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_users_touch ON users;
CREATE TRIGGER trg_users_touch BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_projects_touch ON projects;
CREATE TRIGGER trg_projects_touch BEFORE UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_entries_touch ON time_entries;
CREATE TRIGGER trg_entries_touch BEFORE UPDATE ON time_entries FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

COMMIT;