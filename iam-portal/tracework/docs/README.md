# Tri科研项目职能支持系统

面向研发费用归集与高新技术企业认定的**工时填报、审批与薪酬分摊**系统。
使用公司域账号（Active Directory）登录，前端 + PostgreSQL 后端，容器化部署。

- **访问地址**：<https://work.tri.local>（兼容保留：<https://man.tri.local>）
- **部署主机**：`trivm122.tri.local`（172.16.50.122）
- **版本**：1.0.0

---

## 1. 系统解决了什么问题

原型（`研发工时填报系统模块.html`）是一个纯前端的流程演示，数据全部硬编码，刷新即丢失。
本系统把它变成真正能交付使用的生产系统，关键变化：

| 维度 | 原型 | 本系统 |
|---|---|---|
| 数据 | 硬编码在 JS 里 | PostgreSQL 持久化，多用户并发 |
| 登录 | 无 | AD 域账号认证（LDAP bind），角色自动映射 |
| 人员 | 4 个假员工 | 从 AD 同步真实员工目录（56 用户 / 58 组） |
| 填报 | 前端假保存 | 逐日逐项目落库，服务端校验 |
| 审批 | 前端改内存变量 | 真实状态机 + 审批留痕 + 超期提示 |
| 汇总 | 写死结果 | 实时计算，口径可配置，可冻结留档 |
| 工作日 | 固定 22 天 | 内置法定节假日日历 + 调休 |
| 审计 | 无 | 全量操作审计日志 |
| 安全 | 无 | HTTPS、HttpOnly Cookie、限流、CSP、参数校验 |

---

## 2. 功能一览

### 2.1 我的工作台
- 本月研发/非研发工时、与考勤的差异、填报进度
- 报工状态（草稿/已提交/已通过/已驳回）与驳回原因
- 一键提交审批、撤回
- 待我审批的待办数量

### 2.2 工时填报
- 按工作日逐日填报，支持**一个工作日填多个项目**
- 工时最小单位 **0.5 小时**，服务端强校验
- 单日合计不得超过当日考勤额度（当月考勤工时 ÷ 出勤天数）
- 休息日/节假日填写会给出提示（加班等情形允许提交，由审批人判断）
- 「填满」快捷按钮：按额度补齐
- 支持 HR **代填**（带审计记录）

### 2.3 审批中心
- 项目负责人只看自己负责项目的报工；HR/管理员看全部
- 通过 / 驳回（驳回必须填原因）
- 审批时限按 **2 个工作日**自动计算，超期标红
- HR 支持按人批量通过
- 一张工时单下所有项目都通过后，主状态自动转「已通过」；任一被驳回则转「已驳回」

### 2.4 月度汇总与薪酬分摊
- 项目维度：参与人次、项目工时合计、分摊薪酬、工时占比
- 员工维度：研发工时 / 非研发工时 / 总工时 / 考勤 / 差异 / 异常标记 / 薪酬
- 流程图展示 5 步流转状态
- ECharts 双轴图展示工时与薪酬分布（图表不可用时降级为条形图）
- **勾稽校验**：项目分摊薪酬 + 非研发薪酬 − 职工薪酬总额 = 差异
- 导出 CSV（含三个分节，可直接给财务）
- HR 可「生成留档快照」，冻结当月数据用于审计追溯

### 2.5 人力与考勤
- 月度考勤维护（单人编辑 / 批量录入）
- 研发项目管理（新建、编辑、负责人、成员范围、启用停用）
- 操作审计日志查询

### 2.6 系统管理
- 用户角色与业务属性维护（角色、工号、研发类型、薪酬、标准考勤）
- 手动触发 AD 同步
- 法定节假日日历维护

---

## 3. 架构

