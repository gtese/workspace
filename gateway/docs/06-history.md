# 06 变更历史与踩坑记录

## 1. 节点/架构演进

| 阶段 | 架构 | 结果 |
|---|---|---|
| v0 | 美国 UCloud + WireGuard 全量 | 放弃（WG 不做分流、链路差） |
| v1 | iKuai OpenVPN → 阿里云 ECS（OpenVPN 服务端 + dnsmasq + WG）；订阅 Clash → 253 SS → WG → ECS | 运行（可回滚） |
| v2（当前） | **253 服务中心**：办公网 iKuai L2TP → 253 → OpenVPN(51821) → ECS；订阅 Clash → SS 253 → dante → 同隧道 → ECS | 已全量切换 |

## 2. v1 → v2 切换记录（2026-11-23）

- USG：新增 NAT `50180/50181 TCP`（订阅/SS）与 `51821 UDP`（253↔ECS），策略 `Clash_Access_253`；**已 save**。
- 253：
  - 部署 OpenVPN 服务端 `egress`（UDP 51821，10.99.99.0/24，证书认证，ccd 固定 ECS=10.99.99.2）；
  - 策略路由 table 100（`from 10.10.10.0/24`、`fwmark 100`）+ `egress-up.sh` + `egress-routing.service`；
  - dnsmasq（10.10.10.1 + 127.0.0.1）经隧道解析；resolv.conf → 127.0.0.1（NM dns=none）；
  - dante `sockd`（127.0.0.1:1080，external 10.99.99.1，uid mark 100）；
  - sing-box：SS 50181 → socks 127.0.0.1:1080；DNS 走本地 dnsmasq（detour direct，ipv4_only）；
  - 禁用 IPv6；firewalld direct 放行 ppp0↔tun-egress + MSS 1360。
- ECS：改为 OpenVPN 客户端（10.99.99.2）+ `egress-nat.service`（NAT 10.99.99.0/24）；旧服务 `openvpn-server@ovpn-office`/`dnsmasq`/`wg-quick@wg0` 已 disable --now（配置保留）。
- iKuai：5 条分流规则 → `l2tpToSx`；230 条 DNS 规则 → `10.10.10.1`；`ovpnAliyun` 停用。
- 验证：办公网 chatgpt/google 200、openai 401、baidu 直连 200、出口 8.211.181.28；订阅路径 chatgpt 200、openai 401、google/github 200、claude 403（可达）。

## 3. 踩坑记录（含 v1）

1. iKuai 域名分流不支持 WireGuard 线路 → 改用 OpenVPN/L2TP。
2. iKuai OpenVPN 账号认证不发密码 → 改客户端证书认证。
3. iKuai 证书字段编码：空格→`#`、换行→`@`。
4. 端口被墙/跨境质量：最终用 UDP 443（v1）/ UDP 51821（v2）。
5. DNS 污染：白名单域名经隧道用 1.1.1.1/8.8.8.8 解析。
6. **rp_filter**：253 默认 rp_filter=1 导致隧道 DNS 回包被丢 → 设 all/default=0。
7. **firewalld 默认丢转发**：ppp0↔tun-egress 需 direct 规则放行。
8. **MSS/MTU**：253/ECS 双向 TCPMSS 1360，避免大页面/TLS 卡死。
9. **dante 解析**：resolv.conf 改 127.0.0.1 后必须重启 sockd；内网 tri.local 转发 172.16.10.111 需 dnsmasq mark 排除 172.16.0.0/16。
10. **用户态 WG 不稳定**：跨境丢包导致 DNS 超时，改为 dante+OpenVPN 隧道。
11. **终端 DNS 缓存**：切换后旧污染 IP 还在缓存里，需要刷新。
12. Aegis 自保护（v1 清理云厂商 agent）：systemd drop-in + 重启绕过。

## 4. 变更时间线

| 时间 | 变更 |
|---|---|
| 2026-11-17 | 美国节点 WG/OpenVPN 试错，iKuai 域名分流+DNS 分流打通 |
| 2026-11-18 | 阿里云东京 ECS 上线（v1） |
| 2026-11-19 | Google/GitHub/AI 域名扩展，YouTube 排除 |
| 2026-11-20 | 旧线路/WG 清理，项目资料入库 |
| 2026-11-23 | Claude 分流规则加入订阅；**v2 架构全量切换（253 服务中心）**；USG 保存 |
