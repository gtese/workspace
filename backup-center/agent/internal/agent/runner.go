package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"tri.local/backup-center/agent/internal/api"
	"tri.local/backup-center/agent/internal/config"
	"tri.local/backup-center/agent/internal/fslist"
	"tri.local/backup-center/agent/internal/logging"
	"tri.local/backup-center/agent/internal/model"
	"tri.local/backup-center/agent/internal/pki"
)

const (
	// DefaultHeartbeatInterval 是心跳默认间隔。
	DefaultHeartbeatInterval = 30 * time.Second
	// DefaultProgressInterval 是进度上报最小间隔（≤1 次/秒）。
	DefaultProgressInterval = time.Second
	// maxPollBackoff 是长轮询失败时的最大退避。
	maxPollBackoff = 60 * time.Second
	// certRenewBefore 是证书自动续期阈值（到期前 30 天）。
	certRenewBefore = 30 * 24 * time.Hour
	// renewalCheckInterval 是证书检查周期。
	renewalCheckInterval = 6 * time.Hour
)

// Runner 是代理守护进程。
type Runner struct {
	Config            *config.Config
	Log               *logging.Logger
	Version           string
	Insecure          bool
	ProgressInterval  time.Duration
	HeartbeatInterval time.Duration
	SelfPath          string
	Now               func() time.Time

	apiMu   sync.RWMutex
	api     *api.Client
	renewMu sync.Mutex

	start  time.Time
	active atomic.Value // string：当前任务 ID

	resticTLSCert string
}

// New 构造 Runner 并建立 mTLS 客户端。
func New(cfg *config.Config, log *logging.Logger, version string) (*Runner, error) {
	return NewWithInsecure(cfg, log, version, false)
}

// NewWithInsecure 允许本地开发跳过服务端证书校验（日志会告警）。
func NewWithInsecure(cfg *config.Config, log *logging.Logger, version string, insecure bool) (*Runner, error) {
	if cfg == nil {
		return nil, errors.New("配置为空")
	}
	if log == nil {
		log = logging.Discard()
	}
	if err := cfg.Validate(); err != nil {
		return nil, err
	}
	client, err := api.New(api.Options{
		BaseURL:   cfg.Server,
		CAFile:    cfg.CAFile,
		CertFile:  cfg.CertFile,
		KeyFile:   cfg.KeyFile,
		Insecure:  insecure,
		UserAgent: "backup-center-agent/" + version,
	})
	if err != nil {
		return nil, err
	}
	if insecure {
		log.Warn("已启用 --insecure：跳过服务端证书校验，仅限本地开发")
	}
	selfPath, err := os.Executable()
	if err == nil {
		if resolved, rerr := filepath.EvalSymlinks(selfPath); rerr == nil {
			selfPath = resolved
		}
	} else {
		selfPath = ""
	}
	return &Runner{
		Config:            cfg,
		Log:               log,
		Version:           version,
		Insecure:          insecure,
		ProgressInterval:  DefaultProgressInterval,
		HeartbeatInterval: DefaultHeartbeatInterval,
		SelfPath:          selfPath,
		Now:               time.Now,
		api:               client,
	}, nil
}

func (r *Runner) client() *api.Client {
	r.apiMu.RLock()
	defer r.apiMu.RUnlock()
	return r.api
}

// Run 启动心跳、证书检查与任务长轮询，直到 ctx 取消。
// 返回 nil 表示正常退出（例如升级任务要求进程重启）。
func (r *Runner) Run(ctx context.Context) error {
	if r.Config == nil {
		return errors.New("配置为空")
	}
	if err := os.MkdirAll(r.Config.CacheDir, 0o700); err != nil {
		return fmt.Errorf("创建缓存目录失败: %w", err)
	}
	r.start = r.Now()
	r.active.Store("")
	r.prepareResticTLSBundle()
	resticVersion := r.detectResticVersion(ctx)
	r.Log.Info("代理启动",
		"version", r.Version,
		"client_id", r.Config.ClientID,
		"server", r.Config.Server,
		"os", runtime.GOOS,
		"arch", runtime.GOARCH,
		"restic_version", resticVersion)

	runCtx, cancel := context.WithCancel(ctx)
	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		r.heartbeatLoop(runCtx, resticVersion)
	}()
	go func() {
		defer wg.Done()
		r.renewalLoop(runCtx)
	}()
	err := r.pollLoop(runCtx)
	cancel()
	wg.Wait()
	if err != nil && !errors.Is(err, context.Canceled) && !errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	return nil
}

