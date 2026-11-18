package agent

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"tri.local/backup-center/agent/internal/fslist"
	"tri.local/backup-center/agent/internal/model"
	"tri.local/backup-center/agent/internal/pki"
	"tri.local/backup-center/agent/internal/restic"
	"tri.local/backup-center/agent/internal/upgrade"
)

// executeTask 执行单个任务并回传结果。restart=true 表示任务成功后需要退出进程以完成重启。
func (r *Runner) executeTask(ctx context.Context, t model.Task) (restart bool, err error) {
	if err := t.Validate(); err != nil {
		r.Log.Error("任务载荷无效", "task_id", t.ID, "type", t.Type, "error", err.Error())
		res := model.Result{OK: false, ExitCode: 1, Error: err.Error(), LogTail: err.Error()}
		if perr := r.postResult(ctx, t.ID, res); perr != nil {
			return false, perr
		}
		return false, nil
	}
	timeout := taskTimeout(&t)
	taskCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	r.active.Store(t.ID)
	defer r.active.Store("")
	start := r.Now()
	r.Log.Info("开始执行任务", "task_id", t.ID, "type", t.Type, "timeout", timeout.String())

	rep := newProgressReporter(r, t.ID, taskVerb(t.Type), r.ProgressInterval)
	rep.message(taskCtx, 0, "任务开始")

	var res model.Result
	switch t.Type {
	case model.TaskBackup:
		res = r.doBackup(taskCtx, &t, rep)
	case model.TaskRestore:
		res = r.doRestore(taskCtx, &t, rep)
	case model.TaskFSList:
		res = r.doFSList(taskCtx, &t, rep)
	case model.TaskUpgrade:
		res = r.doUpgrade(taskCtx, &t, rep)
		restart = res.OK
	case model.TaskRenewCert:
		res = r.doRenewCert(taskCtx, &t, rep)
	default:
		res = model.Result{OK: false, ExitCode: 1, Error: "未知任务类型: " + t.Type}
	}
	res.LogTail = tailJoin(restic.DefaultLogTailBytes, res.LogTail)

	if perr := r.postResult(ctx, t.ID, res); perr != nil {
		r.Log.Error("回传任务结果失败", "task_id", t.ID, "error", perr.Error())
		err = perr
	}
	r.Log.Info("任务执行结束",
		"task_id", t.ID,
		"type", t.Type,
		"ok", res.OK,
		"exit_code", res.ExitCode,
		"duration", r.Now().Sub(start).String())
	return restart, err
}

func (r *Runner) postResult(ctx context.Context, taskID string, res model.Result) error {
	// 即使父 ctx 已取消，也尽力把结果送出去。
	postCtx, cancel := context.WithTimeout(context.WithoutCancel(ctx), 20*time.Second)
	defer cancel()
	return r.client().Result(postCtx, taskID, res)
}

func taskTimeout(t *model.Task) time.Duration {
	if t.TimeoutSeconds > 0 {
		return time.Duration(t.TimeoutSeconds) * time.Second
	}
	switch t.Type {
	case model.TaskBackup, model.TaskRestore:
		return 24 * time.Hour
	case model.TaskFSList:
		return 15 * time.Second
	case model.TaskUpgrade:
		return 30 * time.Minute
	case model.TaskRenewCert:
		return 5 * time.Minute
	default:
		return 5 * time.Minute
	}
}

func taskVerb(t string) string {
	switch t {
	case model.TaskBackup:
		return "备份"
	case model.TaskRestore:
		return "恢复"
	case model.TaskFSList:
		return "列举目录"
	case model.TaskUpgrade:
		return "下载升级包"
	case model.TaskRenewCert:
		return "续期证书"
	default:
		return "执行"
	}
}

func (r *Runner) backupParams(t *model.Task) (restic.BackupParams, error) {
	if t.Repo == nil {
		return restic.BackupParams{}, errors.New("缺少仓库信息")
	}
	host := t.Host
	if host == "" {
		host = r.Config.ClientID
	}
	return restic.BackupParams{
		Repo:           restic.Repo{URL: t.Repo.URL, Password: t.Repo.Password, TLSClientCert: r.resticTLSCert},
		Host:           host,
		Paths:          t.Paths,
		Excludes:       t.Excludes,
		Tags:           t.Tags,
		Compression:    t.Compression,
		LimitUploadKiB: t.LimitUploadKiB,
	}, nil
}

