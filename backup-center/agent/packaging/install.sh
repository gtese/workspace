#!/usr/bin/env bash
# backup-center 代理安装脚本（Linux systemd / macOS launchd）。
# 用法示例（root 执行）：
#   sudo ./install.sh --server http://127.0.0.1:9444 --token <一次性token> --insecure
#   sudo ./install.sh --server https://backup.tri.local:8443 --token <token> --binary ./backup-agent
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
INSTALL_DIR="/opt/backup-center-agent"
BIN_DIR="$INSTALL_DIR/bin"
AGENT_BIN="$BIN_DIR/backup-agent"
RESTIC_BIN="$BIN_DIR/restic"
VERSION="${BC_AGENT_VERSION:-0.1.0}"
RESTIC_VERSION="${RESTIC_VERSION:-0.18.0}"

SERVER=""
TOKEN=""
INSECURE=0
BINARY=""
SHA256=""
DOWNLOAD_URL=""
DOWNLOAD_BASE=""
RESTIC_BASE=""
RESTIC_SRC=""
RESTIC_URL=""
RESTIC_SHA256=""
SKIP_RESTIC=0
NO_START=0
NO_ENROLL=0

log() { printf '[install] %s\n' "$*"; }
die() { printf '[install] 错误: %s\n' "$*" >&2; exit 1; }

sha256_check() {
    local expected="$1" file="$2"
    [[ -n "$expected" ]] || return 0
    if command -v sha256sum >/dev/null 2>&1; then
        echo "$expected  $file" | sha256sum -c - >/dev/null
    else
        echo "$expected  $file" | shasum -a 256 -c - >/dev/null
    fi
}

usage() {
    sed -n '2,5p' "$0"
    cat <<'EOF'

选项:
  --server URL        服务端地址（https://<host>:8443，开发模式 http://127.0.0.1:9444）
  --token TOKEN       一次性注册 token
  --version VERSION   代理版本（默认 0.1.0，也可用 BC_AGENT_VERSION）
  --binary PATH       本地代理二进制（默认尝试 deploy/bin/agent/<os>-<arch>/backup-agent）
  --sha256 HEX        代理二进制 sha256（与 --binary/--download-url 配合）
  --download-url URL  代理二进制下载地址（优先级最高）
  --download-base URL 代理二进制分发根（默认从 --server 推断：8443→443、9444→9443，路径 /agent/dist）
  --insecure          仅本地开发：跳过 TLS 证书校验
  --restic-src PATH   本地 restic 二进制路径
  --restic-url URL    自定义 restic 下载地址（默认官方 GitHub release）
  --restic-sha256 HEX restic 压缩包 sha256（可选）
  --skip-restic       不安装 restic（需自行保证 /opt/backup-center-agent/bin/restic）
  --no-enroll         只安装二进制与服务定义，不执行注册
  --no-start          安装但不启动服务
  -h, --help          显示帮助
EOF
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --server) SERVER="${2:-}"; shift 2 ;;
        --token) TOKEN="${2:-}"; shift 2 ;;
        --version) VERSION="${2:-}"; shift 2 ;;
        --binary) BINARY="${2:-}"; shift 2 ;;
        --sha256) SHA256="${2:-}"; shift 2 ;;
        --download-url) DOWNLOAD_URL="${2:-}"; shift 2 ;;
        --download-base) DOWNLOAD_BASE="${2:-}"; shift 2 ;;
        --restic-base) RESTIC_BASE="${2:-}"; shift 2 ;;
        --insecure) INSECURE=1; shift ;;
        --restic-src) RESTIC_SRC="${2:-}"; shift 2 ;;
        --restic-url) RESTIC_URL="${2:-}"; shift 2 ;;
        --restic-sha256) RESTIC_SHA256="${2:-}"; shift 2 ;;
        --skip-restic) SKIP_RESTIC=1; shift ;;
        --no-enroll) NO_ENROLL=1; shift ;;
        --no-start) NO_START=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) die "未知参数: $1（--help 查看帮助）" ;;
    esac
done

[[ "$(id -u)" -eq 0 ]] || die "请使用 root 或 sudo 执行"

case "$(uname -s)" in
    Linux) OS=linux ;;
    Darwin) OS=darwin ;;
    *) die "不支持的操作系统: $(uname -s)" ;;