```
                    ┌──────────────────────────────┐
  浏览器  ──443──▶  │  nginx（TLS 终止 / 域名分流） │
   HTTPS            └───────────────┬──────────────┘
                                   │ 127.0.0.1:3000
                    ┌──────────────▼──────────────┐
                    │  应用容器 rnd-ts-app         │
                    │  Fastify（API + 静态前端）    │
                    │  · 会话 JWT（HttpOnly Cookie）│
                    │  · 业务校验 / 状态机 / 分摊   │
                    └───────┬──────────────┬───────┘
                            │              │ LDAP 389
                ┌───────────▼──────┐   ┌───▼──────────────────┐
                │ rnd-ts-db        │   │ 域控 172.16.10.111   │
                │ PostgreSQL 16    │   │      172.16.10.112   │
                │ (命名卷持久化)    │   │ AD: tri.local        │
                └──────────────────┘   └──────────────────────┘
```

### 技术选型
- **后端**：Node.js 20 + Fastify 4，ESM，PostgreSQL 16
- **前端**：Vue 3 + Vite + Pinia + Vue Router + ECharts（构建产物由后端托管，无独立前端容器）
- **认证**：`ldapts` 直连域控；`jose` 签发 HS256 会话 JWT
- **部署**：podman + podman-compose，nginx 做 TLS 终止

---

## 4. AD 集成设计

### 4.1 认证流程（关键：系统不保存任何用户密码）

```
用户提交 用户名 + 密码
        │
        ▼
以 "{username}@tri.local" 向域控发起 LDAP bind   ← 用用户自己的密码
        │
   ┌────┴────┐
 成功       失败
   │          └─▶ 按 AD 错误码返回精确提示
   │              (52e 密码错误 / 532 密码过期 / 775 账号锁定 ...)
   ▼
用域服务账号 sa_ldap 读取该用户属性（姓名、邮箱、部门、memberOf）
   │
   ▼
校验是否属于 LDAP_ALLOWED_GROUPS（默认 Group_AllStaffs）
   │
   ▼
落地/更新本地 users 档案 → 签发会话 Cookie
```

**密码从不写入数据库、日志或内存缓存**，只用于一次 bind 请求。

### 4.2 角色映射

| AD 组 | 系统角色 | 权限 |
|---|---|---|
| `Group_Roots`、`Domain Admins` | 系统管理员 admin | 全部权限 |
| 其他（默认） | 研发人员 employee | 填报 + 查看自己的数据 |

`pm`（项目负责人）与 `hr`（人力资源部）由管理员在「系统管理」中指派。
这样做的好处是**上线不依赖改动 AD**，权限调整在系统内即时生效。

### 4.3 同步策略
- 服务启动时若本地用户表为空，自动全量同步一次
- 之后按 `LDAP_SYNC_INTERVAL_MINUTES`（默认 60 分钟）定时同步
- 管理员可在「系统管理」手动触发
- **只同步身份属性**（姓名、邮箱、部门、AD 组、在职状态），
  **绝不覆盖业务属性**（角色、工号、薪酬、考勤）
- AD 中已消失的用户标记为离职（`is_active=false`），不物理删除，保证历史工时可追溯

### 4.4 容错
- 多个域控地址按顺序故障转移（`LDAP_URLS`）
- 连接失效自动重建并重试一次
- AD 错误码精确翻译为中文提示（见 `server/src/ldap.js` 的 `classifyLdapError`）

---

## 5. 数据模型

| 表 | 说明 |
|---|---|
| `users` | 用户档案（AD 身份 + 本地业务属性） |
| `projects` | 研发项目（`is_rnd` 区分研发/非研发归集项） |
| `project_members` | 项目成员范围（为空表示全员可报工） |
| `calendar_days` | 法定节假日与调休工作日 |
| `attendance` | 月度考勤（用户 × 月份） |
| `time_entries` | 工时明细（用户 × 日期 × 项目，唯一约束） |
| `timesheets` | 月度工时单（提交/审批单元，状态机） |
| `approvals` | 审批记录（工时单 × 项目） |
| `allocation_runs` | 分摊结果快照（JSONB，冻结留档） |
| `audit_logs` | 操作审计日志 |

