// backup-mountd：特权挂载助手（root 运行，Unix socket，JSON 行协议）。
// 仅接受白名单操作：为备份存储库准备/移除 NFS、CIFS、FTP(rclone) 挂载点。
package main

import (
	"bufio"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"regexp"
	"strings"
	"sync"
)

type Config struct {
	Type     string `json:"type"`
	Server   string `json:"server"`
	Export   string `json:"export"`
	Options  string `json:"options"`
	Share    string `json:"share"`
	Username string `json:"username"`
	Password string `json:"password"`
	Domain   string `json:"domain"`
	Vers     string `json:"vers"`
	Host     string `json:"host"`
	Port     int    `json:"port"`
	TLS      bool   `json:"tls"`
	Dir      string `json:"dir"`
	Path     string `json:"path"`
}

type Request struct {
	Op         string `json:"op"`
	RepoID     string `json:"repo_id"`
	Type       string `json:"type"`
	Config     Config `json:"config"`
	Mountpoint string `json:"mountpoint"`
}

type Response struct {
	OK         bool   `json:"ok"`
	Mountpoint string `json:"mountpoint,omitempty"`
	Error      string `json:"error,omitempty"`
}

var (
	socketPath  = flag.String("socket", "/run/backup-center/mountd.sock", "Unix socket 路径")
	storageRoot = flag.String("storage-root", "/mnt/backup-center", "挂载根目录")
	backupUser  = flag.String("backup-user", "backup", "备份服务用户")
	unitDir     = flag.String("unit-dir", "/etc/systemd/system", "systemd unit 目录")
	stateDir    = flag.String("state-dir", "/etc/backup-center/storage", "凭据与 rclone 配置目录")
	repoIDRe    = regexp.MustCompile(`^[a-z0-9_]{3,64}$`)
	safeRe      = regexp.MustCompile(`^[A-Za-z0-9._:/@-]{1,256}$`)
	mu          sync.Mutex
)

func fail(msg string) Response { return Response{OK: false, Error: msg} }

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%s %v: %v: %s", name, args, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func writeFile0400(path, content string) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, []byte(content), 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func validateRepo(req Request) (string, error) {
	if !repoIDRe.MatchString(req.RepoID) {
		return "", fmt.Errorf("repo_id 非法")
	}
	mountpoint := filepath.Join(*storageRoot, req.RepoID)
	if req.Mountpoint != "" && req.Mountpoint != mountpoint {
		return "", fmt.Errorf("mountpoint 与 repo_id 不匹配")
	}
	return mountpoint, nil
}

func safeOpt(s string) error {
	if s == "" {
		return nil
	}
	if !safeRe.MatchString(s) {
		return fmt.Errorf("参数包含非法字符: %s", s)
	}
	return nil
}

func ensureLocal(mountpoint string) Response {
	if err := os.MkdirAll(mountpoint, 0o700); err != nil {
		return fail(err.Error())
	}
	return Response{OK: true, Mountpoint: mountpoint}
}

func ensureNFS(req Request, mountpoint string) Response {
	c := req.Config
	if err := safeOpt(c.Server); err != nil { return fail(err.Error()) }
	if err := safeOpt(c.Export); err != nil { return fail(err.Error()) }
	opts := c.Options
	if opts == "" { opts = "rw,hard,vers=4.1,_netdev" }
	if err := os.MkdirAll(mountpoint, 0o700); err != nil { return fail(err.Error()) }
	unit := fmt.Sprintf("backup-mount-%s.mount", req.RepoID)
	content := fmt.Sprintf(`[Unit]
Description=backup-center NFS storage %s
After=network-online.target
Wants=network-online.target

[Mount]
What=%s:%s
Where=%s
Type=nfs
Options=%s

[Install]
WantedBy=multi-user.target
`, req.RepoID, c.Server, c.Export, mountpoint, opts)
	if err := os.MkdirAll(*unitDir, 0o755); err != nil { return fail(err.Error()) }
	if err := writeFile0400(filepath.Join(*unitDir, unit), content); err != nil { return fail(err.Error()) }
	if err := run("systemctl", "daemon-reload"); err != nil { return fail(err.Error()) }
	if err := run("systemctl", "enable", "--now", unit); err != nil { return fail(err.Error()) }
	return Response{OK: true, Mountpoint: mountpoint}
}

