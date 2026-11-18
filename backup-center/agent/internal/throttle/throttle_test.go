package throttle

import (
	"testing"
	"time"
)

func TestThrottleByClock(t *testing.T) {
	now := time.Date(2026, 11, 18, 12, 0, 0, 0, time.UTC)
	clock := func() time.Time { return now }
	th := NewWithClock(time.Second, clock)

	if !th.Allow() {
		t.Fatal("首次应该允许")
	}
	if th.Allow() {
		t.Fatal("同一时刻第二次应被拦截")
	}
	now = now.Add(500 * time.Millisecond)
	if th.Allow() {
		t.Fatal("500ms 内应被拦截")
	}
	now = now.Add(500 * time.Millisecond)
	if !th.Allow() {
		t.Fatal("满 1 秒应允许")
	}
	now = now.Add(2 * time.Second)
	if !th.Allow() {
		t.Fatal("超过间隔应允许")
	}
}

func TestReset(t *testing.T) {
	now := time.Now()
	th := NewWithClock(time.Second, func() time.Time { return now })
	if !th.Allow() {
		t.Fatal("首次应该允许")
	}
	th.Reset()
	if !th.Allow() {
		t.Fatal("Reset 后应立即允许")
	}
}

func TestDefaultInterval(t *testing.T) {
	th := New(0)
	if th.Interval() != time.Second {
		t.Fatalf("默认间隔应为 1s，实际 %v", th.Interval())
	}
	if th.Allow() == false {
		t.Fatal("首次应允许")
	}
}
