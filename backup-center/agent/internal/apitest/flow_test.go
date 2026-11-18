// Package apitest 用 httptest mock 服务端验证 enroll → heartbeat → tasks → result 全流程。
package apitest

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"tri.local/backup-center/agent/internal/agent"
	"tri.local/backup-center/agent/internal/config"
	"tri.local/backup-center/agent/internal/logging"
	"tri.local/backup-center/agent/internal/model"
	"tri.local/backup-center/agent/internal/pki"
)

type mockServer struct {
	t *testing.T

	server *httptest.Server
	caCert *x509.Certificate
	caKey  *ecdsa.PrivateKey

	mu           sync.Mutex
	enrollReq    *model.EnrollRequest
	pendingPolls int
	tasks        []model.Task
	taskIssued   bool
	heartbeats   int
	progresses   int
	results      []model.Result
	resultCh     chan model.Result
	clientID     string
}

func newMockServer(t *testing.T, taskPath string) *mockServer {
	t.Helper()
	return newMockServerWithTasks(t, []model.Task{{
		ID:   "t_0123456789abcdef",
		Type: model.TaskFSList,
		Path: taskPath,
	}})
}

func newMockServerWithTasks(t *testing.T, tasks []model.Task) *mockServer {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	tmpl := &x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "backup-center-test-ca"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(10 * 365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageDigitalSignature,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	caCert, err := x509.ParseCertificate(der)
	if err != nil {
		t.Fatal(err)
	}
	m := &mockServer{
		t:        t,
		caCert:   caCert,
		caKey:    key,
		tasks:    tasks,
		clientID: "c_0123456789ab",
		resultCh: make(chan model.Result, 8),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/api/enroll", m.handleEnroll)
	mux.HandleFunc("/api/enroll/e_test", m.handleEnrollStatus)
	mux.HandleFunc("/api/agent/heartbeat", m.handleHeartbeat)
	mux.HandleFunc("/api/agent/tasks", m.handleTasks)
	mux.HandleFunc("/api/agent/tasks/", m.handleTaskAction)
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, `{"ok":true}`)
	})
	m.server = httptest.NewServer(mux)
	t.Cleanup(m.server.Close)
	return m
}

func (m *mockServer) caPEM() []byte {
	return pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: m.caCert.Raw})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func (m *mockServer) handleEnroll(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": map[string]string{"code": "validation"}})
		return
	}
	var req model.EnrollRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "validation", "message": err.Error()}})
		return
	}
	if req.Token != "test-token" {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": map[string]string{"code": "forbidden", "message": "bad token"}})
		return
	}
	if _, err := pki.ParseCSR([]byte(req.CSRPEM)); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "validation", "message": err.Error()}})
		return
	}
	m.mu.Lock()
	m.enrollReq = &req
	m.mu.Unlock()
	writeJSON(w, http.StatusAccepted, model.EnrollCreated{
		RequestID:        "e_test",
		EnrollSecret:     "enroll-secret-test",
		PollAfterSeconds: 1,
	})
}

func (m *mockServer) handleEnrollStatus(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("x-enroll-secret") != "enroll-secret-test" {
		writeJSON(w, http.StatusForbidden, map[string]any{"error": map[string]string{"code": "forbidden"}})
		return
	}
	m.mu.Lock()
	m.pendingPolls++
	pending := m.pendingPolls < 2
	req := m.enrollReq
	m.mu.Unlock()
	if pending || req == nil {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "pending"})
		return
	}
	csr, err := pki.ParseCSR([]byte(req.CSRPEM))
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "internal", "message": err.Error()}})
		return
	}
	leafTmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: m.clientID},
		NotBefore:    time.Now().Add(-time.Minute),
		NotAfter:     time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTmpl, m.caCert, csr.PublicKey, m.caKey)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": map[string]string{"code": "internal", "message": err.Error()}})
		return
	}
	leafPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: leafDER})
	writeJSON(w, http.StatusOK, map[string]any{
		"status":    "approved",
		"client_id": m.clientID,
		"cert_pem":  string(leafPEM),
		"ca_pem":    string(m.caPEM()),
		"config": map[string]any{
			"client_id":         m.clientID,
			"poll_wait_seconds": 1,
			"allowed_roots":     "/",
			"repository_id":     "r_0123456789ab",
		},
	})
}

