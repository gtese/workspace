// Package config 定义代理本地配置与平台默认路径。
package config

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"runtime"
	"strings"
)

// Config 对应 docs/架构.md 6.4 的本地配置。
type Config struct {
	Server          string `json:"server"`
	CAFile          string `json:"ca_file"`
	CertFile        string `json:"cert_file"`
	KeyFile         string `json:"key_file"`
	ClientID        string `json:"client_id"`
	ResticBinary    string `json:"restic_binary"`
	CacheDir        string `json:"cache_dir"`
	PollWaitSeconds int    `json:"poll_wait_seconds"`
	LogFile         string `json:"log_file"`
}

// Paths 是安装期使用的平台默认路径。
type Paths struct {
	Dir        string
	Config     string
	CA         string
	Cert       string
	Key        string
	Cache      string
	Log        string
	Restic     string
	Binary     string
	BinDir     string
	InstallDir string
}

// DefaultPaths 返回当前平台的默认路径。
// Linux: /etc/backup-center-agent/；macOS: /Library/Application Support/backup-center-agent/。
func DefaultPaths() Paths {
	if runtime.GOOS == "darwin" {
		const base = "/Library/Application Support/backup-center-agent"
		return Paths{
			Dir:        base,
			Config:     filepath.Join(base, "config.json"),
			CA:         filepath.Join(base, "ca.pem"),
			Cert:       filepath.Join(base, "agent.crt"),
			Key:        filepath.Join(base, "agent.key"),
			Cache:      "/Library/Caches/backup-center-agent",
			Log:        "/Library/Logs/backup-center-agent.log",
			Restic:     "/opt/backup-center-agent/bin/restic",
			Binary:     "/opt/backup-center-agent/bin/backup-agent",
			BinDir:     "/opt/backup-center-agent/bin",
			InstallDir: "/opt/backup-center-agent",
		}
	}
	const base = "/etc/backup-center-agent"
	return Paths{
		Dir:        base,
		Config:     filepath.Join(base, "config.json"),
		CA:         filepath.Join(base, "ca.pem"),
		Cert:       filepath.Join(base, "agent.crt"),
		Key:        filepath.Join(base, "agent.key"),
		Cache:      "/var/cache/backup-center-agent",
		Log:        "/var/log/backup-center-agent.log",
		Restic:     "/opt/backup-center-agent/bin/restic",
		Binary:     "/opt/backup-center-agent/bin/backup-agent",
		BinDir:     "/opt/backup-center-agent/bin",
		InstallDir: "/opt/backup-center-agent",
	}
}

// WithDir 基于默认路径覆盖配置目录，测试与开发场景使用。
func WithDir(dir string) Paths {
	p := DefaultPaths()
	p.Dir = dir
	p.Config = filepath.Join(dir, "config.json")
	p.CA = filepath.Join(dir, "ca.pem")
	p.Cert = filepath.Join(dir, "agent.crt")
	p.Key = filepath.Join(dir, "agent.key")
	return p
}

// NewDefault 用平台默认路径构造一份空配置骨架。
func NewDefault(server string) *Config {
	p := DefaultPaths()
	return &Config{
		Server:          server,
		CAFile:          p.CA,
		CertFile:        p.Cert,
		KeyFile:         p.Key,
		ResticBinary:    p.Restic,
		CacheDir:        p.Cache,
		PollWaitSeconds: 25,
		LogFile:         p.Log,
	}
}

// Load 读取配置文件并补全默认值。
func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("读取配置失败: %w", err)
	}
	var c Config
	if err := json.Unmarshal(raw, &c); err != nil {
		return nil, fmt.Errorf("解析配置失败: %w", err)
	}
	c.ApplyDefaults(filepath.Dir(path))
	return &c, c.Validate()
}

// ApplyDefaults 补全空字段，dir 为配置目录（cert/key/ca 相对路径的基准）。
func (c *Config) ApplyDefaults(dir string) {
	p := DefaultPaths()
	if c.CAFile == "" {
		c.CAFile = filepath.Join(dir, "ca.pem")
	}
	if c.CertFile == "" {
		c.CertFile = filepath.Join(dir, "agent.crt")
	}
	if c.KeyFile == "" {
		c.KeyFile = filepath.Join(dir, "agent.key")
	}
	if c.ResticBinary == "" {
		c.ResticBinary = p.Restic
	}
	if c.CacheDir == "" {
		c.CacheDir = p.Cache
	}
	if c.LogFile == "" {
		c.LogFile = p.Log
	}
	if c.PollWaitSeconds == 0 {
		c.PollWaitSeconds = 25
	}
	c.Server = strings.TrimRight(strings.TrimSpace(c.Server), "/")
}

// Validate 校验配置完整性。错误信息为中文。
func (c *Config) Validate() error {
	if c == nil {
		return errors.New("配置为空")
	}
	u, err := url.Parse(c.Server)
	if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") {
		return fmt.Errorf("server 必须是 http(s) URL: %q", c.Server)
	}
	if strings.TrimSpace(c.ClientID) == "" {
		return errors.New("config.client_id 不能为空")
	}
	for name, p := range map[string]string{
		"ca_file":       c.CAFile,
		"cert_file":     c.CertFile,
		"key_file":      c.KeyFile,
		"restic_binary": c.ResticBinary,
		"cache_dir":     c.CacheDir,
		"log_file":      c.LogFile,
	} {
		if strings.TrimSpace(p) == "" {
			return fmt.Errorf("config.%s 不能为空", name)
		}
		if !filepath.IsAbs(p) {
			return fmt.Errorf("config.%s 必须是绝对路径: %s", name, p)
		}
	}
	if c.PollWaitSeconds < 1 || c.PollWaitSeconds > 60 {
		return fmt.Errorf("poll_wait_seconds 必须在 1..60 之间: %d", c.PollWaitSeconds)
	}
	return nil
}

// Marshal 输出带缩进的 JSON（末尾换行）。
func (c *Config) Marshal() ([]byte, error) {
	raw, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(raw, '\n'), nil
}

// Save 原子写入配置文件（0600），目录 0700。
func (c *Config) Save(path string) error {
	raw, err := c.Marshal()
	if err != nil {
		return err
	}
	return WriteFileAtomic(path, raw, 0o600)
}

// WriteFileAtomic 原子写文件：同目录临时文件 + chmod + rename。
func WriteFileAtomic(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("创建目录 %s 失败: %w", dir, err)
	}
	tmp, err := os.CreateTemp(dir, ".tmp-*")
	if err != nil {
		return fmt.Errorf("创建临时文件失败: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if err := tmp.Chmod(perm); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("设置临时文件权限失败: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("写入临时文件失败: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("同步临时文件失败: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return fmt.Errorf("关闭临时文件失败: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		return fmt.Errorf("替换文件 %s 失败: %w", path, err)
	}
	return nil
}
