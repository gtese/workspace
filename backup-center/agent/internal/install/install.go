// Package install 实现 Linux systemd / macOS launchd 的安装、卸载、状态与自检。
package install

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"tri.local/backup-center/agent/internal/api"
	"tri.local/backup-center/agent/internal/config"
	"tri.local/backup-center/agent/internal/fslist"
	"tri.local/backup-center/agent/internal/model"
	"tri.local/backup-center/agent/internal/pki"
)

const (
	// LinuxUnitPath 是 systemd unit 安装位置。
	LinuxUnitPath = "/etc/systemd/system/backup-center-agent.service"
	// DarwinPlistPath 是 launchd plist 安装位置。
	DarwinPlistPath = "/Library/LaunchDaemons/tri.backup.agent.plist"
	// launchdLabel 是 launchd 服务标签。
	launchdLabel = "tri.backup.agent"
)

// SystemdUnit 是无入站端口、以 root 运行、异常自动重启的 systemd unit。
const SystemdUnit = `[Unit]
Description=Backup Center Agent
Documentation=https://backup.tri.local
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/backup-center-agent/bin/backup-agent run --config /etc/backup-center-agent/config.json
Restart=always
RestartSec=10
User=root
Group=root
LimitNOFILE=65536
# 代理只发起出站连接，不监听任何端口
NoNewPrivileges=yes

[Install]
WantedBy=multi-user.target
`

// LaunchdPlist 是 macOS LaunchDaemon 配置。
const LaunchdPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>tri.backup.agent</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/backup-center-agent/bin/backup-agent</string>
        <string>run</string>
        <string>--config</string>
        <string>/Library/Application Support/backup-center-agent/config.json</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>10</integer>
    <key>ProcessType</key>
    <string>Background</string>
    <key>StandardOutPath</key>
    <string>/Library/Logs/backup-center-agent.log</string>
    <key>StandardErrorPath</key>
    <string>/Library/Logs/backup-center-agent.log</string>
