# 01 架构与数据流（v2：253 服务中心）

## 1. 需求与演进

- 技术人员访问 GitHub、Google、主流 AI 工具需要海外出口；
- **ECS 节点会更换**，希望替换 ECS 时：iKuai、订阅链接、用户配置都不变；
- 因此引入 **253 作为服务中心（固定）**，ECS 只做可替换的“出口”。

## 2. v1 → v2 变化

| 项 | v1 | v2 |
|---|---|---|
| 办公网境外流量 | iKuai OpenVPN → ECS | iKuai L2TP → 253 → OpenVPN → ECS |
| 订阅用户 | Clash → 253 SS → 用户态 WG → ECS | Clash → 253 SS → dante → OpenVPN 隧道 → ECS |
| DNS | iKuai → 10.66.66.1（ECS dnsmasq） | iKuai → 10.10.10.1（253 dnsmasq） |
| ECS 角色 | OpenVPN 服务端 + dnsmasq + WG 服务端 | OpenVPN 客户端 + NAT（纯出口） |
| 换 ECS | 改 iKuai/订阅/证书 | 新 ECS 连回 253 即可，其他不动 |

## 3. 数据流

### 3.1 办公网访问 ChatGPT（示例）

1. 终端（192.168.9.x）DNS 被 iKuai 强制代理接管；命中规则 `chatgpt.com`/`*.chatgpt.com` → **10.10.10.1**。
2. 查询经 L2TP 到 253 的 dnsmasq（`10.10.10.1`），dnsmasq 通过隧道向 1.1.1.1 查询，返回干净 IP。
3. 终端连接该 IP；iKuai 域名分流规则 `ai-tools` 命中 → 接口 **l2tpToSx**。
4. 流量经 L2TP（源 10.10.10.10）到 253；253 策略路由 `from 10.10.10.0/24 table 100` → `tun-egress`。
5. 253 SNAT（`-o tun-egress MASQUERADE`）→ OpenVPN 加密（UDP 51821）→ ECS（10.99.99.2）。
6. ECS NAT（`10.99.99.0/24 → eth0`）→ 从 8.211.181.28 出网；回程对称。

### 3.2 订阅用户（Clash）

1. 用户导入订阅 `http://<公网IP>:50180/s/<token>/clash`。
2. Clash 按规则把白名单域名发往 SS 节点（253:50181，aes-256-gcm）。
3. 253 的 sing-box 解 SS，转给本机 dante SOCKS（127.0.0.1:1080）。
4. dante 以 uid 打 mark（100）→ 策略路由 table 100 → `tun-egress` → 51821 → ECS → 互联网。
5. sing-box 的 DNS 走本地 dnsmasq（127.0.0.1，detour direct），保证解析干净。

### 3.3 其他流量

- 未命中分流的流量：iKuai 走 wan1 直连；
- `tri.local` 等内网域名：DNS → 172.16.10.114（AD），流量走 L2TP 到 IDC，不经 VPN。

## 4. 关键设计

| 设计 | 说明 |
|---|---|
| 253 固定、ECS 可换 | 隧道由 253 做服务端、ECS 做客户端；换 ECS 只改 ECS 侧 |
| 复用现有 L2TP | 办公网到 253 走既有 L2TP（不加新线路、不改办公网拓扑） |
| 策略路由隔离 | 只把「办公网来源 10.10.10.0/24」和「打 mark 的进程流量」送进隧道，253 自身默认路由不变，不影响 L2TP |
| dnsmasq 干净解析 | 253 的 dnsmasq 经隧道向 1.1.1.1 查询；内网域名转发 AD DNS（172.16.10.111/112） |
| dante 做 SOCKS 出口 | 解决 sing-box 直接出站难以打 mark 的问题；dante 以 uid 打 mark → 隧道 |
| 仅 IPv4 | 253 禁用 IPv6，避免 dante/sing-box 解析 AAAA 后连不通 |
| MSS 钳制 | 253 与 ECS 双向 TCPMSS 1360，避免 L2TP/隧道 MTU 导致大包卡死 |
| rp_filter 关闭 | 253 关闭 rp_filter（0），避免隧道回包被反向路径检查丢弃 |

## 5. 已知边界

- 253 是单点：L2TP、VPN 出口、订阅、DNS 都在它上面；
- ECS 只做 NAT，若 ECS 故障，办公网与订阅都会断（v1 同样依赖 ECS）；
- iKuai DNS 规则上限约 255 条（当前 232），扩展前需清理。
