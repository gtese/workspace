// backup-agent 是 backup-center 的备份代理命令行入口。
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"tri.local/backup-center/agent/internal/agent"
	"tri.local/backup-center/agent/internal/config"
	"tri.local/backup-center/agent/internal/install"
	"tri.local/backup-center/agent/internal/logging"
)

// version 由构建脚本通过 -ldflags "-X main.version=..." 注入。
var version = "dev"

func usage() {
	fmt.Fprintf(os.Stderr, `backup-center agent %s

用法: backup-agent <command> [flags]

命令:
  install    安装二进制与服务定义（systemd / launchd，需要 root）
  enroll     生成密钥与 CSR，提交注册并等待审批
  run        运行守护进程（心跳 + 任务长轮询）
  status     查看本地配置、证书与服务状态
  uninstall  停止并移除服务（--purge 同时删除配置与二进制）
  doctor     本机自检（配置/证书/restic/连通性）
  version    打印版本

示例:
  backup-agent enroll --server https://backup.tri.local:8443 --token <一次性token> [--insecure]
  backup-agent run --config %s
  backup-agent doctor
`, version, config.DefaultPaths().Config)
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	var err error
	switch os.Args[1] {
	case "install":
		err = cmdInstall(os.Args[2:])
	case "enroll":
		err = cmdEnroll(os.Args[2:])
	case "run":
		err = cmdRun(os.Args[2:])
	case "status":
		err = cmdStatus(os.Args[2:])
	case "uninstall":
		err = cmdUninstall(os.Args[2:])
	case "doctor":
		err = cmdDoctor(os.Args[2:])
	case "version", "--version", "-v":
		fmt.Printf("backup-agent %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
		return
	case "help", "-h", "--help":
		usage()
		return
	default:
		fmt.Fprintf(os.Stderr, "未知命令: %s\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
	if errors.Is(err, flag.ErrHelp) {
		return
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "backup-agent: %v\n", err)
		os.Exit(1)
	}
}

func cmdInstall(args []string) error {
	fs := flag.NewFlagSet("install", flag.ContinueOnError)
	configPath := fs.String("config", config.DefaultPaths().Config, "配置文件路径（决定配置目录）")
	selfPath := fs.String("self", "", "待安装的二进制路径（默认当前可执行文件）")
	resticSrc := fs.String("restic-src", "", "本地 restic 二进制路径（可选，安装到 /opt/backup-center-agent/bin/restic）")
	start := fs.Bool("start", false, "安装后立即启动服务")
	if err := fs.Parse(args); err != nil {
		return err
	}
	paths := config.DefaultPaths()
	if *configPath != "" {
		paths = config.WithDir(filepath.Dir(*configPath))
	}
	if err := install.Install(context.Background(), install.Options{
		Paths:      paths,
		SelfPath:   *selfPath,
		ConfigPath: *configPath,
		ResticSrc:  *resticSrc,
		Start:      *start,
	}); err != nil {
		return err
	}
	fmt.Printf("已安装 %s\n", paths.Binary)
	fmt.Printf("服务定义已写入；下一步执行 enroll 注册本机。\n")
	return nil
}

func cmdEnroll(args []string) error {
	fs := flag.NewFlagSet("enroll", flag.ContinueOnError)
	server := fs.String("server", "", "服务端地址，例如 https://backup.tri.local:8443")
	token := fs.String("token", "", "一次性注册 token")
	hostname := fs.String("hostname", "", "主机名（默认取系统 hostname）")
	caFile := fs.String("ca-file", "", "初始信任的 CA 证书路径（可选）")
	configPath := fs.String("config", config.DefaultPaths().Config, "配置文件落盘路径")
	insecure := fs.Bool("insecure", false, "仅本地开发：跳过服务端证书校验")
	logLevel := fs.String("log-level", "info", "日志级别 debug/info/warn/error")
	pollTimeout := fs.Duration("poll-timeout", 20*time.Minute, "等待审批的最长时间")
	if err := fs.Parse(args); err != nil {
		return err
	}
	log, err := logging.New(logging.Options{Stderr: os.Stderr, Level: *logLevel})
	if err != nil {
		return err
	}
	defer log.Close()

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	cfg, err := agent.Enroll(ctx, agent.EnrollOptions{
		Server:       *server,
		Token:        *token,
		Hostname:     *hostname,
		CAFile:       *caFile,
		ConfigPath:   *configPath,
		Insecure:     *insecure,
		AgentVersion: version,
		PollTimeout:  *pollTimeout,
	}, log)
	if err != nil {
		return err
	}
	fmt.Printf("注册成功\n  client_id: %s\n  配置文件: %s\n  证书: %s\n", cfg.ClientID, *configPath, cfg.CertFile)
	if *insecure {
		fmt.Println("警告: 本次注册使用了 --insecure（跳过证书校验），仅限本地开发。")
	}
	fmt.Println("下一步: 启动服务（systemctl restart backup-center-agent / launchctl kickstart -k system/tri.backup.agent）")
	return nil
}

func cmdRun(args []string) error {
	fs := flag.NewFlagSet("run", flag.ContinueOnError)
	configPath := fs.String("config", config.DefaultPaths().Config, "配置文件路径")
	logLevel := fs.String("log-level", "info", "日志级别 debug/info/warn/error")
	insecure := fs.Bool("insecure", false, "仅本地开发：跳过服务端证书校验")
	if err := fs.Parse(args); err != nil {
		return err
	}
	cfg, err := config.Load(*configPath)
	if err != nil {
		return err
	}
	log, err := logging.New(logging.Options{
		File:  cfg.LogFile,
		Level: *logLevel,
		Fields: map[string]string{
			"component": "agent",
			"client_id": cfg.ClientID,
		},
	})
	if err != nil {
		return err
	}
	defer log.Close()

	runner, err := agent.NewWithInsecure(cfg, log, version, *insecure)
	if err != nil {
		return err
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Info("收到启动指令")
	return runner.Run(ctx)
}

func cmdStatus(args []string) error {
	fs := flag.NewFlagSet("status", flag.ContinueOnError)
	configPath := fs.String("config", config.DefaultPaths().Config, "配置文件路径")
	asJSON := fs.Bool("json", false, "以 JSON 输出")
	if err := fs.Parse(args); err != nil {
		return err
	}
	rep := install.Status(context.Background(), *configPath, version)
	if *asJSON {
		raw, err := json.MarshalIndent(rep, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(raw))
		return nil
	}
	fmt.Printf("配置:    %s\n", rep.ConfigPath)
	if rep.ConfigOK {
		fmt.Printf("客户端:  %s\n服务端:  %s\n", rep.ClientID, rep.Server)
		fmt.Printf("证书:    %s（剩余 %d 天）\n", rep.CertExpiresAt, rep.CertDaysLeft)
		fmt.Printf("restic:  %s %s\n", rep.ResticBinary, rep.ResticVersion)
	} else {
		fmt.Printf("配置无效: %s\n", rep.ConfigError)
	}
	serviceState := "未运行"
	if rep.ServiceActive {
		serviceState = "运行中"
	}
	fmt.Printf("服务:    %s（%s）\n", serviceState, rep.ServiceState)
	fmt.Printf("版本:    %s\n", rep.AgentVersion)
	return nil
}

func cmdUninstall(args []string) error {
	fs := flag.NewFlagSet("uninstall", flag.ContinueOnError)
	configPath := fs.String("config", config.DefaultPaths().Config, "配置文件路径")
	purge := fs.Bool("purge", false, "同时删除配置、缓存、日志与二进制")
	yes := fs.Bool("yes", false, "确认执行")
	if err := fs.Parse(args); err != nil {
		return err
	}
	if *purge && !*yes {
		return fmt.Errorf("--purge 会删除配置与数据目录，请同时加 --yes 确认")
	}
	paths := config.DefaultPaths()
	if *configPath != "" {
		paths = config.WithDir(filepath.Dir(*configPath))
	}
	if err := install.Uninstall(context.Background(), install.Options{Paths: paths, Purge: *purge, ConfigPath: *configPath}); err != nil {
		return err
	}
	fmt.Println("已停止并移除 backup-center agent 服务。")
	if *purge {
		fmt.Println("已清除配置、缓存、日志与二进制。")
	}
	return nil
}

func cmdDoctor(args []string) error {
	fs := flag.NewFlagSet("doctor", flag.ContinueOnError)
	configPath := fs.String("config", config.DefaultPaths().Config, "配置文件路径")
	asJSON := fs.Bool("json", false, "以 JSON 输出")
	if err := fs.Parse(args); err != nil {
		return err
	}
	checks := install.Doctor(context.Background(), *configPath, version)
	if *asJSON {
		raw, err := json.MarshalIndent(checks, "", "  ")
		if err != nil {
			return err
		}
		fmt.Println(string(raw))
	} else {
		failed := 0
		for _, c := range checks {
			status := "OK"
			if !c.OK {
				status = "FAIL"
				failed++
			}
			fmt.Printf("[%-4s] %-14s %s\n", status, c.Name, c.Detail)
		}
		if failed > 0 {
			return fmt.Errorf("自检未通过：%d 项失败", failed)
		}
		fmt.Println("自检通过。")
		return nil
	}
	for _, c := range checks {
		if !c.OK {
			return fmt.Errorf("自检未通过")
		}
	}
	return nil
}
