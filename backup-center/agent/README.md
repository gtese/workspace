# backup-center agent（Go）

集中式备份平台的客户端代理：仅使用标准库，静态编译为 linux/amd64、darwin/arm64、darwin/amd64。
接口契约见 `../docs/架构.md` 第 6 节。代理只发起出站连接，不监听任何端口。

## 构建

```bash
cd agent
go vet ./...
go test ./...
../scripts/build-agent.sh          # 产物: deploy/bin/agent/<os>-<arch>/backup-agent + sha256
```

`scripts/build-agent.sh` 使用 `CGO_ENABLED=0` 交叉编译，并生成
`deploy/bin/agent/SHA256SUMS` 聚合清单。

## 本地开发联调

服务端 dev 模式：Web 9443，Agent API 9444（HTTP 明文、无 mTLS）。

```bash
# 1. 在服务端页面生成一次性 token 后：
sudo agent/packaging/install.sh \
  --server http://127.0.0.1:9444 \
  --token <一次性 token> \
  --binary deploy/bin/agent/darwin-arm64/backup-agent \
  --insecure --skip-restic --no-start

# 2. 查看配置/证书/服务状态
sudo /opt/backup-center-agent/bin/backup-agent status --config "/Library/Application Support/backup-center-agent/config.json"

# 3. 自检（含服务端连通性）
sudo /opt/backup-center-agent/bin/backup-agent doctor --config "/Library/Application Support/backup-center-agent/config.json"
```

生产环境使用 `https://backup.tri.local:8443`（mTLS），不要加 `--insecure`。

## 子命令

| 命令 | 说明 |
|---|---|
| `install` | 安装二进制、创建目录、写入 systemd unit / launchd plist（root） |
| `enroll` | 生成 EC P-256 私钥 + CSR，提交注册并轮询审批；证书/CA/config 落盘 0600 |
| `run` | 守护进程：心跳、`/api/agent/tasks?wait=25` 长轮询、任务执行、进度与结果回传 |
| `status` | 查看配置、证书有效期、service 状态、restic 版本（`--json`） |
| `uninstall` | 停止并移除服务；`--purge --yes` 同时删除配置/缓存/日志/二进制 |
| `doctor` | 自检配置权限、证书匹配、restic、磁盘、服务状态、服务端连通性（`--json`） |

## 任务

- `backup`：`restic backup`，注入 `RESTIC_REPOSITORY/RESTIC_PASSWORD/RESTIC_CACHE_DIR/TMPDIR`，
  `RESTIC_PROGRESS_FPS=2`，解析 `--json` 的 status/summary；支持 pre/post hooks。
- `restore`：`restic restore ... --verify --json`，`dry_run` 时加 `--dry-run`。
- `fs_list`：只读列目录（`file/dir/link/other`，含 link_target/mode/mtime/size）+ 挂载点容量。
- `upgrade`：下载 → sha256 校验（tar.gz 或裸二进制）→ 同目录临时文件 rename 原子替换 → 退出进程由服务重启。
- `renew_cert`：生成新密钥/CSR，`POST /api/agent/renew`，校验后落盘并热更 mTLS 客户端；
  证书到期前 30 天也会自动续期。

进度上报 ≤1 次/秒；`log_tail` 为最近 64KB stderr。所有 size/total/free 均为字节。

## 路径

| 平台 | 配置 | 缓存 | 日志 | 二进制/restic |
|---|---|---|---|---|
| Linux | `/etc/backup-center-agent/` | `/var/cache/backup-center-agent` | `/var/log/backup-center-agent.log` | `/opt/backup-center-agent/bin/` |
| macOS | `/Library/Application Support/backup-center-agent/` | `/Library/Caches/backup-center-agent` | `/Library/Logs/backup-center-agent.log` | `/opt/backup-center-agent/bin/` |

配置、私钥、证书、CA、enroll_secret 全部 0600。仓库密码只存在于任务载荷与 restic 环境变量，不落盘、不写日志。
