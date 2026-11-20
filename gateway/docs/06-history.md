# 06 节点历史与变更记录

## 1. 节点演进

| 阶段 | 节点 | 方案 | 结果 |
|---|---|---|---|
| v1 | UCloud 美国 154.83.199.67（LA） | WireGuard 隧道 + iKuai IP 级 allowips（域名解析 IP 加入对端允许网段） | 出口可切换（ifconfig.me → 节点 IP），但 iKuai 域名分流不支持 WG 线路；跨境 200ms、2% 丢包，大文件吞吐差；TCP 443/1194 先后被封；弃用 |
| v2 | UCloud 日本 101.36.104.146（东京） | OpenVPN（TCP 443）+ iKuai 域名分流 | 能连，但链路/端口仍不稳定，会话数分钟级断开、重拨不可靠；弃用 |
| v3（当前） | 阿里云 ECS 东京 8.211.181.28（ap-northeast-1） | OpenVPN UDP 443 + dnsmasq 干净 DNS + NAT/BBR/MSS；iKuai 域名分流 + 按域名 DNS 分流 | 运行中：RTT≈43ms，Google/GitHub/AI 全部分流生效；YouTube 排除 |

保留：UCloud 美国节点的 WireGuard 配置（仅作历史/管理用途，已不在分流路径内）。
iKuai 上旧线路 `ovpnUcloud`、`ovpnTokyo` 保留但已停用。

## 2. 关键踩坑记录

1. **iKuai 域名分流不支持 WireGuard 线路**
   - 对照实验：同一规则指向 L2TP 线路立即生效（出口变为 IDC），指向 WG 接口无任何效果。
   - 官方论坛技术支持回复：WireGuard 线路暂不支持做分流。→ 改用 OpenVPN。

2. **iKuai OpenVPN「账号认证」不可用**
   - 服务端日志：`Auth Username/Password verification failed`，认证脚本记录 `got_len=0`。
   - 现象：iKuai 只发用户名、密码为空。→ 改为**客户端证书认证**（`verify-client-cert` 默认 require，去掉 auth-user-pass-verify）。

3. **iKuai 证书字段编码**
   - 直接提交 PEM 报 `[2005] Invalid characters`。→ 空格→`#`、换行→`@` 后成功。

4. **端口被墙**
   - 美国节点：UDP/TCP 1194 不通；改 TCP 443 可用一段时间后被封。
   - 日本 UCloud：TCP 443 可连但会话易断。
   - 阿里云东京：办公室到节点 TCP 443、UDP 443、UDP 1194 实测均可达 → 选 **UDP 443**（避开 TCP-over-TCP）。

5. **TCP-over-TCP 吞吐差**
   - 洛杉矶节点下载仅 10–25KB/s；UDP/TCP 切换与 MSS/MTU 调优效果有限，主因是 200ms RTT + 跨境丢包。

6. **路径 MTU 与 MSS**
   - PPPoE 路径 MTU 1492；隧道设 `tun-mtu 1400`、`mssfix 1360`，节点侧 `TCPMSS --set-mss 1360`，避免大包分片/黑洞。

7. **DNS 污染**
   - 国内公共 DNS（223.5.5.5 / 119.29.29.29 / 114.114.114.114 / 180.76.76.76）对 Google/OpenAI 等返回污染 IP。
   - iKuai DNS 代理规则支持 `parse_type=proxy`（按域名转发到指定 DNS）→ 白名单域名经隧道到节点 dnsmasq 解析。
   - 规则只精确匹配，子域需再加 `*.域名`。

8. **iKuai DNS 代理规则上限**
   - 约 255 条；当前 232 条（230 境外 + 2 内网）。

9. **阿里云 ECS 自带 agent**
   - 云监控插件未安装；云助手、Aegis、HBR 备份存在。
   - Aegis 自保护（AliSecGuard 内核模块）导致 root 也无法 kill/删除/停服务；官方卸载脚本失败。
   - 解决：systemd drop-in 将 aegis.service 的 ExecStart 改为 `/bin/true`，重启实例后模块不再加载，删除文件与 unit。

10. **出口 IP 归属**
    - 8.211.181.28：Cloudflare `loc=JP, colo=NRT`，DB-IP/ipinfo/ip-api 均 Japan；ip-api 标记 `hosting=true`。
    - 若站点判定「中国 IP」，优先排查会话内是否有其他域名走中国直连（白名单缺口），而非出口 IP 归属。

## 3. 变更时间线

| 时间 | 变更 |
|---|---|
| 2026-11-17 | 美国节点 WireGuard 隧道建立；发现 iKuai 域名分流不支持 WG |
| 2026-11-17 | 美国节点装 OpenVPN（证书认证、UDP/TCP 端口试错） |
| 2026-11-17 | iKuai 域名分流（ifconfig.me）+ 按域名 DNS 分流打通 |
| 2026-11-18 | 东京 UCloud 节点部署；因链路/端口问题停用 |
| 2026-11-18 | 阿里云东京 ECS 部署；清理云厂商 agent（Aegis 自保护处理）；OpenVPN UDP 443 + dnsmasq + NAT/BBR 上线 |
| 2026-11-18 | iKuai 线路 ovpnAliyun 启用；分流规则/DNS 规则迁移；Google/GitHub/AI/CDN 域名批量导入 |
| 2026-11-18 | 开启「禁止 AAAA 解析」；补 CDN/反欺诈域名 |
| 2026-11-19 | Google 全家桶 47 域、GitHub 全家桶 12 域、Claude Code/ChatGPT 全家桶扩展至 49 域；YouTube 排除 |
| 2026-11-20 | 项目资料归档并推送至 git.tri.local/it/gateway 与 workspace |
| 2026-11-20 | 遗留清理：删除 iKuai 旧 OpenVPN 线路 ovpnUcloud/ovpnTokyo、删除旧 WireGuard 接口 wgoffice 及对端；仅保留 ovpnAliyun。变更前配置快照留存在操作机本地 |