</dict>
</plist>
`

// Options 是安装/卸载参数。
type Options struct {
	Paths      config.Paths
	SelfPath   string
	ConfigPath string // 仅用于提示
	ResticSrc  string // 可选：从本地复制 restic
	Start      bool
	Purge      bool
}

// EnsureRoot 检查 root 权限（install/uninstall 需要）。
func EnsureRoot() error {
	if os.Geteuid() != 0 {
		return errors.New("该操作需要 root 权限，请使用 sudo 执行")
	}
	return nil
}

// Install 安装二进制、创建目录、写入服务定义并按需启动。
func Install(ctx context.Context, opts Options) error {
	if err := EnsureRoot(); err != nil {
		return err
	}
	if runtime.GOOS != "linux" && runtime.GOOS != "darwin" {
		return fmt.Errorf("不支持的操作系统: %s", runtime.GOOS)
	}
	self := opts.SelfPath
	if self == "" {
		var err error
		self, err = os.Executable()
		if err != nil {
			return fmt.Errorf("无法确定当前可执行文件: %w", err)
		}
	}
	for _, dir := range []string{opts.Paths.InstallDir, opts.Paths.BinDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return fmt.Errorf("创建目录 %s 失败: %w", dir, err)
		}
	}
	for _, dir := range []string{opts.Paths.Dir, opts.Paths.Cache} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("创建目录 %s 失败: %w", dir, err)
		}
		if err := os.Chmod(dir, 0o700); err != nil {
			return fmt.Errorf("设置目录权限失败: %w", err)
		}
	}
	if err := os.MkdirAll(filepath.Dir(opts.Paths.Log), 0o755); err != nil {
		return fmt.Errorf("创建日志目录失败: %w", err)
	}
	if err := copyExecutable(self, opts.Paths.Binary); err != nil {
		return fmt.Errorf("安装代理二进制失败: %w", err)
	}
	if opts.ResticSrc != "" {
		if err := copyExecutable(opts.ResticSrc, opts.Paths.Restic); err != nil {
			return fmt.Errorf("安装 restic 失败: %w", err)
		}
	}
	switch runtime.GOOS {
	case "linux":
		if err := config.WriteFileAtomic(LinuxUnitPath, []byte(SystemdUnit), 0o644); err != nil {
			return fmt.Errorf("写入 systemd unit 失败: %w", err)
		}
	case "darwin":
		if err := config.WriteFileAtomic(DarwinPlistPath, []byte(LaunchdPlist), 0o644); err != nil {
			return fmt.Errorf("写入 launchd plist 失败: %w", err)
		}
	}
	if opts.Start {
		if err := StartService(ctx); err != nil {
			return err
		}
	}
	return nil
}

// Uninstall 停止并移除服务定义；Purge 为 true 时删除二进制、配置、缓存与日志。
func Uninstall(ctx context.Context, opts Options) error {
	if err := EnsureRoot(); err != nil {
		return err
	}
	_ = StopService(ctx)
	switch runtime.GOOS {
	case "linux":
		_ = os.Remove(LinuxUnitPath)
		run(ctx, "systemctl", "daemon-reload")
		_ = os.RemoveAll(filepath.Dir(LinuxUnitPath) + "/backup-center-agent.service.d")
	case "darwin":
		_ = os.Remove(DarwinPlistPath)
	}
	if !opts.Purge {
		return nil
	}
	for _, dir := range []string{opts.Paths.InstallDir, opts.Paths.Dir, opts.Paths.Cache} {
		if err := safeRemoveAll(dir); err != nil {
			return err
		}
	}
	if opts.Paths.Log != "" {
		_ = os.Remove(opts.Paths.Log)
		_ = os.Remove(opts.Paths.Log + ".1")
	}
	return nil
}

// StartService 启动并启用服务。
func StartService(ctx context.Context) error {
	switch runtime.GOOS {
	case "linux":
		if out, err := run(ctx, "systemctl", "daemon-reload"); err != nil {
			return fmt.Errorf("systemctl daemon-reload 失败: %v (%s)", err, out)
		}
		if out, err := run(ctx, "systemctl", "enable", "backup-center-agent.service"); err != nil {
			return fmt.Errorf("systemctl enable 失败: %v (%s)", err, out)
		}
		if out, err := run(ctx, "systemctl", "restart", "backup-center-agent.service"); err != nil {
			return fmt.Errorf("systemctl restart 失败: %v (%s)", err, out)
		}
		return nil
	case "darwin":
		// 先尝试卸载已加载实例，再 bootstrap；失败时回退 load -w。
		_, _ = run(ctx, "launchctl", "bootout", "system/"+launchdLabel)
		if out, err := run(ctx, "launchctl", "bootstrap", "system", DarwinPlistPath); err == nil {
			return nil
		} else if out2, err2 := run(ctx, "launchctl", "load", "-w", DarwinPlistPath); err2 != nil {
			return fmt.Errorf("launchctl 启动失败: %v (%s) / %v (%s)", err, out, err2, out2)
		}
		return nil
	default:
		return fmt.Errorf("不支持的操作系统: %s", runtime.GOOS)
	}
}

// StopService 停止并禁用服务。
func StopService(ctx context.Context) error {
	switch runtime.GOOS {
	case "linux":
		_, stopErr := run(ctx, "systemctl", "stop", "backup-center-agent.service")
		_, _ = run(ctx, "systemctl", "disable", "backup-center-agent.service")
		return stopErr
	case "darwin":
		if out, err := run(ctx, "launchctl", "bootout", "system/"+launchdLabel); err != nil {
			if out2, err2 := run(ctx, "launchctl", "unload", "-w", DarwinPlistPath); err2 != nil {
				return fmt.Errorf("launchctl 停止失败: %v (%s) / %v (%s)", err, out, err2, out2)
			}
		}
		return nil
	default:
		return fmt.Errorf("不支持的操作系统: %s", runtime.GOOS)
	}
}

// ServiceActive 返回服务是否正在运行。
func ServiceActive(ctx context.Context) (bool, string) {
	switch runtime.GOOS {
	case "linux":
		out, err := run(ctx, "systemctl", "is-active", "backup-center-agent.service")
		state := strings.TrimSpace(out)
		return err == nil && state == "active", state
	case "darwin":
		out, err := run(ctx, "launchctl", "print", "system/"+launchdLabel)
		if err != nil {
			return false, "not loaded"
		}
		if strings.Contains(out, "state = running") {
			return true, "running"
		}
		return false, "loaded"
	default:
		return false, "unsupported"
	}
}

// StatusReport 是 status 子命令的输出。
type StatusReport struct {
	ConfigPath    string `json:"config_path"`
	ConfigOK      bool   `json:"config_ok"`
	ConfigError   string `json:"config_error,omitempty"`
	ClientID      string `json:"client_id,omitempty"`
	Server        string `json:"server,omitempty"`
	CertFile      string `json:"cert_file,omitempty"`
	CertExpiresAt string `json:"cert_expires_at,omitempty"`
	CertDaysLeft  int    `json:"cert_days_left,omitempty"`
	ServiceActive bool   `json:"service_active"`
	ServiceState  string `json:"service_state"`
	ResticBinary  string `json:"restic_binary,omitempty"`
	ResticVersion string `json:"restic_version,omitempty"`
	AgentVersion  string `json:"agent_version"`
}

// Status 汇总本地安装与运行状态（不需要 root）。
func Status(ctx context.Context, configPath, version string) *StatusReport {
	if configPath == "" {
		configPath = config.DefaultPaths().Config
	}
	rep := &StatusReport{ConfigPath: configPath, AgentVersion: version}
	cfg, err := config.Load(configPath)
	if err != nil {
		rep.ConfigError = err.Error()
	} else {
		rep.ConfigOK = true
		rep.ClientID = cfg.ClientID
		rep.Server = cfg.Server
		rep.CertFile = cfg.CertFile
		rep.ResticBinary = cfg.ResticBinary
		if raw, err := os.ReadFile(cfg.CertFile); err == nil {
			if expiry, err := pki.CertificateExpiry(raw); err == nil {
				rep.CertExpiresAt = expiry.UTC().Format(time.RFC3339)
				rep.CertDaysLeft = int(time.Until(expiry).Hours() / 24)
			}
		}
		if v := resticVersion(ctx, cfg.ResticBinary); v != "" {
			rep.ResticVersion = v
		}
	}
	rep.ServiceActive, rep.ServiceState = ServiceActive(ctx)
	return rep
}

// Check 是 doctor 的一项检查结果。
type Check struct {
	Name   string `json:"name"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail,omitempty"`
}

