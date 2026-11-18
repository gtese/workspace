// Package api 实现 Agent API 客户端（注册、心跳、长轮询、进度、结果、续期）。
package api

import (
	"bytes"
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"tri.local/backup-center/agent/internal/model"
)

// Options 构造客户端参数。
type Options struct {
	BaseURL   string
	CAFile    string
	CertFile  string
	KeyFile   string
	Insecure  bool // 仅本地开发：跳过服务端证书校验
	UserAgent string
	Timeout   time.Duration // 普通请求超时；长轮询由调用方 context 控制
}

// Client 是 Agent API 客户端。
type Client struct {
	base      *url.URL
	http      *http.Client
	userAgent string
	insecure  bool
}

// APIError 表示服务端返回的结构化错误。
type APIError struct {
	StatusCode int
	Code       string
	Message    string
}

func (e *APIError) Error() string {
	if e.Code == "" {
		return fmt.Sprintf("服务端返回 HTTP %d: %s", e.StatusCode, e.Message)
	}
	return fmt.Sprintf("服务端错误 %s (HTTP %d): %s", e.Code, e.StatusCode, e.Message)
}

// Insecure 返回客户端是否处于跳过证书校验的开发模式。
func (c *Client) Insecure() bool { return c.insecure }

// HTTPClient 返回复用本客户端 TLS 配置（CA + mTLS 客户端证书）的 http.Client，
// 供升级包下载等需要更长超时的场景使用。timeout <= 0 时不设总超时。
func (c *Client) HTTPClient(timeout time.Duration) *http.Client {
	return &http.Client{Transport: c.http.Transport, Timeout: timeout}
}

// New 创建客户端。CAFile/CertFile/KeyFile 可为空（注册阶段只需要 CA）。
func New(opts Options) (*Client, error) {
	base, err := url.Parse(strings.TrimRight(strings.TrimSpace(opts.BaseURL), "/"))
	if err != nil || base.Host == "" || (base.Scheme != "http" && base.Scheme != "https") {
		return nil, fmt.Errorf("server URL 无效: %q", opts.BaseURL)
	}
	tlsCfg := &tls.Config{MinVersion: tls.VersionTLS12}
	if opts.Insecure {
		tlsCfg.InsecureSkipVerify = true // #nosec G402 —— 仅开发模式显式开启
	}
	if opts.CAFile != "" {
		pool, err := x509.SystemCertPool()
		if err != nil || pool == nil {
			pool = x509.NewCertPool()
		}
		raw, err := os.ReadFile(opts.CAFile)
		if err != nil {
			return nil, fmt.Errorf("读取 CA 证书失败: %w", err)
		}
		if !pool.AppendCertsFromPEM(raw) {
			return nil, fmt.Errorf("CA 证书中没有可用的 PEM 证书: %s", opts.CAFile)
		}
		tlsCfg.RootCAs = pool
	}
	if opts.CertFile != "" || opts.KeyFile != "" {
		if opts.CertFile == "" || opts.KeyFile == "" {
			return nil, errors.New("cert_file 与 key_file 必须同时提供")
		}
		cert, err := tls.LoadX509KeyPair(opts.CertFile, opts.KeyFile)
		if err != nil {
			return nil, fmt.Errorf("加载客户端证书失败: %w", err)
		}
		tlsCfg.Certificates = []tls.Certificate{cert}
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = 60 * time.Second
	}
	transport := &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: (&net.Dialer{
			Timeout:   10 * time.Second,
			KeepAlive: 30 * time.Second,
		}).DialContext,
		TLSClientConfig:     tlsCfg,
		TLSHandshakeTimeout: 10 * time.Second,
		IdleConnTimeout:     90 * time.Second,
		MaxIdleConns:        10,
	}
	ua := opts.UserAgent
	if ua == "" {
		ua = "backup-center-agent"
	}
	return &Client{
		base:      base,
		http:      &http.Client{Transport: transport, Timeout: timeout},
		userAgent: ua,
		insecure:  opts.Insecure,
	}, nil
}

func (c *Client) urlFor(path string, query url.Values) string {
	u := *c.base
	u.Path = strings.TrimRight(u.Path, "/") + path
	if query != nil {
		u.RawQuery = query.Encode()
	}
	return u.String()
}

