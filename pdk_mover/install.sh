#!/bin/bash
# install.sh — 部署 PDK 中转区自动迁移组件（v4 简化规则版）
#
# 用法:
#   sudo ./install.sh              安装/升级
#   sudo ./install.sh --purge-old  同时移除 v1（pdk_n6_*）遗留文件
#
# 说明:
#   - 已存在的 /etc/pdk_mover.conf 不会被覆盖（保护口令与项目列表）
#   - 首次安装会从 example 复制，需手工填入 SMTP_PASS 后再启用
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then
    echo "ERROR: 请以 root 运行 (sudo ./install.sh)" >&2
    exit 1
fi

REPO_DIR="$(cd "$(dirname "$0")" && pwd)"
PURGE=0
[ "${1:-}" = "--purge-old" ] && PURGE=1

echo "[1/6] 安装脚本"
install -m 755 -o root -g root "$REPO_DIR/bin/pdk_mover.sh"        /usr/local/sbin/pdk_mover.sh
install -m 755 -o root -g root "$REPO_DIR/bin/pdk_mover_mailer.py" /usr/local/sbin/pdk_mover_mailer.py

echo "[2/6] 配置文件"
if [ -f /etc/pdk_mover.conf ]; then
    echo "  已存在 /etc/pdk_mover.conf，保留不覆盖"
else
    install -m 600 -o root -g root "$REPO_DIR/etc/pdk_mover.conf.example" /etc/pdk_mover.conf
    echo "  已从模板创建 /etc/pdk_mover.conf —— 请填入 SMTP_PASS 后确认 PROJECTS / ALLOW_DIRS"
fi

echo "[3/6] 运行目录与日志"
install -d -m 755 /var/lib/pdk_mover
touch /var/log/pdk_mover.log
chmod 644 /var/log/pdk_mover.log

echo "[4/6] cron"
install -m 644 -o root -g root "$REPO_DIR/etc/cron.d/pdk_mover" /etc/cron.d/pdk_mover
chmod 644 /etc/cron.d/pdk_mover

echo "[5/6] 语法检查"
bash -n /usr/local/sbin/pdk_mover.sh && echo "  bash OK"
python3 -m py_compile /usr/local/sbin/pdk_mover_mailer.py && echo "  python OK"

if [ "$PURGE" = "1" ]; then
    echo "[6/6] 清理 v1 遗留"
    rm -f /etc/cron.d/pdk_n6_mover /usr/local/sbin/pdk_n6_mover.sh /usr/local/sbin/pdk_n6_mailer.py
    echo "  已移除 pdk_n6_* 相关 cron 与脚本（历史日志保留）"
else
    echo "[6/6] 跳过 v1 清理（如需: sudo ./install.sh --purge-old）"
fi

echo
echo "完成。建议步骤:"
echo "  1) 编辑 /etc/pdk_mover.conf 填入 SMTP_PASS"
echo "  2) DRYRUN=1 /usr/local/sbin/pdk_mover.sh && tail /var/log/pdk_mover.log   # 演练"
echo "  3) DRYRUN=0 /usr/local/sbin/pdk_mover.sh                                  # 正式"
