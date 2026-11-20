# 05 运维手册

## 1. 日常验证

```bash
# 出口 IP（应经 VPN 节点）与对照（应走办公室出口）
curl -s ifconfig.me                 # 期望 8.211.181.28
curl -s https://ipinfo.io/ip        # 期望办公室出口 223.167.143.174（未分流）

# 干净解析
dig +short @192.168.9.1 www.google.com
dig +short @192.168.9.1 api.anthropic.com

# 连通性
curl -o /dev/null -w '%{http_code}\n' https://api.github.com/zen            # 200
curl -o /dev/null -w '%{http_code}\n' https://api.openai.com/v1/models      # 401
curl -o /dev/null -w '%{http_code}\n' https://api.anthropic.com/v1/messages # 405
curl -o /dev/null -w '%{http_code}\n' https://www.baidu.com/                # 200 直连

# 内网
dscacheutil -q host -a name man.tri.local
```

### 节点侧

```bash
systemctl status openvpn-server@ovpn-office dnsmasq vpn-egress
cat /var/log/openvpn-status.log                  # 在线客户端
tail -20 /var/log/openvpn.log                    # 握手/断开原因
ss -ulpn | grep ':443'
ip -br a show tun0                               # 10.66.66.1/24
iptables -t nat -L POSTROUTING -v -n | grep 10.66.66
```

### iKuai 侧

```bash
ikuai-cli vpn openvpn clients --format json       # 线路状态、tunnel_ip
ikuai-cli routing stream domain list --format json
ikuai-cli network dns proxy list --page 1 --page-size 500 --format json | head
ikuai-cli network dns get --format json
```

## 2. 新增域名

见 [04-domain-lists.md](04-domain-lists.md) 第 7 节。要点：分流规则 + 两条 DNS 规则 + 验证。

## 3. 切换节点

1. 新节点按 [02-node-deploy-aliyun.md](02-node-deploy-aliyun.md) 部署（OpenVPN+dnsmasq+NAT）。
2. iKuai 创建新 OpenVPN 客户端线路（证书需按 `#`/`@` 编码），确认 tunnel_ip 获取成功。
3. 将 5 条域名分流规则的 interface 改为新线路。
4. 将所有 DNS 代理规则的 `dns_addr` 改为新节点隧道 IP（内网 tri.local 规则保持不变）。
5. 验证后停用旧线路。

## 4. 回滚 / 停用

```bash
# 停用分流（保留配置）
for id in 1 2 3 4 5; do ikuai-cli routing stream domain toggle $id --enabled no; done

# 停用线路
ikuai-cli vpn openvpn client-toggle <ID> --enabled no

# 关闭 DNS 代理（恢复终端直连 AD DNS；注意分流失效）
ikuai-cli network dns set --data '{"enabled":"no","dns1":"114.114.114.114","dns2":"119.29.29.29","proxy_force":0,"cachemode":0,"defense":0,"forbid_dns_4a":0,"network":0,"query":"https://doh.pub/dns-query"}'

# 节点侧停服务
systemctl disable --now openvpn-server@ovpn-office dnsmasq vpn-egress
```

## 5. 故障排查

| 现象 | 排查/处理 |
|---|---|
| 隧道不通、iKuai 线路无 tunnel_ip | 节点 `systemctl status openvpn-server@ovpn-office`；抓包 `tcpdump -ni eth0 udp port 443`；确认端口未被墙（换端口或换节点）；iKuai 端 toggle 重拨，必要时删除线路重建 |
| 端口疑似被墙 | 从办公室对节点测 TCP/UDP 多个端口（443/8443/1194）：若只有某端口不通、其他通，判定该端口被阻断 |
| OpenVPN 认证失败（AUTH_FAILED） | iKuai「账号认证」只发用户名、密码为空 → 改用客户端证书认证 |
| 证书被 API 拒绝（Invalid characters） | iKuai 要求 PEM 编码：空格→`#`、换行→`@` |
| 网页能解析但打不开 | 检查分流规则是否包含域名（白名单模式）；检查 `ifconfig.me` 是否走节点；看节点 NAT 计数是否增长 |
| 下载/视频很慢 | 节点带宽与跨境链路限制；YouTube 已排除；可关闭 LZO、调小 MTU 或换节点 |
| 部分站点仍判定"中国 IP" | 出口 IP 本身为 JP（Cloudflare loc=JP），多为会话中混入中国直连请求：可对终端做「五元组分流」全量走 VPN、统一 DNS、并禁用浏览器 WebRTC/时区语言指纹 |
| iKuai 规则数到上限 | 清理/合并 DNS 规则，或改旁路由方案 |
| Aegis 删不掉 | 自保护模块 AliSecGuard；用 systemd drop-in + 重启绕过（见 02 文档） |

## 6. 安全检查

- 节点 SSH 仅允许办公室出口 IP（安全组）。
- 节点上的云厂商 agent 已按需清理；云监控插件本就未安装。
- OpenVPN 证书私钥只存在于节点与 iKuai 客户端配置中，不进仓库。
- iKuai API token 通过环境变量注入，不写入任何文件。

## 7. 变更记录模板

```
日期 | 变更 | 影响 | 回滚方式
```
