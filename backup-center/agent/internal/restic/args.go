// Package restic 封装 restic 可执行文件的参数拼装、环境注入与执行。
package restic

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// Repo 是 restic 仓库连接信息。Password 只注入环境变量，不落盘、不写日志。
type Repo struct {
	URL      string
	Password string
	// TLSClientCert 是合并了证书与私钥的 PEM 文件路径（mTLS 访问仓库数据面时使用）。
	TLSClientCert string
}

// BackupParams 对应 docs/架构.md 6.3 的 backup 任务。
type BackupParams struct {
	Repo           Repo
	Host           string
	Paths          []string
	Excludes       []string
	Tags           []string
	Compression    string
	LimitUploadKiB int64
}

// RestoreParams 对应 docs/架构.md 6.3 的 restore 任务。
type RestoreParams struct {
	Repo      Repo
	Snapshot  string
	Target    string
	Includes  []string
	Overwrite string
	DryRun    bool
}

// BackupArgs 严格按契约拼装 restic backup 参数：
// restic backup <paths...> --host <host> --tag <tags...> --exclude <pat...>
//
//	--compression <mode> [--limit-upload <KiB>] --json
func BackupArgs(p BackupParams) ([]string, error) {
	if len(p.Paths) == 0 {
		return nil, errors.New("备份参数缺少 paths")
	}
	if strings.TrimSpace(p.Host) == "" {
		return nil, errors.New("备份参数缺少 host")
	}
	if p.Repo.URL == "" {
		return nil, errors.New("备份参数缺少仓库 URL")
	}
	for _, path := range p.Paths {
		if !filepath.IsAbs(path) {
			return nil, fmt.Errorf("备份路径必须是绝对路径: %s", path)
		}
	}
	compression := p.Compression
	if compression == "" {
		compression = "auto"
	}
	switch compression {
	case "auto", "off", "max":
	default:
		return nil, fmt.Errorf("不支持的压缩模式: %s", compression)
	}
	args := []string{"backup"}
	args = append(args, p.Paths...)
	args = append(args, "--host", p.Host)
	for _, tag := range p.Tags {
		if tag != "" {
			args = append(args, "--tag", tag)
		}
	}
	for _, exclude := range p.Excludes {
		if exclude != "" {
			args = append(args, "--exclude", exclude)
		}
	}
	args = append(args, "--compression", compression)
	if p.LimitUploadKiB > 0 {
		args = append(args, "--limit-upload", strconv.FormatInt(p.LimitUploadKiB, 10))
	}
	args = append(args, "--json")
	return args, nil
}

// RestoreArgs 严格按契约拼装 restic restore 参数：
// restic restore <snap> --target <target> --include <path>... --overwrite <mode>
//
//	[--dry-run] --verify --json
func RestoreArgs(p RestoreParams) ([]string, error) {
	if strings.TrimSpace(p.Snapshot) == "" {
		return nil, errors.New("恢复参数缺少 snapshot")
	}
	if strings.TrimSpace(p.Target) == "" {
		return nil, errors.New("恢复参数缺少 target")
	}
	if !filepath.IsAbs(p.Target) {
		return nil, fmt.Errorf("恢复目标必须是绝对路径: %s", p.Target)
	}
	if p.Repo.URL == "" {
		return nil, errors.New("恢复参数缺少仓库 URL")
	}
	overwrite := p.Overwrite
	if overwrite == "" {
		overwrite = "always"
	}
	switch overwrite {
	case "always", "if-changed", "never":
	default:
		return nil, fmt.Errorf("不支持的 overwrite 模式: %s", overwrite)
	}
	args := []string{"restore", p.Snapshot, "--target", p.Target}
	for _, include := range p.Includes {
		if include != "" {
			args = append(args, "--include", include)
		}
	}
	args = append(args, "--overwrite", overwrite)
	if p.DryRun {
		args = append(args, "--dry-run")
	}
	args = append(args, "--verify", "--json")
	return args, nil
}

// Environment 返回 restic 运行环境：在 base 基础上覆盖
// RESTIC_REPOSITORY / RESTIC_PASSWORD / RESTIC_CACHE_DIR / RESTIC_PROGRESS_FPS / TMPDIR。
// 相同 key 的旧值会被移除，避免重复环境变量导致取到错误值。
func Environment(repo Repo, cacheDir string, base []string) ([]string, error) {
	if repo.URL == "" {
		return nil, errors.New("restic 环境缺少仓库 URL")
	}
	if cacheDir == "" {
		return nil, errors.New("restic 环境缺少缓存目录")
	}
	tmpDir := filepath.Join(cacheDir, "tmp")
	for _, dir := range []string{cacheDir, tmpDir} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return nil, fmt.Errorf("创建 restic 缓存目录 %s 失败: %w", dir, err)
		}
		if err := os.Chmod(dir, 0o700); err != nil {
			return nil, fmt.Errorf("设置 restic 缓存目录权限失败: %w", err)
		}
	}
	if base == nil {
		base = os.Environ()
	}
	repoURL := repo.URL
	if strings.HasPrefix(repoURL, "http://") || strings.HasPrefix(repoURL, "https://") {
		repoURL = "rest:" + repoURL
	}
	env := setEnv(base, "RESTIC_REPOSITORY", repoURL)
	env = setEnv(env, "RESTIC_PASSWORD", repo.Password)
	if repo.TLSClientCert != "" {
		env = setEnv(env, "RESTIC_TLS_CLIENT_CERT", repo.TLSClientCert)
	}
	env = setEnv(env, "RESTIC_CACHE_DIR", cacheDir)
	env = setEnv(env, "RESTIC_PROGRESS_FPS", "2")
	env = setEnv(env, "TMPDIR", tmpDir)
	return env, nil
}

func setEnv(env []string, key, value string) []string {
	prefix := key + "="
	out := make([]string, 0, len(env)+1)
	for _, kv := range env {
		if strings.HasPrefix(kv, prefix) {
			continue
		}
		out = append(out, kv)
	}
	return append(out, prefix+value)
}
