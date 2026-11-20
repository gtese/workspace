# gateway — 办公网 VPN 网关与域名分流

办公网（iKuai）通过 OpenVPN 隧道接入海外云节点，实现 **指定域名走海外节点、其余流量直连**；
同时用 iKuai 的「按域名指定 DNS 服务器」能力做 DNS 分流，解决国内 DNS 对部分域名的污染问题。

## 当前拓扑

```
办公网 192.168.9.0/24
   │
   ├─ iKuai 4.0.313 (IK-A160) 192.168.9.1
   │    ├─ wan1 PPPoE 223.167.143.174（默认出口，国内直连）
   │    ├─ l2tpToSx 10.10.10.10 → IDC（AD DNS 172.16.10.114, tri.local）
   │    └─ ovpnAliyun（OpenVPN 客户端）─── UDP 443 ───┐
   │                                                │
   └─ 阿里云 ECS 东京（ap-northeast-1）8.211.181.28  │
        ├─ OpenVPN server  tun 10.66.66.0/24       ←┘
        ├─ dnsmasq 10.66.66.1:53 → 1.1.1.1/8.8.8.8（干净解析，走隧道）
        └─ NAT（MASQUERADE 10.66.66.0/24 → eth0）→ 境外网站
```

## 关键信息

| 项目 | 值 |
|---|---|
| 办公网段 | 192.168.9.0/24，网关 192.168.9.1（iKuai OS 4.0.313） |
| VPN 节点 | 阿里云 ECS 东京，公网 8.211.181.28，私网 172.21.44.11 |
| 节点系统 | Ubuntu 24.04.5，2 vCPU / 1.7GB / 20GB，RTT(办公室) ≈ 43ms |
| VPN | OpenVPN 2.6.19，UDP 443，证书认证，隧道 10.66.66.0/24 |
| 隧道地址 | 服务端 10.66.66.1，iKuai 10.66.66.2 |
| 干净 DNS | 10.66.66.1（dnsmasq，上游 1.1.1.1 / 8.8.8.8） |
| 默认 DNS（国内） | 119.29.29.29（备用 172.16.10.114 AD DNS） |
| 内网域名 | tri.local / *.tri.local → 172.16.10.114 |

## 域名分流现状（iKuai → ovpnAliyun）

| 规则 | 域名数 | 内容 |
|---|---|---|
| ifconfig-me | 2 | ifconfig.me / ifconfig.co（验证出口用） |
| tech-github | 12 | github.com、githubusercontent.com、github.io、githubassets.com、github.dev、githubpreview.dev、githubcopilot.com、ghcr.io、github.blog、githubapp.com、github.community、githubstatus.com |
| google | 47 | Google 全家桶（含 20 个国家级域名），**不含 YouTube** |
| ai-tools | 49 | OpenAI/ChatGPT、Anthropic/Claude Code、xAI、Perplexity、HuggingFace、Cursor、Windsurf/Mistral/Cohere/Groq/Together/OpenRouter 等 |
| cdn-anti-bot | 6 | cloudflare.com、recaptcha.net、hcaptcha.com、akamaihd.net、akamaized.net、fastly.net |

- **YouTube 全家桶被排除**（youtube.com / youtu.be / ytimg.com / youtube-nocookie.com / googlevideo.com）：节省带宽，访问会被墙直连超时。
- DNS 代理规则 **232 条**：230 条 → 10.66.66.1（境外域名干净解析），2 条 → 172.16.10.114（内网 tri.local）。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | 架构、数据流、设计决策 |
| [docs/02-node-deploy-aliyun.md](docs/02-node-deploy-aliyun.md) | 阿里云节点部署与清理（含阿里云 agent 卸载坑） |
| [docs/03-ikuai-config.md](docs/03-ikuai-config.md) | iKuai 线路/分流/DNS 配置与 API 操作 |
| [docs/04-domain-lists.md](docs/04-domain-lists.md) | 域名清单与维护方法、规则上限 |
| [docs/05-operations.md](docs/05-operations.md) | 运维验证、加域名、切节点、回滚、故障排查 |
| [docs/06-history.md](docs/06-history.md) | 节点历史与变更记录 |

## 快速验证

```bash
# 出口应为 8.211.181.28（经 VPN），非分流站点应为办公室出口
curl -s ifconfig.me
curl -s https://ipinfo.io/ip

# 干净解析验证（经 iKuai）
dig +short @192.168.9.1 www.google.com
dig +short @192.168.9.1 api.anthropic.com

# 连通性
curl -o /dev/null -w '%{http_code}\n' https://api.github.com/zen
curl -o /dev/null -w '%{http_code}\n' https://api.openai.com/v1/models
```

## 注意

- 凭据（iKuai API token、SSH 私钥、OpenVPN 私钥/证书）**不进入本仓库**；脚本一律从环境变量或本机凭据目录读取。
- iKuai DNS 代理规则上限约 255 条，当前 232 条，扩展前需清理/合并。
- 节点出口为数据中心 IP（Cloudflare 判定 JP/NRT；ip-api 标记 hosting=true），部分站点反欺诈可能额外风控。
