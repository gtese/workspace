# 02 ECS 出口节点（OpenVPN 客户端，v2）

> v2 中 ECS 不再做 OpenVPN 服务端/DNS/WG，只做「可替换出口」：
> 连接 253 的 OpenVPN 服务端（UDP 51821），把 10.99.99.0/24 的流量 NAT 到互联网。

## 1. 实例

| 项目 | 值 |
|---|---|
| 云厂商/地域 | 阿里云 ap-northeast-1（东京） |
| 公网 / 私网 IP | 8.211.181.28 / 172.21.44.11 |
| 规格 | 2 vCPU / 1.7GB / 20GB，Ubuntu 24.04.5 |
| 登录 | root（SSH 公钥） |
| 安全组 | 入方向放行 IDC 出口 IP（61.152.165.166、58.246.51.170）的 TCP/UDP/ICMP（UDP 51821 需放行） |

## 2. 客户端配置

证书由 253 的 easy-rsa 签发（CN=ecs-egress，固定 IP 10.99.99.2 由 253 的 ccd 指定）。
证书文件不入库，部署时从 253 导出：

```bash
# 在 253 上生成/复制（需 root）
# /etc/openvpn/easy-rsa/pki/{ca.crt,issued/ecs-egress.crt,private/ecs-egress.key}
```

ECS 上的客户端配置 `/etc/openvpn/client/ecs-egress.conf`：

```
client
dev tun-egress
proto udp
remote 58.246.51.170 51821
resolv-retry infinite
nobind
persist-key
persist-tun
ca /etc/openvpn/client/pki/ca.crt
cert /etc/openvpn/client/pki/ecs-egress.crt
key /etc/openvpn/client/pki/ecs-egress.key
remote-cert-tls server
cipher AES-256-CBC
tun-mtu 1400
mssfix 1360
verb 3
```

```bash
systemctl enable --now openvpn-client@ecs-egress
```

## 3. 转发与 NAT

见 [configs/egress-nat.sh](../configs/egress-nat.sh) 与 [configs/egress-nat.service](../configs/egress-nat.service)：

- `net.ipv4.ip_forward=1`
- FORWARD 放行 `tun-egress`
- `MASQUERADE -s 10.99.99.0/24 -o eth0`
- TCP MSS 1360

```bash
install -m 755 configs/egress-nat.sh /usr/local/sbin/egress-nat.sh
install -m 644 configs/egress-nat.service /etc/systemd/system/
systemctl daemon-reload && systemctl enable --now egress-nat
```

## 4. 替换 ECS 的步骤（关键收益）

1. 新 VPS 安装 `openvpn`；
2. 放入同一份 `ecs-egress` 客户端证书/密钥与配置（或让 253 重新签发）；
3. 连接 253:51821 → 启用 `ip_forward` + `MASQUERADE 10.99.99.0/24`；
4. **253、iKuai、订阅链接、用户侧全部不用改**。

## 5. 旧服务（v1，已停用保留）

`openvpn-server@ovpn-office`（UDP 443）、`dnsmasq`（10.66.66.1）、`wg-quick@wg0`（51820）已 `disable --now`，配置保留用于回滚。
