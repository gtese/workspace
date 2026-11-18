package restic

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
)

// DefaultLogTailBytes 是回传日志尾部的上限（最近 64KB）。
const DefaultLogTailBytes = 64 * 1024

// Status 是解析自 restic --json 状态行的进度。
type Status struct {
	Percent     float64
	BytesDone   int64
	BytesTotal  int64
	FilesDone   int64
	FilesTotal  int64
	CurrentPath string
}

// Options 是执行 restic 的参数。
type Options struct {
	Binary     string
	Args       []string
	Env        []string
	Dir        string
	OnStatus   func(Status)
	MaxLogTail int
	KillGrace  time.Duration // 收到取消后 SIGTERM→SIGKILL 的宽限，默认 10s
}

// Outcome 是一次 restic 执行的结果。
type Outcome struct {
	ExitCode   int
	SnapshotID string
	Summary    map[string]any
	StderrTail string
	Message    string // restic 自身报告的错误消息（若有）
	TimedOut   bool
	Err        error
}

// ExitMessage 把 restic 退出码映射为中文错误。
func ExitMessage(code int) string {
	switch code {
	case 0:
		return "成功"
	case 1:
		return "restic 操作失败"
	case 10:
		return "仓库不存在或不可访问（退出码 10）"
	case 11:
		return "仓库已被其他进程锁定（退出码 11）"
	case 12:
		return "仓库密码错误（退出码 12）"
	case 130:
		return "操作已中断（退出码 130）"
	default:
		return fmt.Sprintf("restic 执行失败（退出码 %d）", code)
	}
}

// Run 执行 restic 并解析 --json 输出。ctx 取消时先 SIGTERM 整个进程组，宽限期后 SIGKILL。
func Run(ctx context.Context, opts Options) (*Outcome, error) {
	if strings.TrimSpace(opts.Binary) == "" {
		return nil, errors.New("restic 二进制路径为空")
	}
	if _, err := exec.LookPath(opts.Binary); err != nil {
		return nil, fmt.Errorf("找不到 restic 可执行文件 %s: %w", opts.Binary, err)
	}
	grace := opts.KillGrace
	if grace <= 0 {
		grace = 10 * time.Second
	}
	out := &Outcome{ExitCode: -1}
	tailMax := opts.MaxLogTail
	if tailMax <= 0 {
		tailMax = DefaultLogTailBytes
	}

	cmd := exec.CommandContext(ctx, opts.Binary, opts.Args...)
	cmd.Env = opts.Env
	cmd.Dir = opts.Dir
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		// 负号表示整个进程组，确保 restic 的子进程一起退出。
		return syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	}
	cmd.WaitDelay = grace

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("获取 restic stdout 失败: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("获取 restic stderr 失败: %w", err)
	}
	tail := newTailBuffer(tailMax)
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("启动 restic 失败: %w", err)
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		parseJSONStream(stdout, out, opts.OnStatus)
	}()
	go func() {
		defer wg.Done()
		_, _ = io.Copy(tail, stderr)
	}()
	wg.Wait()
	waitErr := cmd.Wait()

	out.StderrTail = tail.String()
	if waitErr != nil {
		var exitErr *exec.ExitError
		if errors.As(waitErr, &exitErr) {
			out.ExitCode = exitErr.ExitCode()
		} else {
			out.ExitCode = -1
		}
		out.Err = waitErr
	} else {
		out.ExitCode = 0
	}
	if ctxErr := ctx.Err(); ctxErr != nil {
		out.TimedOut = errors.Is(ctxErr, context.DeadlineExceeded)
		if out.ExitCode == -1 {
			out.ExitCode = 130
		}
	}
	return out, nil
}

func parseJSONStream(r io.Reader, out *Outcome, onStatus func(Status)) {
	reader := bufio.NewReaderSize(r, 256*1024)
	for {
		line, err := reader.ReadBytes('\n')
		if len(line) > 0 {
			handleJSONLine(line, out, onStatus)
		}
		if err != nil {
			return
		}
	}
}

func handleJSONLine(line []byte, out *Outcome, onStatus func(Status)) {
	line = []byte(strings.TrimSpace(string(line)))
	if len(line) == 0 {
		return
	}
	var msg map[string]any
	if err := json.Unmarshal(line, &msg); err != nil {
		return // 非 JSON 行（理论上 --json 不会有）忽略
	}
	kind, _ := msg["message_type"].(string)
	switch kind {
	case "status":
		if onStatus != nil {
			onStatus(statusFromMap(msg))
		}
	case "summary":
		out.Summary = msg
		if id, ok := msg["snapshot_id"].(string); ok {
			out.SnapshotID = id
		}
	case "error":
		// restic 在部分错误场景以 JSON 输出 error 行。
		if e, ok := msg["error"].(map[string]any); ok {
			if m, ok := e["message"].(string); ok {
				out.Message = m
			}
		} else if m, ok := msg["message"].(string); ok {
			out.Message = m
		}
		if onStatus != nil {
			onStatus(Status{Percent: 0})
		}
	default:
		// 兼容未带 message_type 但含 snapshot_id 的 summary。
		if _, ok := msg["snapshot_id"].(string); ok {
			out.Summary = msg
			out.SnapshotID, _ = msg["snapshot_id"].(string)
		}
	}
}

func statusFromMap(msg map[string]any) Status {
	st := Status{
		Percent:     number(msg["percent_done"]) * 100,
		BytesDone:   int64(number(msg["bytes_done"])),
		BytesTotal:  int64(number(msg["total_bytes"])),
		FilesDone:   int64(number(msg["files_done"])),
		FilesTotal:  int64(number(msg["total_files"])),
		CurrentPath: firstString(msg["current_files"]),
	}
	// restore 的 json 状态字段名不同。
	if st.BytesDone == 0 {
		st.BytesDone = int64(number(msg["bytes_restored"]))
	}
	if st.FilesDone == 0 {
		st.FilesDone = int64(number(msg["files_restored"]))
	}
	if st.Percent < 0 {
		st.Percent = 0
	}
	if st.Percent > 100 {
		st.Percent = 100
	}
	return st
}

func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case json.Number:
		f, _ := n.Float64()
		return f
	case int64:
		return float64(n)
	case string:
		f, _ := strconv.ParseFloat(n, 64)
		return f
	default:
		return 0
	}
}

func firstString(v any) string {
	arr, ok := v.([]any)
	if !ok {
		if s, ok := v.(string); ok {
			return s
		}
		return ""
	}
	for _, item := range arr {
		if s, ok := item.(string); ok && s != "" {
			return s
		}
	}
	return ""
}

// tailBuffer 只保留最近 max 字节。
type tailBuffer struct {
	mu  sync.Mutex
	max int
	buf []byte
}

func newTailBuffer(max int) *tailBuffer {
	if max <= 0 {
		max = DefaultLogTailBytes
	}
	return &tailBuffer{max: max}
}

func (t *tailBuffer) Write(p []byte) (int, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.buf = append(t.buf, p...)
	if len(t.buf) > t.max {
		t.buf = t.buf[len(t.buf)-t.max:]
	}
	return len(p), nil
}

func (t *tailBuffer) String() string {
	t.mu.Lock()
	defer t.mu.Unlock()
	return string(t.buf)
}
