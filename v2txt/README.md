# V2TXT · 录音转文字与智能纪要平台

把会议录音变成可执行纪要的 SaaS：网页直接录音、上传音视频，自动转写（含发言人区分）、生成中英纪要，支持签名分享、邮件交付、团队协作与额度计费。

面向海外/港澳台客户，公网入口走 Cloudflare Tunnel（服务器零公网暴露、不需要 NAT 映射）。

## 功能

| 模块 | 能力 |
|---|---|
| 账号 | 邮箱 + 密码注册登录、邮箱验证、忘记密码、30 天会话、修改密码即踢下线 |
| 租户 | 个人空间即用它；可升级为团队，邀请成员、角色（owner/admin/member）、共享额度池 |
| 录音 | 浏览器录音，16k 单声道 WAV，5 分钟自动分段上传、失败重试，放弃即删除 |
| 上传 | wav/mp3/m4a/mp4/mov 等整文件上传，自动转码、时长与大小限制 |
| 转写 | 阿里云 `qwen-audio-3.1-asr-flash-filetrans`，发言人区分（发言人1/2…），可改名 |
| 纪要 | `qwen3.8-flash` JSON 模式输出摘要/决议/待办/风险，中文或英文 |
| 交付 | 签名分享链接（30 天、可撤销、访问审计）、邮件、飞书卡片（可选通道） |
| 计费 | 分钟钱包 + 订阅套餐 + 额度台账 + 对公转账订单（人工确认）+ 成本毛利核算 |
| 运营 | 运营后台：用户、订单确认、手工调额度、30 天用量与毛利 |

## 架构

```
浏览器 ──HTTP──┐
               ├─→ cloudflared (Cloudflare Tunnel, 出站连接) ─→ FastAPI 容器 ─→ SQLite/Postgres
飞书/邮件 ─────┘                                                  │
                                                                  ├─ 阿里云 DashScope（ASR/LLM）
                                                                  └─ 本地磁盘 data/recordings
```

- 单容器应用（`api`），内置 DB 队列 worker（`FM_WORKER_COUNT` 线程原子认领任务）。
- 数据默认 SQLite，可选 Postgres（`--profile pg`）。
- 音频转写后 WAV 压缩为 m4a 并删除分段，默认保留 30 天。

## 快速开始（本地）

```bash
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt -r backend/requirements-dev.txt
cp deploy/env.example .env          # 改 FM_SECRET_KEY；本地可用 mock provider
cd backend && FM_DATA_DIR=../data FM_ASR_PROVIDER=mock FM_LLM_PROVIDER=mock \
  PYTHONPATH=. ../.venv/bin/python -m uvicorn app.main:app --reload --port 8000
```

打开 http://127.0.0.1:8000 注册账号即可（mock 模式下 ASR/LLM 返回固定结果）。

测试与检查：

```bash
.venv/bin/python -m pytest -q backend/tests   # 76 passed
.venv/bin/ruff check .
```

## 部署（Docker）

```bash
cp deploy/env.example .env && chmod 600 .env   # 必改 FM_SECRET_KEY / FM_PUBLIC_BASE_URL
make build && make up
make health
```

服务器上必须能访问：`dashscope.aliyuncs.com`（ASR/LLM）、`mirrors.aliyun.com`（apt/pip 镜像）、SMTP 服务；公网入口依赖 `cloudflared` 能访问 Cloudflare 边缘（`region1.v2.argotunnel.com` 等）。

Cloudflare Tunnel（宿主机 systemd，不占容器）：

```bash
cloudflared tunnel login                       # 或直接 tunnel token
cloudflared tunnel create v2txt
cloudflared tunnel route dns v2txt app.v2txt.cn
cloudflared service install <TUNNEL_TOKEN>
```

`.env` 中 `BIND_ADDR` 默认 `127.0.0.1`（只给 cloudflared 用）；内网直连调试时改成服务器内网 IP。

## 关键配置

见 [`deploy/env.example`](deploy/env.example)，重点：

| 变量 | 说明 |
|---|---|
| `FM_SECRET_KEY` | 会话与签名链接密钥，必须改，泄露等于全站失守 |
| `FM_PUBLIC_BASE_URL` | 生成验证邮件/分享链接的站点地址 |
| `FM_ADMIN_EMAILS` | 运营后台权限邮箱，逗号分隔 |
| `FM_SIGNUP_BONUS_MINUTES` | 新注册赠送额度 |
| `FM_PRICE_PER_MINUTE_USD` | 超额单价 |
| `FM_ASR_PROVIDER` | `aliyun_filetrans`（生产）/ `mock`（本地） |
| `FM_EMAIL_MODE` | `real` 走 SMTP，`mock` 只写日志 |
| `FM_RETENTION_DAYS` | 音频保留天数 |

凭据不进仓库：`~/.mm/aliyun`、`~/.mm/smtp` 等由容器只读挂载到 `/app/.mm`，由 `app/secrets.py` 读取。

## 目录

```
backend/app/            FastAPI 应用
  api/                  auth_users, orgs, billing_api, admin, recordings, uploads, shared, media
  accounts.py           密码哈希（scrypt）、会话、一次性令牌
  billing.py            钱包/台账/扣费/套餐
  mailer.py             邮件发送与模板
  pipeline.py           合并 → 转写 → 纪要 → 分发 → 结算
  asr/ llm/ feishu/     外部能力适配
web/                    index / auth / app / admin / detail（原生 HTML+JS）
deploy/                 env.example、entrypoint
docs/                   设计、部署、API、运维文档
```

## 计费规则

- 扣费按音频时长，向上取整到 0.1 分钟，最低 0.5 分钟。
- 套餐按周期发放额度（`grant`），超额从钱包余额按单价扣（`consume`）。
- 对公转账：客户提交充值单 → 运营后台「确认到账」→ 额度入账并邮件通知。
- 每个任务记录 ASR/LLM 成本，运营后台可看 30 天毛利。

## 安全

- 密码 scrypt（N=16384）加盐哈希；会话只存 SHA-256，可即时撤销。
- 所有数据按 `org_id` 隔离，`X-Org-Id` 头必须命中成员关系。
- 分享链接 HMAC 签名、可撤销、访问留审计。
- 进程内令牌桶限流（登录/注册/录音/上传/订单）。
- 容器 `cap_drop: ALL`、`no-new-privileges`。

## 许可

私有项目，未经许可不得分发。
