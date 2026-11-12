# 企业统一身份平台（Keycloak OIDC）

企业内网的统一登录（SSO）中心：一次域账号登录，访问所有接入的内部系统。

| 项 | 值 |
|---|---|
| 访问地址 | **https://sso.tri.local** （员工登录 / 管理控制台 `/admin/`） |
| 部署主机 | `trivm101.tri.local`（172.16.50.101，Rocky Linux 8.10） |
| 技术栈 | Keycloak 26.8.1 × 2（生产模式、Infinispan 集群）+ PostgreSQL 16 + nginx + rootless Podman |
| 身份来源 | Active Directory（LDAPS 636，服务账号只读绑定，**不保存员工口令**） |
| 协议 | OpenID Connect 1.0（授权码 + PKCE S256）、RP-Initiated Logout |
| 版本 | 1.0.0（2026-10-29 首次部署） |
| 验收 | OIDC 端到端 14/14 通过；重启后复验 14/14 通过 |

## 文档

| 文档 | 读者 | 内容 |
|---|---|---|
| [部署文档](docs/部署文档.md) | 实施/审计 | 系统是什么、架构、端口、从零部署步骤、验收清单、关键决策与原因、业务接入指引 |
| [管理手册](docs/管理手册.md) | 日常运维 | 启停、备份恢复、升级、加 client/角色、用户生命周期、控制台操作、故障速查、安全加固路线、应急 |
| [业务系统接入指南](docs/业务系统接入指南.md) | 业务开发 | 接入流程、参数速查、三类系统的差异、AD 组继续使用的做法、安全红线 |
| **[接入对接包](docs/接入对接包/README.md)** | **给同事（对外）** | **要发给业务系统的四件套**：总览+自测、接入指南、参数与接口、验收清单；含发送模板 |
| [双登录方案](docs/双登录方案.md) | 决策/安全评审 | 业务系统能否同时保留自有登录页：三种方案的取舍、本地账号通道的安全设计、验收用例 |
| [排障笔记](docs/排障笔记.md) | 排障 | 本次部署踩到的 12 类坑（含报错原文）与解决办法，重建/升级前必读 |
| [接入参考实现](ops/integration/README.md) | 业务系统开发 | Node/Fastify、Flask、Next.js 三种骨架 + 接入检查表 |

## 30 秒上手

```bash
# 状态与验收
./deploy/deploy.sh status
./deploy/deploy.sh verify <域账号> <域口令>

# 改配置（client / 角色映射 / 会话）后重新应用（幂等）
./deploy/deploy.sh provision

# 备份 / 重启
./deploy/deploy.sh backup
systemctl --user restart tri-oidc.service
```

## 当前接入状态

| Client | 系统 | 状态 |
|---|---|---|
| `chat-openwebui` | 企业 AI 助手 https://chat.tri.local | IdP 侧就绪，待系统改造（现状 LDAP 明文，建议优先） |
| `knowledge-hub` | 知识平台 https://ai.tri.local | IdP 侧就绪，待系统改造 |
| `man-timesheet` | 科研项目职能支持 https://work.tri.local（兼容 man.tri.local） | IdP 侧就绪，待系统改造 |
| `slurm-web` | 集群管理 https://cluster.tri.local | IdP 侧就绪（默认未启用） |
| `portal` | 企业应用门户 https://portal.tri.local | **已接入并上线**（2026-11-04） |
| `ood` | 集群门户 Open OnDemand https://edas.tri.local | **已接入并上线**（2026-11-09，mod_auth_openidc） |

改造方式见 [业务系统接入指南](docs/业务系统接入指南.md) 与 [接入参考实现](ops/integration/README.md)。

**完整改造包**（代码骨架 + 数据库迁移 + 操作清单 + 验收用例）：
- [ai.tri.local 知识平台](ops/integration/knowledge-hub/接入清单.md)（OIDC 客户端 + 身份映射 + 前后端片段）
- [man.tri.local 工时系统](ops/integration/man-timesheet/接入清单.md)（含双登录本地账号通道）

## 仓库结构

```
deploy/      编排、部署脚本、nginx、realm 配置工具、验收脚本
docker/      自建 Keycloak 镜像（内置企业根 CA + 预构建）
ops/         系统安装、健康巡检、备份清理、业务接入参考实现
docs/        部署文档、管理手册、排障笔记
```

## 约定

- **密钥不入库**：`deploy/.env`、证书私钥、导出的 realm（含 client secret）都在 `.gitignore` 中。
- **配置以仓库为准**：所有 client / 角色映射 / 会话参数的改动走 `configure.py`，不在控制台手工改（会被下一次 `provision` 覆盖）。
- **变更必验收**：任何变更后执行 `./deploy/deploy.sh verify`，并在排障笔记的变更记录里留一行。