// Doctor 执行本机自检，返回检查列表。
func Doctor(ctx context.Context, configPath, version string) []Check {
	if configPath == "" {
		configPath = config.DefaultPaths().Config
	}
	var checks []Check
	add := func(name string, ok bool, detail string) {
		if detail == "" {
			if ok {
				detail = "正常"
			} else {
				detail = "异常"
			}
		}
		checks = append(checks, Check{Name: name, OK: ok, Detail: detail})
	}
	checks = append(checks, Check{Name: "平台", OK: runtime.GOOS == "linux" || runtime.GOOS == "darwin", Detail: runtime.GOOS + "/" + runtime.GOARCH})

	info, err := os.Stat(configPath)
	if err != nil {
		add("配置文件", false, "无法读取: "+err.Error())
		return checks
	}
	perm := info.Mode().Perm()
	add("配置文件", perm&0o077 == 0, fmt.Sprintf("%s，权限 %04o（要求 0600）", configPath, perm))

	cfg, err := config.Load(configPath)
	if err != nil {
		add("配置校验", false, err.Error())
		return checks
	}
	add("配置校验", true, "server="+cfg.Server+" client_id="+cfg.ClientID)

	certRaw, certErr := os.ReadFile(cfg.CertFile)
	keyRaw, keyErr := os.ReadFile(cfg.KeyFile)
	if certErr != nil || keyErr != nil {
		add("证书/私钥", false, fmt.Sprintf("读取失败: cert=%v key=%v", certErr, keyErr))
	} else if err := pki.VerifyCertificateMatchesKey(certRaw, keyRaw); err != nil {
		add("证书/私钥", false, err.Error())
	} else {
		add("证书/私钥", true, "匹配")
		if expiry, err := pki.CertificateExpiry(certRaw); err == nil {
			days := int(time.Until(expiry).Hours() / 24)
			ok := days > 0
			add("证书有效期", ok, fmt.Sprintf("到期 %s（剩余 %d 天）", expiry.UTC().Format(time.RFC3339), days))
		}
	}

	if _, err := os.Stat(cfg.CAFile); err != nil {
		add("CA 证书", false, "无法读取: "+err.Error())
	} else {
		add("CA 证书", true, cfg.CAFile)
	}

	if v := resticVersion(ctx, cfg.ResticBinary); v == "" {
		add("restic", false, "不可执行或无法获取版本: "+cfg.ResticBinary)
	} else {
		add("restic", true, v)
	}

	add("缓存目录", checkWritableDir(cfg.CacheDir), cfg.CacheDir)
	add("日志文件", checkWritableFile(cfg.LogFile), cfg.LogFile)

	if total, free, err := fslist.DiskUsage(cfg.CacheDir); err != nil {
		add("磁盘空间", false, err.Error())
	} else {
		add("磁盘空间", free > 512<<20, fmt.Sprintf("可用 %.1f GiB / 总 %.1f GiB", float64(free)/(1<<30), float64(total)/(1<<30)))
	}

	active, state := ServiceActive(ctx)
	add("服务状态", active, state)

	if client, err := api.New(api.Options{
		BaseURL:   cfg.Server,
		CAFile:    cfg.CAFile,
		CertFile:  cfg.CertFile,
		KeyFile:   cfg.KeyFile,
		UserAgent: "backup-center-agent/" + version,
	}); err != nil {
		add("服务端连通性", false, err.Error())
	} else {
		checkCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
		_, err := client.Heartbeat(checkCtx, model.Heartbeat{
			AgentVersion:  version,
			OS:            runtime.GOOS,
			Arch:          runtime.GOARCH,
			UptimeSeconds: 0,
			ResticVersion: resticVersion(ctx, cfg.ResticBinary),
		})
		cancel()
		if err != nil {
			add("服务端连通性", false, err.Error())
		} else {
			add("服务端连通性", true, cfg.Server)
		}
	}
	return checks
}

