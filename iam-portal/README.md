# 统一身份与应用门户（IAM Portal）项目资料

> 三个仓库的本地汇总，供查阅与交接。**已脱敏**：不含任何口令、密钥、API Key。
>
> | 项 | 值 |
> |---|---|
> | 部署日期 | 2026-10-29（IdP）/ 2026-11-03（门户）/ 2026-11-04（工时接入） |
> | 部署主机 | `trivm101.tri.local`（172.16.50.101，IdP）、`trivm122.tri.local`（172.16.50.122，门户与业务系统） |
> | 技术栈 | Keycloak 26.8.1 × 2 + PostgreSQL 16；门户 Node 20 零依赖；业务系统 Node/Fastify + Vue 3 |

---

## 1. 这个项目解决什么

企业内网原先每个系统各自连 AD 登录，员工要输多次域口令，撤权限要等各系统自己的同步周期。
本项目建设了一套**统一身份平台 + 应用门户**：

```
            员工浏览器
                │
        ┌───────┴────────┐
        │                │
   portal.tri.local   sso.tri.local
   （应用门户）        （Keycloak 统一身份）
        │                │ LDAPS 636
        │                ▼
        │            AD 域控（认证与组的事实来源）
        │
        └──► chat.tri.local / work.tri.local / edas.tri.local …
```

| 能力 | 状态 | 说明 |
|---|---|---|
| 统一登录（OIDC SSO） | ✅ 上线 | 授权码 + PKCE，一次登录访问所有已接入系统 |
| 应用门户 | ✅ 上线 | 员工登录后看到自己的应用列表，管理员可拖拽排序、增删卡片 |
| 单点登出 | ✅ 上线 | 登出同时结束本地会话与 IdP 会话 |
| 双实例高可用 | ✅ 上线 | Keycloak 双实例 + Infinispan 集群，单实例故障不影响登录 |
| 审计 | ✅ 上线 | 登录/令牌/管理操作事件统一记录，保留 180 天 |

---

## 2. 目录说明

```
iam-portal/
├── oidc/        统一身份平台（Keycloak）—— git.tri.local/it/oidc
├── portal/      应用门户（portal.tri.local）—— git.tri.local/it/portal
└── tracework/   科研项目职能支持（work.tri.local）—— git.tri.local/it/tracework
```

> 三个子目录是各自仓库的**快照**（不含 `.git`），用于在 workspace 中统一查阅。
> 实际开发与提交请到对应仓库。拉取方式见 §5。

### 2.1 oidc — 统一身份平台

| 项 | 值 |
|---|---|
| 仓库 | `git.tri.local/it/oidc` |
| 地址 | https://sso.tri.local |
| 文档 | [部署文档](oidc/docs/部署文档.md) ｜ [管理手册](oidc/docs/管理手册.md) ｜ [排障笔记](oidc/docs/排障笔记.md) ｜ [业务系统接入指南](oidc/docs/业务系统接入指南.md) ｜ [双登录方案](oidc/docs/双登录方案.md) ｜ [给同事的交接包](oidc/docs/接入对接包/README.md) |

关键内容：

- `deploy/` compose、部署脚本、nginx、realm 配置工具
- `deploy/scripts/configure.py` 幂等配置（AD 联邦 / 组→角色映射 / client / 审计）
- `deploy/scripts/verify-oidc.py` 登录链路验收 14 项
- `docker/keycloak/` 自建镜像（内置企业根 CA + 预构建）
- `ops/integration/` 各业务系统接入参考实现

### 2.2 portal — 应用门户

| 项 | 值 |
|---|---|
| 仓库 | `git.tri.local/it/portal` |
| 地址 | https://portal.tri.local |
| 文档 | [部署文档](portal/docs/部署文档.md) ｜ [运维速查](portal/docs/运维速查.md) |

关键内容：