### 状态机

```
        保存/修改
   ┌──────────────┐
   ▼              │
 draft ──提交──▶ submitted ──全部通过──▶ approved
   ▲              │
   │              └──任一驳回──▶ rejected ──重新提交──▶ submitted
   └────── 撤回（未审批前）────────┘
```

---

## 6. 分摊算法

设员工 *e* 当月薪酬为 *S(e)*，在项目 *p* 上的研发工时为 *h(e,p)*，
非研发工时为 *n(e)*，则当月总工时 *T(e) = Σ_p h(e,p) + n(e)*。

1. **非研发薪酬**（不计入研发费用）
   `NonRnd(e) = S(e) × n(e) / T(e)`

2. **项目 *p* 分摊薪酬**
   `Alloc(p) = Σ_e [ S(e) × h(e,p) / T(e) ]`

3. **勾稽校验**
   `Σ_p Alloc(p) + Σ_e NonRnd(e) − Σ_e S(e) ≈ 0`（容差 0.05 元，吸收四舍五入）

> 注意：这里采用**按人加权**而非"全公司总工时占比"，因为每位员工的薪酬水平不同，
> 按人计算才符合研发费用实际归集口径。原型中的简化算法（`分摊额 = 总薪酬 × 项目工时占比`）
> 在员工薪酬差异较大时会产生归集偏差，本系统已修正。

---

## 7. 部署

### 7.1 前置条件
- Rocky Linux 8 / RHEL 8 及以上，已加入 AD 域
- 能访问域控 389/636 端口
- `*.tri.local` 通配证书（含私钥）

### 7.2 目录结构

```
/opt/rnd-timesheet/
├── server/              后端源码
│   ├── src/             应用代码
│   └── migrations/      SQL 迁移（启动时自动执行）
├── web/                 前端源码
└── deploy/
    ├── Containerfile    应用镜像
    ├── compose.yaml     编排定义
    ├── deploy.sh        一键部署脚本
    ├── .env             环境变量（含密钥，权限 600）
    ├── nginx-man.tri.local.conf
    └── certs/           TLS 证书
```

### 7.3 一键部署

```bash
cd /opt/rnd-timesheet
sudo bash deploy/deploy.sh install     # 首次安装
sudo bash deploy/deploy.sh upgrade     # 升级（重建镜像并滚动重启）
sudo bash deploy/deploy.sh status      # 查看状态
sudo bash deploy/deploy.sh backup      # 备份数据库
```

`install` 会依次完成：安装依赖包 → 安装证书并校验证书/私钥匹配 → 构建镜像 →
启动容器 → 配置 nginx → 开放防火墙 → 注册开机自启服务。

### 7.4 配置项（`deploy/.env`）

| 变量 | 说明 | 默认 |
|---|---|---|
| `POSTGRES_PASSWORD` | 数据库密码 | 安装时随机生成 |
| `SESSION_SECRET` | 会话签名密钥（≥32 字符） | 安装时随机生成 |
| `LDAP_URLS` | 域控地址，逗号分隔 | `ldap://172.16.10.111,ldap://172.16.10.112` |
| `LDAP_BASE_DN` | 目录根 | `DC=tri,DC=local` |
| `LDAP_BIND_DN` | 域服务账号 | `sa_ldap@tri.local` |
| `LDAP_BIND_PASSWORD` | 服务账号密码 | — |
| `LDAP_ALLOWED_GROUPS` | 允许登录的 AD 组 | `Group_AllStaffs` |
| `LDAP_ADMIN_GROUPS` | 自动授予管理员的 AD 组 | `Group_Roots,Domain Admins` |
| `LDAP_SYNC_INTERVAL_MINUTES` | 同步间隔（分钟，0 关闭） | `60` |
| `APPROVAL_SLA_WORKDAYS` | 审批时限（工作日） | `2` |
| `DEFAULT_ATTENDANCE_HOURS` | 默认月考勤工时（0=按工作日折算） | `0` |
| `SESSION_TTL_MINUTES` | 会话有效期（分钟） | `480` |

