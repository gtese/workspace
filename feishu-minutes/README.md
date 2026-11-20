# feishu-minutes · 飞书录音纪要

在飞书工作台打开一个**网页应用**，手机录音（30–90 分钟会议，2 分钟一段自动落盘上传），1–5 分钟后拿到带时间戳、发言人分段、待办的结构化纪要，推送飞书群、回调公司网站、可选邮件发送。

> 入口用**网页应用（H5）**而不是小程序——飞书官方已将小程序标记为"不再升级迭代、推荐网页应用"，且新企业可能无法创建小程序入口。详见 [ADR-001](docs/04-技术决策记录.md)。

## 现在能跑什么

本地 mock 模式（无需任何凭据）即可跑通：**录音 → 分段上传 → 合并 → 转写 → 纪要 → 飞书卡片（落盘模拟）→ 签名音频播放**。

```bash
cd backend
FM_SYNC_PIPELINE=true ../.venv/bin/python -m uvicorn app.main:app --port 8000
# 打开 http://127.0.0.1:8000/
```

- 录音页：`/`（WAV 编码、2 分钟自动分段、断点重传、环境自检、飞书免登）
- 详情页：`/d/{id}`（摘要/要点/待办/全文/音频播放）
- API 文档：`/docs`（FastAPI 自动生成）
- 测试：`cd backend && ../.venv/bin/python -m pytest -q`（31 个用例）
- 浏览器 E2E：`cd backend && FM_E2E_BASE=http://127.0.0.1:8777 ../.venv/bin/python tests/e2e/test_recorder_browser.py`

## 文档

| 文档 | 内容 |
|---|---|
| [需求与方案 v0.2](docs/01-需求与方案.md) | 需求画像、架构、功能清单、选型、成本、里程碑 |
| [飞书应用配置清单](docs/02-飞书应用配置清单.md) | 自建应用创建、scope、发布流程 |
| [技术决策记录](docs/04-技术决策记录.md) | 7 条 ADR，含官方文档证据链接 |
| [POC 计划](docs/05-POC计划.md) | 先验证什么、怎么验证、需要什么素材 |
| [开发与部署](docs/06-开发与部署.md) | 本地运行、测试、切真实服务、Docker 部署 |

## 结构

```
backend/app/           FastAPI 服务
  api/                 录音会话 / 分段上传 / 签名媒体
  asr/                 转写适配器（mock / 腾讯云）
  llm/                 纪要生成（mock / DeepSeek）
  feishu/              应用机器人卡片
  pipeline.py          合并 → 转写 → 纪要 → 分发
web/                   H5 录音页、详情页
deploy/                Caddy 配置
docker-compose.yml     api + postgres + caddy
```

## 当前状态

- 需求：3 轮问答已对齐
- 选型：已定稿（v0.2）
- POC：后端全链路已跑通（mock）；浏览器真实录音 E2E 已通过（Chromium 假麦克风）
- 队列：DB worker 串行处理，重启不丢任务；音频 90 天自动清理
- 分发：飞书卡片（mock 落盘）、网站回调（HMAC 签名）、邮件 SMTP（mock 落盘）三条通道已实现
- 下一步：飞书应用 + 腾讯云 ASR 凭据到位后真机联调
