# 04 域名清单与维护

> 分流规则使用 iKuai「域名分流」的后缀匹配：写入 `example.com` 即覆盖 `*.example.com` 子域。
> 每条境外域名还需要对应 DNS 代理规则（`域名` + `*.域名` 各一条 → 10.66.66.1），否则会被国内 DNS 污染。

## 1. Google 全家桶（规则 google，47 个，不含 YouTube）

核心：`google.com`、`googleapis.com`、`gstatic.com`、`googleusercontent.com`、`ggpht.com`、`gvt1.com`、`gvt2.com`、`googlesource.com`、`gmail.com`、`google.dev`、`googleblog.com`、`googlemail.com`、`goo.gl`、`g.co`

统计/广告：`google-analytics.com`、`googleanalytics.com`、`googletagmanager.com`、`googletagservices.com`、`googlesyndication.com`、`googleadservices.com`、`doubleclick.net`

其他：`blogger.com`、`blogspot.com`、`android.com`、`withgoogle.com`、`deepmind.com`、`deepmind.google`

国家/地区域名（20）：`google.com.hk`、`google.co.jp`、`google.com.tw`、`google.co.uk`、`google.de`、`google.fr`、`google.es`、`google.it`、`google.nl`、`google.ca`、`google.com.au`、`google.co.nz`、`google.com.sg`、`google.co.kr`、`google.co.in`、`google.com.br`、`google.com.mx`、`google.ru`、`google.com.tr`、`google.co.il`

> 子域已实测覆盖：accounts / drive / mail / docs / maps / translate / play / photos / gemini / notebooklm / aistudio / scholar / colab.research / console.cloud / www.googleapis / www.gstatic 等。
> `google.cn` 为国内镜像，**不纳入**。

## 2. GitHub 全家桶（规则 tech-github，12 个）

`github.com`、`githubusercontent.com`、`github.io`、`githubassets.com`、`github.dev`、`githubpreview.dev`、`githubcopilot.com`、`ghcr.io`、`github.blog`、`githubapp.com`、`github.community`、`githubstatus.com`

覆盖：api / raw / objects（release 下载）/ gist / pages / Codespaces / Copilot / Packages（ghcr、npm.pkg 等）。

## 3. AI 工具（规则 ai-tools，49 个）

**OpenAI / ChatGPT**：`openai.com`、`chatgpt.com`、`oaistatic.com`、`oaiusercontent.com`、`oaistatsig.com`、`sora.com`、`ai.com`、`chat.com`、`crixet.com`、`openaicom.imgix.net`、`openaiapi-site.azureedge.net`、`production-openaicom-storage.azureedge.net`、`workos.com`（登录/SSO）、`arkoselabs.com`（人机验证）

**Anthropic / Claude Code**：`anthropic.com`（api/console）、`claude.ai`（登录/下载）、`claude.com`（platform.claude.com）、`claudeusercontent.com`、`statsig.com`、`statsigapi.net`、`featuregates.org`（功能开关/遥测）

**其他**：`x.ai`、`grok.com`、`perplexity.ai`、`perplexity.com`、`huggingface.co`、`hf.co`、`copilot.microsoft.com`、`cursor.com`、`cursor.sh`、`windsurf.com`、`codeium.com`、`mistral.ai`、`cohere.com`、`cohere.ai`、`groq.com`、`together.ai`、`together.xyz`、`openrouter.ai`、`midjourney.com`、`elevenlabs.io`、`replit.com`、`replit.dev`、`poe.com`、`lmstudio.ai`、`ollama.com`、`runwayml.com`、`stability.ai`、`v0.dev`

> Claude Code 可设 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1` 关闭 Statsig/Sentry 遥测；
> ChatGPT 语音模式会连 Azure 特定 IP（非域名），需要语音时再补 IP。

## 4. CDN / 反欺诈（规则 cdn-anti-bot，6 个）

`cloudflare.com`（覆盖 challenges/insights/turnstile）、`recaptcha.net`、`hcaptcha.com`、`akamaihd.net`、`akamaized.net`、`fastly.net`

## 5. 验证用（规则 ifconfig-me，2 个）

`ifconfig.me`、`ifconfig.co`（用于快速确认出口 IP）

## 6. 明确排除

| 域名 | 原因 |
|---|---|
| youtube.com、youtu.be、ytimg.com、youtube-nocookie.com、googlevideo.com | 视频带宽大，按需求不走 VPN（直连被墙，不可访问） |
| google.cn | 国内镜像，直连 |

## 7. 新增域名流程

1. 把域名加入对应分流规则（后缀即可）：

   ```bash
   ikuai-cli routing stream domain update <规则ID> --domain "原有域名,新域名" --interface ovpnAliyun --enabled yes
   ```

2. 为新域名创建 DNS 代理规则（**两条**）：

   ```bash
   ikuai-cli network dns proxy create --domain "new.example" --dns-addr 10.66.66.1 --parse-type proxy
   ikuai-cli network dns proxy create --domain "*.new.example" --dns-addr 10.66.66.1 --parse-type proxy
   ```

3. 验证：

   ```bash
   dig +short @192.168.9.1 www.new.example
   curl -o /dev/null -w '%{http_code}\n' https://www.new.example/
   ```

## 8. 规则数量上限

- iKuai DNS 代理规则：约 **255 条**上限，当前 **232 条**（230 境外 + 2 内网）。
- 每个新境外域名消耗 2 条。剩余约 11 个域名余量，之后需要合并/清理或改为旁路由方案。