func (m *mockServer) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	var hb model.Heartbeat
	if err := json.NewDecoder(r.Body).Decode(&hb); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "validation"}})
		return
	}
	m.mu.Lock()
	m.heartbeats++
	m.mu.Unlock()
	writeJSON(w, http.StatusOK, model.HeartbeatResponse{OK: true, NextPollSeconds: 30})
}

func (m *mockServer) handleTasks(w http.ResponseWriter, r *http.Request) {
	if r.URL.Query().Get("wait") == "" {
		// 长轮询必须带 wait 参数。
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "validation", "message": "missing wait"}})
		return
	}
	m.mu.Lock()
	first := !m.taskIssued
	if first {
		m.taskIssued = true
	}
	tasks := append([]model.Task(nil), m.tasks...)
	m.mu.Unlock()
	if first {
		writeJSON(w, http.StatusOK, model.TasksResponse{Tasks: tasks})
		return
	}
	select {
	case <-r.Context().Done():
	case <-time.After(150 * time.Millisecond):
	}
	writeJSON(w, http.StatusOK, model.TasksResponse{Tasks: []model.Task{}})
}

func (m *mockServer) handleTaskAction(w http.ResponseWriter, r *http.Request) {
	switch filepath.Base(r.URL.Path) {
	case "progress":
		var p model.Progress
		_ = json.NewDecoder(r.Body).Decode(&p)
		m.mu.Lock()
		m.progresses++
		m.mu.Unlock()
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	case "result":
		var res model.Result
		if err := json.NewDecoder(r.Body).Decode(&res); err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": map[string]string{"code": "validation"}})
			return
		}
		m.mu.Lock()
		m.results = append(m.results, res)
		m.mu.Unlock()
		select {
		case m.resultCh <- res:
		default:
		}
		writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
	default:
		writeJSON(w, http.StatusNotFound, map[string]any{"error": map[string]string{"code": "not_found"}})
	}
}

