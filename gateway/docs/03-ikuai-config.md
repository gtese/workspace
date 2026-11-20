# 03 iKuai 配置

> 设备：iKuai OS 4.0.313（IK-A160），LAN 192.168.9.1。
> 操作优先通过 iKuai API（`ikuai-cli`，Bearer token 从环境变量 `IKUAI_CLI_TOKEN` 读取，不写入仓库）。

## 1. OpenVPN 客户端线路

| 字段 | 值 |
|---|---|
| 名称 | ovpnAliyun |
| 服务器 | 8.211.181.28:443（UDP） |
| 认证 | 客户端证书 + CA（iKuai 的「账号认证」不可用，见 06-history） |
| 绑定线路 | wan1 |
| tunnel_ip | 10.66.66.2 |
| 状态 | enabled |

历史线路（已停用保留）：`ovpnUcloud`（154.83.199.67:8443，美国 UCloud）、`ovpnTokyo`（101.36.104.146:443，东京 UCloud）。

## 2. 域名分流规则（全部 → ovpnAliyun，已启用）

| 规则 | 域名数 | 内容 |
|---|---|---|
| ifconfig-me | 2 | ifconfig.me、ifconfig.co（出口验证） |
| tech-github | 12 | GitHub 全家桶 |
| google | 47 | Google 全家桶（不含 YouTube） |
| ai-tools | 49 | ChatGPT/Claude Code/Cursor 等 AI 工具 |
| cdn-anti-bot | 6 | cloudflare.com、recaptcha.net、hcaptcha.com、akamaihd.net、akamaized.net、fastly.net |

详见 [04-domain-lists.md](04-domain-lists.md)。

## 3. DNS 配置

| 项 | 值 | 说明 |
|---|---|---|
| DNS 代理服务 | enabled = yes | 客户端 DNS 由 iKuai 处理 |
| 强制客户端 DNS 代理 | proxy_force = 1 | 终端 DNS 指向哪里都会被劫持到 iKuai |
| 默认上游 dns1 | 119.29.29.29 | 国内解析（按需求保持国内） |
| 备用上游 dns2 | 172.16.10.114 | AD DNS |
| 禁止 AAAA | forbid_dns_4a = 1 | 防 IPv6 绕过分流 |

### DNS 代理规则（共 232 条）

| 目标 DNS | 条数 | 用途 |
|---|---|---|
| 10.66.66.1（隧道内干净解析） | 230 | 白名单境外域名（每个域名 = 域名 + `*.域名` 两条） |
| 172.16.10.114（AD DNS） | 2 | tri.local、*.tri.local |

规则模式：`parse_type = proxy`（把该域名的解析转发到指定 DNS）。

### DNS 解析流程

1. 客户端 → iKuai（强制代理）→ 命中域名规则 → 10.66.66.1（经隧道）
2. dnsmasq（节点）用 1.1.1.1/8.8.8.8 解析 → 干净 IP
3. iKuai 学习域名→IP → 域名分流规则把流量送往 ovpnAliyun
4. 未命中规则的域名 → 默认 119.29.29.29（国内）

## 4. 常用 API 操作

```bash
export IKUAI_CLI_BASE_URL=https://192.168.9.1
export IKUAI_CLI_TOKEN=...        # 从本机凭据读取，禁止提交
# 也可直接 curl：Authorization: Bearer $IKUAI_CLI_TOKEN

# 查看线路 / 分流规则 / DNS 规则
ikuai-cli vpn openvpn clients --format json
ikuai-cli routing stream domain list --format json
ikuai-cli network dns proxy list --page 1 --page-size 500 --format json

# 线路启停
ikuai-cli vpn openvpn client-toggle <ID> --enabled no|yes

# 域名分流
ikuai-cli routing stream domain update <ID> --domain "a.com,b.com" --interface ovpnAliyun --enabled yes
ikuai-cli routing stream domain create --name <名> --domain "a.com,b.com" --interface ovpnAliyun

# DNS 代理规则
ikuai-cli network dns proxy create --domain "*.example.com" --dns-addr 10.66.66.1 --parse-type proxy
ikuai-cli network dns proxy delete <ID> --yes
```

## 5. 证书字段编码（注意）

iKuai API 的 PEM 字段格式：空格→`#`，换行→`@`。示例转换（本地）：

```bash
enc() { printf '%s' "$1" | sed 's/ /#/g' | tr '\n' '@'; }
```

CA / 客户端证书 / 客户端私钥均按此编码后写入（私钥只写入 iKuai，不落仓库）。
