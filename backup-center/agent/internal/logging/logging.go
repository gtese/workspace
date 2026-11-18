// Package logging 提供 JSON 行日志：同时写 stderr 与文件（0600），绝不记录密码。
package logging

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// Level 是日志级别。
type Level int

const (
	LevelDebug Level = iota
	LevelInfo
	LevelWarn
	LevelError
)

func parseLevel(s string) Level {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "debug":
		return LevelDebug
	case "warn", "warning":
		return LevelWarn
	case "error":
		return LevelError
	default:
		return LevelInfo
	}
}

func (l Level) String() string {
	switch l {
	case LevelDebug:
		return "debug"
	case LevelWarn:
		return "warn"
	case LevelError:
		return "error"
	default:
		return "info"
	}
}

// Logger 是并发安全的 JSON 行日志器。
type Logger struct {
	mu     sync.Mutex
	file   *os.File
	stderr io.Writer
	level  Level
	fields map[string]string
}

// Options 描述日志器创建参数。
type Options struct {
	File   string // 为空则只写 stderr
	Level  string // debug/info/warn/error
	Stderr io.Writer
	Fields map[string]string // 固定附加字段，例如 component=agent
}

// New 创建日志器。文件以 0600 追加写入；目录不存在时创建。
func New(opts Options) (*Logger, error) {
	l := &Logger{
		stderr: opts.Stderr,
		level:  parseLevel(opts.Level),
		fields: map[string]string{},
	}
	if l.stderr == nil {
		l.stderr = os.Stderr
	}
	for k, v := range opts.Fields {
		l.fields[k] = v
	}
	if opts.File != "" {
		if err := os.MkdirAll(filepath.Dir(opts.File), 0o700); err != nil {
			return nil, fmt.Errorf("创建日志目录失败: %w", err)
		}
		f, err := os.OpenFile(opts.File, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
		if err != nil {
			return nil, fmt.Errorf("打开日志文件失败: %w", err)
		}
		if err := f.Chmod(0o600); err != nil {
			_ = f.Close()
			return nil, fmt.Errorf("设置日志文件权限失败: %w", err)
		}
		l.file = f
	}
	return l, nil
}

// Discard 返回一个只写 io.Discard 的日志器，供测试使用。
func Discard() *Logger {
	l, _ := New(Options{Stderr: io.Discard, Level: "error"})
	return l
}

// Close 关闭日志文件。
func (l *Logger) Close() error {
	if l == nil {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		err := l.file.Close()
		l.file = nil
		return err
	}
	return nil
}

// With 返回带附加固定字段的子日志器（共享同一输出）。
func (l *Logger) With(kv ...string) *Logger {
	child := &Logger{stderr: l.stderr, level: l.level, fields: map[string]string{}}
	l.mu.Lock()
	child.file = l.file
	for k, v := range l.fields {
		child.fields[k] = v
	}
	l.mu.Unlock()
	for i := 0; i+1 < len(kv); i += 2 {
		child.fields[kv[i]] = kv[i+1]
	}
	return child
}

func (l *Logger) log(lv Level, msg string, kv ...any) {
	if l == nil || lv < l.level {
		return
	}
	rec := make(map[string]any, len(l.fields)+4+len(kv)/2)
	rec["time"] = time.Now().UTC().Format("2006-01-02T15:04:05.000Z07:00")
	rec["level"] = lv.String()
	rec["msg"] = msg
	for k, v := range l.fields {
		rec[k] = v
	}
	for i := 0; i+1 < len(kv); i += 2 {
		key, ok := kv[i].(string)
		if !ok || !safeLogKey(key) {
			continue
		}
		rec[key] = redactValue(key, kv[i+1])
	}
	line, err := json.Marshal(rec)
	if err != nil {
		line = []byte(fmt.Sprintf(`{"time":%q,"level":%q,"msg":%q}`, time.Now().UTC().Format(time.RFC3339), lv.String(), msg))
	}
	line = append(line, '\n')
	l.mu.Lock()
	defer l.mu.Unlock()
	_, _ = l.stderr.Write(line)
	if l.file != nil {
		_, _ = l.file.Write(line)
	}
}

// safeLogKey 拒绝可能携带凭据的字段名，避免误把密码写进日志。
func safeLogKey(key string) bool {
	k := strings.ToLower(key)
	for _, bad := range []string{"password", "secret", "token", "private", "credential", "passwd"} {
		if strings.Contains(k, bad) {
			return false
		}
	}
	return true
}

func redactValue(key string, v any) any {
	if s, ok := v.(string); ok && looksSecret(s) {
		return "<redacted>"
	}
	return v
}

// looksSecret 粗略识别 PEM 私钥 / token 形态，避免日志中出现敏感内容。
func looksSecret(s string) bool {
	if strings.Contains(s, "PRIVATE KEY-----") || strings.Contains(s, "BEGIN CERTIFICATE REQUEST") {
		return true
	}
	return false
}

func (l *Logger) Debug(msg string, kv ...any) { l.log(LevelDebug, msg, kv...) }
func (l *Logger) Info(msg string, kv ...any)  { l.log(LevelInfo, msg, kv...) }
func (l *Logger) Warn(msg string, kv ...any)  { l.log(LevelWarn, msg, kv...) }
func (l *Logger) Error(msg string, kv ...any) { l.log(LevelError, msg, kv...) }