func resticVersion(ctx context.Context, binary string) string {
	if strings.TrimSpace(binary) == "" {
		return ""
	}
	vctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(vctx, binary, "version").Output()
	if err != nil {
		return ""
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) >= 2 {
		return fields[1]
	}
	return ""
}

func checkWritableDir(dir string) bool {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return false
	}
	f, err := os.CreateTemp(dir, ".doctor-*")
	if err != nil {
		return false
	}
	name := f.Name()
	_ = f.Close()
	_ = os.Remove(name)
	return true
}

func checkWritableFile(path string) bool {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return false
	}
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		return false
	}
	_ = f.Close()
	return true
}

func copyExecutable(src, dst string) error {
	srcAbs, _ := filepath.Abs(src)
	dstAbs, _ := filepath.Abs(dst)
	if srcAbs == dstAbs {
		return nil
	}
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	dir := filepath.Dir(dst)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, ".install-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := io.Copy(tmp, in); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Chmod(0o755); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, dst)
}

// safeRemoveAll 只允许删除明确的代理目录，避免误删系统路径。
func safeRemoveAll(dir string) error {
	clean := filepath.Clean(dir)
	allowed := map[string]bool{
		"/opt/backup-center-agent":                         true,
		"/etc/backup-center-agent":                         true,
		"/var/cache/backup-center-agent":                   true,
		"/Library/Application Support/backup-center-agent": true,
		"/Library/Caches/backup-center-agent":              true,
	}
	if !allowed[clean] {
		// 非默认目录（例如测试目录）仅在位于 /tmp 或用户目录下时允许。
		if !strings.HasPrefix(clean, "/tmp/") && !strings.HasPrefix(clean, os.TempDir()+"/") {
			return fmt.Errorf("拒绝删除非预期目录: %s", clean)
		}
	}
	if err := os.RemoveAll(clean); err != nil {
		return fmt.Errorf("删除 %s 失败: %w", clean, err)
	}
	return nil
}

func run(ctx context.Context, name string, args ...string) (string, error) {
	runCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	out, err := exec.CommandContext(runCtx, name, args...).CombinedOutput()
	return strings.TrimSpace(string(out)), err
}