func (r *Runner) pollLoop(ctx context.Context) error {
	wait := r.Config.PollWaitSeconds
	if wait <= 0 {
		wait = 25
	}
	backoff := time.Second
	for {
		if ctx.Err() != nil {
			return nil
		}
		tasks, err := r.client().Tasks(ctx, wait)
		if err != nil {
			if ctx.Err() != nil {
				return nil
			}
			r.Log.Warn("拉取任务失败，将退避重试", "error", err.Error(), "backoff", backoff.String())
			if sleepCtx(ctx, backoff) != nil {
				return nil
			}
			backoff *= 2
			if backoff > maxPollBackoff {
				backoff = maxPollBackoff
			}
			continue
		}
		backoff = time.Second
		for i := range tasks {
			if ctx.Err() != nil {
				return nil
			}
			restart, err := r.executeTask(ctx, tasks[i])
			if err != nil {
				r.Log.Error("任务执行异常", "task_id", tasks[i].ID, "type", tasks[i].Type, "error", err.Error())
			}
			if restart {
				r.Log.Info("升级完成，退出进程以便 systemd/launchd 重启", "task_id", tasks[i].ID)
				return nil
			}
		}
	}
}

func (r *Runner) heartbeatLoop(ctx context.Context, resticVersion string) {
	interval := r.HeartbeatInterval
	if interval <= 0 {
		interval = DefaultHeartbeatInterval
	}
	timer := time.NewTimer(interval / 2)
	defer timer.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
			hbCtx, cancel := context.WithTimeout(ctx, 20*time.Second)
			resp, err := r.client().Heartbeat(hbCtx, r.heartbeatPayload(resticVersion))
			cancel()
			if err != nil {
				if ctx.Err() == nil {
					r.Log.Warn("心跳失败", "error", err.Error())
				}
			} else if resp.NextPollSeconds >= 5 && resp.NextPollSeconds <= 300 {
				interval = time.Duration(resp.NextPollSeconds) * time.Second
			}
			timer.Reset(interval)
		}
	}
}

func (r *Runner) heartbeatPayload(resticVersion string) model.Heartbeat {
	hb := model.Heartbeat{
		AgentVersion:  r.Version,
		OS:            runtime.GOOS,
		Arch:          runtime.GOARCH,
		UptimeSeconds: int64(r.Now().Sub(r.start).Seconds()),
		ResticVersion: resticVersion,
	}
	if id, ok := r.active.Load().(string); ok {
		hb.ActiveTaskID = id
	}
	mounts, err := fslist.ListMounts()
	if err == nil {
		for _, m := range mounts {
			hb.Mounts = append(hb.Mounts, model.Mount{Path: m.Path, FS: m.FS, Total: m.Total, Free: m.Free})
		}
	}
	seen := map[string]bool{}
	for _, p := range []string{"/", r.Config.CacheDir} {
		if p == "" || seen[p] {
			continue
		}
		seen[p] = true
		if total, free, err := fslist.DiskUsage(p); err == nil {
			hb.Disks = append(hb.Disks, model.Disk{Path: p, Total: total, Free: free})
		}
	}
	return hb
}

