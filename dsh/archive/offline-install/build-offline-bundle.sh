#!/usr/bin/env bash
# =============================================================================
# 构建 DeepSeek Harness 离线安装包（目标：Rocky Linux 8 / x86_64）
#
# 在一台「能上外网」的机器上运行，三种方式任选：
#   1) macOS + Docker Desktop（Apple 芯片会模拟 x86_64，慢但可用）
#   2) 任意 x86_64 Linux + Docker / Podman
#   3) 任意联网的 Rocky 8 机器：sudo ./build-offline-bundle.sh --native
#
# 产物（在 out/ 下）：
#   dsh-<版本>-rocky8-x86_64.tar.gz          含 Node 24 + dsh + pnpm
#   dsh-<版本>-rocky8-x86_64.tar.gz.sha256
#
# 可覆盖的环境变量：
#   DSH_VERSION=0.2.0-rc.2   NODE_VERSION=24.18.1   PNPM_VERSION=11
# =============================================================================
set -euo pipefail

DSH_VERSION="${DSH_VERSION:-0.2.0-rc.2}"
NODE_VERSION="${NODE_VERSION:-24.18.1}"
PNPM_VERSION="${PNPM_VERSION:-11}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OUT="${SCRIPT_DIR}/out"
mkdir -p "$OUT"

NATIVE=0
[ "${1:-}" = "--native" ] && NATIVE=1

RUNTIME=""
if [ "$NATIVE" = 0 ]; then
  if command -v docker >/dev/null 2>&1; then
    RUNTIME=docker
  elif command -v podman >/dev/null 2>&1; then
    RUNTIME=podman
  else
    cat >&2 <<'EOF'
错误：没有找到 docker 或 podman。

二选一：
  A. 装 Docker Desktop / colima / podman 后重跑本脚本；
  B. 找一台能联网的 Rocky 8 / x86_64 Linux，把本脚本和 README 拷过去，
     执行：sudo ./build-offline-bundle.sh --native
EOF
    exit 1
  fi
fi

# ---- 真正在 Linux/容器里执行的步骤 -----------------------------------------
STEPS="${OUT}/.build-steps.sh"
cat > "$STEPS" <<'STEPS'
#!/usr/bin/env bash
set -eo pipefail
: "${DSH_VERSION:?}" "${NODE_VERSION:?}" "${PNPM_VERSION:?}"

echo "== [1/6] 安装构建工具（Node 原生模块需要编译兜底）"
dnf -y install tar xz gzip curl gcc gcc-c++ make python3 git
if dnf -y install gcc-toolset-13; then
  . /opt/rh/gcc-toolset-13/enable
  echo "已启用 gcc-toolset-13"
else
  echo "!! gcc-toolset-13 不可用，将使用系统 gcc；若 node-pty 编译失败，改装 gcc-toolset-12/14 重试"
fi

echo "== [2/6] 安装 Node.js v${NODE_VERSION} 到 /opt/dsh"
curl -fsSL -o /tmp/node.tar.xz \
  "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
mkdir -p /opt/dsh
tar -xJf /tmp/node.tar.xz -C /opt/dsh --strip-components=1
export PATH="/opt/dsh/bin:$PATH"
node -v
npm -v

echo "== [3/6] 安装 @deepseek-ai/dsh@${DSH_VERSION} 和 pnpm@${PNPM_VERSION}"
npm install -g --prefix /opt/dsh \
  "@deepseek-ai/dsh@${DSH_VERSION}" "pnpm@${PNPM_VERSION}"

echo "== [4/6] 冒烟检查"
/opt/dsh/bin/dsh --version
/opt/dsh/bin/node -v
/opt/dsh/bin/pnpm --version || true

echo "== [5/6] 放宽权限（所有用户可读可执行）"
chmod -R a+rX /opt/dsh

echo "== [6/6] 打包"
OUT_DIR="${OUT_DIR:-/out}"
mkdir -p "$OUT_DIR"
TARBALL="${OUT_DIR}/dsh-${DSH_VERSION}-rocky8-x86_64.tar.gz"
tar -C /opt -czf "$TARBALL" dsh
# 校验文件里只写文件名，方便在服务器上 cd 到目录后直接 sha256sum -c
( cd "$OUT_DIR" && sha256sum "$(basename "$TARBALL")" ) > "${TARBALL}.sha256"
ls -lh "$TARBALL"
echo "完成。"
STEPS
chmod +x "$STEPS"

cleanup() { rm -f "$STEPS"; }
trap cleanup EXIT

if [ "$NATIVE" = 1 ]; then
  echo "在本机（应为 Rocky 8 / x86_64）原生构建，需要 root 权限执行 dnf："
  sudo DSH_VERSION="$DSH_VERSION" NODE_VERSION="$NODE_VERSION" \
    PNPM_VERSION="$PNPM_VERSION" OUT_DIR="$OUT" \
    bash "$STEPS"
else
  # 把产物写进 out/，用 x86_64 基础镜像保证 glibc/原生模块与 Rocky 8 兼容
  "$RUNTIME" run --rm --platform linux/amd64 \
    -v "${OUT}:/out" \
    -v "${STEPS}:/build-steps.sh:ro" \
    -e "DSH_VERSION=${DSH_VERSION}" \
    -e "NODE_VERSION=${NODE_VERSION}" \
    -e "PNPM_VERSION=${PNPM_VERSION}" \
    -e "OUT_DIR=/out" \
    rockylinux:8 bash /build-steps.sh
fi

echo
echo "产物："
ls -lh "${OUT}"/dsh-*.tar.gz "${OUT}"/dsh-*.sha256
