#!/usr/bin/env bash
# 切换 backup-center 对外域名（更新服务端配置、OIDC 回调与本机代理的 server 地址）。
# 用法：sudo ./switch-hostname.sh <新域名> [期望IP] [--check]
set -euo pipefail
NEW="${1:-}"
EXPECT_IP="${2:-172.16.50.150}"
CHECK=0
[[ "${3:-}" == "--check" || "${2:-}" == "--check" ]] && CHECK=1
[[ -n "$NEW" ]] || { echo "用法: $0 <新域名> [期望IP] [--check]" >&2; exit 2; }
[[ $(id -u) -eq 0 ]] || { echo "请用 root 执行" >&2; exit 1; }

log() { printf '[switch] %s\n' "$*"; }

resolved=$(getent hosts "$NEW" | awk '{print $1}' | head -1 || true)
log "DNS: $NEW -> ${resolved:-未解析}，期望 $EXPECT_IP"
if [[ "$resolved" != "$EXPECT_IP" ]]; then
  echo "错误：$NEW 未指向 $EXPECT_IP。请先修正 DNS（或由 172.16.50.122 反向代理并把 8443 也转发到 $EXPECT_IP:8443）。" >&2
  exit 1
fi

if ! curl -fsS "https://$NEW/healthz" >/dev/null; then
  echo "错误：https://$NEW/healthz 不可用（检查证书/端口/防火墙）" >&2
  exit 1
fi
log "HTTPS 健康检查通过"

if [[ "$CHECK" -eq 1 ]]; then
  log "仅检查模式，未修改配置"
  exit 0
fi

cp -a /etc/backup-center/config.json "/etc/backup-center/config.json.bak-$(date +%Y%m%d-%H%M%S)"
python3 - "$NEW" <<'PY'
import json, sys
host = sys.argv[1]
p = '/etc/backup-center/config.json'
d = json.load(open(p))
d['server']['hostname'] = host
d['server']['public_url'] = f'https://{host}'
d['server']['agent_url'] = f'https://{host}:{d["agent"]["port"]}'
if 'oidc' in d:
    d['oidc']['redirect_uri'] = f'https://{host}/auth/oidc/callback'
    d['oidc']['post_logout_uri'] = f'https://{host}/'
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
print('config updated')
PY
chown root:backup /etc/backup-center/config.json
chmod 0640 /etc/backup-center/config.json
systemctl restart backup-center

# 本机代理如存在，同步 server 地址
if [[ -f /etc/backup-center-agent/config.json ]]; then
  cp -a /etc/backup-center-agent/config.json "/etc/backup-center-agent/config.json.bak-$(date +%Y%m%d-%H%M%S)"
  python3 - "$NEW" <<'PY'
import json, sys
host = sys.argv[1]
p = '/etc/backup-center-agent/config.json'
d = json.load(open(p))
d['server'] = f'https://{host}:8443'
json.dump(d, open(p, 'w'), indent=2)
print('agent config updated')
PY
  chmod 0600 /etc/backup-center-agent/config.json
  systemctl restart backup-center-agent || true
fi

sleep 2
curl -fsS "https://$NEW/healthz" >/dev/null && log "切换完成：https://$NEW"