func TestEnrollAndServeTaskFlow(t *testing.T) {
	dir := t.TempDir()
	listDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(listDir, "hello.txt"), []byte("hi"), 0o644); err != nil {
		t.Fatal(err)
	}
	mock := newMockServer(t, listDir)
	cfgPath := filepath.Join(dir, "config.json")
	logger := logging.Discard()

	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	cfg, err := agent.Enroll(ctx, agent.EnrollOptions{
		Server:       mock.server.URL,
		Token:        "test-token",
		Hostname:     "testhost",
		ConfigPath:   cfgPath,
		AgentVersion: "test",
	}, logger)
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	if cfg.ClientID != mock.clientID {
		t.Fatalf("client_id 不符: %s", cfg.ClientID)
	}
	for _, path := range []string{cfgPath, cfg.CertFile, cfg.KeyFile, cfg.CAFile} {
		info, err := os.Stat(path)
		if err != nil {
			t.Fatalf("文件未落盘 %s: %v", path, err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Fatalf("%s 权限应为 0600，实际 %04o", path, perm)
		}
	}
	if _, err := os.Stat(filepath.Join(dir, "enroll-secret")); !os.IsNotExist(err) {
		t.Fatal("enroll-secret 用完应删除")
	}
	loaded, err := config.Load(cfgPath)
	if err != nil {
		t.Fatalf("配置回读失败: %v", err)
	}
	if loaded.Server != mock.server.URL {
		t.Fatalf("配置 server 不符: %s", loaded.Server)
	}
	if loaded.PollWaitSeconds != 1 {
		t.Fatalf("服务端下发的 poll_wait_seconds 未生效: %d", loaded.PollWaitSeconds)
	}

	// 测试环境用临时 cache，避免写系统目录。
	loaded.CacheDir = filepath.Join(dir, "cache")
	loaded.LogFile = filepath.Join(dir, "agent.log")
	if err := loaded.Save(cfgPath); err != nil {
		t.Fatal(err)
	}
	runner, err := agent.New(loaded, logger, "test")
	if err != nil {
		t.Fatalf("New runner: %v", err)
	}
	runner.HeartbeatInterval = 100 * time.Millisecond

	runCtx, runCancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(runCtx) }()

	var result model.Result
	select {
	case result = <-mock.resultCh:
	case <-time.After(15 * time.Second):
		runCancel()
		t.Fatal("等待任务结果超时")
	}
	// 等待至少一次心跳（心跳定时器可能晚于任务结果）。
	hbDeadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(hbDeadline) {
		mock.mu.Lock()
		hb := mock.heartbeats
		mock.mu.Unlock()
		if hb > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	runCancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Runner.Run 返回错误: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Runner 未在取消后退出")
	}

	if !result.OK || result.ExitCode != 0 {
		t.Fatalf("fs_list 结果异常: %+v", result)
	}
	summary, ok := result.Summary.(map[string]any)
	if !ok {
		t.Fatalf("summary 类型异常: %T", result.Summary)
	}
	if got, _ := summary["path"].(string); got != listDir {
		t.Fatalf("summary.path 不符: %v", summary["path"])
	}
	entries, _ := summary["entries"].([]any)
	if len(entries) != 1 {
		t.Fatalf("summary.entries 数量异常: %v", summary["entries"])
	}
	first, _ := entries[0].(map[string]any)
	if first["name"] != "hello.txt" || first["type"] != "file" {
		t.Fatalf("条目字段异常: %v", first)
	}

	mock.mu.Lock()
	heartbeats := mock.heartbeats
	progresses := mock.progresses
	mock.mu.Unlock()
	if heartbeats == 0 {
		t.Fatal("未收到心跳")
	}
	if progresses == 0 {
		t.Fatal("未收到进度上报")
	}
}

func TestEnrollRejected(t *testing.T) {
	// 一个只返回 rejected 的最小服务端。
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/enroll":
			writeJSON(w, http.StatusAccepted, model.EnrollCreated{RequestID: "e_bad", EnrollSecret: "s", PollAfterSeconds: 1})
		case "/api/enroll/e_bad":
			writeJSON(w, http.StatusGone, map[string]string{"status": "rejected"})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()
	dir := t.TempDir()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	_, err := agent.Enroll(ctx, agent.EnrollOptions{
		Server:     srv.URL,
		Token:      "t",
		Hostname:   "h",
		ConfigPath: filepath.Join(dir, "config.json"),
	}, logging.Discard())
	if err == nil {
		t.Fatal("rejected 应返回错误")
	}
}

