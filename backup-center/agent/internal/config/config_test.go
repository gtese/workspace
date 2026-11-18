package config

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"
)

func validConfig(t *testing.T) *Config {
	t.Helper()
	dir := t.TempDir()
	paths := WithDir(dir)
	cfg := &Config{
		Server:          "https://backup.tri.local:8443",
		CAFile:          paths.CA,
		CertFile:        paths.Cert,
		KeyFile:         paths.Key,
		ClientID:        "c_0123456789ab",
		ResticBinary:    paths.Restic,
		CacheDir:        paths.Cache,
		PollWaitSeconds: 25,
		LogFile:         paths.Log,
	}
	return cfg
}

func TestValidateOK(t *testing.T) {
	cfg := validConfig(t)
	if err := cfg.Validate(); err != nil {
		t.Fatalf("合法配置不应报错: %v", err)
	}
}

func TestValidateFailures(t *testing.T) {
	cases := []struct {
		name string
		mod  func(*Config)
	}{
		{"缺少 server", func(c *Config) { c.Server = "" }},
		{"非法 server", func(c *Config) { c.Server = "ftp://x" }},
		{"缺少 client_id", func(c *Config) { c.ClientID = "" }},
		{"缺少 cert", func(c *Config) { c.CertFile = "" }},
		{"相对路径", func(c *Config) { c.ResticBinary = "restic" }},
		{"poll 太短", func(c *Config) { c.PollWaitSeconds = 0 }},
		{"poll 太长", func(c *Config) { c.PollWaitSeconds = 61 }},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cfg := validConfig(t)
			tc.mod(cfg)
			if err := cfg.Validate(); err == nil {
				t.Fatal("期望校验失败")
			}
		})
	}
}

func TestSaveLoadRoundtrip(t *testing.T) {
	dir := t.TempDir()
	cfg := validConfig(t)
	cfg.PollWaitSeconds = 15
	path := filepath.Join(dir, "config.json")
	if err := cfg.Save(path); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if perm := info.Mode().Perm(); perm != 0o600 {
		t.Fatalf("配置权限应为 0600，实际 %04o", perm)
	}
	loaded, err := Load(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.ClientID != cfg.ClientID || loaded.PollWaitSeconds != 15 {
		t.Fatalf("回读不一致: %+v", loaded)
	}
}

func TestApplyDefaults(t *testing.T) {
	dir := t.TempDir()
	cfg := &Config{Server: "http://127.0.0.1:9444"}
	cfg.ApplyDefaults(dir)
	if cfg.CAFile != filepath.Join(dir, "ca.pem") || cfg.PollWaitSeconds != 25 {
		t.Fatalf("默认值异常: %+v", cfg)
	}
	if cfg.Server != "http://127.0.0.1:9444" {
		t.Fatalf("server 不应变化: %s", cfg.Server)
	}
}

func TestDefaultPathsByPlatform(t *testing.T) {
	p := DefaultPaths()
	if p.Config == "" || !filepath.IsAbs(p.Config) || !filepath.IsAbs(p.Binary) {
		t.Fatalf("路径必须为绝对路径: %+v", p)
	}
	if runtime.GOOS == "darwin" {
		if p.Dir != "/Library/Application Support/backup-center-agent" {
			t.Fatalf("macOS 配置目录不符: %s", p.Dir)
		}
	} else if runtime.GOOS == "linux" {
		if p.Dir != "/etc/backup-center-agent" {
			t.Fatalf("Linux 配置目录不符: %s", p.Dir)
		}
	}
}
