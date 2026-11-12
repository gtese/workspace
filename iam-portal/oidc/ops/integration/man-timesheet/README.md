# man.tri.local（rnd-timesheet）接入 OIDC 改造包

> 本目录是**可直接合入 rnd-timesheet 仓库**的改造参考代码，不是独立服务。
> 完整操作清单见 [接入清单](<接入清单.md>)。

## 文件对照

| 本目录文件 | 复制到 rnd-timesheet 仓库 | 说明 |
|---|---|---|
| `oidc.js` | `server/src/oidc.js`（新增） | OIDC 客户端：discovery、PKCE、换令牌、JWKS 验签、登出 |
| `auth-oidc.js` | `server/src/auth.js`（合并） | 在现有 `createSession` 之上增加 `sub` 字段（可选改动，见 §3） |
| `oidc-routes.js` | `server/src/routes.js`（合并 3 个路由） | `/api/auth/login`、`/api/auth/oidc/callback`、`/api/auth/logout` |
| `migrations/20261101_oidc_sub.sql` | `server/migrations/` | 给 `users` 表加 `oidc_sub` 列 |
| `LoginView.vue` | `web/src/views/LoginView.vue`（替换渲染部分） | 删口令表单，改为「使用公司账号登录」 |
| `env.snippet` | `rnd-timesheet/deploy/.env` | 新增 OIDC_* 变量，删除 LDAP_*（见清单第 6 步） |

## 为什么不改 `users.role` 的数据模型

rnd-timesheet 的权限依赖 `users.role`（employee/pm/finance/hr/admin），其中 `pm` 由业务指派。
这项业务属性**不应该**由 IdP 覆盖。本方案：

- **登录身份** → Keycloak（`sub` + AD 组）；
- **`users.role`** → 保留（库里的既有值），`admin` 由 Keycloak 角色 `ts:admin` 决定；
- **准入/财务/管理员判定所需的 AD 组** → 通过请求 `groups` scope 拿 userinfo 的 `groups`。

> 二期可以把 `role` 逐步迁移到 IdP 的角色（`ts:admin/ts:finance`），届时只需改 `deriveRole` 一处。