func TestBackupTaskFlow(t *testing.T) {
	dir := t.TempDir()
	backupDir := t.TempDir()
	if err := os.WriteFile(filepath.Join(backupDir, "doc.txt"), []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	argsFile := filepath.Join(dir, "args.txt")
	repoFile := filepath.Join(dir, "repo.txt")
	passwordFile := filepath.Join(dir, "password.txt")
	resticScript := filepath.Join(dir, "restic")
	script := "#!/bin/sh\n" +
		"if [ \"$1\" = \"version\" ]; then echo \"restic 0.18.0\"; exit 0; fi\n" +
		"printf '%s\\n' \"$@\" > " + argsFile + "\n" +
		"printf '%s\\n' \"$RESTIC_REPOSITORY\" > " + repoFile + "\n" +
		"printf '%s\\n' \"$RESTIC_PASSWORD\" > " + passwordFile + "\n" +
		"echo '{\"message_type\":\"status\",\"percent_done\":0.5,\"bytes_done\":50,\"total_bytes\":100,\"files_done\":1,\"total_files\":2}'\n" +
		"echo '{\"message_type\":\"summary\",\"snapshot_id\":\"snap-backup\",\"files_new\":1,\"bytes_added\":100}'\n" +
		"echo 'backup warning' >&2\n" +
		"exit 0\n"
	if err := os.WriteFile(resticScript, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	repoURL := "https://127.0.0.1:18444/repo/r_0123456789ab/c_0123456789ab/"
	mock := newMockServerWithTasks(t, []model.Task{{
		ID:             "t_backup000000001",
		Type:           model.TaskBackup,
		RunID:          "run_0123456789abcdef",
		PlanID:         "p_0123456789ab",
		Repo:           &model.Repository{URL: repoURL, Password: "repo-pass"},
		Host:           "c_0123456789ab",
		Paths:          []string{backupDir},
		Excludes:       []string{"*.tmp"},
		Tags:           []string{"plan:p_0123456789ab"},
		Compression:    "auto",
		TimeoutSeconds: 120,
	}})

	cfgPath := filepath.Join(dir, "config.json")
	logger := logging.Discard()
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	cfg, err := agent.Enroll(ctx, agent.EnrollOptions{
		Server:       mock.server.URL,
		Token:        "test-token",
		Hostname:     "backup-host",
		ConfigPath:   cfgPath,
		AgentVersion: "test",
	}, logger)
	if err != nil {
		t.Fatalf("Enroll: %v", err)
	}
	cfg.CacheDir = filepath.Join(dir, "cache")
	cfg.LogFile = filepath.Join(dir, "agent.log")
	cfg.ResticBinary = resticScript
	if err := cfg.Save(cfgPath); err != nil {
		t.Fatal(err)
	}
	rawCfg, _ := os.ReadFile(cfgPath)
	if strings.Contains(string(rawCfg), "repo-pass") {
		t.Fatal("配置文件不得包含仓库密码")
	}

	runner, err := agent.New(cfg, logger, "test")
	if err != nil {
		t.Fatal(err)
	}
	runner.HeartbeatInterval = 100 * time.Millisecond
	runCtx, runCancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- runner.Run(runCtx) }()

	var result model.Result
	select {
	case result = <-mock.resultCh:
	case <-time.After(20 * time.Second):
		runCancel()
		t.Fatal("等待备份结果超时")
	}
	runCancel()
	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Runner.Run: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("Runner 未退出")
	}

	if !result.OK || result.ExitCode != 0 {
		t.Fatalf("备份结果异常: %+v", result)
	}
	if result.SnapshotID != "snap-backup" {
		t.Fatalf("snapshot_id 不符: %q", result.SnapshotID)
	}
	if !strings.Contains(result.LogTail, "backup warning") {
		t.Fatalf("log_tail 未包含 stderr: %q", result.LogTail)
	}

	argsRaw, err := os.ReadFile(argsFile)
	if err != nil {
		t.Fatal(err)
	}
	args := strings.Split(strings.TrimSpace(string(argsRaw)), "\n")
	wantArgs := []string{"backup", backupDir, "--host", "c_0123456789ab", "--tag", "plan:p_0123456789ab", "--exclude", "*.tmp", "--compression", "auto", "--json"}
	if !reflect.DeepEqual(args, wantArgs) {
		t.Fatalf("restic 参数不符:\n got=%v\nwant=%v", args, wantArgs)
	}
	wantRepo := repoURL
	if !strings.HasPrefix(wantRepo, "rest:") {
		wantRepo = "rest:" + wantRepo
	}
	if got, _ := os.ReadFile(repoFile); strings.TrimSpace(string(got)) != wantRepo {
		t.Fatalf("RESTIC_REPOSITORY 不符: %q", got)
	}
	if got, _ := os.ReadFile(passwordFile); strings.TrimSpace(string(got)) != "repo-pass" {
		t.Fatalf("RESTIC_PASSWORD 未注入")
	}
	mock.mu.Lock()
	progresses := mock.progresses
	mock.mu.Unlock()
	if progresses == 0 {
		t.Fatal("未收到进度上报")
	}
}
