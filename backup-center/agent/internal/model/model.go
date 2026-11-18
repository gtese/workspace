// Package model 定义代理与服务端之间共享的 JSON 数据结构。
// 契约来源：docs/架构.md 第 6 节 Agent API。
package model

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
)

// 任务类型。
const (
	TaskBackup    = "backup"
	TaskRestore   = "restore"
	TaskFSList    = "fs_list"
	TaskUpgrade   = "upgrade"
	TaskRenewCert = "renew_cert"
)

// Repository 是服务端下发的 restic 仓库信息。
// Password 仅存在于进程内存与 restic 环境变量中，绝不落盘或写日志。
type Repository struct {
	URL      string `json:"url"`
	Password string `json:"password"`
}

// Hooks 是任务前后在客户端以 root 执行的 shell 命令。
type Hooks struct {
	Pre  *string `json:"pre"`
	Post *string `json:"post"`
}

// Task 是服务端下发的单个任务载荷。
// 字段集合覆盖 backup / restore / fs_list / upgrade / renew_cert 五种类型。
type Task struct {
	ID   string `json:"id"`
	Type string `json:"type"`

	// backup / restore 公共
	Repo *Repository `json:"repo,omitempty"`

	// backup
	RunID          string   `json:"run_id,omitempty"`
	PlanID         string   `json:"plan_id,omitempty"`
	Host           string   `json:"host,omitempty"`
	Paths          []string `json:"paths,omitempty"`
	Excludes       []string `json:"excludes,omitempty"`
	Tags           []string `json:"tags,omitempty"`
	Compression    string   `json:"compression,omitempty"`
	LimitUploadKiB int64    `json:"limit_upload_kib,omitempty"`
	Hooks          *Hooks   `json:"hooks,omitempty"`
	TimeoutSeconds int64    `json:"timeout_seconds,omitempty"`

	// restore
	RestoreID string   `json:"restore_id,omitempty"`
	Snapshot  string   `json:"snapshot,omitempty"`
	Includes  []string `json:"includes,omitempty"`
	Target    string   `json:"target,omitempty"`
	Overwrite string   `json:"overwrite,omitempty"`
	DryRun    bool     `json:"dry_run,omitempty"`

	// fs_list
	Path string `json:"path,omitempty"`

	// upgrade
	Version string `json:"version,omitempty"`
	URL     string `json:"url,omitempty"`
	SHA256  string `json:"sha256,omitempty"`
}

// Progress 是进度上报载荷（≤1 次/秒）。
type Progress struct {
	Percent     float64 `json:"percent"`
	BytesDone   int64   `json:"bytes_done"`
	BytesTotal  int64   `json:"bytes_total"`
	FilesDone   int64   `json:"files_done"`
	FilesTotal  int64   `json:"files_total"`
	CurrentPath string  `json:"current_path,omitempty"`
	Message     string  `json:"message,omitempty"`
}

// Result 是任务结果回传载荷。
// SnapshotID 仅 backup 使用；Summary 为结构化摘要（backup 统计 / fs_list 目录内容等）。
type Result struct {
	OK         bool   `json:"ok"`
	ExitCode   int    `json:"exit_code"`
	SnapshotID string `json:"snapshot_id,omitempty"`
	Summary    any    `json:"summary,omitempty"`
	Error      string `json:"error,omitempty"`
	LogTail    string `json:"log_tail,omitempty"`
}

// Disk 是心跳中的磁盘容量信息，total/free 单位为字节。
type Disk struct {
	Path  string `json:"path"`
	Total uint64 `json:"total"`
	Free  uint64 `json:"free"`
}

// Mount 是心跳中的挂载点信息。
type Mount struct {
	Path  string `json:"path"`
	FS    string `json:"fs"`
	Total uint64 `json:"total,omitempty"`
	Free  uint64 `json:"free,omitempty"`
}

// Heartbeat 是定时心跳载荷。
type Heartbeat struct {
	AgentVersion  string  `json:"agent_version"`
	OS            string  `json:"os"`
	Arch          string  `json:"arch"`
	UptimeSeconds int64   `json:"uptime_seconds"`
	ResticVersion string  `json:"restic_version"`
	Disks         []Disk  `json:"disks"`
	Mounts        []Mount `json:"mounts"`
	ActiveTaskID  string  `json:"active_task_id,omitempty"`
}

// TasksResponse 是 /api/agent/tasks 的响应。
type TasksResponse struct {
	Tasks []Task `json:"tasks"`
}

// EnrollRequest 是 POST /api/enroll 的请求体。
type EnrollRequest struct {
	Token        string `json:"token"`
	Hostname     string `json:"hostname"`
	OS           string `json:"os"`
	OSVersion    string `json:"os_version"`
	Arch         string `json:"arch"`
	AgentVersion string `json:"agent_version"`
	CSRPEM       string `json:"csr_pem"`
}

