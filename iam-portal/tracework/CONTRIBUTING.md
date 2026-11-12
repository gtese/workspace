# 开发与变更流程

## 仓库结构

```
tracework/
├── server/              后端（Node.js + Fastify + PostgreSQL）
│   ├── src/             应用代码
│   ├── migrations/      数据库迁移（启动时自动执行）
│   └── package.json
├── web/                 前端（Vue 3 + Vite）
│   └── src/
│       ├── views/       14 个页面
│       ├── components/  共用组件
│       └── composables/ 组合式函数
├── deploy/              部署与运维
│   ├── Containerfile    应用镜像
│   ├── compose.yaml     编排
│   ├── deploy.sh        一键部署
│   ├── nginx-*.conf     站点配置
│   ├── certs/           TLS 证书（私钥不入库）
│   └── *.sh             测试脚本
├── scripts/             演示数据装载
├── docs/                完整文档
└── README.md
```

## 本地开发

```bash
# 后端
cd server && npm install
cp ../deploy/.env.example .env    # 填入数据库、LDAP 等配置
npm run dev                        # 默认 3000 端口

# 前端（另开终端）
cd web && npm install
npm run dev                        # 默认 5173，代理 /api 到 3000
```

## 变更流程

1. **改代码**
2. **本地自测**
   ```bash
   cd server && npm run dev
   cd web && npm run dev
   ```
3. **跑测试**（需先部署到测试环境）
   ```bash
   TEST_USER=你的域账号 TEST_PASS=密码 bash deploy/e2e-test.sh
   ```
4. **提交并推送**（推荐用同步脚本，自带安全检查）
   ```bash
   bash deploy/sync.sh "feat: 简要说明改动"
   ```

   或手动：
   ```bash
   git add -A
   git commit -m "feat: 简要说明改动"
   git push origin main
   ```
5. **部署到服务器**
   ```bash
   sudo bash /opt/rnd-timesheet/deploy/deploy.sh upgrade
   ```

## 提交信息约定

| 前缀 | 含义 |
|---|---|
| `feat:` | 新功能 |
| `fix:` | 缺陷修复 |
| `docs:` | 仅文档 |
| `refactor:` | 重构（不改行为） |
| `test:` | 测试相关 |
| `chore:` | 构建/依赖/杂项 |

示例：
- `feat: 新增 IT 资产管理模块，使用人挂接 AD 账号`
- `fix: 工时单合计在事务内读取到旧快照`

## 数据库迁移规范

- 迁移文件放在 `server/migrations/`，命名 `NNN_描述.sql`
- **必须幂等**（可重复执行）：用 `CREATE TABLE IF NOT EXISTS`、
  `ADD COLUMN IF NOT EXISTS`、`INSERT ... ON CONFLICT DO NOTHING`
- 应用启动时自动执行未应用的迁移
- 迁移内如需 `ALTER TYPE ... ADD VALUE`，必须放在 `BEGIN` 之前
  （PostgreSQL 限制）

## 仓库与同步

| 项 | 值 |
|---|---|
| 仓库地址 | <https://git.tri.local/it/tracework.git> |
| 主分支 | `main`（受保护，禁止强推） |
| 本地目录 | `~/deepseek/rnd-timesheet` |

### 同步脚本

每次变更后执行即可自动提交并推送：

```bash
bash deploy/sync.sh                 # 自动生成提交信息
bash deploy/sync.sh "feat: xxx"     # 指定提交信息
bash deploy/sync.sh --dry-run       # 只看改动，不提交
```

脚本会**在提交前扫描私钥与凭据**，发现即中止。

### 自动同步（已启用）

开发机已配置 **launchd 常驻服务**，每 2 分钟检查一次本地改动，有变更即自动提交推送：

```bash
# 查看状态
launchctl list | grep tracework

# 查看日志
tail -f /tmp/tracework-autosync.log

# 停止
launchctl unload ~/Library/LaunchAgents/local.tracework.autosync.plist

# 重启
launchctl load ~/Library/LaunchAgents/local.tracework.autosync.plist
```

配置位置：`~/Library/LaunchAgents/local.tracework.autosync.plist`

**手动同步**（不改等自动）：

```bash
bash deploy/auto-sync.sh --once
```

> 注意：自动同步会用通用提交信息 `chore: 自动同步 <时间>`。
> 若希望提交信息更规范，请手动用 `sync.sh "feat: ..."` 提交。

## 敏感信息规范（重要）

**绝不提交**：
- `.env`（数据库密码、会话密钥、LDAP 密码）
- `*.key` / `*.pfx`（TLS 私钥）
- 任何硬编码的账号密码

测试脚本通过环境变量传账号密码：

```bash
TEST_USER=linyiyao TEST_PASS=**** bash deploy/e2e-test.sh
```

## 测试脚本清单

| 脚本 | 覆盖范围 | 项数 |
|---|---|---|
| `e2e-test.sh` | 工时填报、审批状态机、考勤勾稽 | 45 |
| `e2e-costing.sh` | 费用归集、15 类台账、四口径测算、文档 | 36 |
| `test-finance-boundary.sh` | 财务权限边界 | 20 |
| `test-ad-sync.sh` | AD 禁用/删除/恢复同步语义 | 13 |
| `verify-integrity.sh` | 数据完整性审计 | 35 |
| `verify-domains.sh` | 双域名、证书、品牌 | 11 |
| `test-api.sh` | 开放 API 认证、权限、限流、规范 | 24 |
| `verify-ui.sh` | **前端全部 13 个页面真实浏览器渲染** | 18 |

全部通过后再推送。

> **强制纪律**：任何改动前端页面或接口后，必须同时运行
> `verify-ui.sh`（真实浏览器渲染）和对应后端测试。
> 只跑 curl 测试不足以发现前端白屏、路由报错、组件未挂载等问题。
> UI 测试需要 node 与 Chrome，在开发机本地对生产域名执行。

## 部署环境

| 项 | 值 |
|---|---|
| 主域名 | https://work.tri.local |
| 兼容域名 | https://man.tri.local |
| 主机 | trivm122.tri.local (172.16.50.122) |
| 部署目录 | /opt/rnd-timesheet |
| 容器 | rnd-ts-app（应用）、rnd-ts-db（PostgreSQL） |
| 技术栈 | Node.js 20 + Fastify + PostgreSQL 16 + Vue 3 + nginx |
