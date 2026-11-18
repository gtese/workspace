package upgrade

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func sha256Hex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestApplyRawBinary(t *testing.T) {
	binary := []byte("#!/bin/sh\necho binary\n")
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(binary)
	}))
	defer srv.Close()

	dir := t.TempDir()
	target := filepath.Join(dir, "backup-agent")
	if err := os.WriteFile(target, []byte("old"), 0o755); err != nil {
		t.Fatal(err)
	}
	var progressCalls int
	result, err := Apply(context.Background(), Options{
		URL:     srv.URL,
		SHA256:  sha256Hex(binary),
		Target:  target,
		Version: "0.1.1",
		Progress: func(done, total int64) {
			progressCalls++
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Source != "binary" || result.SHA256 != sha256Hex(binary) || result.Version != "0.1.1" {
		t.Fatalf("结果异常: %+v", result)
	}
	got, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(got, binary) {
		t.Fatalf("目标未更新: %v %q", err, got)
	}
	info, _ := os.Stat(target)
	if info.Mode().Perm() != 0o755 {
		t.Fatalf("目标权限应为 0755，实际 %04o", info.Mode().Perm())
	}
	if progressCalls == 0 {
		t.Fatal("应至少回调一次下载进度")
	}
}

func TestApplyRejectsBadSHA(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("payload"))
	}))
	defer srv.Close()
	dir := t.TempDir()
	target := filepath.Join(dir, "backup-agent")
	_, err := Apply(context.Background(), Options{
		URL:    srv.URL,
		SHA256: sha256Hex([]byte("other")),
		Target: target,
	})
	if err == nil {
		t.Fatal("sha256 不匹配应失败")
	}
	if _, statErr := os.Stat(target); !os.IsNotExist(statErr) {
		t.Fatal("校验失败不应写出目标文件")
	}
}

func makeTarGz(t *testing.T, name string, content []byte) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	if err := tw.WriteHeader(&tar.Header{Name: name, Mode: 0o755, Size: int64(len(content)), Typeflag: tar.TypeReg}); err != nil {
		t.Fatal(err)
	}
	if _, err := tw.Write(content); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func TestApplyTarGz(t *testing.T) {
	binary := []byte("#!/bin/sh\necho tar-binary\n")
	archive := makeTarGz(t, "backup-agent", binary)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(archive)
	}))
	defer srv.Close()
	dir := t.TempDir()
	target := filepath.Join(dir, "backup-agent")
	result, err := Apply(context.Background(), Options{
		URL:    srv.URL,
		SHA256: sha256Hex(archive), // 允许匹配下载的压缩包
		Target: target,
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Source != "tar.gz" || result.SHA256 != sha256Hex(binary) {
		t.Fatalf("tar 结果异常: %+v", result)
	}
	got, err := os.ReadFile(target)
	if err != nil || !bytes.Equal(got, binary) {
		t.Fatalf("tar 解包后二进制不符: %v %q", err, got)
	}
}

func TestApplyRejectsInvalidInput(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "a")
	if _, err := Apply(context.Background(), Options{URL: "ftp://x/a", SHA256: sha256Hex(nil), Target: target}); err == nil {
		t.Fatal("非法 URL 应失败")
	}
	if _, err := Apply(context.Background(), Options{URL: "http://x/a", SHA256: "zz", Target: target}); err == nil {
		t.Fatal("非法 sha256 应失败")
	}
	if _, err := Apply(context.Background(), Options{URL: "http://x/a", SHA256: sha256Hex(nil), Target: "relative"}); err == nil {
		t.Fatal("相对目标路径应失败")
	}
}

func TestApplyHTTPError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "nope", http.StatusForbidden)
	}))
	defer srv.Close()
	dir := t.TempDir()
	if _, err := Apply(context.Background(), Options{
		URL:    srv.URL,
		SHA256: sha256Hex([]byte("x")),
		Target: filepath.Join(dir, "a"),
	}); err == nil {
		t.Fatal("HTTP 403 应失败")
	}
}