---

## 8. 运维手册

### 8.1 常用命令

```bash
# 查看日志
podman logs -f rnd-ts-app
podman logs -f rnd-ts-db

# 重启应用
podman restart rnd-ts-app

# 进入数据库
podman exec -it rnd-ts-db psql -U timesheet -d timesheet

# 查看容器状态
podman ps -a --filter name=rnd-ts
```

### 8.2 备份与恢复

```bash
# 备份（自动保留最近 30 份）
sudo bash deploy/deploy.sh backup /var/backups/rnd-timesheet

# 恢复
gunzip -c /var/backups/rnd-timesheet/timesheet-YYYYmmdd-HHMMSS.sql.gz \
  | podman exec -i rnd-ts-db psql -U timesheet -d timesheet
```

建议将备份目录纳入现有备份体系，或配置 crontab：

```cron
0 2 * * * cd /opt/rnd-timesheet && bash deploy/deploy.sh backup >/dev/null 2>&1
```

### 8.3 证书更换
证书到期前（当前证书有效期至 **2028-10-21**）替换：

```bash
# 证书文件名保留 man.tri.local（历史命名），实际为 *.tri.local 通配证书
cp 新证书 /opt/rnd-timesheet/deploy/certs/man.tri.local.crt
cp 新私钥 /opt/rnd-timesheet/deploy/certs/man.tri.local.key
chmod 600 /opt/rnd-timesheet/deploy/certs/man.tri.local.key
sudo bash deploy/deploy.sh install     # 会重新安装证书并 reload nginx
```

### 8.4 排查清单

| 现象 | 排查方向 |
|---|---|
| 502 Bad Gateway | `podman ps` 看应用是否运行；`curl 127.0.0.1:3000/api/health` |
| 登录提示"用户名或密码错误" | 确认账号在 `Group_AllStaffs` 组内；用 `ldapsearch` 手工验证 bind |
| 登录提示"无法连接域控" | 检查 389 端口连通性：`nc -zv 172.16.10.111 389` |
| 人员列表为空 | 「系统管理 → 立即同步 AD 用户」，或查看应用日志中的同步结果 |
| 分摊勾稽不平衡 | 检查未设置月薪却在报工的人员；检查非研发工时是否填报 |
| nginx 起不来 | `nginx -t`；确认 80/443 未被占用：`ss -tlnp \| grep -E ':(80\|443) '` |
| 请求卡住 / 504 超时 | 查数据库锁：见下方「锁与死锁」 |

#### 容器网络（重要）

本机 podman 的 CNI 桥接网络**偶发新建网络无法出网**，表现为容器内访问域控
`EHOSTUNREACH`、解析 `db` 报 `EAI_AGAIN`。排查与修复：

```bash
# 1. 确认宿主机能通域控
nc -zv 172.16.10.111 389

# 2. 确认容器能通域控（容器内非 root 无法用 ping，改用 node）
podman exec rnd-ts-app node -e '
const net=require("net");const s=net.connect(389,"172.16.10.111");
s.on("connect",()=>{console.log("OK");process.exit(0)});
s.on("error",e=>{console.log("FAIL",e.code);process.exit(1)});'

# 3. 若不通：重建网络（实测最有效的修复）
cd /opt/rnd-timesheet/deploy
podman-compose -f compose.yaml --env-file .env down
podman network rm -f rnd-ts
podman-compose -f compose.yaml --env-file .env up -d
```

系统已内置两层防护：应用启动时重试解析数据库主机名并打印结果
（日志中 `[db] 主机名 db 解析为 ...`），compose 中用 `extra_hosts` 固定了数据库地址。

