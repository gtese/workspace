package fslist

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

func TestListDirectory(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hello"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("/etc/hosts", filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}

	listing, err := List(dir)
	if err != nil {
		t.Fatal(err)
	}
	if listing.Path != dir || listing.Parent != filepath.Dir(dir) {
		t.Fatalf("路径字段不符: %+v", listing)
	}
	if len(listing.Entries) != 3 {
		t.Fatalf("条目数应为 3，实际 %d: %+v", len(listing.Entries), listing.Entries)
	}
	byName := map[string]Entry{}
	for _, e := range listing.Entries {
		byName[e.Name] = e
		if len(e.Mode) != 4 && !strings.HasPrefix(e.Mode, "0") {
			t.Fatalf("mode 格式异常: %q", e.Mode)
		}
	}
	if e := byName["a.txt"]; e.Type != "file" || e.Size != 5 || e.Path != filepath.Join(dir, "a.txt") {
		t.Fatalf("文件条目异常: %+v", e)
	}
	if e := byName["sub"]; e.Type != "dir" {
		t.Fatalf("目录条目异常: %+v", e)
	}
	if e := byName["link"]; e.Type != "link" || e.LinkTarget != "/etc/hosts" || e.Size != 0 {
		t.Fatalf("符号链接条目异常: %+v", e)
	}
	if byName["a.txt"].Mode != "0644" {
		t.Fatalf("文件权限应为 0644，实际 %s", byName["a.txt"].Mode)
	}
}

func TestListErrors(t *testing.T) {
	if _, err := List("relative/path"); err == nil {
		t.Fatal("相对路径应报错")
	}
	if _, err := List(""); err == nil {
		t.Fatal("空路径应报错")
	}
	if _, err := List("/nonexistent/path/for/test"); err == nil {
		t.Fatal("不存在路径应报错")
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "f")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := List(file); err == nil {
		t.Fatal("非目录应报错")
	}
}

func TestDiskUsage(t *testing.T) {
	total, free, err := DiskUsage("/")
	if err != nil {
		t.Fatal(err)
	}
	if total == 0 || free > total {
		t.Fatalf("容量数据异常: total=%d free=%d", total, free)
	}
}

func TestListMounts(t *testing.T) {
	mounts, err := ListMounts()
	if err != nil {
		t.Skipf("当前平台无法枚举挂载点: %v", err)
	}
	if runtime.GOOS == "darwin" || runtime.GOOS == "linux" {
		foundRoot := false
		for _, m := range mounts {
			if m.Path == "/" {
				foundRoot = true
				if m.FS == "" {
					t.Fatal("挂载点缺少文件系统类型")
				}
			}
		}
		if !foundRoot {
			t.Fatalf("未找到根挂载点: %+v", mounts)
		}
	}
}
