# gateway — 办公网 VPN 网关与域名分流（v2：253 服务中心架构）

办公网（iKuai）通过 L2TP 把白名单域名流量交给 **253（服务中心）**，253 再经 OpenVPN 隧道送到 **ECS（可替换出口）** 出网；
外网/移动用户通过 Clash 订阅接入 **253**，同样由 253 转发到 ECS。iKuai、订阅链接、用户侧配置都不随 ECS 变化。

## v2 拓扑

```
办公网 192.168.9.0/24
   │
   ├─ iKuai 4.0.313 192.168.9.1
   │    ├─ wan1 PPPoE（默认出口，国内直连）
   │    ├─ l2tpToSx：L2TP 10.10.10.10 ↔ 10.10.10.1（253）  ← 白名单域名分流到这里
   │    └─ ovpnAliyun（旧线路，已停用，保留回滚）
   │
   └─ 253 / trivm253（服务中心，172.16.10.253，Rocky 8.10）
        ├─ L2TP 服务端（xl2tpd/ppp0，10.10.10.1）
        ├─ OpenVPN 服务端 egress：UDP 51821，tun-egress 10.99.99.0/24（服务端 .1）
        ├─ 策略路由 table 100：办公网来源 / 打 mark 的流量 → tun-egress
        ├─ dnsmasq 10.10.10.1 + 127.0.0.1：白名单域名 → 1.1.1.1（经隧道）
        ├─ dante sockd 127.0.0.1:1080（出站打 mark → 隧道）
        ├─ sing-box：SS 入站 0.0.0.0:50181 → socks 127.0.0.1:1080
        └─ nginx：订阅服务 50180（/s/<token>/clash）

阿里云 ECS 东京（8.211.181.28）
   └─ OpenVPN 客户端 → 253:51821（tun-egress 10.99.99.2）→ NAT（10.99.99.0/24 → eth0）→ 互联网
```

## 关键信息

| 项目 | 值 |
|---|---|
| 办公网段 | 192.168.9.0/24，网关 192.168.9.1（iKuai OS 4.0.313） |
| 服务中心 | 253 / trivm253：172.16.10.253，Rocky 8.10 |
| 出口节点 | 阿里云 ECS 东京 8.211.181.28（可替换，只负责 NAT 出网） |
| 隧道 | 253 → ECS：OpenVPN UDP 51821，10.99.99.0/24（253=.1，ECS=.2） |
| 办公网接入 | iKuai L2TP（10.10.10.0/24）到 253 |
| 订阅 | http://<公网IP>:50180/s/<token>/clash（token 见 253 nginx 配置） |
| DNS | 办公网：iKuai 强制代理 → 10.10.10.1（253 dnsmasq）→ 隧道 → 1.1.1.1；内网 tri.local → 172.16.10.114 |
| USG | 172.16.10.254：NAT 50180/50181 TCP、51821 UDP（双 WAN）；策略 Clash_Access_253；已 save |

## 当前分流规则（iKuai → l2tpToSx）

| 规则 | 域名数 | 内容 |
|---|---|---|
| ifconfig-me | 2 | ifconfig.me/co（出口验证） |
| tech-github | 12 | GitHub 全家桶 |
| google | 47 | Google 全家桶（不含 YouTube） |
| ai-tools | 49 | OpenAI/ChatGPT、Anthropic/Claude、xAI、Cursor 等 |
| cdn-anti-bot | 6 | cloudflare.com、recaptcha、hcaptcha、akamai、fastly 等 |

DNS 代理规则 **232 条**：230 → 10.10.10.1（境外白名单），2 → 172.16.10.114（tri.local）。

## 文档索引

| 文档 | 内容 |
|---|---|
| [docs/01-architecture.md](docs/01-architecture.md) | v2 架构、数据流、设计决策 |
| [docs/02-node-deploy-aliyun.md](docs/02-node-deploy-aliyun.md) | ECS 出口节点（OpenVPN 客户端）部署 |
| [docs/03-ikuai-config.md](docs/03-ikuai-config.md) | iKuai 分流/DNS/线路配置 |
| [docs/04-domain-lists.md](docs/04-domain-lists.md) | 域名清单与维护 |
| [docs/05-operations.md](docs/05-operations.md) | 验证、替换 ECS、回滚、故障排查 |
| [docs/06-history.md](docs/06-history.md) | 变更历史与踩坑记录 |
| [docs/07-253-hub.md](docs/07-253-hub.md) | 253 服务中心组件与运维要点 |

## 快速验证

```bash
# 办公网：出口应为 8.211.181.28（经 253 → ECS）
curl -s ifconfig.me

# 干净解析（经 iKuai）
dig +short @192.168.9.1 chatgpt.com
dig +short @192.168.9.1 api.anthropic.com

# 订阅服务（公网）
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' http://58.246.51.170:50180/s/<token>/clash
```

## 注意

- 凭据（token、SS 密码、证书私钥）不入库；脚本从环境变量读取。
- 253 是单点（L2TP + VPN 出口 + 订阅），需监控；ECS 可随时替换。
- iKuai DNS 规则上限约 255 条（当前 232）。
