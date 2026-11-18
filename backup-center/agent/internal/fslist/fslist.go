// Package fslist 实现只读目录列举与挂载/磁盘容量采集（不依赖 restic）。
package fslist

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// Entry 是目录中的一个条目，字段与 docs/架构.md 5.3 保持一致。
type Entry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	Type       string `json:"type"` // file/dir/link/other
	Size       int64  `json:"size"`
	Mode       string `json:"mode"` // 例如 0644
	MTime      string `json:"mtime"`
	LinkTarget string `json:"link_target,omitempty"`
}

// Mount 是挂载点及其容量（total/free 单位：字节）。
type Mount struct {
	Path  string `json:"path"`
	FS    string `json:"fs"`
	Total uint64 `json:"total"`
	Free  uint64 `json:"free"`
}

// Listing 是一次 fs_list 的结果。
type Listing struct {
	Path    string  `json:"path"`
	Parent  string  `json:"parent"`
	Entries []Entry `json:"entries"`
	Mounts  []Mount `json:"mounts"`
}

// List 只读列目录（非递归），并附带挂载点/容量信息。
// 对危险路径（如 /proc 内容）不做特殊处理，由服务端负责拦截。
func List(path string) (*Listing, error) {
	if path == "" {
		return nil, errors.New("路径不能为空")
	}
	if !filepath.IsAbs(path) {
		return nil, fmt.Errorf("路径必须是绝对路径: %s", path)
	}
	clean := filepath.Clean(path)
	rootInfo, err := os.Lstat(clean)
	if err != nil {
		return nil, fmt.Errorf("读取路径失败: %w", err)
	}
	if !rootInfo.IsDir() {
		return nil, fmt.Errorf("路径不是目录: %s", clean)
	}
	dirEntries, err := os.ReadDir(clean)
	if err != nil {
		return nil, fmt.Errorf("读取目录失败: %w", err)
	}
	listing := &Listing{
		Path:    clean,
		Parent:  filepath.Dir(clean),
		Entries: make([]Entry, 0, len(dirEntries)),
		Mounts:  []Mount{},
	}
	for _, de := range dirEntries {
		entryPath := filepath.Join(clean, de.Name())
		info, err := os.Lstat(entryPath)
		if err != nil {
			// 单个条目消失或无权限不应让整次列举失败。
			continue
		}
		entry := Entry{
			Name:  de.Name(),
			Path:  entryPath,
			Type:  classify(info.Mode()),
			Mode:  fmt.Sprintf("%04o", info.Mode().Perm()),
			MTime: info.ModTime().UTC().Format(time.RFC3339),
		}
		if info.Mode().IsRegular() {
			entry.Size = info.Size()
		}
		if info.Mode()&os.ModeSymlink != 0 {
			if target, err := os.Readlink(entryPath); err == nil {
				entry.LinkTarget = target
			}
		}
		listing.Entries = append(listing.Entries, entry)
	}
	if mounts, err := ListMounts(); err == nil {
		listing.Mounts = mounts
	}
	return listing, nil
}

func classify(mode os.FileMode) string {
	switch {
	case mode.IsRegular():
		return "file"
	case mode.IsDir():
		return "dir"
	case mode&os.ModeSymlink != 0:
		return "link"
	default:
		return "other"
	}
}

// DiskUsage 返回给定路径所在文件系统的总容量与可用容量（字节）。
func DiskUsage(path string) (total, free uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, fmt.Errorf("读取磁盘容量失败: %w", err)
	}
	bsize := uint64(st.Bsize)
	return uint64(st.Blocks) * bsize, uint64(st.Bavail) * bsize, nil
}