#### 锁与死锁

应用已设置 `statement_timeout=15s` / `lock_timeout=10s`，
异常时请求会在 15 秒内失败并回滚，不会无限挂起。排查：

```bash
# 查看是否有长时间持锁的事务
podman exec rnd-ts-db psql -U timesheet -d timesheet -c "
SELECT pid, state, wait_event_type, now()-query_start AS dur, left(query,70)
FROM pg_stat_activity WHERE datname='timesheet' AND pid<>pg_backend_pid()
ORDER BY query_start;"

# 清理卡住的事务（会中断正在执行的查询，请谨慎）
podman exec rnd-ts-db psql -U timesheet -d timesheet -c "
SELECT pg_terminate_backend(pid) FROM pg_stat_activity
WHERE datname='timesheet' AND pid<>pg_backend_pid()
  AND (state='idle in transaction' OR wait_event_type='Lock');"
```

> **开发提示**：在事务中调用数据访问函数时，务必把事务客户端 `c` 传进去。
> 若使用全局连接池，会在另一条连接上等待本事务已持有的行锁，造成自死锁
> （请求挂起到网关超时，且日志无任何报错）。
> `setTimesheetStatus`、`decideApproval`、`approvalStatuses`
> 均支持末位的可选 `client` 参数。

#### 枚举类型写入

`status`、`role` 等列是 PostgreSQL 枚举类型，写入时必须显式转换，否则报 `42804`：

```sql
COALESCE($7::timesheet_status, 'draft'::timesheet_status)   -- 正确
role = $2::user_role                                        -- 正确
```

#### 环境变量中的花括号

`podman-compose` 1.0.6 会破坏含 `{}` 的环境变量值
（`{username}@tri.local` 会变成 `{username}@tri.local@tri.local}`）。
系统因此改用 `LDAP_UPN_SUFFIX=@tri.local` 表达同一语义，
应用会自动从 `LDAP_BIND_DN` 推导后缀，并对脏模板做兼容处理。

#### 两处易踩坑的 SQL

- `listUsers` 对 `users` 做了自连接取上级姓名，所有列引用需带 `u.` 前缀，
  否则 `is_active`/`role` 会报 `42702 列引用不明确`。
- `date_trunc('month', work_date)` 不是 IMMUTABLE 函数，**不能**用于表达式索引；
  应改为对 `work_date` 建普通索引。

#### 日期整体偏移一天（时区陷阱，已修复）

**症状**：法定节假日日历、工作日计算、审批时限全部错位一天。
例如 2026-10 的调休上班日 `10/10` 被算成 `10/09`，
国庆假期 `10/08` 却被当成工作日（工作日总数仍是 17 天，极具迷惑性）。

**原因**：`pg` 驱动会把 `DATE` 列解析为「本地时区午夜」的 `Date` 对象。
容器若以 UTC 运行而业务日期按 `Asia/Shanghai` 理解，则
`2026-10-10` 会变成 `2026-10-09T16:00:00Z`，
此时调用 `getUTCDate()` 得到的是 **9**，即前一天。

**修复**（两道防线，均已落地）：

```js
// server/src/db.js —— 让 DATE 保持字符串，驱动不做时区解释
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);
```

```sql
-- server/src/repo.js —— 需要日期字符串时直接由 SQL 产出
SELECT to_char(day, 'YYYY-MM-DD') AS day_key, is_workday FROM calendar_days
```

**同时修复的时区配置**：Alpine 镜像原本 `apk del tzdata` 删掉了时区库，
导致 `TZ=Asia/Shanghai` 形同虚设、进程实际跑在 UTC。
现已保留 tzdata，容器内 `date` 正确显示 CST。

> **开发提示**：任何新增的日期字段读取，都应使用 `to_char(..., 'YYYY-MM-DD')`
> 或依赖上面的 `DATE` 类型解析器，**不要**对驱动返回的 `Date` 调用
> `toISOString()` / `getUTCDate()` 来推导业务日期。

