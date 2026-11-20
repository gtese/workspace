#!/bin/bash
# 给 iKuai 增加域名：加入指定域名分流规则 + 创建干净 DNS 规则
#
# 依赖环境变量：
#   IKUAI_CLI_BASE_URL  例如 https://192.168.9.1
#   IKUAI_CLI_TOKEN     API token（从本机凭据读取，禁止写入仓库）
#   IKUAI_CLI           可选，ikuai-cli 可执行文件路径，默认 PATH 中查找
#
# 用法：
#   ./ikuai-add-domain.sh <分流规则ID> <域名> [--dns 10.66.66.1|172.16.10.114]
#   例：./ikuai-add-domain.sh 2 example.com
#       ./ikuai-add-domain.sh 5 corp.local --dns 172.16.10.114

set -euo pipefail

RULE_ID="${1:?usage: $0 <rule-id> <domain> [--dns IP]}"
DOMAIN="${2:?usage: $0 <rule-id> <domain> [--dns IP]}"
DNS_ADDR="10.66.66.1"
if [ "${3:-}" = "--dns" ] && [ -n "${4:-}" ]; then DNS_ADDR="$4"; fi

CLI="${IKUAI_CLI:-ikuai-cli}"
: "${IKUAI_CLI_BASE_URL:?请先 export IKUAI_CLI_BASE_URL}"
: "${IKUAI_CLI_TOKEN:?请先 export IKUAI_CLI_TOKEN}"

echo "==> 读取规则 $RULE_ID"
CURRENT=$("$CLI" routing stream domain list --format json \
  | python3 -c "import sys,json;d=json.load(sys.stdin);r=[x for x in d['data'] if str(x['id'])=='$RULE_ID'][0];print(','.join(r['domain'].get('custom',[])))")
IFACE=$("$CLI" routing stream domain list --format json \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print([x for x in d['data'] if str(x['id'])=='$RULE_ID'][0]['interface'])")

case ",$CURRENT," in
  *",$DOMAIN,"*) NEW="$CURRENT" ;;
  *) NEW="${CURRENT:+$CURRENT,}$DOMAIN" ;;
esac

echo "==> 更新规则 $RULE_ID（$IFACE）：追加 $DOMAIN"
"$CLI" routing stream domain update "$RULE_ID" --domain "$NEW" --interface "$IFACE" --enabled yes >/dev/null

echo "==> 创建 DNS 代理规则 → $DNS_ADDR"
for d in "$DOMAIN" "*.$DOMAIN"; do
  "$CLI" network dns proxy create --domain "$d" --dns-addr "$DNS_ADDR" --parse-type proxy >/dev/null 2>&1 \
    && echo "    + $d" || echo "    ! $d 已存在或创建失败"
done

echo "==> 验证解析"
for d in "$DOMAIN" "www.$DOMAIN"; do
  printf "    %-24s " "$d"
  dig +short +time=5 +tries=1 @192.168.9.1 "$d" 2>/dev/null | head -2 | tr '\n' ' '; echo
done
echo "完成。提示：iKuai DNS 规则上限约 255 条，注意余量。"
