#!/usr/bin/env bash
# 在 150 上启用 Keycloak OIDC（读取 client secret 文件，更新配置并重启）
# 用法：sudo ./enable-oidc.sh [secret文件] [域名]
set -euo pipefail
SECRET_FILE="${1:-/tmp/backup-center-oidc.secret}"
HOST="${2:-backup.tri.local}"
[[ $(id -u) -eq 0 ]] || { echo "请用 root 执行" >&2; exit 1; }
[[ -s "$SECRET_FILE" ]] || { echo "缺少 client secret 文件：$SECRET_FILE" >&2; exit 2; }
CFG=/etc/backup-center/config.json
cp -a "$CFG" "$CFG.bak-$(date +%Y%m%d-%H%M%S)"
python3 - "$SECRET_FILE" "$HOST" <<'PY'
import json, sys
secret_file, host = sys.argv[1], sys.argv[2]
secret = open(secret_file).read().strip()
p = '/etc/backup-center/config.json'
d = json.load(open(p))
o = d.setdefault('oidc', {})
o.update({
    'enabled': True,
    'issuer': o.get('issuer', 'https://sso.tri.local/realms/tri'),
    'client_id': 'backup-center',
    'client_secret': secret,
    'redirect_uri': f'https://{host}/auth/oidc/callback',
    'post_logout_uri': f'https://{host}/',
    'admin_group': 'Group_Roots',
    'admin_role': 'backup:admin',
    'operator_group': '',
    'ca_file': '/etc/pki/ca-trust/source/anchors/tri-local-enterprise-root-ca.crt',
})
json.dump(d, open(p, 'w'), ensure_ascii=False, indent=2)
print('oidc config updated for', host)
PY
chown root:backup "$CFG"; chmod 0640 "$CFG"
systemctl restart backup-center
sleep 2
curl -fsS "https://$HOST/healthz" >/dev/null
curl -fsS "https://$HOST/api/auth/config" | python3 -m json.tool
