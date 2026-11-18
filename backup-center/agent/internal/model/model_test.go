package model

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestParseTasksObjectAndArray(t *testing.T) {
	obj := []byte(`{"tasks":[{"id":"t_1","type":"fs_list","path":"/home"},{"id":"t_2","type":"renew_cert"}]}`)
	tasks, err := ParseTasks(obj)
	if err != nil || len(tasks) != 2 || tasks[0].Path != "/home" {
		t.Fatalf("对象形式解析失败: %v %+v", err, tasks)
	}
	arr := []byte(`[{"id":"t_3","type":"fs_list","path":"/"}]`)
	tasks, err = ParseTasks(arr)
	if err != nil || len(tasks) != 1 || tasks[0].ID != "t_3" {
		t.Fatalf("数组形式解析失败: %v %+v", err, tasks)
	}
	if tasks, err = ParseTasks([]byte("")); err != nil || tasks != nil {
		t.Fatalf("空响应应返回 nil: %v %+v", err, tasks)
	}
	if _, err := ParseTasks([]byte("{")); err == nil {
		t.Fatal("非法 JSON 应报错")
	}
}

func TestParseBackupTask(t *testing.T) {
	raw := `{"id":"t_1","type":"backup","run_id":"run_x","plan_id":"p_x",
	  "repo":{"url":"https://backup:8443/repo/r_x/c_y/","password":"pw"},
	  "host":"c_y","paths":["/home/docs"],"excludes":["*.tmp"],"tags":["plan:p_x"],
	  "compression":"auto","limit_upload_kib":0,"hooks":{"pre":null,"post":"echo done"},
	  "timeout_seconds":86400}`
	var task Task
	if err := json.Unmarshal([]byte(raw), &task); err != nil {
		t.Fatal(err)
	}
	if err := task.Validate(); err != nil {
		t.Fatalf("合法备份任务不应失败: %v", err)
	}
	if task.Repo == nil || task.Repo.Password != "pw" {
		t.Fatal("repo 解析失败")
	}
	if task.Hooks == nil || task.Hooks.Pre != nil || task.Hooks.Post == nil {
		t.Fatal("hooks 解析失败")
	}
}

func TestValidateBackupErrors(t *testing.T) {
	base := func() *Task {
		return &Task{
			ID: "t_1", Type: TaskBackup,
			Repo:  &Repository{URL: "https://backup:8443/repo/r/c/", Password: "x"},
			Paths: []string{"/home"}, Host: "c_y",
		}
	}
	cases := map[string]func(*Task){
		"缺 repo":      func(t *Task) { t.Repo = nil },
		"非法 repo url": func(t *Task) { t.Repo.URL = "ftp://x" },
		"缺 paths":     func(t *Task) { t.Paths = nil },
		"相对路径":        func(t *Task) { t.Paths = []string{"home"} },
		"非法压缩":        func(t *Task) { t.Compression = "zstd" },
		"负限速":         func(t *Task) { t.LimitUploadKiB = -1 },
	}
	for name, mod := range cases {
		t.Run(name, func(t *testing.T) {
			task := base()
			mod(task)
			if err := task.Validate(); err == nil {
				t.Fatal("期望校验失败")
			}
		})
	}
}

func TestValidateRestoreAndOthers(t *testing.T) {
	restore := &Task{ID: "t_1", Type: TaskRestore,
		Repo:     &Repository{URL: "http://x/repo", Password: "p"},
		Snapshot: "snap", Target: "/tmp/restore", Overwrite: "always"}
	if err := restore.Validate(); err != nil {
		t.Fatalf("合法恢复任务: %v", err)
	}
	badOverwrite := *restore
	badOverwrite.Overwrite = "maybe"
	if err := badOverwrite.Validate(); err == nil {
		t.Fatal("非法 overwrite 应失败")
	}
	relativeTarget := *restore
	relativeTarget.Target = "tmp/restore"
	if err := relativeTarget.Validate(); err == nil {
		t.Fatal("相对恢复目标应失败")
	}

	if err := (&Task{ID: "t_2", Type: TaskFSList, Path: "/home"}).Validate(); err != nil {
		t.Fatalf("fs_list: %v", err)
	}
	if err := (&Task{ID: "t_2", Type: TaskFSList, Path: "home"}).Validate(); err == nil {
		t.Fatal("fs_list 相对路径应失败")
	}

	up := &Task{ID: "t_3", Type: TaskUpgrade, URL: "https://x/dist", SHA256: strings.Repeat("a", 64)}
	if err := up.Validate(); err != nil {
		t.Fatalf("升级任务: %v", err)
	}
	up.SHA256 = "short"
	if err := up.Validate(); err == nil {
		t.Fatal("非法 sha256 应失败")
	}
}

func TestValidateUnknownType(t *testing.T) {
	task := &Task{ID: "t_1", Type: "reboot"}
	if err := task.Validate(); err == nil {
		t.Fatal("未知任务类型应失败")
	}
	task = &Task{Type: TaskFSList, Path: "/"}
	if err := task.Validate(); err == nil {
		t.Fatal("缺少 id 应失败")
	}
}

func TestResultJSON(t *testing.T) {
	res := Result{OK: true, ExitCode: 0, SnapshotID: "abc", Summary: map[string]any{"files_new": 3}, LogTail: "tail"}
	raw, err := json.Marshal(res)
	if err != nil {
		t.Fatal(err)
	}
	var back map[string]any
	if err := json.Unmarshal(raw, &back); err != nil {
		t.Fatal(err)
	}
	if back["snapshot_id"] != "abc" || back["ok"] != true || back["exit_code"].(float64) != 0 {
		t.Fatalf("结果字段不符: %s", raw)
	}
	if back["summary"].(map[string]any)["files_new"].(float64) != 3 {
		t.Fatalf("summary 未正确序列化: %s", raw)
	}
}
