// Package upgrade 实现代理自升级：下载 → sha256 校验 → 原子替换。
package upgrade

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// MaxArtifactBytes 是升级包大小上限（512MB）。
const MaxArtifactBytes = 512 << 20

// Options 描述一次升级。
type Options struct {
	URL      string
	SHA256   string // 期望值；tar 场景下可匹配压缩包或其中的 backup-agent
	Target   string // 待替换的可执行文件绝对路径
	Version  string // 仅用于摘要
	HTTP     *http.Client
	Progress func(done, total int64) // 可为 nil；调用频率由调用方控制
}

// Result 是升级结果摘要。
type Result struct {
	Version        string `json:"version,omitempty"`
	Path           string `json:"path"`
	Bytes          int64  `json:"bytes"`
	SHA256         string `json:"sha256"`
	ArtifactSHA256 string `json:"artifact_sha256"`
	Source         string `json:"source"` // binary/tar.gz
}

// Apply 下载升级包、校验 sha256，并以 rename 原子替换 Target。
func Apply(ctx context.Context, opts Options) (*Result, error) {
	if !filepath.IsAbs(opts.Target) {
		return nil, fmt.Errorf("升级目标必须是绝对路径: %s", opts.Target)
	}
	if len(opts.SHA256) != 64 {
		return nil, errors.New("升级 sha256 长度必须为 64 位十六进制")
	}
	if _, err := hex.DecodeString(opts.SHA256); err != nil {
		return nil, errors.New("升级 sha256 不是合法十六进制")
	}
	u, err := url.Parse(opts.URL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" {
		return nil, fmt.Errorf("升级 URL 无效: %q", opts.URL)
	}
	client := opts.HTTP
	if client == nil {
		client = &http.Client{Timeout: 10 * time.Minute}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, opts.URL, nil)
	if err != nil {
		return nil, fmt.Errorf("构造升级下载请求失败: %w", err)
	}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("下载升级包失败: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("下载升级包失败: HTTP %d", resp.StatusCode)
	}
	total := resp.ContentLength

	dir := filepath.Dir(opts.Target)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("创建升级目标目录失败: %w", err)
	}
	artifact, err := os.CreateTemp(dir, ".upgrade-download-*")
	if err != nil {
		return nil, fmt.Errorf("创建升级临时文件失败: %w", err)
	}
	artifactName := artifact.Name()
	defer os.Remove(artifactName)
	hasher := sha256.New()
	limited := io.LimitReader(resp.Body, MaxArtifactBytes+1)
	var written int64
	buf := make([]byte, 256*1024)
	for {
		n, rerr := limited.Read(buf)
		if n > 0 {
			if written+int64(n) > MaxArtifactBytes {
				_ = artifact.Close()
				return nil, errors.New("升级包超过大小上限")
			}
			if _, werr := artifact.Write(buf[:n]); werr != nil {
				_ = artifact.Close()
				return nil, fmt.Errorf("写入升级包失败: %w", werr)
			}
			_, _ = hasher.Write(buf[:n])
			written += int64(n)
			if opts.Progress != nil {
				opts.Progress(written, total)
			}
		}
		if rerr == io.EOF {
			break
		}
		if rerr != nil {
			_ = artifact.Close()
			return nil, fmt.Errorf("读取升级包失败: %w", rerr)
		}
	}
	if err := artifact.Sync(); err != nil {
		_ = artifact.Close()
		return nil, err
	}
	if err := artifact.Close(); err != nil {
		return nil, err
	}
	artifactSHA := hex.EncodeToString(hasher.Sum(nil))
	result := &Result{
		Version:        opts.Version,
		Path:           opts.Target,
		Bytes:          written,
		ArtifactSHA256: artifactSHA,
	}

	header := make([]byte, 2)
	f, err := os.Open(artifactName)
	if err != nil {
		return nil, err
	}
	_, _ = io.ReadFull(f, header)
	_ = f.Close()
	isGzip := len(header) == 2 && header[0] == 0x1f && header[1] == 0x8b

	var binaryPath string
	if isGzip {
		extracted, binSHA, err := extractBinary(artifactName)
		if err != nil {
			return nil, err
		}
		defer os.Remove(extracted)
		binaryPath = extracted
		result.Source = "tar.gz"
		if !strings.EqualFold(binSHA, opts.SHA256) && !strings.EqualFold(artifactSHA, opts.SHA256) {
			return nil, fmt.Errorf("升级包 sha256 校验失败: 期望 %s，实际 %s", opts.SHA256, binSHA)
		}
		result.SHA256 = binSHA
	} else {
		binaryPath = artifactName
		if !strings.EqualFold(artifactSHA, opts.SHA256) {
			return nil, fmt.Errorf("升级包 sha256 校验失败: 期望 %s，实际 %s", opts.SHA256, artifactSHA)
		}
		result.SHA256 = artifactSHA
		result.Source = "binary"
	}

	if err := installAtomically(binaryPath, opts.Target); err != nil {
		return nil, err
	}
	return result, nil
}

func installAtomically(src, target string) error {
	in, err := os.Open(src)
	if err != nil {
		return fmt.Errorf("打开升级二进制失败: %w", err)
	}
	defer in.Close()
	dir := filepath.Dir(target)
	tmp, err := os.CreateTemp(dir, ".upgrade-binary-*")
	if err != nil {
		return fmt.Errorf("创建升级临时文件失败: %w", err)
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := io.Copy(tmp, in); err != nil {
		_ = tmp.Close()
		return fmt.Errorf("写入升级二进制失败: %w", err)
	}
	if err := tmp.Chmod(0o755); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Sync(); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, target); err != nil {
		return fmt.Errorf("原子替换 %s 失败: %w", target, err)
	}
	return nil
}

// extractBinary 从 tar.gz 中提取 backup-agent，返回临时文件路径与 sha256。
func extractBinary(archivePath string) (string, string, error) {
	f, err := os.Open(archivePath)
	if err != nil {
		return "", "", err
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return "", "", fmt.Errorf("解压升级包失败: %w", err)
	}
	defer gz.Close()
	tr := tar.NewReader(gz)
	tmp, err := os.CreateTemp("", "backup-agent-upgrade-*")
	if err != nil {
		return "", "", err
	}
	tmpName := tmp.Name()
	// 调用方负责清理：成功时保留路径供替换；失败时删除。
	cleanup := true
	defer func() {
		_ = tmp.Close()
		if cleanup {
			_ = os.Remove(tmpName)
		}
	}()

	hasher := sha256.New()
	found := false
	for {
		hdr, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", "", fmt.Errorf("读取升级包失败: %w", err)
		}
		if hdr.Typeflag != tar.TypeReg {
			continue
		}
		base := filepath.Base(hdr.Name)
		if base != "backup-agent" {
			continue
		}
		_, _ = io.Copy(io.MultiWriter(tmp, hasher), tr)
		found = true
		break
	}
	if !found {
		return "", "", errors.New("升级包中未找到 backup-agent")
	}
	if err := tmp.Sync(); err != nil {
		return "", "", err
	}
	cleanup = false
	return tmpName, hex.EncodeToString(hasher.Sum(nil)), nil
}
