#!/bin/bash
# 部署/升级后做端到端验证（普通用户身份运行，不需要 sudo）。
# 用法:
#   ./verify.sh                 # 版本 + 一次对话
#   ./verify.sh --tool          # 额外验证工具调用（whoami）
#   ./verify.sh --web           # 额外验证 Web UI 启动与 token 认证
set -uo pipefail

PREFIX="${DSH_PREFIX:-/eda/apps/deepseek}"
FAIL=0
DO_TOOL=0
DO_WEB=0
for arg in "$@"; do
  case "$arg" in
    --tool) DO_TOOL=1 ;;
    --web)  DO_WEB=1 ;;
    *) echo "未知参数: $arg（可用: --tool --web）" >&2; exit 2 ;;
  esac
done

say() { printf '\n== %s\n' "$*"; }
ok() { printf '   OK  %s\n' "$*"; }
bad() { printf '   FAIL %s\n' "$*"; FAIL=1; }

say "版本"
V="$(dsh --version 2>&1)" && ok "dsh --version -> $V" || bad "dsh --version"

say "headless 对话"
OUT="$(timeout 180 dsh --profile headless '你好，请只回复：verify-ok' 2>&1 | tail -3)"
echo "   输出: $OUT"
case "$OUT" in
  *verify-ok*) ok "模型对话正常" ;;
  *) bad "模型对话失败（检查 /etc/dsh.env、Open WebUI、shim）" ;;
esac

if [ "$DO_TOOL" = 1 ]; then
  say "工具调用（whoami）"
  OUT="$(timeout 180 dsh --profile headless '运行 whoami 命令，然后只回复命令的输出' 2>&1 | tail -3)"
  echo "   输出: $OUT"
  case "$OUT" in
    *"$(id -un)"*) ok "bash 工具正常" ;;
    *) bad "工具调用异常" ;;
  esac
fi

if [ "$DO_WEB" = 1 ]; then
  say "Web UI 启动与认证"
  LOG="$(mktemp /tmp/dsh-verify.XXXXXX)"
  timeout 120 dsh >"$LOG" 2>&1 &
  PID=$!
  URL=""
  i=0
  while [ "$i" -lt 60 ]; do
    URL="$(grep -o 'http://127.0.0.1:[0-9]*/?token=[A-Za-z0-9_-]*' "$LOG" | head -1 || true)"
    [ -n "$URL" ] && break
    sleep 1
    i=$((i + 1))
  done
  if [ -n "$URL" ]; then
    PORT="$(echo "$URL" | sed 's#.*:\([0-9]*\)/.*#\1#')"
    CODE_NO_TOKEN="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$PORT/")"
    CODE_TOKEN="$(curl -s -m 5 -o /dev/null -w '%{http_code}' "$URL")"
    echo "   no-token=$CODE_NO_TOKEN token=$CODE_TOKEN"
    [ "$CODE_NO_TOKEN" = "401" ] && [ "$CODE_TOKEN" = "303" ] && ok "Web UI/token 正常" || bad "Web UI/token 异常"
  else
    bad "Web UI 未在 60s 内打印 URL"
  fi
  kill "$PID" 2>/dev/null
  wait "$PID" 2>/dev/null
  sleep 1
  rm -f "$LOG"
fi

if [ "$FAIL" = 0 ]; then
  printf '\n全部通过\n'
else
  printf '\n存在失败项，请检查\n'
fi
exit "$FAIL"
