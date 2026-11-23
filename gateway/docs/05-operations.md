# 05 运维手册（v2）

## 1. 日常验证

```bash
# 办公网出口（应经 253 → ECS）
curl -s ifconfig.me                 # 期望 8.211.181.28

# 解析（经 iKuai）
dig +short @192.168.9.1 chatgpt.com
dig +short @192.168.9.1 api.anthropic.com

# 连通性
curl -o /dev/null -w '%{http_code}\n' https://chatgpt.com/          # 200
curl -o /dev/null -w '%{http_code}\n' https://api.openai.com/v1/models  # 401
curl -o /dev/null -w '%{http_code}\n' https://www.baidu.com/        # 200 直连

# 订阅（公网）
curl -s -o /dev/null -w '%{http_code} %{size_download}\n' http://58.246.51.170:50180/s/<token>/clash
```

### 253 侧

```bash
systemctl status openvpn-server@egress dnsmasq sockd sing-box nginx egress-routing
ip -br a show tun-egress            # 10.99.99.1
ip route show table 100             # default dev tun-egress
ip rule show | head -8
iptables -t mangle -L OUTPUT -v -n | head -6   # dnsmasq/dante mark
tail -20 /var/log/openvpn-egress.log
wg show 2>/dev/null                 # v2 不用 WG
```

### ECS 侧

```bash
systemctl status openvpn-client@ecs-egress egress-nat
ip -br a show tun-egress            # 10.99.99.2
iptables -t nat -L POSTROUTING -v -n | grep 10.99.99
```

## 2. 替换 ECS（253 不动）

1. 新 VPS 安装 openvpn；
2. 复制 `ecs-egress` 客户端证书/配置（或让 253 重新签发）；
3. 连接 `58.246.51.170:51821`；
4. `ip_forward=1` + `MASQUERADE 10.99.99.0/24 → eth0`（可用 egress-nat.service）；
5. 验证：办公网 `ifconfig.me` 变成新 ECS IP，其余不变。

## 3. 回滚到 v1

```bash
# iKuai 分流规则改回 ovpnAliyun；DNS 规则改回 10.66.66.1；启用旧线路
# ECS 上：
systemctl enable --now openvpn-server@ovpn-office dnsmasq wg-quick@wg0
```

## 4. 故障排查（v2 特有）

| 现象 | 排查/处理 |
|---|---|
| 办公网能解析但打不开 | 检查 253 `ip route show table 100` 是否有 `default dev tun-egress`（OpenVPN 重启后需 `egress-up.sh`，已挂 up 钩子 + egress-routing.service） |
| DNS 返回污染 IP | 确认 253 dnsmasq 的 mark 规则存在且表 100 正确；`dig @10.10.10.1 www.google.com` 应从隧道出 |
| 隧道回包被丢 | 253 `rp_filter=0`（已写入 `/etc/sysctl.d/99-vpn-egress.conf`）；253 firewalld direct 规则放行 ppp0↔tun-egress |
| 大页面/TLS 卡住 | 253 对 ppp0↔tun-egress 做 TCPMSS 1360；ECS 对 tun-egress 做 TCPMSS 1360 |
| dante 解析失败 | dante 启动时读 `/etc/resolv.conf`；修改后需 `systemctl restart sockd`；253 resolv.conf 固定 127.0.0.1（NM dns=none） |
| 终端仍打不开 | 终端 DNS 缓存旧污染 IP：macOS `sudo dscacheutil -flushcache; sudo killall -HUP mDNSResponder`，Windows `ipconfig /flushdns` |
| 订阅路径不通 | 检查 sing-box（50181）、sockd（1080）、dante 出站 mark、tun-egress 路由 |

## 5. 安全与运维

- 253 为单点：建议纳入监控（服务/隧道/解析/磁盘/证书）；
- 订阅 token 共用，泄露后需更换 token 并更新 nginx；
- USG 的 50180/50181/51821 NAT 已 save；如需变更，改后 save；
- 凭据（token、SS 密码、证书私钥）不入库。
