# 01 架构与设计决策

## 1. 需求

- 技术人员访问 GitHub、Google、主流 AI 工具（ChatGPT、Claude Code、Cursor 等）需要海外出口。
- 带宽有限：**YouTube 等视频流量不走 VPN**。
- 内网域名（tri.local）与国内网站继续走国内线路，不牺牲速度。
- DNS 不能被污染（国内 DNS 对 Google/OpenAI 等返回污染 IP）。

## 2. 方案对比与选型

| 方案 | 结论 |
|---|---|
| WireGuard 隧道 + iKuai 域名分流 | ❌ 实测不可用：iKuai 的「域名分流」不把 WireGuard 隧道当作可选线路（同规则指向 L2TP 生效、指向 WG 不生效；官方论坛亦确认 WireGuard 线路暂不支持分流） |
| 静态路由/IP 级分流 | 只适合少量固定 IP，域名多时无法维护 |
| **OpenVPN 隧道 + iKuai 域名分流** | ✅ 采用。iKuai 原生把 OpenVPN 客户端线路当作可分流线路 |
| 旁路由 / 客户端代理 | 备选，需要额外设备，本次未采用 |

## 3. 数据流

### 3.1 请求境外白名单域名（如 www.google.com）

1. 客户端 DNS 查询被 iKuai「强制 DNS 代理」接收。
2. iKuai 命中 DNS 代理规则（google.com/*.google.com → 10.66.66.1），经 OpenVPN 隧道转发到节点 dnsmasq。
3. dnsmasq 用 1.1.1.1/8.8.8.8 解析，返回干净 IP（无 GFW 污染）。
4. iKuai 从 DNS 应答中学习「域名 → IP」，域名分流规则命中后把流量送往 ovpnAliyun 线路。
5. 节点收到流量 → MASQUERADE → 从 8.211.181.28 出网。

### 3.2 访问国内站点

- DNS：由 iKuai 默认上游 119.29.29.29 解析，或命中内网规则走 AD DNS。
- 流量：未命中分流规则，走 wan1 直连。

### 3.3 访问内网域名（man.tri.local 等）

- DNS 命中 tri.local / *.tri.local 规则 → 172.16.10.114（AD DNS）。
- 流量走 l2tpToSx → IDC，全程不经 VPN。

## 4. 关键设计点

| 设计 | 说明 |
|---|---|
| 证书认证 | iKuai OpenVPN 客户端用「账号认证」时只发用户名、密码为空（实测 AUTH_FAILED），因此服务端改为**客户端证书认证**（不启用 auth-user-pass） |
| 证书编码 | iKuai API 的 PEM 字段要求：空格→`#`，换行→`@` |
| UDP 443 | 办公室到节点的 UDP 443 实测可达，性能优于 TCP-over-TCP；1194 与 TCP 443 在部分节点被墙 |
| tun-mtu 1400 / mssfix 1360 | 规避路径 MTU（PPPoe 1492）与 MSS 问题；节点侧再加 TCPMSS --set-mss 1360 |
| 压缩 | iKuai 客户端默认 LZO，服务端 `allow-compression yes` + `comp-lzo adaptive` 兼容 |
| BBR | 节点开启 BBR + fq，改善长肥管道吞吐 |
| DNS 分流 | 默认上游保持国内 119.29.29.29；仅对白名单境外域名做干净解析（否则会被污染） |
| YouTube 排除 | 视频流量大，从分流与干净 DNS 规则中全部移除，直连（被墙）即不可用 |
| AAAA 禁用 | `forbid_dns_4a=1`，避免终端 IPv6 直连绕过 VPN |

## 5. 已知边界

- iKuai DNS 代理规则上限约 255 条（当前 232）；域名规模扩大需重构（合并规则/改旁路由）。
- 节点是数据中心 IP，部分站点风控更严（Cloudflare 判定 JP，ip-api 标记 hosting）。
- 兼容性：iKuai OpenVPN 客户端协商结果为 TLS 1.2 / AES-256-CBC / HMAC-SHA1 / LZO。
