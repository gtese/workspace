package restic

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestBackupArgs(t *testing.T) {
	args, err := BackupArgs(BackupParams{
		Repo:           Repo{URL: "https://backup:8443/repo/r/c/", Password: "secret"},
		Host:           "c_0123456789ab",
		Paths:          []string{"/home/docs", "/etc"},
		Excludes:       []string{"*.tmp", ".cache"},
		Tags:           []string{"plan:p_1"},
		Compression:    "auto",
		LimitUploadKiB: 2048,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"backup", "/home/docs", "/etc",
		"--host", "c_0123456789ab",
		"--tag", "plan:p_1",
		"--exclude", "*.tmp", "--exclude", ".cache",
		"--compression", "auto",
		"--limit-upload", "2048",
		"--json",
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("参数不符:\n got=%v\nwant=%v", args, want)
	}
	for _, a := range args {
		if strings.Contains(a, "secret") {
			t.Fatal("参数中不得出现密码")
		}
	}
}

func TestBackupArgsDefaults(t *testing.T) {
	args, err := BackupArgs(BackupParams{
		Repo:  Repo{URL: "https://x/repo"},
		Host:  "c_y",
		Paths: []string{"/home"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{"backup", "/home", "--host", "c_y", "--compression", "auto", "--json"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("参数不符: got=%v want=%v", args, want)
	}
	if _, err := BackupArgs(BackupParams{Host: "h", Paths: []string{"/x"}}); err == nil {
		t.Fatal("缺少仓库 URL 应失败")
	}
	if _, err := BackupArgs(BackupParams{Repo: Repo{URL: "https://x"}, Host: "h", Paths: []string{"rel"}}); err == nil {
		t.Fatal("相对路径应失败")
	}
	if _, err := BackupArgs(BackupParams{Repo: Repo{URL: "https://x"}, Host: "h", Paths: []string{"/x"}, Compression: "zstd"}); err == nil {
		t.Fatal("非法压缩应失败")
	}
}

func TestRestoreArgs(t *testing.T) {
	args, err := RestoreArgs(RestoreParams{
		Repo:      Repo{URL: "https://x/repo", Password: "p"},
		Snapshot:  "abc123",
		Target:    "/tmp/restore",
		Includes:  []string{"/home/docs", "/etc/hosts"},
		Overwrite: "if-changed",
		DryRun:    true,
	})
	if err != nil {
		t.Fatal(err)
	}
	want := []string{
		"restore", "abc123",
		"--target", "/tmp/restore",
		"--include", "/home/docs", "--include", "/etc/hosts",
		"--overwrite", "if-changed",
		"--dry-run", "--verify", "--json",
	}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("参数不符:\n got=%v\nwant=%v", args, want)
	}
	args, err = RestoreArgs(RestoreParams{Repo: Repo{URL: "https://x"}, Snapshot: "s", Target: "/"})
	if err != nil {
		t.Fatal(err)
	}
	want = []string{"restore", "s", "--target", "/", "--overwrite", "always", "--verify", "--json"}
	if !reflect.DeepEqual(args, want) {
		t.Fatalf("默认参数不符: got=%v want=%v", args, want)
	}
}

func TestEnvironmentOverrides(t *testing.T) {
	cache := t.TempDir()
	base := []string{"PATH=/usr/bin", "RESTIC_PASSWORD=old", "RESTIC_REPOSITORY=old-repo"}
	env, err := Environment(Repo{URL: "https://backup:8443/repo/r/c/", Password: "new-secret"}, cache, base)
	if err != nil {
		t.Fatal(err)
	}
	count := map[string]int{}
	for _, kv := range env {
		key := strings.SplitN(kv, "=", 2)[0]
		count[key]++
	}
	for _, key := range []string{"RESTIC_REPOSITORY", "RESTIC_PASSWORD", "RESTIC_CACHE_DIR", "RESTIC_PROGRESS_FPS", "TMPDIR"} {
		if count[key] != 1 {
			t.Fatalf("%s 应恰好出现一次，实际 %d", key, count[key])
		}
	}
	if got := findEnv(env, "RESTIC_PASSWORD"); got != "new-secret" {
		t.Fatalf("RESTIC_PASSWORD 未覆盖: %q", got)
	}
	if got := findEnv(env, "RESTIC_PROGRESS_FPS"); got != "2" {
		t.Fatalf("RESTIC_PROGRESS_FPS 应为 2: %q", got)
	}
	if got := findEnv(env, "TMPDIR"); got != filepath.Join(cache, "tmp") {
		t.Fatalf("TMPDIR 不符: %q", got)
	}
	info, err := os.Stat(filepath.Join(cache, "tmp"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o700 {
		t.Fatalf("tmp 权限应为 0700，实际 %04o", info.Mode().Perm())
	}
}

func findEnv(env []string, key string) string {
	for _, kv := range env {
		if strings.HasPrefix(kv, key+"=") {
			return strings.TrimPrefix(kv, key+"=")
		}
	}
	return ""
}

func TestExitMessage(t *testing.T) {
	cases := map[int]string{
		0:  "成功",
		1:  "restic 操作失败",
		10: "仓库不存在或不可访问（退出码 10）",
		11: "仓库已被其他进程锁定（退出码 11）",
		12: "仓库密码错误（退出码 12）",
	}
	for code, want := range cases {
		if got := ExitMessage(code); got != want {
			t.Fatalf("退出码 %d 文案不符: %q != %q", code, got, want)
		}
	}
	if got := ExitMessage(99); !strings.Contains(got, "99") {
		t.Fatalf("未知退出码应包含码值: %q", got)
	}
}

func TestRunParsesJSONAndExitCode(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "restic")
	content := `#!/bin/sh
echo '{"message_type":"status","percent_done":0.5,"bytes_done":50,"total_bytes":100,"files_done":1,"total_files":2,"current_files":["/home/a"]}'
echo '{"message_type":"summary","snapshot_id":"snap123","files_new":1,"total_bytes_processed":100}'
exit 0
`
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	var statuses []Status
	outcome, err := Run(context.Background(), Options{
		Binary: script,
		Args:   []string{"backup"},
		OnStatus: func(st Status) {
			statuses = append(statuses, st)
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if outcome.ExitCode != 0 || outcome.SnapshotID != "snap123" {
		t.Fatalf("结果异常: %+v", outcome)
	}
	if outcome.Summary["files_new"].(float64) != 1 {
		t.Fatalf("summary 未解析: %+v", outcome.Summary)
	}
	if len(statuses) != 1 || statuses[0].Percent != 50 || statuses[0].CurrentPath != "/home/a" {
		t.Fatalf("状态解析异常: %+v", statuses)
	}
}

func TestRunMapsExitCodeAndTail(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "restic")
	content := `#!/bin/sh
echo '{"message_type":"error","error":{"message":"unable to open config"}}'
echo 'repository is locked by another process' >&2
exit 11
`
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	outcome, err := Run(context.Background(), Options{Binary: script})
	if err != nil {
		t.Fatal(err)
	}
	if outcome.ExitCode != 11 {
		t.Fatalf("退出码应为 11，实际 %d", outcome.ExitCode)
	}
	if !strings.Contains(outcome.StderrTail, "locked") {
		t.Fatalf("stderr 尾部缺失: %q", outcome.StderrTail)
	}
	if outcome.Message != "unable to open config" {
		t.Fatalf("error 行解析失败: %q", outcome.Message)
	}
}

func TestRunTimeoutKillsProcess(t *testing.T) {
	dir := t.TempDir()
	script := filepath.Join(dir, "restic")
	content := "#!/bin/sh\nsleep 30\n"
	if err := os.WriteFile(script, []byte(content), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer cancel()
	start := time.Now()
	outcome, err := Run(ctx, Options{Binary: script, KillGrace: 2 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	if elapsed := time.Since(start); elapsed > 8*time.Second {
		t.Fatalf("超时未及时终止: %v", elapsed)
	}
	if !outcome.TimedOut {
		t.Fatalf("应标记超时: %+v", outcome)
	}
}

func TestRunRejectsMissingBinary(t *testing.T) {
	if _, err := Run(context.Background(), Options{Binary: "/nonexistent/restic"}); err == nil {
		t.Fatal("不存在的 restic 应报错")
	}
}
