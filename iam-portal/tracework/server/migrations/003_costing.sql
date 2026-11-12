-- ============================================================
-- 科研项目管理平台 · 第二阶段：研发费用归集与备查体系
-- ============================================================
-- 在原有「工时填报与分摊」之上，扩展为完整的科研项目管理平台：
--   · 项目七要素（立项/可行性/任务书/结题）
--   · 研发费用六类归集（人工/直接投入/折旧/摊销/设计费/其他）
--   · 公共费用分摊（折旧、水电、房租）
--   · 委托与合作研发
--   · 14 类备查台账
--   · 多口径测算（加计扣除 / 高企认定 / 会计准则 / R&D 统计）
--   · 备查资料文档生成记录
--
-- 设计原则：金额一律 numeric(16,2)，单位「万元」在接口层统一（与申报表口径一致）
-- ============================================================

-- 新增「财务」角色：研发费用归集与备查资料主要由财务岗维护。
-- ALTER TYPE ... ADD VALUE 不能在事务块中执行，故放在 BEGIN 之前。
DO $$ BEGIN
  ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'finance';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

BEGIN;

-- ============================================================
-- 枚举
-- ============================================================

DO $$ BEGIN
  CREATE TYPE project_form AS ENUM ('自主研发','合作研发','委托研发','受托研发','集中研发');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE project_stage AS ENUM ('立项','在研','中期','结题','终止');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE cost_category AS ENUM ('labor','direct','dep','amort','design','other');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE txn_direction AS ENUM ('out','in');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE approval_state AS ENUM ('draft','pending','approved','rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE doc_status AS ENUM ('missing','draft','ready','locked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ============================================================
-- 1. 企业档案（申报主体信息，多口径测算的输入）
-- ============================================================
CREATE TABLE IF NOT EXISTS company_profile (
  id                BIGSERIAL PRIMARY KEY,
  name              TEXT NOT NULL DEFAULT '',
  credit_code       TEXT,                      -- 统一社会信用代码
  industry          TEXT,
  establish_date    DATE,
  address           TEXT,
  legal_person      TEXT,
  rd_institution    TEXT,                      -- 研发机构名称
  rd_leader         TEXT,
  rd_leader_phone   TEXT,
  finance_officer   TEXT,
  contact           TEXT,
  -- 加计扣除相关
  negative_industry BOOLEAN NOT NULL DEFAULT FALSE,  -- 是否负面清单行业
  negative_ratio    NUMERIC(6,2) NOT NULL DEFAULT 0, -- 该类收入占比(%)
  deduct_rate       NUMERIC(6,2) NOT NULL DEFAULT 100, -- 加计比例(%)：100 或 75
  -- 高企八大指标相关（近三年）
  total_revenue     NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_revenue_3y  NUMERIC(16,2) NOT NULL DEFAULT 0,
  rd_expense_3y     NUMERIC(16,2) NOT NULL DEFAULT 0,
  rd_expense_year   NUMERIC(16,2) NOT NULL DEFAULT 0,
  rd_domestic_3y    NUMERIC(16,2) NOT NULL DEFAULT 0,
  high_tech_income  NUMERIC(16,2) NOT NULL DEFAULT 0,
  total_staff       INT NOT NULL DEFAULT 0,
  tech_staff        INT NOT NULL DEFAULT 0,
  innovation_score  NUMERIC(6,2) NOT NULL DEFAULT 0,
  last_audit        TEXT,
  audit_firm        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 2. 扩展项目：七要素与立项信息
-- ============================================================
ALTER TABLE projects ADD COLUMN IF NOT EXISTS field         TEXT;              -- 技术领域
ALTER TABLE projects ADD COLUMN IF NOT EXISTS form          project_form NOT NULL DEFAULT '自主研发';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS stage         project_stage  NOT NULL DEFAULT '在研';
ALTER TABLE projects ADD COLUMN IF NOT EXISTS leader        TEXT;              -- 项目负责人（可与 owner_id 并存）
ALTER TABLE projects ADD COLUMN IF NOT EXISTS member_count  INT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS objective     TEXT;              -- 研发目标
ALTER TABLE projects ADD COLUMN IF NOT EXISTS tech_route    TEXT;              -- 技术路线
ALTER TABLE projects ADD COLUMN IF NOT EXISTS innovation    TEXT;              -- 创新点
ALTER TABLE projects ADD COLUMN IF NOT EXISTS budget        NUMERIC(16,2);     -- 预算（万元）
ALTER TABLE projects ADD COLUMN IF NOT EXISTS acceptance    TEXT;              -- 验收标准
ALTER TABLE projects ADD COLUMN IF NOT EXISTS decide_date   DATE;              -- 立项决议日期
ALTER TABLE projects ADD COLUMN IF NOT EXISTS decide_no     TEXT;              -- 立项决议文号
ALTER TABLE projects ADD COLUMN IF NOT EXISTS finish_date   DATE;              -- 结题日期
CREATE INDEX IF NOT EXISTS idx_projects_stage ON projects(stage);
CREATE INDEX IF NOT EXISTS idx_projects_form  ON projects(form);

-- ============================================================
-- 3. 研发费用明细账（辅助账的基础交易流水）
-- ============================================================
CREATE TABLE IF NOT EXISTS cost_entries (
  id            BIGSERIAL PRIMARY KEY,
  period        CHAR(7) NOT NULL,                     -- YYYY-MM
  project_id    BIGINT REFERENCES projects(id) ON DELETE CASCADE,
  category      cost_category NOT NULL,
  sub_item      TEXT,                                  -- 明细科目
  amount        NUMERIC(16,2) NOT NULL DEFAULT 0,      -- 万元
  direction     txn_direction NOT NULL DEFAULT 'out',  -- out=费用发生 in=冲减
  occurred_on   DATE,
  voucher_no    TEXT,                                  -- 凭证号
  counterparty  TEXT,                                  -- 供应商/对方单位
  summary       TEXT,
  source        TEXT NOT NULL DEFAULT 'manual',        -- manual|time_labor|shared_alloc|import|auto
  source_ref    TEXT,                                  -- 自动生成的来源标识，防重复
  created_by    BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_cost_period CHECK (period ~ '^\d{4}-\d{2}$')
);
CREATE INDEX IF NOT EXISTS idx_cost_period   ON cost_entries(period);
CREATE INDEX IF NOT EXISTS idx_cost_project  ON cost_entries(project_id, category);
CREATE INDEX IF NOT EXISTS idx_cost_category ON cost_entries(category);
-- 同一来源引用只允许一条，保证「从工时自动生成人工费用」可重复执行而不重复计账。
-- 注意：必须建成**具名约束**而非部分唯一索引 ——
-- ON CONFLICT (col) 无法推断带 WHERE 的部分索引，会报 42P10。
-- PostgreSQL 中 UNIQUE 约束默认允许多个 NULL，正好满足「手工录入的 source_ref 为空」的场景。
DO $$ BEGIN
  ALTER TABLE cost_entries ADD CONSTRAINT uq_cost_source_ref UNIQUE (source_ref);
EXCEPTION WHEN duplicate_table OR duplicate_object THEN NULL; END $$;

COMMIT;

-- 第二段：公共费用、委外、台账、测算快照与文档
BEGIN;
-- ============================================================
-- 4. 公共费用（折旧/水电/房租）与分摊依据
-- ============================================================
CREATE TABLE IF NOT EXISTS shared_expenses (
  id             BIGSERIAL PRIMARY KEY,
  period         CHAR(7) NOT NULL,
  item           TEXT NOT NULL,                        -- 费用项目名称
  category       cost_category NOT NULL DEFAULT 'other',
  total_amount   NUMERIC(16,2) NOT NULL DEFAULT 0,     -- 该项费用总额（万元）
  basis_total    NUMERIC(16,2) NOT NULL DEFAULT 0,     -- 分摊基数合计
  basis_rd       NUMERIC(16,2) NOT NULL DEFAULT 0,     -- 其中研发使用量
  basis_unit     TEXT DEFAULT '',                      -- 基数单位（工时/面积等）
  basis_note     TEXT DEFAULT '',                      -- 分摊依据说明
  note           TEXT DEFAULT '',
  created_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_shared_period CHECK (period ~ '^\d{4}-\d{2}$'),
  CONSTRAINT chk_shared_rate CHECK (basis_total = 0 OR basis_rd <= basis_total),
  CONSTRAINT chk_shared_nonneg CHECK (total_amount >= 0 AND basis_total >= 0 AND basis_rd >= 0)
);
CREATE INDEX IF NOT EXISTS idx_shared_period ON shared_expenses(period);

-- ============================================================
-- 5. 委外 / 合作研发
-- ============================================================
CREATE TABLE IF NOT EXISTS outsource_contracts (
  id             BIGSERIAL PRIMARY KEY,
  project_id     BIGINT REFERENCES projects(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL DEFAULT '委托研发',      -- 委托研发 | 合作研发
  party          TEXT NOT NULL DEFAULT '',             -- 受托/合作单位
  content        TEXT DEFAULT '',                      -- 研发内容
  amount         NUMERIC(16,2) NOT NULL DEFAULT 0,     -- 合同金额（万元）
  actual_amount  NUMERIC(16,2) NOT NULL DEFAULT 0,     -- 实际发生额（万元）
  is_domestic    BOOLEAN NOT NULL DEFAULT TRUE,        -- 境内/境外
  is_related     BOOLEAN NOT NULL DEFAULT FALSE,       -- 是否关联方
  tech_reg_no    TEXT,                                 -- 科技部门登记号
  reg_date       DATE,
  our_input      NUMERIC(16,2) NOT NULL DEFAULT 0,     -- 合作研发本方投入
  other_input    NUMERIC(16,2) NOT NULL DEFAULT 0,     -- 合作研发对方投入
  ownership      TEXT,                                 -- 成果归属约定
  acceptance     TEXT,                                 -- 阶段成果验收情况
  pay_match      TEXT,                                 -- 付款与成果匹配
  note           TEXT DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_os_nonneg CHECK (amount >= 0 AND actual_amount >= 0)
);
CREATE INDEX IF NOT EXISTS idx_os_project ON outsource_contracts(project_id);

-- ============================================================
-- 6. 人员名册扩展（科技人员认定所需）
-- ============================================================
ALTER TABLE users ADD COLUMN IF NOT EXISTS education      TEXT;              -- 学历
ALTER TABLE users ADD COLUMN IF NOT EXISTS major          TEXT;              -- 专业
ALTER TABLE users ADD COLUMN IF NOT EXISTS post           TEXT;              -- 岗位
ALTER TABLE users ADD COLUMN IF NOT EXISTS rd_duty        TEXT;              -- 主要研发职责
ALTER TABLE users ADD COLUMN IF NOT EXISTS join_date      DATE;              -- 入职/合作起始
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_tech_staff  BOOLEAN NOT NULL DEFAULT FALSE; -- 科技人员标识
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_rd_staff    BOOLEAN NOT NULL DEFAULT TRUE;  -- 是否研发人员
ALTER TABLE users ADD COLUMN IF NOT EXISTS certify_note   TEXT;              -- 佐证材料

-- ============================================================
-- 7. 备查台账（14 类，统一结构化存储）
-- ============================================================
-- 采用「台账类型 + JSONB 行数据」设计：
--   各类台账字段差异很大（人员名册 vs 物料去向 vs 资本化判定），
--   用固定列会导致上百个稀疏字段。JSONB 保留灵活性的同时，
--   由应用层的 LEDGER 定义统一约束字段、类型与校验规则。
CREATE TABLE IF NOT EXISTS ledger_rows (
  id          BIGSERIAL PRIMARY KEY,
  ledger_key  TEXT NOT NULL,                    -- roster / transfer / materialIn / ...
  period      CHAR(7),                          -- 可选的归属月份
  project_id  BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  seq         INT NOT NULL DEFAULT 0,           -- 行序
  created_by  BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ledger_key    ON ledger_rows(ledger_key);
CREATE INDEX IF NOT EXISTS idx_ledger_period ON ledger_rows(ledger_key, period);
CREATE INDEX IF NOT EXISTS idx_ledger_data   ON ledger_rows USING gin(data);

-- ============================================================
-- 8. 多口径测算快照（按月/按年冻结，供申报与审计追溯）
-- ============================================================
CREATE TABLE IF NOT EXISTS deduction_runs (
  id             BIGSERIAL PRIMARY KEY,
  period         TEXT NOT NULL,                 -- 'YYYY' 年度 或 'YYYY-MM'
  scope          TEXT NOT NULL DEFAULT 'year',  -- year | month
  payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
  anti_rd_base   NUMERIC(16,2) NOT NULL DEFAULT 0,   -- 加计扣除基数
  deduction      NUMERIC(16,2) NOT NULL DEFAULT 0,   -- 加计扣除额
  hi_rd          NUMERIC(16,2) NOT NULL DEFAULT 0,   -- 高企口径研发费用
  accounting_rd  NUMERIC(16,2) NOT NULL DEFAULT 0,   -- 会计口径
  stat_rd        NUMERIC(16,2) NOT NULL DEFAULT 0,   -- R&D 统计口径
  created_by     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (period, scope)
);

-- ============================================================
-- 9. 备查资料文档生成记录
-- ============================================================
CREATE TABLE IF NOT EXISTS generated_docs (
  id           BIGSERIAL PRIMARY KEY,
  doc_key      TEXT NOT NULL,                   -- t01 ~ t36
  period       TEXT NOT NULL,                   -- 所属年度
  status       doc_status NOT NULL DEFAULT 'draft',
  payload      JSONB NOT NULL DEFAULT '{}'::jsonb,   -- 生成时的数据快照
  generated_at TIMESTAMPTZ,
  generated_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (doc_key, period)
);

-- ============================================================
-- 10. 触发器
-- ============================================================
DROP TRIGGER IF EXISTS trg_cost_touch ON cost_entries;
CREATE TRIGGER trg_cost_touch BEFORE UPDATE ON cost_entries
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_shared_touch ON shared_expenses;
CREATE TRIGGER trg_shared_touch BEFORE UPDATE ON shared_expenses
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_os_touch ON outsource_contracts;
CREATE TRIGGER trg_os_touch BEFORE UPDATE ON outsource_contracts
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
DROP TRIGGER IF EXISTS trg_ledger_touch ON ledger_rows;
CREATE TRIGGER trg_ledger_touch BEFORE UPDATE ON ledger_rows
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- 单例企业档案
INSERT INTO company_profile (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

COMMIT;
