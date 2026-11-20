# POC 计划（M1）

> 目标：用最小代价验证 3 个可能推翻方案的不确定点，再投入 MVP 开发。

## POC-1 真机录音通路（最高风险，先做）

在飞书移动端打开测试 H5 页面，分别验证：

| # | 验证项 | 判定标准 |
|---|---|---|
| 1 | `navigator.mediaDevices.getUserMedia` 在飞书 WebView（iOS/Android）是否可用 | 能拿到 `MediaStream` 并录出可播放音频 |
| 2 | 飞书 JSAPI `tt.getRecorderManager`（需 JSAPI config 鉴权）是否可用 | `start({duration:540000, sampleRate:16000, numberOfChannels:1})` 能录 9 分钟 |
| 3 | `onFrameRecorded` / `onStop` 得到的文件能否被 `fetch` 或 `tt.uploadFile` 上传到自有域名 | 服务器收到完整分段 |
| 4 | 息屏、切后台、来电后的行为 | 记录现象，决定是否需要"保持前台"引导 |
| 5 | 上传耗时（4G/WiFi，17MB 一段） | 决定分段长度与码率策略 |

**决策分支**：
- JSAPI 可用 → 主路径（录 ⟶ 分段 ⟶ 自行上传）。
- 仅 getUserMedia 可用 → 用 MediaRecorder（webm/opus 或 mp4）分段。
- 都不可用 → 降级为「手机系统录音 App 录 → 飞书内 H5 选文件上传」，并保留 PC 浏览器录音。

## POC-2 转写与纪要质量（可与 POC-1 并行）

1. 准备 3–20 段真实会议录音（建议：2 场 60 分钟 + 几段 10 分钟客户沟通）。
2. 同一音频跑：腾讯（会议引擎 + 分离）、火山（ssd_version=300）、百炼 paraformer-v2。
3. 指标：人名/专有名词错误数、说话人切分错误（DER 粗测）、人工整理到"能发"的耗时（分钟/场）。
4. 用 DeepSeek 生成三套模板纪要，让 2–3 位真实用户打分。
5. 输出：选定主 ASR + 单场成本 + 纪要 prompt v1。

## POC-3 飞书链路（依赖应用创建）

1. 免登：`requestAuthCode` → 后端换 user_access_token → open_id → 员工档案。
2. 卡片：`im/v1/messages` 发 interactive card 到个人/群，按钮跳详情页。
3. 归档：回调公司网站 URL + 可选 SMTP 邮件。

## 需要用户提供

- 飞书自建应用 App ID/Secret（`~/.mm/feishu-minutes`）
- 腾讯云 ASR SecretId/SecretKey（`~/.mm/tencent-asr`）
- 服务器 SSH + 域名（`~/.mm/server`）
- 3–20 段真实录音（可选，用于 A/B；也可先用公开中文会议音频冒烟）
