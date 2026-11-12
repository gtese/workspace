#!/usr/bin/env bash
# 签发 sso.tri.local 专用证书（可选，强烈建议）
#
# 现状：知识平台/工时系统用的是 *.tri.local 通配证书（2048 位 RSA，2028 年到期）。
# 身份平台承担全公司登录，建议独立签发一张：
#   - 私钥 4096 位，不复用通配证书私钥（通配私钥已复制到多台机器）
#   - subjectAltName 只含 sso.tri.local
#   - 有效期短（1~2 年），与通配证书解耦
#
# 流程（需要域控/CA 管理员配合）：
#   1) 本脚本生成私钥 + CSR：
#        ./deploy/scripts/issue-sso-cert.sh csr
#      产物：deploy/certs/sso.tri.local.key（私钥，勿外传）+ sso.tri.local.csr
#   2) 把 CSR 交给 CA 管理员，用「企业根 CA 下的服务器证书模板」签发，
#      得到 sso.tri.local.crt（含中间证书的 fullchain）。
#   3) 安装：
#        ./deploy/scripts/issue-sso-cert.sh install /path/to/sso.tri.local.crt
#      会把证书装到 /etc/pki/tls/oidc/ 并让 nginx 使用。
#
# 在拿到专用证书前，deploy.sh 默认使用现有的通配证书（可用但不是最佳实践）。
set -Eeuo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DIR="$ROOT/deploy/certs"
case "${1:-}" in
  csr)
    openssl req -new -newkey rsa:4096 -nodes \
      -keyout "$DIR/sso.tri.local.key" -out "$DIR/sso.tri.local.csr" \
      -subj "/C=CN/ST=Shanghai/L=Shanghai/O=TRI/OU=IT/CN=sso.tri.local" \
      -addext "subjectAltName=DNS:sso.tri.local" \
      -addext "keyUsage=critical,digitalSignature,keyEncipherment" \
      -addext "extendedKeyUsage=serverAuth"
    chmod 600 "$DIR/sso.tri.local.key"
    echo "✓ 已生成：$DIR/sso.tri.local.key / sso.tri.local.csr（把 CSR 交给 CA 管理员）"
    ;;
  install)
    [[ -f "${2:-}" ]] || { echo "用法：$0 install <fullchain.crt>"; exit 1; }
    openssl x509 -in "$2" -noout -subject -ext subjectAltName
    sudo install -m 0644 "$2" /etc/pki/tls/oidc/sso.tri.local.crt
    sudo install -m 0600 "$DIR/sso.tri.local.key" /etc/pki/tls/oidc/sso.tri.local.key
    sudo sed -i 's#/etc/pki/tls/oidc/tri.local.crt#/etc/pki/tls/oidc/sso.tri.local.crt#' \
      /etc/nginx/conf.d/sso.tri.local.conf
    sudo nginx -t && sudo systemctl reload nginx
    echo "✓ 已安装专用证书并重载 nginx"
    ;;
  *) sed -n '2,30p' "$0" ;;
esac
