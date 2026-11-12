# TraceWork 开放 API 文档

> 版本：v1　　基础路径：`https://work.tri.local/api/v1`
> 在线规范：<https://work.tri.local/api/v1/openapi.json>

---

## 一、快速上手

### 1. 获取凭证

有两种方式，任选其一。

**方式 A：API Key（推荐给系统集成）**

在「系统管理 → 开放 API 密钥」点击「创建密钥」，选择权限范围与有效期。
**密钥明文只显示一次**，请立即保存。

**方式 B：账号密码换 Token（适合调试脚本）**

```bash
curl -X POST https://work.tri.local/api/v1/auth/token \
  -H 'Content-Type: application/json' \
  -d '{"username":"yourname","password":"yourpassword"}'
```

响应：

```json
{
  "ok": true,
  "data": {
    "accessToken": "eyJhbGciOiJIUzI1NiIs...",
    "tokenType": "Bearer",
    "expiresIn": 7200,
    "user": { "id": 1, "username": "linyiyao", "role": "admin" }
  }
}
```

### 2. 调用接口

```bash
curl https://work.tri.local/api/v1/projects \
  -H "Authorization: Bearer <你的凭证>"
```

---

## 二、认证与权限

### 2.1 请求头

```
Authorization: Bearer <API Key 或 JWT>
```

API Key 以 `twk_` 开头，JWT 以 `eyJ` 开头，服务端自动识别。

### 2.2 权限模型

> **最终权限 = API Key 的 scopes ∩ 归属用户的角色权限**

即使创建 Key 时授予了 `*`，也只能做该用户角色允许的事。
这避免了「用低权限账号的 Key 越权操作」。

### 2.3 权限范围（scopes）

| Scope | 说明 |
|---|---|
| `timesheet:read` | 读取工时明细、工时单 |
| `timesheet:write` | 填报工时、提交/撤回报工 |
| `approval:read` | 读取审批单 |
| `approval:write` | 审批通过/驳回 |
| `project:read` | 读取项目与成员、审批人 |
| `project:write` | 新建/修改/删除项目，配置成员与审批人 |
| `costing:read` | 读取费用归集、公共费用、委外、台账 |
| `costing:write` | 维护费用、公共费用、委外、台账 |
| `summary:read` | 读取月度汇总与多口径测算 |
| `summary:write` | 生成分摊/测算快照 |
| `doc:read` | 读取备查资料清单与下载 Word |
| `doc:write` | 生成备查资料 |
| `asset:read` | 读取 IT 资产 |
| `asset:write` | 维护 IT 资产 |
| `user:read` | 读取用户列表 |
| `user:write` | 修改用户档案与角色 |
| `admin` | 系统管理（AD 同步、审计日志、API Key 管理） |
| `*` | 全部权限 |

也支持领域通配，如 `costing:*` 等价于 `costing:read` + `costing:write`。

### 2.4 各角色最大可授予范围

| 角色 | 最大 scopes |
|---|---|
| admin | `*` |
| hr | 工时、审批、项目、费用、汇总、资料、资产全部 + `user:read` |
| finance | 费用、汇总、资料全部 + 工时读、审批、项目 |
| pm | 工时、审批全部 + 项目读、汇总读 |
| employee | 工时全部 + 审批读 |

创建 Key 时若申请的 scope 超出归属角色，返回 `422 SCOPE_OVERREACH`。

---

## 三、响应格式

### 成功

```json
{
  "ok": true,
  "data": { ... }
}
```

列表接口额外带分页：

```json
{
  "ok": true,
  "data": {
    "rows": [ ... ],
    "page": 1,
    "pageSize": 50,
    "total": 137
  }
}
```

### 失败

```json
{
  "ok": false,
  "error": {
    "code": "FORBIDDEN",
    "message": "当前凭证缺少权限范围「project:write」"
  }
}
```

### 错误码表

| HTTP | code | 含义 |
|---|---|---|
| 400 | `BAD_REQUEST` | 请求参数不合法 |
| 401 | `NO_CREDENTIAL` | 未提供 Authorization 头 |
| 401 | `INVALID_KEY` | API Key 不存在 |
| 401 | `KEY_REVOKED` | API Key 已吊销 |
| 401 | `KEY_EXPIRED` | API Key 已过期 |
| 401 | `INVALID_TOKEN` | JWT 无效或过期 |
| 403 | `FORBIDDEN` | 缺少所需 scope |
| 403 | `ROLE_FORBIDDEN` | 角色不允许该操作 |
| 403 | `OWNER_INACTIVE` | Key 归属用户已停用 |
| 404 | `NOT_FOUND` | 对象不存在 |
| 409 | `LOCKED` | 数据已锁定（如工时已审批） |
| 409 | `HAS_REFERENCES` | 对象被引用，不可删除 |
| 409 | `ALREADY_DECIDED` | 审批单已处理 |
| 422 | `VALIDATION` | 字段校验失败 |
| 422 | `SCOPE_OVERREACH` | 申请的 scope 超出角色权限 |
| 429 | `RATE_LIMITED` | 超过限流阈值 |
| 500 | `INTERNAL_ERROR` | 服务器内部错误 |

---

## 四、限流

按 API Key 每分钟限流（默认 600 次，创建时可调）。

响应头：

```
X-RateLimit-Limit: 600
X-RateLimit-Remaining: 587
```

超限返回 `429`，并带 `Retry-After`（秒）。

---

## 五、接口清单

### 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/token` | 账号密码换 Token |
| GET | `/auth/whoami` | 查看当前身份与权限 |

### API 密钥（仅 admin）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api-keys` | 密钥列表 |
| POST | `/api-keys` | 创建密钥（明文仅返回一次） |
| DELETE | `/api-keys/{id}` | 吊销密钥 |
| GET | `/api-keys/scopes` | 列出全部 scope |
| GET | `/api-logs` | API 调用日志 |

