# 业务系统接入 OIDC 参考实现

这里给出三种常见技术栈的**最小可运行骨架**，业务系统可照抄。共同约定：

| 项 | 值 |
|---|---|
| Issuer | `https://sso.tri.local/realms/tri` |
| 发现文档 | `https://sso.tri.local/realms/tri/.well-known/openid-configuration` |
| Client | 各系统自己的（`man-timesheet` / `knowledge-hub` / `chat-openwebui` / `slurm-web`） |
| Client 类型 | Confidential（有后端），回调地址精确白名单 |
| PKCE | 必须 S256 |
| 角色 | 读 `realm_access.roles`（access_token 或 userinfo） |
| 登出 | 本地清 session → 302 到 `end_session_endpoint`，带 `id_token_hint` |

## 接入检查表（每个系统都要过一遍）

- [ ] 登录页换成一个按钮，**删除用户名口令输入框**
- [ ] `/auth/login` 生成 `state`、`nonce`、`code_verifier` 并存后端 session
- [ ] `/auth/callback` 校验 `state`，用 code 换令牌，校验 `iss/aud/exp/nonce`
- [ ] 本地会话 cookie：`Secure; HttpOnly; SameSite=Lax`
- [ ] 用户主键用 `sub`；`preferred_username` 只用于展示与一次性迁移对账
- [ ] 授权用业务角色，**不读 AD 组名**
- [ ] `/auth/logout` 调 IdP 登出端点
- [ ] 删除 `LDAP_*` 配置、AD 同步任务、`memberOf` 判断
- [ ] 保留 1 周 `AUTH_MODE=oidc|ldap` 回滚开关，验收后删除

## 目录

| 目录 | 技术栈 | 适用系统 |
|---|---|---|
| `node-fastify/` | Node 20 + Fastify（手写 OIDC 客户端，仅用标准库 `fetch`） | man-timesheet、knowledge-hub |
| `nextjs/` | Next.js App Router（`next-auth` / `openid-client`） | 若后续有前端框架的系统 |
| `flask/` | Python 3 + Flask | slurm-web 等自研 Python 后台 |
| `man-timesheet/` | Node 20 + Fastify + Vue（**完整改造包**） | 工时系统：代码骨架、DB 迁移、env 片段、操作清单与验收表 |
| `man-timesheet/dual-login/` | Node 20 | 双登录（保留自有登录页）的本地账号通道：bcrypt 校验、应急模式、告警 |
| `knowledge-hub/` | Node 20 + Fastify + 单文件 SPA（**完整改造包**） | 知识平台：OIDC 客户端、身份映射（复用 AD 组推导角色/部门）、路由与前端片段、迁移、操作清单 |

> 这些骨架**不直接部署**，只作为改造参照。复制到业务仓库后按各自的会话表结构适配。