- `src/` 零依赖 Node 服务 + 单页前端（拖拽排序、卡片增删改）
- `deploy/scripts/verify.py` 登录链路 12 项 ｜ `verify-edit.py` 编辑功能 10 项
- 应用配置存数据卷 `tri-portal-data`（运行时数据，不在 Git）

### 2.3 tracework — 科研项目职能支持

| 项 | 值 |
|---|---|
| 仓库 | `git.tri.local/it/tracework` |
| 地址 | https://work.tri.local（兼容 https://man.tri.local） |
| 文档 | [OIDC 接入说明](tracework/docs/OIDC接入说明.md) ｜ `docs/README.md` 系统说明 |

关键内容：

- `server/src/oidc.js` + `oidcRoutes.js` 统一身份接入
- `AUTH_MODE=oidc|ldap` 回滚开关
- 业务代码未改动（会话/准入/角色推导/审计全部复用）

---

## 3. 当前接入状态

| 系统 | 地址 | 统一身份 | 门户卡片 |
|---|---|---|---|
| 企业 AI 助手（Open WebUI） | chat.tri.local | ✅ 免登录（打开即跳 IdP） | ✅ |
| 科研项目职能支持（TraceWork） | work.tri.local | ✅ 免登录 | ✅ |
| 集群门户（Open OnDemand） | edas.tri.local | ✅ 免登录 | ✅ |
| GitLab | git.tri.local | ⚠️ 尚未接入 | ✅（需单独登录） |
| 集群作业管理 | 待定 | — | 占位 |

角色映射（AD 组 → 业务角色）只在 `oidc/deploy/scripts/configure.py` 的 `ROLE_MAPPINGS` 维护一处。

---

## 4. 关键设计决策（为什么这么做）

| 决策 | 原因 |
|---|---|
| 口令只在 IdP 输入 | 业务系统不再接触域口令，攻击面从 N 个降到 1 个 |
| 组 → 角色映射集中在 IdP | 原先组名散落在 3 个系统的 `.env` 与代码里，一改要动 3 处 |
| 瘦令牌 + 回源 | AD 58 个组，全塞进令牌会撑爆 Cookie，且撤权延迟长 |
| 门户配置存数据卷 | 运行时数据不入 Git，避免每次 pull 冲掉管理员的自定义 |
| 业务系统保留自有会话 | 每请求验 IdP 会把 IdP 变成性能瓶颈，且不利于跨站登出 |
| 不保留口令登录旁路 | 保留等于永远保留，且会让 SSO 失去意义（应急场景另设默认关闭的通道） |

---

## 5. 拉取与重建

```bash
# 三个仓库（需 git.tri.local 凭据）
git clone https://git.tri.local/it/oidc.git
git clone https://git.tri.local/it/portal.git
git clone https://git.tri.local/it/tracework.git

# 本目录的更新
cd ~/deepseek/workspace
git add iam-portal && git commit -m "docs: update iam-portal materials" && git push
```

重建环境请按各仓库 `docs/部署文档.md` 操作；密钥从 `.env` 生成（`openssl rand`），**不入库**。

---

## 6. 脱敏说明

本目录与三个仓库均**不含**：数据库口令、Keycloak 管理员口令、LDAP 服务账号口令、
client secret、API Key、令牌、私钥。

- 配置示例文件（`.env.example`）中所有密钥项均为空或 `CHANGE_ME_*` 占位；
- 文档中的命令一律通过环境变量或占位符引用凭据；
- 已验证三个仓库的**全部提交历史**中也无凭据泄露。

> 若需要实际凭据，请在部署主机的 `deploy/.env` 中查看（权限 600），或向 IT 索取。

---

## 7. 相关文档（工作区其他项目）

| 项目 | 关系 |
|---|---|
| [ood/](../ood/) | 集群门户（Open OnDemand），已接入本项目的统一身份 |
| [dsh/](../dsh/) | DeepSeek Harness 使用资料 |
| [slurm/](../slurm/) | Slurm 集群运维 |