func (r *Runner) doBackup(ctx context.Context, t *model.Task, rep *progressReporter) model.Result {
	res := model.Result{ExitCode: 1}
	params, err := r.backupParams(t)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	args, err := restic.BackupArgs(params)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	env, err := restic.Environment(params.Repo, r.Config.CacheDir, nil)
	if err != nil {
		res.Error = err.Error()
		return res
	}

	var extraTail strings.Builder
	hooks := t.Hooks
	if hooks != nil && hooks.Pre != nil && strings.TrimSpace(*hooks.Pre) != "" {
		rep.message(ctx, 1, "执行前置钩子")
		out, herr := runHook(ctx, *hooks.Pre)
		appendTail(&extraTail, out)
		if herr != nil {
			res.ExitCode = 1
			res.Error = fmt.Sprintf("前置钩子执行失败: %v", herr)
			res.LogTail = extraTail.String()
			return res
		}
	}

	rep.message(ctx, 2, "开始备份")
	outcome, err := restic.Run(ctx, restic.Options{
		Binary: r.Config.ResticBinary,
		Args:   args,
		Env:    env,
		OnStatus: func(st restic.Status) {
			rep.status(ctx, st)
		},
	})
	if err != nil {
		res.Error = err.Error()
		res.LogTail = extraTail.String()
		return res
	}
	res.ExitCode = outcome.ExitCode
	res.SnapshotID = outcome.SnapshotID
	if outcome.Summary != nil {
		res.Summary = outcome.Summary
	}
	appendTail(&extraTail, outcome.StderrTail)
	if outcome.ExitCode != 0 {
		res.OK = false
		res.Error = resticErrorText(outcome)
		res.LogTail = extraTail.String()
		return res
	}
	res.OK = true
	res.Summary = backupSummary(outcome.Summary, outcome.SnapshotID)
	rep.force(ctx, 100, "备份完成")

	if hooks != nil && hooks.Post != nil && strings.TrimSpace(*hooks.Post) != "" {
		out, herr := runHook(ctx, *hooks.Post)
		appendTail(&extraTail, out)
		if herr != nil {
			res.OK = false
			res.Error = fmt.Sprintf("后置钩子执行失败: %v", herr)
		}
	}
	res.LogTail = extraTail.String()
	return res
}

func (r *Runner) doRestore(ctx context.Context, t *model.Task, rep *progressReporter) model.Result {
	res := model.Result{ExitCode: 1}
	if t.Repo == nil {
		res.Error = "缺少仓库信息"
		return res
	}
	params := restic.RestoreParams{
		Repo:      restic.Repo{URL: t.Repo.URL, Password: t.Repo.Password, TLSClientCert: r.resticTLSCert},
		Snapshot:  t.Snapshot,
		Target:    t.Target,
		Includes:  t.Includes,
		Overwrite: t.Overwrite,
		DryRun:    t.DryRun,
	}
	args, err := restic.RestoreArgs(params)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	env, err := restic.Environment(params.Repo, r.Config.CacheDir, nil)
	if err != nil {
		res.Error = err.Error()
		return res
	}
	rep.message(ctx, 1, "开始恢复")
	outcome, err := restic.Run(ctx, restic.Options{
		Binary: r.Config.ResticBinary,
		Args:   args,
		Env:    env,
		OnStatus: func(st restic.Status) {
			rep.status(ctx, st)
		},
	})
	if err != nil {
		res.Error = err.Error()
		return res
	}
	res.ExitCode = outcome.ExitCode
	res.LogTail = outcome.StderrTail
	if outcome.ExitCode != 0 {
		res.Error = resticErrorText(outcome)
		return res
	}
	res.OK = true
	if outcome.Summary != nil {
		res.Summary = outcome.Summary
	} else {
		res.Summary = map[string]any{
			"snapshot": t.Snapshot,
			"target":   t.Target,
			"dry_run":  t.DryRun,
		}
	}
	rep.force(ctx, 100, "恢复完成")
	return res
}

func (r *Runner) doFSList(ctx context.Context, t *model.Task, rep *progressReporter) model.Result {
	listing, err := fslist.List(t.Path)
	if err != nil {
		return model.Result{OK: false, ExitCode: 1, Error: err.Error(), LogTail: err.Error()}
	}
	rep.force(ctx, 100, fmt.Sprintf("已列出 %d 项", len(listing.Entries)))
	return model.Result{
		OK:       true,
		ExitCode: 0,
		Summary:  listing,
		LogTail:  fmt.Sprintf("已列出 %s 共 %d 项", listing.Path, len(listing.Entries)),
	}
}