func ensureCIFS(req Request, mountpoint string) Response {
	c := req.Config
	if err := safeOpt(c.Server); err != nil { return fail(err.Error()) }
	if err := safeOpt(c.Share); err != nil { return fail(err.Error()) }
	if c.Password == "" { return fail("CIFS 需要密码") }
	credFile := filepath.Join(*stateDir, req.RepoID+".cred")
	cred := fmt.Sprintf("username=%s\npassword=%s\n", c.Username, c.Password)
	if c.Domain != "" { cred = fmt.Sprintf("domain=%s\n%s", c.Domain, cred) }
	if err := writeFile0400(credFile, cred); err != nil { return fail(err.Error()) }
	vers := c.Vers
	if vers == "" { vers = "3.0" }
	opts := fmt.Sprintf("credentials=%s,uid=%s,gid=%s,file_mode=0600,dir_mode=0700,vers=%s,nofail,_netdev", credFile, *backupUser, *backupUser, vers)
	if err := os.MkdirAll(mountpoint, 0o700); err != nil { return fail(err.Error()) }
	unit := fmt.Sprintf("backup-mount-%s.mount", req.RepoID)
	content := fmt.Sprintf(`[Unit]
Description=backup-center CIFS storage %s
After=network-online.target
Wants=network-online.target

[Mount]
What=//%s/%s
Where=%s
Type=cifs
Options=%s

[Install]
WantedBy=multi-user.target
`, req.RepoID, c.Server, c.Share, mountpoint, opts)
	if err := writeFile0400(filepath.Join(*unitDir, unit), content); err != nil { return fail(err.Error()) }
	if err := run("systemctl", "daemon-reload"); err != nil { return fail(err.Error()) }
	if err := run("systemctl", "enable", "--now", unit); err != nil { return fail(err.Error()) }
	return Response{OK: true, Mountpoint: mountpoint}
}

func ensureFTP(req Request, mountpoint string) Response {
	c := req.Config
	if err := safeOpt(c.Host); err != nil { return fail(err.Error()) }
	if c.Port == 0 { c.Port = 21 }
	confFile := filepath.Join(*stateDir, req.RepoID+".rclone.conf")
	// rclone 的 FTP 后端要求密码为 obscure 后的值
	obscured, err := exec.Command("/opt/backup-center/bin/rclone", "obscure", c.Password).Output()
	if err != nil {
		return fail(fmt.Sprintf("rclone obscure 失败: %v", err))
	}
	tlsOpt := "false"
	if c.TLS { tlsOpt = "true" }
	conf := fmt.Sprintf("[ftp]\ntype = ftp\nhost = %s\nport = %d\nuser = %s\npass = %s\ntls = %s\n",
		c.Host, c.Port, c.Username, strings.TrimSpace(string(obscured)), tlsOpt)
	if err := writeFile0400(confFile, conf); err != nil { return fail(err.Error()) }
	remote := strings.TrimSuffix("/"+strings.TrimSpace(c.Dir), "/")
	if remote == "" { remote = "/" }
	if err := os.MkdirAll(mountpoint, 0o700); err != nil { return fail(err.Error()) }
	unit := fmt.Sprintf("backup-mount-%s.service", req.RepoID)
	content := fmt.Sprintf(`[Unit]
Description=backup-center FTP storage %s
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/opt/backup-center/bin/rclone mount --config %s --vfs-cache-mode writes --vfs-cache-max-age 1h --allow-non-empty ftp:%s %s
ExecStop=/bin/umount -l %s
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
`, req.RepoID, confFile, remote, mountpoint, mountpoint)
	if err := writeFile0400(filepath.Join(*unitDir, unit), content); err != nil { return fail(err.Error()) }
	if err := run("systemctl", "daemon-reload"); err != nil { return fail(err.Error()) }
	if err := run("systemctl", "enable", "--now", unit); err != nil { return fail(err.Error()) }
	return Response{OK: true, Mountpoint: mountpoint}
}

