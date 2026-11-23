# EDA Task Platform File Browser

AD 账号认证的 Web 文件浏览器，浏览 `/eda/workspace/eda-task-platform/agent-runs/`
下的任务产物，支持在线预览与下载。

## 访问方式

```
http://172.16.50.107:8080
```

用户名：AD 账号（如 `zhangyong`），密码：AD 域密码。

## 部署位置

| 项 | 值 |
|---|---|
| 主机 | `172.16.50.107` (opsnas.tri.local) |
| 目录 | `/opt/eda-filebrowser` |
| 服务 | `eda-filebrowser.service` |
| 端口 | 8080（firewalld 已放行） |
| Python | `/usr/bin/python3.6` |

> 原部署在 172.16.50.150，已完全回滚并迁移至此。

## 权限模型

- **认证**：LDAP 绑定 `tri-sh-dc01/02.tri.local`，UPN 形式 `user@tri.local`
- **授权**：`FB_ALLOWED_GROUPS` 留空 = 任何通过 AD 认证的用户都能访问
- **文件访问**：进程以 root 启动，每次请求 `seteuid` 到登录用户，
  由 NFS 服务端按真实用户 + 全部附加组判定权限

### 目录权限（2026-11-20 调整）

`agent-runs/` 及其下所有子目录、文件，属组统一改为 `group_allstaffs`（37 人），
并赋予组读权限，实现**全员可读**：

```
drwxr-s--- 2750  edaide-admin:group_allstaffs   agent-runs/
```

注意：目录保留 `setgid` 位（`s`），新建文件会自动继承 `group_allstaffs`，
不需要再手工修权限。

## 功能

- 目录浏览，面包屑 + "返回上级"
- 在线预览：Markdown（渲染）、CSV（表格）、JSON/LOG/TXT/代码（高亮+行号）
- 任意文件下载
- 文件名过滤（`/` 聚焦，`Esc` 清空）
- 预览上限 8MB（超出只显示前 8MB，仍可下载完整文件）

## 服务管理

```bash
systemctl status eda-filebrowser
systemctl restart eda-filebrowser
tail -f /opt/eda-filebrowser/logs/service.log
journalctl -u eda-filebrowser -n 50
```

## 环境配置 (`env.conf`)

| 变量 | 说明 | 当前值 |
|---|---|---|
| `FB_BASE_DIR` | 根目录 | `/eda/workspace/eda-task-platform/agent-runs` |
| `FB_PORT` | 监听端口 | `8080` |
| `FB_AD_SERVERS` | 域控列表 | `tri-sh-dc01,tri-sh-dc02` |
| `FB_AD_BASE_DN` | 搜索基 | `DC=tri,DC=local` |
| `FB_ALLOWED_GROUPS` | 允许的组（留空=认证即可） | 空 |
| `FB_MAX_PREVIEW` | 预览字节上限 | `8388608` |
| `FB_IMPERSONATE` | 用户身份切换 | `1` |
| `FB_AD_UID_MIN` | AD 用户 uid 起点 | `1000000` |

## 安全设计

- 路径穿越防护：`safe_join()` 用 realpath 校验，越界 403
- uid 映射只接受 AD 区间（≥1000000）的账号，避免命中同名本地用户
- 映射失败直接拒绝，绝不降级为 root 身份访问
- 登录失败不区分"用户不存在/密码错误"
- 响应头带 `X-Content-Type-Options`、`X-Frame-Options`

## 已知限制

- Flask 内置服务器（开发级），并发约几十级；用户多建议换 gunicorn
- HTTP 明文，密码可被嗅探；长期建议加 HTTPS 反代
- 启动约 9~10 秒（DNS 解析域控），systemd 已设 `Restart=always`

## 变更记录

- 2026-11-20 部署于 172.16.50.150（原方案，需 group_agenticflow 授权）
- 2026-11-20 迁移至 172.16.50.107，权限改为 group_allstaffs 全员可读