### 项目

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/projects` | 项目列表 |
| GET | `/projects/{id}` | 详情（含成员、审批人） |
| POST | `/projects` | 新建 |
| PATCH | `/projects/{id}` | 修改 |
| DELETE | `/projects/{id}` | 删除（有业务数据时 409） |
| PUT | `/projects/{id}/members` | 设置成员（整表替换） |
| PUT | `/projects/{id}/approvers` | 设置审批人（或签，≤20 位） |

### 用户

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/users` | 用户列表（支持 role/q 过滤） |
| GET | `/users/me` | 当前用户 |
| PATCH | `/users/{id}` | 修改档案 |

### 工时

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/timesheets/{period}` | 某月工时单与明细 |
| PUT | `/timesheets/{period}/day` | 保存某天填报（整日覆盖） |
| POST | `/timesheets/{period}/submit` | 提交报工 |
| POST | `/timesheets/{period}/withdraw` | 撤回报工 |
| GET | `/timesheets/{period}/history` | 某月明细 |
| GET | `/entries` | 明细查询（多维过滤 + 分页） |

### 审批

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/approvals` | 审批收件箱 |
| POST | `/approvals/{id}/decide` | 审批（approve / reject） |

### 考勤

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/attendance/{period}` | 某月考勤 |
| PUT | `/attendance/{period}/{userId}` | 设置考勤 |
| DELETE | `/attendance/{period}/{userId}` | 清除考勤 |
| GET | `/calendar/{period}` | 节假日日历 |

### 费用

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/cost-entries` | 费用明细 |
| PATCH/DELETE | `/cost-entries/{id}` | 修改/删除 |
| GET/POST | `/shared-expenses` | 公共费用 |
| GET | `/outsourcing` | 委外/合作研发 |
| GET | `/ledgers` | 15 类台账目录 |
| GET | `/ledgers/{key}` | 某类台账（含派生字段） |
| POST | `/ledgers/{key}/rows` | 新增台账行 |
| PATCH/DELETE | `/ledgers/{key}/rows/{id}` | 修改/删除 |

### 汇总与测算

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/summary/{period}` | 月度汇总（`?snapshot=1` 生成快照） |
| GET | `/deduction/{period}` | 多口径测算（`?scope=month\|year`） |
| GET | `/labor-allocation/{period}` | 工时转人工费用预览 |

### 备查资料

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/documents` | 模板清单与生成记录 |
| GET | `/documents/{key}/preview` | 下载 Word |
| POST | `/documents/generate` | 批量生成 |

### IT 资产

| 方法 | 路径 | 说明 |
|---|---|---|
| GET/POST | `/assets` | 资产列表/新增 |
| GET | `/assets/stats` | 统计 |
| GET/PATCH/DELETE | `/assets/{id}` | 详情/修改/删除 |
| POST | `/assets/{id}/return` | 办理归还 |

### 系统

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/meta` | 元数据（角色、scope、项目） |
| GET | `/openapi.json` | OpenAPI 3.0 规范 |

---

## 六、调用示例

### 示例 1：查询某个人的某月工时

```bash
curl "https://work.tri.local/api/v1/entries?period=2026-10&userId=9&pageSize=100" \
  -H "Authorization: Bearer $TOKEN"
```

### 示例 2：填报某天工时

```bash
curl -X PUT "https://work.tri.local/api/v1/timesheets/2026-10/day" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
    "date": "2026-10-09",
    "entries": [
      { "projectId": 36, "hours": 6, "note": "" },
      { "projectId": 37, "hours": 2, "note": "" }
    ]
  }'
```

### 示例 3：批量拉取费用明细（Python）

```python
import requests

TOKEN = "twk_xxxxxxxxxxxx"
BASE = "https://work.tri.local/api/v1"
H = {"Authorization": f"Bearer {TOKEN}"}

page = 1
all_rows = []
while True:
    r = requests.get(f"{BASE}/cost-entries",
                     params={"period": "2026-10", "page": page, "pageSize": 200},
                     headers=H)
    r.raise_for_status()
    d = r.json()["data"]
    all_rows.extend(d["rows"])
    if page * d["pageSize"] >= d["total"]:
        break
    page += 1

print(f"共 {len(all_rows)} 条费用记录")
```

### 示例 4：审批（或签）

```bash
curl -X POST "https://work.tri.local/api/v1/approvals/12/decide" \
  -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"decision": "approve", "comment": "同意"}'
```

### 示例 5：查询 IT 资产并导出

```bash
# 查询在用笔记本
curl "https://work.tri.local/api/v1/assets?type=笔记本&status=在用" \
  -H "Authorization: Bearer $TOKEN"
```

---

## 七、安全建议

1. **密钥最小化授权**
   只授予实际需要的 scope。报表系统用 `*:read` 即可，不要给 `*`。

2. **设置有效期**
   为短期集成设置过期时间，长期不用的密钥及时吊销。

3. **定期检查调用日志**
   「系统管理」页面可看每个 Key 的调用次数与最后使用时间。
   异常时间或异常量级应警惕。

4. **密钥不入代码库**
   通过环境变量或密钥管理服务注入，切勿硬编码。

5. **优先用 API Key**
   账号密码换 Token 适合调试，不宜用于生产集成（密码需在客户端保存）。

---

## 八、验证

```bash
cd /opt/rnd-timesheet/deploy
TEST_USER=你的账号 TEST_PASS=你的密码 bash test-api.sh
```

覆盖 24 项：认证、权限隔离、限流、响应格式、各领域接口、日志、密钥生命周期、OpenAPI 规范。