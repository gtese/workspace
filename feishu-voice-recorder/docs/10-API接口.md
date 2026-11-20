# API 接口

Base：`https://voice.traceic.com:5266`；文档页：`/docs`；OpenAPI：`/openapi.json`。

## 鉴权

| 模式 | 规则 |
|---|---|
| 生产（`FM_FEISHU_MODE=real`） | 必须带 `Authorization: Bearer fm_...`（飞书免登后签发，7 天有效）；缺失/过期返回 401 |
| 开发（`FM_FEISHU_MODE=mock`） | 可用 `X-Employee-Open-Id` 模拟身份，缺省 `demo` |
| 分享链接 | `/s/<id>?exp&sig` 与 `/api/v1/shared/<id>` 免登录，签名有效期 30 天 |
| 媒体文件 | `/media/...` 需 `exp+sig`，默认 1 小时 |

会话 token 由 `POST /api/v1/auth/feishu-login` 签发，存放在前端 `localStorage.fm_token`。

## 接口

### 系统

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 返回 asr/llm/feishu 当前模式（公开） |
| GET | `/api/v1/feishu/app-id` | 前端登录用 App ID 与模式 |
| POST | `/api/v1/auth/feishu-login` | `{code}` → `{open_id,name,token}` |
| GET | `/api/v1/me` | 当前员工信息 |

### 录音

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/v1/recordings` | `{title, scene}` 创建会话 |
| GET | `/api/v1/recordings` | 我的录音列表（最近 100） |
| GET | `/api/v1/recordings/{id}` | 详情（转写、纪要、音频地址、文档地址） |
| POST | `/api/v1/recordings/{id}/segments?idx=N` | 上传分段（multipart `file`，wav/m4a/mp3/webm，≤120MB） |
| POST | `/api/v1/recordings/{id}/finish` | 提交转写（完成后返回，处理中 409） |
| POST | `/api/v1/recordings/{id}/rerun` | 重新生成（处理中 409） |
| DELETE | `/api/v1/recordings/{id}` | 移除录音（音频+纪要，处理中 409） |
| GET | `/api/v1/recordings/{id}/share` | 生成 30 天签名分享链接（返回 `revoked` 状态） |
| POST | `/api/v1/recordings/{id}/share/revoke` | 撤销分享链接 |
| DELETE | `/api/v1/recordings/{id}/share/revoke` | 恢复分享链接 |
| POST | `/api/v1/recordings/{id}/send` | `{receive_id, receive_id_type}` 转发卡片 |
| PUT | `/api/v1/recordings/{id}/speakers` | `{mapping: {"发言人1":"张三"}}` 改名 |

### 检索与统计

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/search?q=` | 标题/转写/纪要全文搜索，返回片段 |
| GET | `/api/v1/stats` | 录音数、总分钟、预估转写成本 |

### 公开

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/shared/{id}?exp&sig` | 分享链接只读详情（撤销后 403，访问写审计） |
| GET | `/media/{path}?exp&sig` | 签名音频 |

## 运维接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/health` | 公开探活（含 version、db_ok） |
| GET | `/api/v1/ops/health` | 需 `X-Ops-Token: $FM_OPS_TOKEN`，返回队列/失败/磁盘快照 |

## 限流

按 open_id + 动作的令牌桶，超限返回 `429` + `Retry-After: 30`。
默认：创建 20/min、分段 120/min、提交 20/min、分享/删除/发送 30/min、改名 60/min（突发上限见 `app/ratelimit.py`）。

## 状态码

- `400` 参数/音频格式错误
- `401` 未登录或 token 过期（前端自动重登）
- `404` 不存在或无权访问（不区分）
- `409` 处理中，禁止重复提交/删除
- `413` 单段超过 120MB
