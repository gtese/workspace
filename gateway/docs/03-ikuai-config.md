# 03 iKuai 配置（v2）

> 设备：iKuai OS 4.0.313（IK-A160），LAN 192.168.9.1。
> API 操作通过 `ikuai-cli`，Bearer token 从环境变量 `IKUAI_CLI_TOKEN` 读取，不入库。

## 1. 线路

| 线路 | 说明 | 状态 |
|---|---|---|
| wan1 | PPPoE 223.167.143.174（默认出口） | 启用 |
| l2tpToSx | L2TP 客户端 10.10.10.10 → 253（10.10.10.1） | 启用（分流目标） |
| ovpnAliyun | 旧 OpenVPN 线路 8.211.181.28:443 | **已停用**（配置保留回滚） |

## 2. 域名分流（全部 → l2tpToSx）

| 规则 | 域名数 |
|---|---|
| ifconfig-me | 2 |
| tech-github | 12 |
| google | 47 |
| ai-tools | 49 |
| cdn-anti-bot | 6 |

## 3. DNS

| 项 | 值 |
|---|---|
| DNS 代理 | enabled=yes，proxy_force=1 |
| 默认上游 dns1 | 119.29.29.29（国内） |
| 备用 dns2 | 172.16.10.114（AD） |
| 禁止 AAAA | forbid_dns_4a=1 |

### DNS 代理规则（232 条）

| 目标 | 条数 | 用途 |
|---|---|---|
| 10.10.10.1（253 dnsmasq，经 L2TP） | 230 | 境外白名单域名干净解析 |
| 172.16.10.114（AD DNS） | 2 | tri.local、*.tri.local |

### 解析链路

```
终端 → iKuai（强制代理）→ 10.10.10.1（253 dnsmasq）→ 隧道 → 1.1.1.1 → 干净 IP
```

## 4. 常用 API 操作

```bash
export IKUAI_CLI_BASE_URL=https://192.168.9.1
export IKUAI_CLI_TOKEN=...   # 从凭据库读取

# 线路
ikuai-cli vpn openvpn clients --format json
ikuai-cli vpn openvpn client-toggle 3 --enabled no

# 分流规则改到 L2TP
ikuai-cli routing stream domain update <ID> --domain "a.com,b.com" --interface l2tpToSx --enabled yes

# DNS 规则
ikuai-cli network dns proxy update <ID> --domain "*.example.com" --dns-addr 10.10.10.1 --parse-type proxy --enabled yes
ikuai-cli network dns proxy list --page 1 --page-size 500 --format json
```

## 5. 回滚到 v1

1. 5 条分流规则接口改回 `ovpnAliyun`；
2. 230 条 DNS 规则 dns_addr 改回 `10.66.66.1`；
3. 启用 `ovpnAliyun` 线路；
4. ECS 上重新启用旧服务（见 02 文档）。
