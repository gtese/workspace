#!/usr/bin/env bash
# backup-center 代理卸载脚本。
#   sudo ./uninstall.sh            # 停止并移除服务，保留配置与二进制
#   sudo ./uninstall.sh --purge    # 同时删除配置、缓存、日志与二进制
set -euo pipefail

AGENT_BIN="/opt/backup-center-agent/bin/backup-agent"
PURGE=0
YES=0

log() { printf '[uninstall] %s\n' "$*"; }
die() { printf '[uninstall] 错误: %s\n' "$*" >&2; exit 1; }

while [[ $# -gt 0 ]]; do
    case "$1" in
        --purge) PURGE=1; shift ;;
        --yes) YES=1; shift ;;
        -h|--help)
            sed -n '2,4p' "$0"
            printf '\n选项:\n  --purge  同时删除配置、缓存、日志与二进制（需 --yes 确认）\n  --yes    确认执行\n'
            exit 0
            ;;
        *) die "未知参数: $1" ;;
    esac
done

[[ "$(id -u)" -eq 0 ]] || die "请使用 root 或 sudo 执行"
if [[ "$PURGE" == "1" && "$YES" != "1" ]]; then
    die "--purge 会删除配置与数据目录，请同时加 --yes 确认"
fi

if [[ -x "$AGENT_BIN" ]]; then
    args=(uninstall)
    if [[ "$PURGE" == "1" ]]; then
        args+=(--purge --yes)
    fi
    "$AGENT_BIN" "${args[@]}" || true
fi

# 兜底清理服务定义（二进制不存在或 uninstall 失败时）。
case "$(uname -s)" in
    Linux)
        systemctl stop backup-center-agent.service 2>/dev/null || true
        systemctl disable backup-center-agent.service 2>/dev/null || true
        rm -f /etc/systemd/system/backup-center-agent.service
        systemctl daemon-reload 2>/dev/null || true
        ;;
    Darwin)
        launchctl bootout system/tri.backup.agent 2>/dev/null || true
        launchctl unload -w /Library/LaunchDaemons/tri.backup.agent.plist 2>/dev/null || true
        rm -f /Library/LaunchDaemons/tri.backup.agent.plist
        ;;
    *)
        die "不支持的操作系统: $(uname -s)"
        ;;
esac

if [[ "$PURGE" == "1" ]]; then
    rm -rf /opt/backup-center-agent
    rm -rf "/etc/backup-center-agent"
    rm -rf "/var/cache/backup-center-agent"
    rm -f "/var/log/backup-center-agent.log"
    rm -rf "/Library/Application Support/backup-center-agent"
    rm -rf "/Library/Caches/backup-center-agent"
    rm -f "/Library/Logs/backup-center-agent.log"
    log "已删除配置、缓存、日志与二进制"
fi
log "卸载完成"