esac
case "$(uname -m)" in
    x86_64|amd64) ARCH=amd64 ;;
    arm64|aarch64) ARCH=arm64 ;;
    *) die "不支持的架构: $(uname -m)" ;;
esac

# 由 --server 推导 Web 根地址（8443/9444 -> 443/9443）
web_base() {
    local wb="${SERVER%/}"
    wb="${wb/:8443/:443}"
    wb="${wb/:9444/:9443}"
    printf '%s' "$wb"
}

# 目标机未信任企业根 CA 时，自动下载并安装（后续下载/注册均走正常 TLS 校验）
ensure_ca() {
    [[ "$INSECURE" == "1" ]] && { log "已指定 --insecure，跳过 CA 安装"; return 0; }
    [[ -n "$SERVER" ]] || return 0
    local web; web="$(web_base)"
    if curl -fsS --max-time 8 "${web}/healthz" >/dev/null 2>&1; then
        log "企业根 CA 已受信任"
        return 0
    fi
    log "目标机未信任企业根 CA，尝试自动安装（仅首次）"
    local tmp; tmp="$(mktemp)"
    if ! curl -kfsSL --max-time 20 "${web}/agent/ca.crt" -o "$tmp"; then
        rm -f "$tmp"; die "下载企业根 CA 失败：${web}/agent/ca.crt"
    fi
    if [[ "$OS" == "linux" ]]; then
        if command -v update-ca-trust >/dev/null 2>&1; then
            install -m 0644 "$tmp" /etc/pki/ca-trust/source/anchors/tri-local-enterprise-root-ca.crt
            update-ca-trust extract
        elif command -v update-ca-certificates >/dev/null 2>&1; then
            install -m 0644 "$tmp" /usr/local/share/ca-certificates/tri-local-enterprise-root-ca.crt
            update-ca-certificates
        else
            rm -f "$tmp"; die "未找到 CA 信任工具（update-ca-trust / update-ca-certificates）"
        fi
    elif [[ "$OS" == "darwin" ]]; then
        security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain "$tmp" || { rm -f "$tmp"; die "macOS 安装 CA 失败"; }
    fi
    rm -f "$tmp"
    curl -fsS --max-time 8 "${web}/healthz" >/dev/null 2>&1 || die "CA 安装后仍无法验证 ${web}/healthz"
    log "企业根 CA 安装完成"
}
if [[ "$OS" == "darwin" ]]; then
    CONFIG_PATH="/Library/Application Support/backup-center-agent/config.json"
    LOG_PATH="/Library/Logs/backup-center-agent.log"
else
    CONFIG_PATH="/etc/backup-center-agent/config.json"
    LOG_PATH="/var/log/backup-center-agent.log"
fi

# 1. 安装 restic
install_restic() {
    if [[ -x "$RESTIC_BIN" ]]; then
        if [[ "$("$RESTIC_BIN" version 2>/dev/null | awk '{print $2}')" == "$RESTIC_VERSION" ]]; then
            log "restic 已安装: $RESTIC_BIN"
            return
        fi
    fi
    if [[ "$SKIP_RESTIC" == "1" ]]; then
        log "跳过 restic 安装（--skip-restic）"
        return
    fi
    mkdir -p "$BIN_DIR"
    if [[ -n "$RESTIC_SRC" ]]; then
        [[ -f "$RESTIC_SRC" ]] || die "restic 源文件不存在: $RESTIC_SRC"
        install -m 0755 "$RESTIC_SRC" "$RESTIC_BIN"
        log "已安装本地 restic: $RESTIC_BIN"
        return
    fi
    local url="$RESTIC_URL" tmp
    if [[ -z "$RESTIC_BASE" && -n "$SERVER" ]]; then
        local wb="${SERVER%/}"
        wb="${wb/:8443/:443}"
        wb="${wb/:9444/:9443}"
        RESTIC_BASE="${wb}/agent/dist/restic"
    fi
    if [[ -z "$url" && -n "$RESTIC_BASE" ]]; then
        url="${RESTIC_BASE%/}/${OS}/${ARCH}/restic"
    fi
    if [[ -z "$url" ]]; then
        local asset
        asset="restic_${RESTIC_VERSION}_${OS}_${ARCH}.bz2"
        url="https://github.com/restic/restic/releases/download/v${RESTIC_VERSION}/${asset}"
    fi
    tmp="$(mktemp -d)"
    log "下载 restic: $url"
    if ! curl -fL --retry 3 --connect-timeout 20 -o "$tmp/restic.bz2" "$url"; then
        die "restic 下载失败；请使用 --restic-src 指定本地文件，或 --skip-restic 跳过"
    fi
    if ! sha256_check "$RESTIC_SHA256" "$tmp/restic.bz2"; then
        rm -rf "$tmp"
        die "restic sha256 校验失败"
    fi
    if [[ "$url" == *.bz2 ]]; then
        bzip2 -dc "$tmp/restic.bz2" > "$tmp/restic"
    else
        cp "$tmp/restic.bz2" "$tmp/restic"
    fi
    install -m 0755 "$tmp/restic" "$RESTIC_BIN"
    rm -rf "$tmp"
    log "已安装 restic: $RESTIC_BIN"
}

