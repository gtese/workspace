package agent

import (
	"context"
	"fmt"
	"time"

	"tri.local/backup-center/agent/internal/logging"
	"tri.local/backup-center/agent/internal/model"
	"tri.local/backup-center/agent/internal/restic"
	"tri.local/backup-center/agent/internal/throttle"
)

// progressReporter 负责以 ≤1 次/秒 的频率上报任务进度。
type progressReporter struct {
	runner *Runner
	taskID string
	verb   string
	th     *throttle.Throttle
	log    *logging.Logger
}

func newProgressReporter(r *Runner, taskID, verb string, interval time.Duration) *progressReporter {
	// 依赖 time 通过参数传入的 interval 使用；这里保留显式类型以便测试覆盖。
	return &progressReporter{
		runner: r,
		taskID: taskID,
		verb:   verb,
		th:     throttle.New(interval),
		log:    r.Log,
	}
}

func (p *progressReporter) send(ctx context.Context, prog model.Progress) {
	if p == nil || p.runner == nil || p.taskID == "" {
		return
	}
	sendCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := p.runner.client().Progress(sendCtx, p.taskID, prog); err != nil {
		if p.log != nil && ctx.Err() == nil {
			p.log.Debug("上报进度失败", "task_id", p.taskID, "error", err.Error())
		}
	}
}

// status 根据 restic 状态行节流上报。
func (p *progressReporter) status(ctx context.Context, st restic.Status) {
	if p == nil || !p.th.Allow() {
		return
	}
	msg := fmt.Sprintf("%s中 %.1f%%", p.verb, st.Percent)
	if st.CurrentPath != "" {
		msg = fmt.Sprintf("%s中 %.1f%%（%s）", p.verb, st.Percent, st.CurrentPath)
	}
	p.send(ctx, model.Progress{
		Percent:     st.Percent,
		BytesDone:   st.BytesDone,
		BytesTotal:  st.BytesTotal,
		FilesDone:   st.FilesDone,
		FilesTotal:  st.FilesTotal,
		CurrentPath: st.CurrentPath,
		Message:     msg,
	})
}

// message 上报一条带百分比的进度消息（同样受节流限制）。
func (p *progressReporter) message(ctx context.Context, percent float64, msg string) {
	if p == nil || !p.th.Allow() {
		return
	}
	p.send(ctx, model.Progress{Percent: percent, Message: msg})
}

// force 无视节流上报最终进度（例如 100%）。
func (p *progressReporter) force(ctx context.Context, percent float64, msg string) {
	if p == nil {
		return
	}
	p.th.Reset()
	p.send(ctx, model.Progress{Percent: percent, Message: msg})
}
