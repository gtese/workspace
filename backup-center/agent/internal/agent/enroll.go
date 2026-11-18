package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"tri.local/backup-center/agent/internal/api"
	"tri.local/backup-center/agent/internal/config"
	"tri.local/backup-center/agent/internal/logging"
	"tri.local/backup-center/agent/internal/model"
	"tri.local/backup-center/agent/internal/pki"
)

// EnrollOptions 描述注册参数。
type EnrollOptions struct {
	Server       string
	Token        string
	Hostname     string
	OSVersion    string
	CAFile       string // 初始信任的 CA（可选；先有鸡还是先有蛋，可配合 --insecure）
	ConfigPath   string // 默认平台路径
	Insecure     bool
	AgentVersion string
	PollTimeout  time.Duration // 默认 20 分钟
}

// Enroll 生成 EC P-256 私钥与 CSR，提交注册并轮询审批，批准后把证书/配置落盘 0600。
func Enroll(ctx context.Context, opts EnrollOptions, log *logging.Logger) (*config.Config, error) {
	if log == nil {
		log = logging.Discard()
	}
	token := strings.TrimSpace(opts.Token)
	if token == "" {
		return nil, fmt.Errorf("缺少注册 token（--token）")
	}
	if strings.TrimSpace(opts.Server) == "" {
		return nil, fmt.Errorf("缺少服务端地址（--server）")
	}
	paths := config.DefaultPaths()
	if opts.ConfigPath != "" {
		paths = config.WithDir(filepath.Dir(opts.ConfigPath))
	}
	if opts.PollTimeout <= 0 {
		opts.PollTimeout = 20 * time.Minute
	}

	client, err := api.New(api.Options{
		BaseURL:  opts.Server,
		CAFile:   opts.CAFile,
		Insecure: opts.Insecure,
	})
	if err != nil {
		return nil, err
	}
	if client.Insecure() {
		log.Warn("已启用 --insecure：跳过服务端证书校验，仅限本地开发")
	}

	hostname := strings.TrimSpace(opts.Hostname)
	if hostname == "" {
		hostname, _ = os.Hostname()
	}
	if hostname == "" {
		hostname = "unknown"
	}
	osVersion := opts.OSVersion
	if osVersion == "" {
		osVersion = DetectOSVersion()
	}

	key, err := pki.GenerateKey()
	if err != nil {
		return nil, err
	}
	keyPEM, err := pki.EncodeKeyPEM(key)
	if err != nil {
		return nil, err
	}
	csrPEM, err := pki.CreateCSR(key, hostname)
	if err != nil {
		return nil, err
	}
	if _, err := pki.ParseCSR(csrPEM); err != nil {
		return nil, fmt.Errorf("本地 CSR 校验失败: %w", err)
	}

	enrollCtx, cancel := context.WithTimeout(ctx, opts.PollTimeout)
	defer cancel()
	created, err := client.Enroll(enrollCtx, model.EnrollRequest{
		Token:        token,
		Hostname:     hostname,
		OS:           osName(),
		OSVersion:    osVersion,
		Arch:         archName(),
		AgentVersion: opts.AgentVersion,
		CSRPEM:       string(csrPEM),
	})
	if err != nil {
		return nil, fmt.Errorf("提交注册失败: %w", err)
	}
	log.Info("注册请求已提交，等待管理员审批", "request_id", created.RequestID, "hostname", hostname)

	// enroll_secret 仅用于轮询，落盘 0600 并在结束后删除。
	secretPath := filepath.Join(paths.Dir, "enroll-secret")
	if err := pki.WriteFile0600(secretPath, []byte(created.EnrollSecret+"\n")); err != nil {
		return nil, err
	}
	defer os.Remove(secretPath)

	for {
		status, _, err := client.EnrollStatus(enrollCtx, created.RequestID, created.EnrollSecret)
		if err != nil {
			if enrollCtx.Err() != nil {
				return nil, fmt.Errorf("等待审批超时: %w", enrollCtx.Err())
			}
			// 404/5xx 等瞬时错误继续轮询。
			log.Warn("查询审批状态失败，将重试", "error", err.Error())
		} else {
			switch status.Status {
			case "approved":
				return finalizeEnroll(paths, opts, keyPEM, status, log)
			case "rejected":
				return nil, fmt.Errorf("注册请求已被管理员拒绝（request_id=%s）", created.RequestID)
			case "expired":
				return nil, fmt.Errorf("注册请求已过期，请重新生成安装命令（request_id=%s）", created.RequestID)
			}
		}
		wait := created.PollAfterSeconds
		if wait < 1 {
			wait = 10
		}
		if wait > 60 {
			wait = 60
		}
		if err := sleepCtx(enrollCtx, time.Duration(wait)*time.Second); err != nil {
			return nil, fmt.Errorf("等待审批超时: %w", err)
		}
	}
}

