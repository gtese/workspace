# 给同事的交接包：让你的业务系统接入公司统一身份（SSO）

> 你收到这个包，说明你们要在自己的系统上做「用公司域账号登录」（接 `sso.tri.local`）。
> **照着本目录的 4 个文件从头做，不需要找 IT 反复问**；卡住时按 §5 的对照表定位问题。

---

## 0. 你需要从 IT 那里拿到三样东西

| # | 内容 | 例 |
|---|---|---|
| 1 | **Client ID** | `my-app` |
| 2 | **Client Secret** | 64 位十六进制串（**只放后端**，不要进 Git、不进前端） |
| 3 | **回调地址确认** | IT 已在 IdP 登记 `https://<你的域名>/…`，你必须用与之**完全一致**的地址 |

固定值（所有人一样，不用问）：

```
Issuer        https://sso.tri.local/realms/tri
Discovery     https://sso.tri.local/realms/tri/.well-known/openid-configuration
签名算法       RS256
PKCE          必须 S256
scope         openid profile email roles        （权限依赖 AD 组的系统再加 groups）
```

---

## 1. 四个文件，各干什么（按顺序读）

| 顺序 | 文件 | 你用来做什么 | 读完你应该能 |
|---|---|---|---|
| ① | [01-接入指南.md](01-接入指南.md) | 了解原理、流程、必做清单、安全红线 | 说出登录的 4 步，知道哪些事绝对不能做 |
| ② | [02-参数与接口.md](02-参数与接口.md) | 接口清单、请求/响应格式、claim 字段、错误码、curl 自测命令 | 不看代码就能用 curl 跑通一次登录 |
| ③ | 代码样例（挑你用的那套） | 直接抄或对照改：<br>· [Node/Fastify](../ops/integration/node-fastify/oidc.js)<br>· [Flask](../ops/integration/flask/oidc.py)<br>· [Next.js](../ops/integration/nextjs/README.md)<br>· 真实成品：[知识平台](../ops/integration/knowledge-hub/) · [工时系统](../ops/integration/man-timesheet/) | 拿到可运行的会话与路由骨架 |
| ④ | [03-验收清单.md](03-验收清单.md) | 上线前逐条打勾（含"哪些必须测、怎么测、失败怎么查"） | 自信地说"我的系统接好了" |

---

## 2. 30 秒版流程（先理解再动手）

```
浏览器                  你的系统（后端）                      sso.tri.local
  │ ①点「公司账号登录」→ /auth/login │                            │
  │ ← 302 到 IdP（带 state/nonce/PKCE 挑战）─→                    │
  │ ②在 IdP 输域账号口令 ───────────────────────────────────────→ │ 校验 AD
  │ ← 302 回 /auth/callback?code=…&state=… ──→ │                  │
  │                                           │ ③后端用 code+secret 换令牌（服务端到服务端）
  │                                           │   校验 iss/aud/exp/nonce/签名
  │                                           │   用 sub 建你自己的会话
  │ ← 302 回你要去的页面（带你的 session cookie）│
```

**你要实现的只有三个路由**：

| 路由 | 作用 | 关键点 |
|---|---|---|
| `GET /auth/login` | 302 到 IdP | 生成并**保存** state / nonce / code_verifier |
| `GET /auth/callback` | 换令牌、建会话、跳回原页面 | **校验 state**；令牌只留在后端 |
| `POST /auth/logout` | 清本地会话 + 跳 IdP 登出 | 必须整页跳转，不能 fetch |

---

## 3. 十分钟自测（不需要写代码也能先验证连通性）

```bash
# 1) 你的 client 是否能发起授权（把 CLIENT_ID 换成你的、REDIRECT 换成你登记的）
open "https://sso.tri.local/realms/tri/protocol/openid-connect/auth?client_id=CLIENT_ID&redirect_uri=REDIRECT_URI&response_type=code&scope=openid%20profile%20email%20roles&state=test&nonce=test&code_challenge=E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM&code_challenge_method=S256"

# 期望：出现公司统一登录页。
# 若报 Invalid parameter: redirect_uri → 你和 IT 登记的地址不一致（最常见问题）
# 若报 invalid_scope → 你的 client 没分配 roles/groups scope，找 IT 补
```

登录后浏览器会跳到你的回调地址（此时你还什么都没实现，页面会报错，**这是正常的**）——
只要地址栏带上了 `?code=...&state=test`，说明 IdP 侧已经完全打通，剩下的都是你系统内部的事。

---

## 4. 技术选型：别自己造轮子

| 你的技术栈 | 推荐做法 |
|---|---|
| Node.js / TypeScript | 参照 [node-fastify 样例](../ops/integration/node-fastify/oidc.js)（零依赖）或 `openid-client` 库 |
| Python | `authlib` 或参照 [Flask 样例](../ops/integration/flask/oidc.py) |
| Java / Spring | `spring-boot-starter-oauth2-client`（配置即可） |
| .NET | `Microsoft.AspNetCore.Authentication.OpenIdConnect` |
| Go | `coreos/go-oidc` |
| 前端框架（Next/Nuxt） | `next-auth` / `nuxt-auth-utils`，**回调放在后端**，不要放纯前端 |
| 没有后端（纯静态站） | 只能用 **Public Client + PKCE**，且**不能**持有 secret；请先和 IT 确认 |

