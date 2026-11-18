//go:build linux

package fslist

import (
	"os"
	"strings"
)

// ListMounts 解析 /proc/self/mounts，返回挂载点与容量（字节）。
func ListMounts() ([]Mount, error) {
	raw, err := os.ReadFile("/proc/self/mounts")
	if err != nil {
		return nil, err
	}
	seen := map[string]bool{}
	mounts := make([]Mount, 0, 32)
	for _, line := range strings.Split(string(raw), "\n") {
		fields := strings.Fields(line)
		if len(fields) < 3 {
			continue
		}
		path := unescapeMountPath(fields[1])
		if seen[path] {
			continue
		}
		seen[path] = true
		m := Mount{Path: path, FS: fields[2]}
		if total, free, err := DiskUsage(path); err == nil {
			m.Total, m.Free = total, free
		}
		mounts = append(mounts, m)
	}
	return mounts, nil
}

// unescapeMountPath 处理 /proc/mounts 中的八进制转义（如 \040 空格）。
func unescapeMountPath(s string) string {
	if !strings.Contains(s, "\\") {
		return s
	}
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		if s[i] == '\\' && i+3 < len(s) {
			var v int
			ok := true
			for j := 1; j <= 3; j++ {
				c := s[i+j]
				if c < '0' || c > '7' {
					ok = false
					break
				}
				v = v*8 + int(c-'0')
			}
			if ok {
				b.WriteByte(byte(v))
				i += 3
				continue
			}
		}
		b.WriteByte(s[i])
	}
	return b.String()
}