func finalizeEnroll(paths config.Paths, opts EnrollOptions, keyPEM []byte, status *model.EnrollStatus, log *logging.Logger) (*config.Config, error) {
	if strings.TrimSpace(status.ClientID) == "" {
		return nil, fmt.Errorf("审批响应缺少 client_id")
	}
	if strings.TrimSpace(status.CertPEM) == "" {
		return nil, fmt.Errorf("审批响应缺少 cert_pem")
	}
	if strings.TrimSpace(status.CAPEM) == "" {
		return nil, fmt.Errorf("审批响应缺少 ca_pem")
	}
	certPEM := []byte(status.CertPEM)
	if err := pki.VerifyCertificateMatchesKey(certPEM, keyPEM); err != nil {
		return nil, fmt.Errorf("服务端签发证书与本地私钥不匹配: %w", err)
	}
	if _, err := pki.ParseCertificatePEM([]byte(status.CAPEM)); err != nil {
		return nil, fmt.Errorf("服务端返回的 CA 无效: %w", err)
	}
	if err := os.MkdirAll(paths.Dir, 0o700); err != nil {
		return nil, fmt.Errorf("创建配置目录失败: %w", err)
	}
	if err := os.Chmod(paths.Dir, 0o700); err != nil {
		return nil, fmt.Errorf("设置配置目录权限失败: %w", err)
	}
	if err := pki.WriteFile0600(paths.Key, keyPEM); err != nil {
		return nil, err
	}
	if err := pki.WriteFile0600(paths.Cert, certPEM); err != nil {
		return nil, err
	}
	if err := pki.WriteFile0600(paths.CA, []byte(status.CAPEM)); err != nil {
		return nil, err
	}

	cfg := config.NewDefault(opts.Server)
	cfg.CAFile = paths.CA
	cfg.CertFile = paths.Cert
	cfg.KeyFile = paths.Key
	cfg.ClientID = status.ClientID
	applyServerConfig(cfg, status.Config)
	cfg.Server = strings.TrimRight(strings.TrimSpace(opts.Server), "/")
	cfg.ApplyDefaults(paths.Dir)
	if err := cfg.Validate(); err != nil {
		return nil, fmt.Errorf("服务端下发的配置无效: %w", err)
	}
	if err := cfg.Save(paths.Config); err != nil {
		return nil, err
	}
	expiry, _ := pki.CertificateExpiry(certPEM)
	log.Info("注册完成，证书已落盘",
		"client_id", cfg.ClientID,
		"cert_expires_at", expiry.UTC().Format(time.RFC3339),
		"config", paths.Config)
	return cfg, nil
}

// applyServerConfig 把服务端下发的 config 中代理关心的字段合并进来；
// server/client_id 与证书路径由代理自身决定，服务端配置不能覆盖。
func applyServerConfig(cfg *config.Config, raw json.RawMessage) {
	if len(raw) == 0 {
		return
	}
	var m map[string]json.RawMessage
	if err := json.Unmarshal(raw, &m); err != nil {
		return
	}
	str := func(key string) (string, bool) {
		v, ok := m[key]
		if !ok {
			return "", false
		}
		var s string
		if json.Unmarshal(v, &s) != nil || strings.TrimSpace(s) == "" {
			return "", false
		}
		return s, true
	}
	if v, ok := str("cache_dir"); ok {
		cfg.CacheDir = v
	}
	if v, ok := str("restic_binary"); ok {
		cfg.ResticBinary = v
	}
	if v, ok := str("log_file"); ok {
		cfg.LogFile = v
	}
	if v, ok := m["poll_wait_seconds"]; ok {
		var n int
		if json.Unmarshal(v, &n) == nil && n >= 1 && n <= 60 {
			cfg.PollWaitSeconds = n
		}
	}
}

// DetectOSVersion 尽力获取操作系统版本描述。
func DetectOSVersion() string {
	if raw, err := os.ReadFile("/etc/os-release"); err == nil {
		for _, line := range strings.Split(string(raw), "\n") {
			if strings.HasPrefix(line, "PRETTY_NAME=") {
				return strings.Trim(strings.TrimPrefix(line, "PRETTY_NAME="), `"`)
			}
		}
	}
	if raw, err := os.ReadFile("/System/Library/CoreServices/SystemVersion.plist"); err == nil {
		s := string(raw)
		if i := strings.Index(s, "<string>"); i >= 0 {
			if j := strings.Index(s[i+len("<string>"):], "</string>"); j >= 0 {
				return s[i+len("<string>") : i+len("<string>")+j]
			}
		}
	}
	return ""
}

func sleepCtx(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}
