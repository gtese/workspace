//go:build darwin

package fslist

import (
	"strings"
	"syscall"
)

// ListMounts 通过 getfsstat 枚举挂载点并返回容量（字节）。
func ListMounts() ([]Mount, error) {
	const mntNowait = 2 // MNT_NOWAIT，避免阻塞在网络挂载上
	n, err := syscall.Getfsstat(nil, mntNowait)
	if err != nil {
		return nil, err
	}
	if n <= 0 {
		return nil, nil
	}
	buf := make([]syscall.Statfs_t, n)
	n, err = syscall.Getfsstat(buf, mntNowait)
	if err != nil {
		return nil, err
	}
	if n > len(buf) {
		n = len(buf)
	}
	mounts := make([]Mount, 0, n)
	for i := 0; i < n; i++ {
		path := cString(buf[i].Mntonname[:])
		fs := cString(buf[i].Fstypename[:])
		if path == "" || path == "/dev" || path == "/System/Volumes/VM" {
			continue
		}
		m := Mount{Path: path, FS: fs}
		if total, free, err := DiskUsage(path); err == nil {
			m.Total, m.Free = total, free
		}
		mounts = append(mounts, m)
	}
	return mounts, nil
}

func cString[T ~byte | ~int8](b []T) string {
	var sb strings.Builder
	for _, c := range b {
		if c == 0 {
			break
		}
		sb.WriteByte(byte(c))
	}
	return sb.String()
}
