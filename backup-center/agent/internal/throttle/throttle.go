// Package throttle 提供“最多每秒一次”的进度节流器，可注入时钟便于测试。
package throttle

import (
	"sync"
	"time"
)

// Throttle 保证 Allow 在 interval 内最多返回一次 true。
type Throttle struct {
	mu       sync.Mutex
	interval time.Duration
	last     time.Time
	now      func() time.Time
}

// New 创建节流器；interval <= 0 时默认 1 秒。
func New(interval time.Duration) *Throttle {
	if interval <= 0 {
		interval = time.Second
	}
	return &Throttle{interval: interval, now: time.Now}
}

// NewWithClock 用自定义时钟创建节流器，用于单元测试。
func NewWithClock(interval time.Duration, now func() time.Time) *Throttle {
	t := New(interval)
	if now != nil {
		t.now = now
	}
	return t
}

// Allow 判断当前是否允许上报；允许时记录本次时间。
func (t *Throttle) Allow() bool {
	if t == nil {
		return false
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	now := t.now()
	if t.last.IsZero() || now.Sub(t.last) >= t.interval {
		t.last = now
		return true
	}
	return false
}

// Reset 清除最近一次记录，使下次 Allow 立即通过。
func (t *Throttle) Reset() {
	if t == nil {
		return
	}
	t.mu.Lock()
	t.last = time.Time{}
	t.mu.Unlock()
}

// Interval 返回节流间隔。
func (t *Throttle) Interval() time.Duration {
	if t == nil {
		return 0
	}
	return t.interval
}