func (r *Runner) renewalLoop(ctx context.Context) {
	check := func() {
		raw, err := os.ReadFile(r.Config.CertFile)
		if err != nil {
			r.Log.Warn("读取代理证书失败，跳过自动续期", "error", err.Error())
			return
		}
		expiry, err := pki.CertificateExpiry(raw)
		if err != nil {
			r.Log.Warn("解析代理证书失败，跳过自动续期", "error", err.Error())
			return
		}
		remaining := expiry.Sub(r.Now())
		if remaining > certRenewBefore {
			return
		}
		r.Log.Info("证书即将到期，开始自动续期", "expires_at", expiry.UTC().Format(time.RFC3339))
		renewCtx, cancel := context.WithTimeout(ctx, 2*time.Minute)
		defer cancel()
		if err := r.renewCertificate(renewCtx); err != nil {
			r.Log.Error("证书自动续期失败", "error", err.Error())
			return
		}
		r.Log.Info("证书自动续期成功")
	}
	check()
	ticker := time.NewTicker(renewalCheckInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			check()
		}
	}
}

// renewCertificate 生成新密钥与 CSR，调用 /api/agent/renew，校验后落盘并热更客户端。
func (r *Runner) renewCertificate(ctx context.Context) error {
	// 自动续期与 renew_cert 任务可能并发，串行化避免密钥/证书交错写入。
	r.renewMu.Lock()
	defer r.renewMu.Unlock()
	key, err := pki.GenerateKey()
	if err != nil {
		return err
	}
	keyPEM, err := pki.EncodeKeyPEM(key)
	if err != nil {
		return err
	}
	csrPEM, err := pki.CreateCSR(key, r.Config.ClientID)
	if err != nil {
		return err
	}
	certPEM, err := r.client().Renew(ctx, csrPEM)
	if err != nil {
		return fmt.Errorf("提交续期请求失败: %w", err)
	}
	if err := pki.VerifyCertificateMatchesKey(certPEM, keyPEM); err != nil {
		return fmt.Errorf("续期证书校验失败: %w", err)
	}
	if err := pki.WriteFile0600(r.Config.KeyFile, keyPEM); err != nil {
		return err
	}
	if err := pki.WriteFile0600(r.Config.CertFile, certPEM); err != nil {
		return err
	}
	r.prepareResticTLSBundle()
	return r.rebuildClient()
}

// prepareResticTLSBundle 把客户端证书与私钥合并为 restic 需要的单文件 PEM（0600），
// 用于让 restic 子进程以 mTLS 访问仓库数据面。
func (r *Runner) prepareResticTLSBundle() {
	r.resticTLSCert = ""
	if r.Config == nil || !strings.HasPrefix(strings.ToLower(r.Config.Server), "https://") {
		return
	}
	cert, err := os.ReadFile(r.Config.CertFile)
	if err != nil {
		return
	}
	key, err := os.ReadFile(r.Config.KeyFile)
	if err != nil {
		return
	}
	path := filepath.Join(r.Config.CacheDir, "restic-tls.pem")
	combined := append(append([]byte{}, cert...), key...)
	if err := os.WriteFile(path, combined, 0o600); err != nil {
		return
	}
	_ = os.Chmod(path, 0o600)
	r.resticTLSCert = path
}

// rebuildClient 在证书更新后重建 HTTP 客户端。
func (r *Runner) rebuildClient() error {
	client, err := api.New(api.Options{
		BaseURL:   r.Config.Server,
		CAFile:    r.Config.CAFile,
		CertFile:  r.Config.CertFile,
		KeyFile:   r.Config.KeyFile,
		Insecure:  r.Insecure,
		UserAgent: "backup-center-agent/" + r.Version,
	})
	if err != nil {
		return fmt.Errorf("重建 API 客户端失败: %w", err)
	}
	r.apiMu.Lock()
	r.api = client
	r.apiMu.Unlock()
	return nil
}

func (r *Runner) detectResticVersion(ctx context.Context) string {
	if r.Config == nil || r.Config.ResticBinary == "" {
		return ""
	}
	vctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(vctx, r.Config.ResticBinary, "version").Output()
	if err != nil {
		r.Log.Warn("读取 restic 版本失败", "error", err.Error())
		return ""
	}
	fields := strings.Fields(strings.TrimSpace(string(out)))
	if len(fields) >= 2 {
		return fields[1]
	}
	return strings.TrimSpace(string(out))
}

func osName() string { return runtime.GOOS }

func archName() string { return runtime.GOARCH }
