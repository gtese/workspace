#!/usr/bin/env bash
# =============================================================================
# 在 Rocky Linux 8 服务器上安装 DeepSeek Harness 离线包
#
# 系统级（管理员，装到 /opt/dsh，全机共享程序）：
#   sudo ./install-offline.sh dsh-0.2.0-rc.2-rocky8-x86_64.tar.gz
#
# 用户级（普通用户，装到 ~/opt/dsh，不需要 root）：
#   ./install-offline.sh --user dsh-0.2.0-rc.2-rocky8-x86_64.tar.gz
#
# 覆盖已有系统级安装：FORCE=1 sudo ./install-offline.sh <包>
# =============================================================================
set -euo pipefail

MODE=system
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --user)  MODE=user; shift ;;
    --force|-f) FORCE=1; shift ;;
    --) shift; break ;;
    -*) echo "未知参数：$1" >&2; exit 1 ;;
    *) break ;;
  esac
done

if [ $# -lt 1 ]; then
  echo "用法: $0 [--user] [--force] dsh-<版本>-rocky8-x86_64.tar.gz" >&2
  exit 1
fi
TARBALL="$1"
[ -f "$TARBALL" ] || { echo "找不到文件：$TARBALL" >&2; exit 1; }
TARBALL="$(cd "$(dirname "$TARBALL")" && pwd)/$(basename "$TARBALL")"

# 可选校验
if [ -f "${TARBALL}.sha256" ]; then
  echo "== 校验 sha256"
  ( cd "$(dirname "$TARBALL")" && sha256sum -c "$(basename "$TARBALL").sha256" )
fi

if [ "$MODE" = system ]; then
  [ "$(id -u)" = 0 ] || { echo "系统级安装需要 root；普通用户请加 --user" >&2; exit 1; }
  if [ -e /opt/dsh ] && [ "$FORCE" != 1 ]; then
    echo "/opt/dsh 已存在。确认覆盖请执行：sudo $0 --force $TARBALL" >&2
    exit 1
  fi

  if [ "$FORCE" = 1 ]; then
    echo "== 覆盖安装：删除旧 /opt/dsh"
    rm -rf /opt/dsh
  fi
  echo "== 解压到 /opt/dsh"
  tar -xzf "$TARBALL" -C /opt

  echo "== 生成统一入口 /usr/local/bin/dsh（固定使用包内 Node）"
  cat > /usr/local/bin/dsh <<'WRAP'
#!/bin/sh
# 保证 dsh plugin（pnpm）与包内 Node 始终可用，不依赖登录 shell 的 PATH
PATH="/opt/dsh/bin:$PATH"
export PATH
exec /opt/dsh/bin/node /opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js "$@"
WRAP
  chmod 755 /usr/local/bin/dsh

  # Rocky 8 默认开 SELinux；给 /opt 下的文件补一次标签，避免执行被拦
  command -v restorecon >/dev/null 2>&1 && restorecon -R /opt/dsh || true

  echo "== 验证"
  /usr/local/bin/dsh --version

  cat <<'EOF'

系统级安装完成：
  /opt/dsh                         Node + dsh + pnpm（只读，全机共用程序）
  /usr/local/bin/dsh               固定入口（不依赖 PATH，内部自动带上包内 Node/pnpm）

每个用户在自己的账号下运行（各自的 ~/.dsh、各自的 API key）：
  dsh --profile web --no-open --port 18080
然后在本地电脑：ssh -L 18080:127.0.0.1:18080 <用户>@<服务器>
浏览器打开终端打印的 http://127.0.0.1:18080/?token=... 地址。
EOF
else
  DEST="${HOME}/opt"
  echo "== 解压到 ${DEST}/dsh"
  mkdir -p "$DEST"
  tar -xzf "$TARBALL" -C "$DEST"

  mkdir -p "${HOME}/.local/bin"
  cat > "${HOME}/.local/bin/dsh" <<'WRAP'
#!/bin/sh
PATH="$HOME/opt/dsh/bin:$PATH"
export PATH
exec "$HOME/opt/dsh/bin/node" "$HOME/opt/dsh/lib/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"
WRAP
  chmod 755 "${HOME}/.local/bin/dsh"

  echo "== 验证"
  "${HOME}/.local/bin/dsh" --version

  cat <<EOF

用户级安装完成：${DEST}/dsh
入口：${HOME}/.local/bin/dsh

如果 ~/.local/bin 不在 PATH 里：
  echo 'export PATH="\$HOME/.local/bin:\$PATH"' >> ~/.bashrc && source ~/.bashrc
  或者直接用绝对路径：~/.local/bin/dsh --profile web --no-open --port 18080

启动后在本地电脑：ssh -L 18080:127.0.0.1:18080 <用户>@<服务器>
浏览器打开终端打印的带 token 的 URL。
EOF
fi