func verifyWritable(mountpoint, user string) error {
	probe := filepath.Join(mountpoint, fmt.Sprintf(".probe-%d", os.Getpid()))
	if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
		return fmt.Errorf("目录不可写: %v", err)
	}
	defer os.Remove(probe)
	cmd := exec.Command("runuser", "-u", user, "--", "test", "-w", mountpoint)
	if out, err := cmd.CombinedOutput(); err != nil {
		return fmt.Errorf("备份用户 %s 不可写挂载点: %v %s", user, err, strings.TrimSpace(string(out)))
	}
	return nil
}

func handle(req Request) Response {
	switch req.Op {
	case "ensure":
		mountpoint, err := validateRepo(req)
		if err != nil { return fail(err.Error()) }
		var resp Response
		switch req.Type {
		case "local":
			resp = ensureLocal(mountpoint)
		case "nfs":
			resp = ensureNFS(req, mountpoint)
		case "cifs":
			resp = ensureCIFS(req, mountpoint)
		case "ftp":
			resp = ensureFTP(req, mountpoint)
		default:
			return fail("不支持的存储类型: " + req.Type)
		}
		if !resp.OK { return resp }
		if req.Type != "local" {
			if err := verifyWritable(mountpoint, *backupUser); err != nil { return fail(err.Error()) }
		}
		return resp
	case "status":
		mountpoint, err := validateRepo(req)
		if err != nil { return fail(err.Error()) }
		if _, err := os.Stat(mountpoint); err != nil { return fail("挂载点不存在") }
		return Response{OK: true, Mountpoint: mountpoint}
	case "remove":
		mountpoint, err := validateRepo(req)
		if err != nil { return fail(err.Error()) }
		for _, unit := range []string{
			fmt.Sprintf("backup-mount-%s.mount", req.RepoID),
			fmt.Sprintf("backup-mount-%s.service", req.RepoID),
		} {
			_ = run("systemctl", "disable", "--now", unit)
			_ = os.Remove(filepath.Join(*unitDir, unit))
		}
		_ = run("systemctl", "daemon-reload")
		return Response{OK: true, Mountpoint: mountpoint}
	default:
		return fail("未知操作")
	}
}

func main() {
	flag.Parse()
	_ = os.MkdirAll(filepath.Dir(*socketPath), 0o755)
	_ = os.Remove(*socketPath)
	l, err := net.Listen("unix", *socketPath)
	if err != nil {
		fmt.Fprintln(os.Stderr, "监听 socket 失败:", err)
		os.Exit(1)
	}
	_ = os.Chmod(*socketPath, 0o660)
	if grp, err := user.LookupGroup(*backupUser); err == nil {
		if gid, err := strconv.Atoi(grp.Gid); err == nil {
			_ = os.Chown(*socketPath, 0, gid)
		}
	}
	fmt.Println("backup-mountd 已启动:", *socketPath)
	for {
		conn, err := l.Accept()
		if err != nil { continue }
		go func(c net.Conn) {
			defer c.Close()
			mu.Lock()
			defer mu.Unlock()
			sc := bufio.NewScanner(c)
			sc.Buffer(make([]byte, 0, 64*1024), 1024*1024)
			enc := json.NewEncoder(c)
			for sc.Scan() {
				var req Request
				if err := json.Unmarshal(sc.Bytes(), &req); err != nil {
					_ = enc.Encode(fail("请求 JSON 无效"))
					continue
				}
				_ = enc.Encode(handle(req))
			}
		}(conn)
	}
}