# 2. 准备代理二进制
prepare_agent_binary() {
    local src="" tmp
    if [[ -n "$BINARY" ]]; then
        [[ -f "$BINARY" ]] || die "代理二进制不存在: $BINARY"
        src="$BINARY"
    elif [[ -f "$ROOT_DIR/deploy/bin/agent/${OS}-${ARCH}/backup-agent" ]]; then
        src="$ROOT_DIR/deploy/bin/agent/${OS}-${ARCH}/backup-agent"
    else
        local url="$DOWNLOAD_URL"
        if [[ -z "$url" ]]; then
            local base="${DOWNLOAD_BASE:-}"
            if [[ -z "$base" && -n "$SERVER" ]]; then
                base="${SERVER%/}"
                base="${base/:8443/:443}"
                base="${base/:9444/:9443}"
                base="${base}/agent/dist"
            fi
            [[ -n "$base" ]] && url="${base%/}/agent/${VERSION}/${OS}/${ARCH}/backup-agent"
        fi
        [[ -n "$url" ]] || die "未找到代理二进制：请用 --binary 指定，或提供 --server/--download-url"
        tmp="$(mktemp)"
        log "下载代理二进制: $url"
        local curl_args=(-fL --retry 3 --connect-timeout 20)
        [[ "$INSECURE" == "1" ]] && curl_args+=(-k)
        curl "${curl_args[@]}" -o "$tmp" "$url" || { rm -f "$tmp"; die "代理二进制下载失败"; }
        if ! sha256_check "$SHA256" "$tmp"; then
            rm -f "$tmp"
            die "代理二进制 sha256 校验失败"
        fi
        src="$tmp"
    fi
    sha256_check "$SHA256" "$src" || die "代理二进制 sha256 校验失败"
    mkdir -p "$BIN_DIR"
    install -m 0755 "$src" "$AGENT_BIN"
    if [[ -n "${tmp:-}" ]]; then rm -f "$tmp"; fi
    log "已安装代理: $AGENT_BIN"
}

# 3. 写服务定义
install_agent() {
    "$AGENT_BIN" install --config "$CONFIG_PATH"
}

# 4. 注册
enroll_agent() {
    if [[ "$NO_ENROLL" == "1" ]]; then
        log "跳过注册（--no-enroll）"
        return
    fi
    [[ -n "$SERVER" ]] || die "缺少 --server"
    [[ -n "$TOKEN" ]] || die "缺少 --token"
    local args=(enroll --server "$SERVER" --token "$TOKEN" --config "$CONFIG_PATH")
    [[ "$INSECURE" == "1" ]] && args+=(--insecure)
    "$AGENT_BIN" "${args[@]}"
}

# 5. 启动
start_agent() {
    if [[ "$NO_START" == "1" ]]; then
        log "已跳过启动；稍后可执行: systemctl enable --now backup-center-agent.service"
        return
    fi
    "$AGENT_BIN" install --start --config "$CONFIG_PATH"
    sleep 2
    if [[ "$OS" == "linux" ]]; then
        systemctl --no-pager --lines=0 status backup-center-agent.service || true
    else
        launchctl print "system/tri.backup.agent" >/dev/null 2>&1 && log "launchd 服务已加载" || true
    fi
}

ensure_ca
install_restic
prepare_agent_binary
install_agent
enroll_agent
start_agent

log "安装完成"
log "配置文件: $CONFIG_PATH"
log "日志文件: $LOG_PATH"
log "下一步: sudo $AGENT_BIN doctor"