> 判断标准：**回调时能不能在服务端做 HTTP 请求**。能 → Confidential Client（推荐）；
> 不能 → 只能 Public Client，安全等级下降，需要 IT 单独审批。

---

## 5. 卡住了先看这张表

| 现象 | 最可能原因 | 找谁 |
|---|---|---|
| `Invalid parameter: redirect_uri` | 回调地址与登记值不一致（多/少斜杠、http/https） | 你自己 + IT |
| `invalid_scope` | client 没分配 `roles`/`groups` scope | IT（改 `configure.py` 后 `deploy.sh provision`） |
| 登录成功但回跳后 401 | state 没保存或已过期；cookie 没带上（检查 SameSite/Secure） | 你自己 |
| 提示"账号或密码错误"但账号没错 | 你在用**域账号**登 IdP？确认是公司统一登录页，不是旧登录页 | 你自己 |
| 登录后拿到身份但没有角色 | 没请求 `roles` scope，或没读 `realm_access.roles` | 你自己 |
| 登录后"无部门/无权限" | 你的权限依赖 AD 组，但没请求 `groups` scope | 你自己 + IT |
| 退出后其它系统还是登录态 | 只清了本地 cookie，没跳 IdP 的 `end_session_endpoint` | 你自己 |
| IdP 报错信息看不懂 | 把地址栏里 `error_description=` 后面的原文发 IT | IT |

---

## 6. 边界：什么事不归这个包管

| 事项 | 谁负责 |
|---|---|
| IdP 建 client、分配 scope、改角色映射 | IT（你只要提需求：需要哪些角色） |
| 你的系统里"谁能看什么"的业务权限 | 你（按角色判断，别按 AD 组名判断） |
| AD 账号开通/禁用/调岗 | IT/HR（IdP 自动跟随 AD） |
| 你的服务器、域名、证书 | 你 |
| 上线后 IdP 侧排障 | IT（你提供：时间、账号、`error_description`） |

---

## 7. 怎么把资料发出去（IT 用）

### 7.1 发送清单（一次发全，别分批）

| 发什么 | 怎么发 |
|---|---|
| 本目录 4 个文件 | 仓库地址 `git.tri.local/it/oidc` → `docs/接入对接包/`；或打包成 zip 发 |
| 代码样例 | 同仓库 `ops/integration/`（按对方技术栈挑一个） |
| **三个参数** | **单独用安全渠道发**（公司 IM 私聊/密码管理器），**不要写进文档或群里** |
| 联调联系人 | 你的名字 + 可联调时间段 |

### 7.2 邮件/IM 模板（直接复制改）

```
你好，

公司统一身份（SSO）已上线，你的系统可以接入，员工用域账号登录一次即可进入。

已为你创建接入凭证：
  Client ID:      my-app
  Client Secret:  （见下一条消息，请勿转发）
  回调地址：       https://myapp.tri.local/auth/callback（如需其它路径告诉我改）

接入资料（请按顺序看）：
  1. 总览与自测：docs/接入对接包/README.md
  2. 接入指南：  docs/接入对接包/01-接入指南.md
  3. 接口参数：  docs/接入对接包/02-参数与接口.md
  4. 验收清单：  docs/接入对接包/03-验收清单.md
代码样例在 ops/integration/ 下挑你用的技术栈。

关键提醒：
  · 口令只在统一登录页输入，你的系统不要再接收域口令
  · 权限按 IdP 下发的角色判断，不要硬编码 AD 组名
  · 如果你们的权限依赖 AD 组，告诉我，我给你开 groups scope
  · 登录后请按验收清单跑一遍，验收通过再切生产

我可以在 <时间段> 一起联调，有问题把浏览器地址栏里的
 error_description 原文发我即可。

<你的名字>
```

### 7.3 对方回报时你要检查的三件事

1. 回调地址是否与登记完全一致（最常见问题）；
2. 是否请求了 `roles`（以及需要时的 `groups`）；
3. 旧口令登录接口是否已关闭（用 curl 验证一次）。

### 7.4 什么时候该拒绝

| 诉求 | 回答 |
|---|---|
| "我保留邮箱口令登录，跟 SSO 并存" | 不行：除非是外包/应急场景，见 [双登录方案](../双登录方案.md) |
| "给我一个能读 AD 全目录的账号" | 不行：IdP 不提供直连 AD 的能力，只给 OIDC |
| "登录失败时自动降级到本地登录" | 不行（安全红线） |
| "把 client_secret 写在前端" | 不行；除非改为 Public Client + PKCE 并由安全评审 |
| "我要在令牌里放更多用户属性" | 可以评估：走 userinfo claim，不进 ID Token |