func (r *Runner) doUpgrade(ctx context.Context, t *model.Task, rep *progressReporter) model.Result {
	target := r.SelfPath
	if target == "" {
		return model.Result{OK: false, ExitCode: 1, Error: "无法确定当前可执行文件路径"}
	}
	rep.message(ctx, 0, "开始下载升级包")
	progress := func(done, total int64) {
		if total <= 0 || !rep.th.Allow() {
			return
		}
		percent := float64(done) / float64(total) * 100
		if percent > 99 {
			percent = 99
		}
		rep.send(ctx, model.Progress{
			Percent:    percent,
			BytesDone:  done,
			BytesTotal: total,
			Message:    fmt.Sprintf("下载升级包 %.1f%%", percent),
		})
	}
	result, err := upgrade.Apply(ctx, upgrade.Options{
		URL:      t.URL,
		SHA256:   t.SHA256,
		Target:   target,
		Version:  t.Version,
		HTTP:     r.client().HTTPClient(10 * time.Minute),
		Progress: progress,
	})
	if err != nil {
		return model.Result{OK: false, ExitCode: 1, Error: err.Error(), LogTail: err.Error()}
	}
	rep.force(ctx, 100, "升级包已安装，准备重启")
	return model.Result{
		OK:       true,
		ExitCode: 0,
		Summary: map[string]any{
			"version": result.Version,
			"path":    result.Path,
			"bytes":   result.Bytes,
			"sha256":  result.SHA256,
			"source":  result.Source,
		},
		LogTail: fmt.Sprintf("已安装升级包 %s -> %s（%d 字节）", t.Version, result.Path, result.Bytes),
	}
}

func (r *Runner) doRenewCert(ctx context.Context, t *model.Task, rep *progressReporter) model.Result {
	_ = t
	rep.message(ctx, 10, "生成新的密钥与 CSR")
	if err := r.renewCertificate(ctx); err != nil {
		return model.Result{OK: false, ExitCode: 1, Error: err.Error(), LogTail: err.Error()}
	}
	raw, err := os.ReadFile(r.Config.CertFile)
	if err != nil {
		return model.Result{OK: false, ExitCode: 1, Error: "读取新证书失败: " + err.Error()}
	}
	expiry, err := pki.CertificateExpiry(raw)
	if err != nil {
		return model.Result{OK: false, ExitCode: 1, Error: "解析新证书失败: " + err.Error()}
	}
	rep.force(ctx, 100, "证书续期完成")
	return model.Result{
		OK:       true,
		ExitCode: 0,
		Summary: map[string]any{
			"expires_at":      expiry.UTC().Format(time.RFC3339),
			"expires_in_days": int(expiry.Sub(r.Now()).Hours() / 24),
		},
		LogTail: "证书续期完成，到期时间 " + expiry.UTC().Format(time.RFC3339),
	}
}

func operationLabel(code int) string {
	switch code {
	case 10:
		return "仓库不存在或不可访问"
	case 11:
		return "仓库被锁定"
	case 12:
		return "仓库密码错误"
	default:
		return "restic 执行失败"
	}
}

func resticErrorText(outcome *restic.Outcome) string {
	if outcome == nil {
		return "restic 执行失败"
	}
	if outcome.TimedOut {
		return "任务超时，restic 已被终止"
	}
	msg := restic.ExitMessage(outcome.ExitCode)
	if outcome.Message != "" && outcome.Message != msg {
		msg = msg + ": " + outcome.Message
	}
	return msg
}

// backupSummary 保证 summary 中携带服务端关心的关键字段。
func backupSummary(summary map[string]any, snapshotID string) map[string]any {
	out := map[string]any{}
	for k, v := range summary {
		out[k] = v
	}
	if snapshotID != "" {
		out["snapshot_id"] = snapshotID
	}
	return out
}

// runHook 以 sh -c 执行管理员配置的钩子，输出保留尾部。
func runHook(ctx context.Context, script string) (string, error) {
	if strings.TrimSpace(script) == "" {
		return "", nil
	}
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", script)
	cmd.Env = os.Environ()
	buf := &cappedBuffer{max: restic.DefaultLogTailBytes}
	cmd.Stdout = buf
	cmd.Stderr = buf
	err := cmd.Run()
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return buf.String(), fmt.Errorf("钩子被中断: %w", ctxErr)
		}
		return buf.String(), fmt.Errorf("钩子退出异常: %w", err)
	}
	return buf.String(), nil
}

// cappedBuffer 只保留写入内容末尾 max 字节。
type cappedBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func (c *cappedBuffer) Write(p []byte) (int, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.buf = append(c.buf, p...)
	if c.max > 0 && len(c.buf) > c.max {
		c.buf = c.buf[len(c.buf)-c.max:]
	}
	return len(p), nil
}

func (c *cappedBuffer) String() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return string(c.buf)
}

func appendTail(b *strings.Builder, s string) {
	if s == "" {
		return
	}
	if b.Len() > 0 {
		b.WriteByte('\n')
	}
	b.WriteString(s)
}

// tailJoin 拼接并截断到最近 max 字节，尽量在行边界截断。
func tailJoin(max int, parts ...string) string {
	var nonEmpty []string
	for _, p := range parts {
		if p = strings.TrimRight(p, "\n"); p != "" {
			nonEmpty = append(nonEmpty, p)
		}
	}
	joined := strings.Join(nonEmpty, "\n")
	if max <= 0 || len(joined) <= max {
		return joined
	}
	cut := joined[len(joined)-max:]
	if idx := strings.IndexByte(cut, '\n'); idx >= 0 {
		cut = cut[idx+1:]
	}
	return cut
}
