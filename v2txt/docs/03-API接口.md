# 03 · API 接口

Base：`/api/v1`。除公开接口外都需要：

```
Authorization: Bearer vt_xxx
X-Org-Id: org_xxx        # 团队空间（默认为用户默认空间）
```

## 认证

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/auth/register` | `{email,password,name?,locale?}` → `{token,user}`，同时发验证邮件 |
| POST | `/auth/login` | `{email,password}` → `{token,user}` |
| POST | `/auth/logout` | 撤销当前会话 |
| POST | `/auth/verify-email` | `{token}` |
| POST | `/auth/resend-verify` | 重发验证邮件（需登录） |
| POST | `/auth/forgot-password` | `{email}`，无论是否存在都返回 200 |
| POST | `/auth/reset-password` | `{token,password}`，成功后撤销全部会话 |
| GET | `/me` | 用户 + 空间列表 + 余额 |
| PATCH | `/me` | `{name?,locale?}` |
| POST | `/me/password` | `{old_password,new_password}`，成功后撤销全部会话 |

## 团队

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/orgs` | 我的空间列表 |
| POST | `/orgs` | `{name}` 新建团队空间（owner） |
| PATCH | `/orgs/{id}` | 改名（owner） |
| GET | `/orgs/{id}/members` | 成员 + 待接受邀请 |
| POST | `/orgs/{id}/invites` | `{email,role}` 发邀请（非生产环境返回 link） |
| POST | `/orgs/accept-invite` | `{token}` |
| PATCH | `/orgs/{id}/members/{uid}` | `{role}`（owner） |
| DELETE | `/orgs/{id}/members/{uid}` | 移除成员 |
| POST | `/me/switch-org` | `{org_id}` 切换默认空间 |

## 计费

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/billing/summary` | 余额、套餐、单价、低额告警 |
| GET | `/billing/plans` | 套餐 + 分钟包（公开） |
| GET | `/billing/ledger?limit=` | 额度流水 |
| GET | `/billing/orders` | 我的订单 |
| POST | `/billing/orders` | `{minutes,amount,currency,payer_name?,note?}` 充值单 |
| POST | `/billing/subscribe` | `{plan_code}` 订阅单 |
| POST | `/billing/orders/{id}/cancel` | 取消待确认订单 |
| GET | `/billing/payment-info` | 对公账户信息 |

## 录音

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/recordings` | `{title,scene}` 新建（需余额） |
| GET | `/recordings` | 空间内最近 100 条 |
| GET | `/recordings/{id}` | 详情（含转写/纪要/音频签名 URL） |
| POST | `/recordings/{id}/segments?idx=N` | multipart `file`，分段音频 |
| POST | `/recordings/{id}/finish` | 结束并转写（需余额） |
| POST | `/recordings/{id}/rerun` | 重新转写 |
| DELETE | `/recordings/{id}` | 删除（处理中禁止） |
| PUT | `/recordings/{id}/speakers` | `{mapping:{"发言人1":"张三"}}` |
| GET | `/recordings/{id}/share` | 分享链接 + 是否已撤销 |
| POST/DELETE | `/recordings/{id}/share/revoke` | 撤销/恢复分享 |
| POST | `/recordings/{id}/send` | 飞书卡片（通道未启用返回 400） |
| POST | `/recordings/{id}/email` | 把纪要邮件发给自己 |
| GET | `/search?q=` | 标题/转写/纪要全文搜索 |
| GET | `/stats` | 空间统计 |

## 上传

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/uploads/limits` | 支持格式、大小/时长上限 |
| POST | `/uploads` | multipart `file` + `title`，转码后入队 |

## 运营后台（`FM_ADMIN_EMAILS`）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/admin/overview` | 用户数、录音数、收入/成本、待确认订单 |
| GET | `/admin/users?q=` | 用户列表（含余额、验证状态） |
| POST | `/admin/users/{id}/status` | `{status: active|disabled}` |
| GET | `/admin/orders?status=` | 订单列表 |
| POST | `/admin/orders/{id}/confirm` | `{minutes?,note?}` 确认到账 |
| POST | `/admin/orgs/{id}/grant` | `{minutes,note}` 手工加额度 |
| GET | `/admin/usage?days=30` | 按空间聚合的用量/成本/毛利 |

## 公开接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/config` | 站点配置（注册开关、单价、赠送额度等） |
| GET | `/shared/{id}?exp=&sig=` | 分享链接只读详情，写访问审计 |
| GET | `/health` | 健康检查 |
| GET | `/ops/health` | 运维指标（`X-Ops-Token`） |

## 状态机

`created → recording → queued → transcribing → transcribed → summarizing → done | failed`

## 错误码约定

| 码 | 场景 |
|---|---|
| 400 | 参数/格式错误（弱密码、不支持的音频） |
| 401 | 未登录/会话失效 |
| 402 | 额度不足 |
| 403 | 无权限（非成员、非管理员） |
| 409 | 状态冲突（处理中、邮箱已注册） |
| 413 | 文件过大/超时长 |
| 429 | 限流，带 `Retry-After` |
