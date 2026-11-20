# 02 节点部署（阿里云 ECS 东京）

## 1. 实例

| 项目 | 值 |
|---|---|
| 云厂商/地域 | 阿里云 ap-northeast-1（东京） |
| 公网 / 私网 IP | 8.211.181.28 / 172.21.44.11 |
| 规格 | 2 vCPU / 1.7GB / 20GB（含 4GB swap） |
| 系统 | Ubuntu 24.04.5，内核 6.8.0 |
| 登录 | root（SSH 公钥） |
| 安全组 | 入方向放行办公室出口 IP（223.167.143.174/24）的 TCP/UDP/ICMP |

## 2. 清理云厂商 agent（重要）

阿里云默认镜像会带以下组件，作为纯 VPN 网关按需清理：

| 组件 | 说明 | 处理 |
|---|---|---|
| 云监控插件（argusagent） | **本机未安装**（全盘无 argus/cloudmonitor 痕迹） | 无需处理 |
| 云助手 aliyun-assist | 控制台远程命令/重置密码通道 | `dpkg --purge aliyun-assist`，删除 `/usr/local/share/aliyun-assist` 与 `/etc/systemd/system/aliyun.service` |
| 云安全中心 Aegis | AliYunDun / AliYunDunUpdate / AliYunDunMonitor，连 100.100.88.88:80 | 见下方「自保护」处理 |
| 混合云备份 HBR | hbrclient/updater，连 100.100.0.237:443 | `/opt/alibabacloud/hbrclient/uninstall` 后删除目录与 unit |

### Aegis 自保护绕过（关键坑）

Aegis 有内核自保护模块 `AliSecGuard`，**root 也无法 kill 进程、无法删除文件、无法 systemctl disable**（`Operation not permitted`）。
官方卸载脚本 `/tmp/aegis_uninstall.sh` 会提示 `wait AliYunDun process exit fail, possibly due to self-protection...`。

可行处理（本机实测成功）：

```bash
# 1) 用 systemd drop-in 让 aegis.service 开机只启动 /bin/true
mkdir -p /etc/systemd/system/aegis.service.d
cat > /etc/systemd/system/aegis.service.d/override.conf <<'EOF'
[Service]
ExecStart=
ExecStart=/bin/true
RemainAfterExit=yes
EOF
systemctl daemon-reload
# 2) 重启实例（自保护模块未加载 → 可删除）
systemctl reboot
# 3) 重启后清理
rm -rf /usr/local/aegis
rm -f /etc/systemd/system/aegis.service
systemctl daemon-reload
```

清理后验证：无 `AliYunDun*` 进程、`lsmod` 无 `AliSecGuard`、`ss -tnp | grep 100.100` 无连接、无相关 unit。

## 3. 安装组件

```bash
apt-get update
apt-get install -y openvpn easy-rsa dnsmasq
```

生成 PKI：

```bash
cp -r /usr/share/easy-rsa /etc/openvpn/easy-rsa
cd /etc/openvpn/easy-rsa
./easyrsa --batch init-pki
./easyrsa --batch build-ca nopass
./easyrsa --batch build-server-full server nopass
./easyrsa --batch build-client-full office nopass
./easyrsa --batch gen-dh
```

## 4. 服务端配置

见 [configs/ovpn-office.conf](../configs/ovpn-office.conf)。要点：

- `port 443` / `proto udp`
- `server 10.66.66.0 255.255.255.0`
- 证书认证（不启用 auth-user-pass-verify）
- `data-ciphers AES-256-CBC:AES-128-CBC` + fallback（兼容 iKuai）
- `allow-compression yes` + `comp-lzo adaptive`
- `tun-mtu 1400`、`mssfix 1360`
- 状态/日志：`/var/log/openvpn-status.log`、`/var/log/openvpn.log`

```bash
systemctl enable --now openvpn-server@ovpn-office
```

## 5. 干净 DNS（dnsmasq）

见 [configs/dnsmasq-ovpn-dns.conf](../configs/dnsmasq-ovpn-dns.conf)：只监听隧道地址 `10.66.66.1:53`，上游 1.1.1.1 / 8.8.8.8，`bind-dynamic` 适配 tun 接口动态出现。

```bash
systemctl enable --now dnsmasq
```

## 6. 转发与 NAT

见 [configs/vpn-egress.sh](../configs/vpn-egress.sh) 与 [configs/vpn-egress.service](../configs/vpn-egress.service)：

- `net.ipv4.ip_forward=1`、BBR + fq（`/etc/sysctl.d/99-vpn.conf`）
- FORWARD 放行 tun+ ↔ eth0
- `MASQUERADE -s 10.66.66.0/24 -o eth0`
- TCP MSS 钳制 1360（双向）

```bash
install -m 755 configs/vpn-egress.sh /usr/local/sbin/vpn-egress.sh
install -m 644 configs/vpn-egress.service /etc/systemd/system/vpn-egress.service
systemctl daemon-reload && systemctl enable --now vpn-egress
```

## 7. 验证

```bash
systemctl status openvpn-server@ovpn-office dnsmasq vpn-egress
ss -ulpn | grep ':443'
ip -br a show tun0        # 10.66.66.1/24
dig +short @10.66.66.1 www.google.com
# 出口验证（办公室侧）：curl -s ifconfig.me → 8.211.181.28
```
