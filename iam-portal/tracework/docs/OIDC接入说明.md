# TraceWork 接入公司统一身份（sso.tri.local）

> 实施日期：2026-11-03　　状态：**已上线**
> 影响范围：仅认证方式。业务功能、数据模型、权限规则均不变。

---

## 一、一句话说明

员工不再在 work.tri.local 输入域账号口令，改为跳转 `sso.tri.local` 登录一次；
本系统只接收已签名的身份声明（`sub` + 姓名 + 邮箱 + AD 组），**不再接触口令**。

```
改造前：员工 ──口令──▶ TraceWork ──LDAP bind──▶ AD
改造后：员工 ──口令──▶ sso.tri.local ──LDAP bind──▶ AD
                          │ 授权码（一次性，60 秒）
                          ▼
                    TraceWork 后端 ──换令牌──▶ sso.tri.local
                          └─ 校验签名/iss/aud/exp/nonce → 建本系统会话（逻辑不变）
```

**SSO 效果**：在任一已接入系统登录后，再打开 TraceWork 无需再次输入密码。

## 二、实现文件

| 文件 | 说明 |
|---|---|
| `server/src/oidc.js` | OIDC 客户端：discovery、JWKS、PKCE、验签、userinfo、登出 |
| `server/src/oidcRoutes.js` | 三个路由：login / callback / logout |
| `server/src/config.js` | `AUTH_MODE` 与 `oidc.*`，启动自检 |
| `server/src/repo.js` | `getUserByOidcSub` / `bindOidcSubject` / `upsertUserFromOidc` |
| `server/migrations/012_oidc_sub.sql` | `users.oidc_sub` 列 + 唯一索引 |
| `web/src/views/LoginView.vue` | 口令表单 → 「使用公司账号登录」按钮 |
| `web/src/main.js` | 401 自动跳 IdP（无感续期） |
| `web/src/store.js` | 登出整页跳 IdP 登出地址 |

## 三、关键实现细节

### 3.1 企业根 CA
容器内 Node 不信任企业自签 CA，因此 `oidc.js` 使用 `node:https` + 显式 `ca` 加载
`/etc/ts-certs/tri.local_ca.crt`（compose 以 `:ro,z` 挂载 `./certs`）。

> **踩坑**：仅写 `:ro` 时，Rocky Linux + SELinux 会导致容器内看不到文件（挂载成功但目录为空），必须加 `,z`。

### 3.2 JWKS 验签
`jose` v5 的 `createRemoteJWKSet` 不支持自定义 fetcher，无法复用带企业 CA 的请求函数。
因此改为**自行拉取 JWKS** + `createLocalJWKSet`，1 小时缓存，验签失败时强制刷新一次（应对密钥轮换）。

### 3.3 AD 组归一化
Keycloak 的 `groups` claim 默认下发**纯组名**（`full.path=false`），如 `Group_AllStaffs`；
而 `ldap.js` 的 `extractCn()` 只认 DN 形态（`CN=xxx,...`），直接传入会得到空数组 → 所有人被拒。
`oidcRoutes.js` 的 `normalizeGroupName()` 统一处理纯组名 / DN / 路径三种形态。

> **踩坑**：这是接入时最隐蔽的问题 —— 日志里 `groups: []` 但 Keycloak 用户确实有组。

### 3.4 研发类型同步
OIDC 模式下 AD 定时同步可能关闭，`employee_type`（研发/支持）改由登录时按
`deriveEmployeeType()` 刷新，避免永久停留在首次入库的值。

### 3.5 业务角色不被覆盖
`L upsertUserFromOidc()` 刻意不更新 `role`（`pm` 等业务指派由管理员在界面维护），
只在**首次创建**用户时用 `deriveRole()` 初始化。

## 四、IdP 侧配置（Keycloak realm `tri`，client `man-timesheet`）

| 项 | 值 |
|---|---|
| Client ID | `man-timesheet` |
| 回调白名单 | `https://work.tri.local/*`、`https://man.tri.local/*` |
| 登出回跳 | 同上 |
| PKCE | S256（强制） |
| scope | `openid profile email groups` |
| **groups scope** | **必须设为 default**（不是 optional），否则 userinfo 不下发 groups |

> **踩坑**：`groups` scope 原先只在 optional 列表中，必须显式加入 default：
> `PUT /admin/realms/tri/clients/{id}/default-client-scopes/{scopeId}`

## 五、环境变量

```bash
AUTH_MODE=oidc
OIDC_ISSUER=https://sso.tri.local/realms/tri
OIDC_CLIENT_ID=man-timesheet
OIDC_CLIENT_SECRET=<从 IdP 获取>
OIDC_REDIRECT_URI=https://work.tri.local/api/auth/oidc/callback
OIDC_SCOPE=openid profile email groups
OIDC_POST_LOGOUT_URI=https://work.tri.local/
```

## 六、回滚（5 分钟）

```bash
cd /opt/rnd-timesheet/deploy
sed -i 's/^AUTH_MODE=oidc/AUTH_MODE=ldap/' .env
podman-compose -f compose.yaml --env-file .env up -d --force-recreate
```

LDAP 模式口令登录仍保留在代码中（仅 `AUTH_MODE=ldap` 时注册），无需改代码。

## 七、验收结果（实测）

| # | 用例 | 结果 |
|---|---|---|
| 1 | 未登录访问 `/fill` | 跳 IdP → 登录后回到 `/fill` ✅ |
| 2 | 域账号登录 | 进入系统，显示正确姓名与角色 ✅ |
| 3 | 已登录其它系统后打开 | **免密直达**，无 IdP 登录页 ✅ |
| 4 | 财务/HR 角色 | 权限未放宽 ✅ |
| 5 | 退出 | 跳 IdP 登出页，再访问需重新登录 ✅ |
| 6 | 旧口令接口 `POST /api/auth/login` | 404（已关闭）✅ |
| 7 | 业务数据 | 项目/资产/工时/考勤全部完好 ✅ |
| 8 | `oidc_sub` 绑定 | 首次登录自动绑定 ✅ |

## 八、门户

`portal.tri.local` 的「科研项目职能支持」卡片已改为 `sso: true`，显示「免登录」标识。