// do 发送请求，out 可为 nil；返回原始响应体（调用方负责解码）。
func (c *Client) do(ctx context.Context, method, path string, query url.Values, body any, headers map[string]string) ([]byte, int, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, 0, fmt.Errorf("编码请求失败: %w", err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.urlFor(path, query), reader)
	if err != nil {
		return nil, 0, fmt.Errorf("构造请求失败: %w", err)
	}
	req.Header.Set("User-Agent", c.userAgent)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	} else {
		req.Header.Set("Accept", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := c.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return nil, 0, ctxErr
		}
		return nil, 0, fmt.Errorf("请求 %s 失败: %w", path, err)
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 32<<20))
	if err != nil {
		return nil, resp.StatusCode, fmt.Errorf("读取响应失败: %w", err)
	}
	if resp.StatusCode >= 400 {
		apiErr := &APIError{StatusCode: resp.StatusCode, Message: strings.TrimSpace(string(raw))}
		var body struct {
			Error struct {
				Code    string `json:"code"`
				Message string `json:"message"`
			} `json:"error"`
		}
		if json.Unmarshal(raw, &body) == nil && (body.Error.Code != "" || body.Error.Message != "") {
			apiErr.Code = body.Error.Code
			apiErr.Message = body.Error.Message
		}
		return raw, resp.StatusCode, apiErr
	}
	return raw, resp.StatusCode, nil
}

// Enroll 提交注册请求（一次性 token）。
func (c *Client) Enroll(ctx context.Context, req model.EnrollRequest) (*model.EnrollCreated, error) {
	raw, status, err := c.do(ctx, http.MethodPost, "/api/enroll", nil, req, nil)
	if err != nil {
		return nil, err
	}
	if status != http.StatusOK && status != http.StatusCreated && status != http.StatusAccepted {
		return nil, fmt.Errorf("注册请求返回意外状态码: %d", status)
	}
	var out model.EnrollCreated
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("解析注册响应失败: %w", err)
	}
	if out.RequestID == "" || out.EnrollSecret == "" {
		return nil, errors.New("注册响应缺少 request_id 或 enroll_secret")
	}
	if out.PollAfterSeconds <= 0 {
		out.PollAfterSeconds = 10
	}
	return &out, nil
}

// EnrollStatus 轮询审批状态。pending 返回 (status, nil, nil)；approved/rejected 返回对应结构。
func (c *Client) EnrollStatus(ctx context.Context, requestID, secret string) (*model.EnrollStatus, int, error) {
	raw, code, err := c.do(ctx, http.MethodGet, "/api/enroll/"+url.PathEscape(requestID), nil, nil,
		map[string]string{"x-enroll-secret": secret})
	if err != nil {
		// 410 表示被拒绝，响应体仍带 {"status":"rejected"}，需要解析出来。
		if code == http.StatusGone {
			var rejected model.EnrollStatus
			if json.Unmarshal(raw, &rejected) == nil {
				return &rejected, code, nil
			}
		}
		return nil, code, err
	}
	var out model.EnrollStatus
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, code, fmt.Errorf("解析审批响应失败: %w", err)
	}
	return &out, code, nil
}

// Heartbeat 发送心跳，返回下一次建议间隔。
func (c *Client) Heartbeat(ctx context.Context, hb model.Heartbeat) (*model.HeartbeatResponse, error) {
	raw, _, err := c.do(ctx, http.MethodPost, "/api/agent/heartbeat", nil, hb, nil)
	if err != nil {
		return nil, err
	}
	var out model.HeartbeatResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("解析心跳响应失败: %w", err)
	}
	return &out, nil
}

// Tasks 长轮询任务。waitSeconds 由服务端限制在合理范围。
func (c *Client) Tasks(ctx context.Context, waitSeconds int) ([]model.Task, error) {
	if waitSeconds <= 0 {
		waitSeconds = 25
	}
	q := url.Values{}
	q.Set("wait", strconv.Itoa(waitSeconds))
	raw, code, err := c.do(ctx, http.MethodGet, "/api/agent/tasks", q, nil, nil)
	if err != nil {
		return nil, err
	}
	if code == http.StatusNoContent {
		return nil, nil
	}
	return model.ParseTasks(raw)
}

// Progress 上报任务进度（调用方负责 ≤1 次/秒 节流）。
func (c *Client) Progress(ctx context.Context, taskID string, p model.Progress) error {
	_, _, err := c.do(ctx, http.MethodPost, "/api/agent/tasks/"+url.PathEscape(taskID)+"/progress", nil, p, nil)
	return err
}

// Result 回传任务结果。
func (c *Client) Result(ctx context.Context, taskID string, r model.Result) error {
	_, _, err := c.do(ctx, http.MethodPost, "/api/agent/tasks/"+url.PathEscape(taskID)+"/result", nil, r, nil)
	return err
}

// Renew 提交证书续期 CSR，返回新证书。
func (c *Client) Renew(ctx context.Context, csrPEM []byte) ([]byte, error) {
	raw, _, err := c.do(ctx, http.MethodPost, "/api/agent/renew", nil, model.RenewRequest{CSRPEM: string(csrPEM)}, nil)
	if err != nil {
		return nil, err
	}
	var out model.RenewResponse
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("解析续期响应失败: %w", err)
	}
	if strings.TrimSpace(out.CertPEM) == "" {
		return nil, errors.New("续期响应缺少 cert_pem")
	}
	return []byte(out.CertPEM), nil
}