#### 演示数据脚本不能放进 migrations 目录

应用启动时会自动执行 `server/migrations/*.sql`。
演示数据脚本含 `DELETE`（清空业务数据）以及 psql 专有的 `\echo` 元命令，
一旦放进该目录会导致：

- 通过 `pg` 驱动执行时报 `syntax error at or near "\"`（42601），应用启动失败
- 每次重启都会清空业务数据

因此演示脚本统一放在 `scripts/` 目录，通过 `load-demo-data.sh` 手动执行。

---

### 8.5 首次上线后的初始化步骤

1. 用域账号登录（需在 `Group_AllStaffs` 内），确认自动获得账号
2. 进入「系统管理」，为每位研发人员设置：**工号、研发类型、月薪**
3. 指派 **人力资源部（hr）** 和 **项目负责人（pm）** 角色
4. 进入「人力与考勤」，录入当月**考勤工时**
5. （可选）在「系统管理 → 节假日日历」补充本年度法定节假日
6. 通知研发人员开始填报

---

## 9. 安全设计

- **认证**：AD 域账号，密码仅用于一次 LDAP bind，不落盘
- **会话**：HS256 JWT，HttpOnly + Secure + SameSite=Lax Cookie，默认 8 小时过期
- **授权**：接口级角色校验（employee / pm / hr / admin），数据范围隔离
- **传输**：强制 HTTPS，TLS 1.2+，HSTS
- **请求体**：`zod` 全量校验，防注入；LDAP 过滤器做 RFC4515 转义
- **限流**：登录接口 10 次/分钟/来源，防暴力破解
- **响应头**：CSP、X-Frame-Options、X-Content-Type-Options、Referrer-Policy
- **审计**：登录、填报、提交、审批、分摊冻结、用户与项目变更全部留痕
- **最小权限**：容器内以非 root 用户运行；数据库仅监听容器网络

---

## 10. 已知限制与后续规划

- **考勤数据源**：当前为 HR 手工录入/批量录入。如需对接考勤机或 HR 系统，
  可在 `server/src/service.js` 的 `setAttendance` 处接入导入接口。
- **代填审计**：HR 代填已记录审计日志，但界面尚未提供按人查看代填历史的视图。
- **多级审批**：当前为单级审批（项目负责人）。如需部门经理 → HR → 财务多级，
  可在 `approvals` 表增加 `step` 字段扩展。
- **报表导出**：当前导出 CSV。如需 Excel（带公式与格式）或 PDF 归档，
  可接入后端 `exceljs`（依赖已在 `package.json` 中）。
- **单点登录**：当前为 LDAP bind 认证。若域环境已部署 ADFS/Kerberos，
  可扩展为 SPNEGO 免密登录。

---

## 11. 开发

```bash
# 后端
cd server && npm install
PGHOST=127.0.0.1 PGPASSWORD=xxx SESSION_SECRET=$(openssl rand -base64 48) \
  LDAP_BIND_PASSWORD=xxx npm run dev

# 前端（开发服务器，API 代理到 127.0.0.1:3000）
cd web && npm install && npm run dev

# 数据库迁移（服务启动时会自动执行，也可单独运行）
cd server && npm run migrate
```

代码组织：

```
server/src/
├── index.js      服务入口（插件注册、启动、优雅退出）
├── config.js     配置加载与启动校验
├── db.js         连接池与事务助手
├── ldap.js       AD 集成（认证、查询、错误码翻译）
├── auth.js       会话、Cookie、角色判定
├── domain.js     纯业务逻辑（工作日、校验、分摊算法）
├── repo.js       数据访问层（SQL 集中管理）
├── service.js    业务服务层（状态机、编排）
├── routes.js     HTTP 路由（鉴权 + 审计）
├── migrate.js    迁移执行器
└── jobs/syncAd.js  AD 同步任务
```