// EnrollCreated 是 POST /api/enroll 的 202 响应。
type EnrollCreated struct {
	RequestID        string `json:"request_id"`
	EnrollSecret     string `json:"enroll_secret"`
	PollAfterSeconds int    `json:"poll_after_seconds"`
}

// EnrollStatus 是 GET /api/enroll/<request_id> 的响应。
type EnrollStatus struct {
	Status   string          `json:"status"`
	ClientID string          `json:"client_id,omitempty"`
	CertPEM  string          `json:"cert_pem,omitempty"`
	CAPEM    string          `json:"ca_pem,omitempty"`
	Config   json.RawMessage `json:"config,omitempty"`
}

// HeartbeatResponse 是 /api/agent/heartbeat 的响应。
type HeartbeatResponse struct {
	OK              bool `json:"ok"`
	NextPollSeconds int  `json:"next_poll_seconds"`
}

// RenewRequest 是 POST /api/agent/renew 的请求体。
type RenewRequest struct {
	CSRPEM string `json:"csr_pem"`
}

// RenewResponse 是 POST /api/agent/renew 的响应。
type RenewResponse struct {
	CertPEM string `json:"cert_pem"`
}

// ParseTasks 解析 /api/agent/tasks 响应，兼容裸数组与 {tasks:[...]} 两种形状。
func ParseTasks(raw []byte) ([]Task, error) {
	trimmed := strings.TrimSpace(string(raw))
	if trimmed == "" || trimmed == "null" {
		return nil, nil
	}
	if strings.HasPrefix(trimmed, "[") {
		var tasks []Task
		if err := json.Unmarshal(raw, &tasks); err != nil {
			return nil, fmt.Errorf("解析任务数组失败: %w", err)
		}
		return tasks, nil
	}
	var resp TasksResponse
	if err := json.Unmarshal(raw, &resp); err != nil {
		return nil, fmt.Errorf("解析任务响应失败: %w", err)
	}
	return resp.Tasks, nil
}

func validHTTPURL(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Host == "" {
		return false
	}
	return u.Scheme == "http" || u.Scheme == "https"
}

// Validate 校验任务载荷是否满足执行前提，错误信息为中文，可直接回传。
func (t *Task) Validate() error {
	if t == nil {
		return errors.New("任务为空")
	}
	t.ID = strings.TrimSpace(t.ID)
	t.Type = strings.TrimSpace(t.Type)
	if t.ID == "" {
		return errors.New("任务缺少 id")
	}
	switch t.Type {
	case TaskBackup:
		if t.Repo == nil {
			return errors.New("备份任务缺少 repo")
		}
		if !validHTTPURL(t.Repo.URL) {
			return errors.New("备份任务的 repo.url 无效")
		}
		if len(t.Paths) == 0 {
			return errors.New("备份任务缺少 paths")
		}
		for _, p := range t.Paths {
			if !filepath.IsAbs(p) {
				return fmt.Errorf("备份路径必须是绝对路径: %s", p)
			}
		}
		for _, p := range t.Excludes {
			if strings.TrimSpace(p) == "" {
				return errors.New("备份任务包含空 exclude")
			}
		}
		switch t.Compression {
		case "", "auto", "off", "max":
		default:
			return fmt.Errorf("不支持的压缩模式: %s", t.Compression)
		}
		if t.LimitUploadKiB < 0 {
			return errors.New("limit_upload_kib 不能为负")
		}
	case TaskRestore:
		if t.Repo == nil {
			return errors.New("恢复任务缺少 repo")
		}
		if !validHTTPURL(t.Repo.URL) {
			return errors.New("恢复任务的 repo.url 无效")
		}
		if strings.TrimSpace(t.Snapshot) == "" {
			return errors.New("恢复任务缺少 snapshot")
		}
		if !filepath.IsAbs(t.Target) {
			return errors.New("恢复目标必须是绝对路径")
		}
		switch t.Overwrite {
		case "", "always", "if-changed", "never":
		default:
			return fmt.Errorf("不支持的 overwrite 模式: %s", t.Overwrite)
		}
	case TaskFSList:
		if !filepath.IsAbs(t.Path) {
			return errors.New("fs_list 路径必须是绝对路径")
		}
	case TaskUpgrade:
		if !validHTTPURL(t.URL) {
			return errors.New("升级任务 url 无效")
		}
		if len(t.SHA256) != 64 {
			return errors.New("升级任务 sha256 无效")
		}
	case TaskRenewCert:
		// 无附加字段
	default:
		return fmt.Errorf("未知任务类型: %s", t.Type)
	}
	return nil
}
