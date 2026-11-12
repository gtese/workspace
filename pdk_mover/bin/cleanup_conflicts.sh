#!/bin/bash
# cleanup_conflicts.sh — 一次性清理中转区"目标已存在且内容一致"的重复文件
#
# 背景：pdk_mover.sh v2 在目标端已有同名文件时无条件跳过（conflict），导致重复上传
#       的文件永久冻结在中转区。本脚本只处理「内容与正式区完全一致」的部分，删除源文件
#       不会造成任何数据丢失；内容不一致的文件一律跳过，留给人工或 v3 的 dedup 策略处理。
#
# 用法：
#   ./cleanup_conflicts.sh              # 默认 DRYRUN，仅列出计划，不删除
#   REAL=1 ./cleanup_conflicts.sh       # 真正执行删除
#
# 逻辑：对每个白名单目录的每个文件，若目标端存在同名文件，则比对 大小 + md5，
#       两者都相同 → 删除源文件并记录；任何一项不同 → 跳过并标记 SKIP_DIFF。

set -u

CONF="${CONF:-/etc/pdk_mover.conf}"
if [ -r "$CONF" ]; then
    # shellcheck disable=SC1090
    . "$CONF"
fi

SRC_ROOT="${SRC_ROOT:-/eda/workspace/transfer/backend/nas_cifs/pdk/release}"
DST_ROOT="${DST_ROOT:-/nas_cifs/pdk/release}"
PROJECTS="${PROJECTS:-tsmc/n6}"
ALLOW_DIRS="${ALLOW_DIRS:-io/cdl io/db io/gds io/lef io/lib ram/avm ram/cdl ram/db ram/gds ram/lef ram/libs rom/avm rom/cdl rom/db rom/gds rom/lef rom/libs}"

REAL="${REAL:-0}"
LOG="${LOG:-/var/log/pdk_mover.log}"
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"

DELETED=0; SKIPPED_DIFF=0; SCANNED=0

echo "模式: $([ "$REAL" = "1" ] && echo 真实删除 || echo 'DRYRUN（不删除，仅列出）')"
echo "时间: $STAMP"
echo

for PROJ in $PROJECTS; do
    SRC="$SRC_ROOT/$PROJ"
    DST="$DST_ROOT/$PROJ"
    [ -d "$SRC" ] || continue
    [ -d "$DST" ] || { echo "[$PROJ] 目标缺失，跳过"; continue; }

    for AD in $ALLOW_DIRS; do
        SDIR="$SRC/$AD"; DDIR="$DST/$AD"
        [ -d "$SDIR" ] || continue
        [ -d "$DDIR" ] || continue
        find "$SDIR" -maxdepth 1 -type f -print | while IFS= read -r f; do
            base="$(basename "$f")"; target="$DDIR/$base"
            [ -e "$target" ] || continue
            if [ "$(stat -c %s "$f")" = "$(stat -c %s "$target")" ] \
               && [ "$(md5sum "$f" | cut -d' ' -f1)" = "$(md5sum "$target" | cut -d' ' -f1)" ]; then
                if [ "$REAL" = "1" ]; then
                    if rm -f -- "$f"; then
                        echo "DEL   $AD/$base"
                        echo "$STAMP [cleanup] dedup delete $PROJ/$AD/$base" >> "$LOG"
                    else
                        echo "ERR   $AD/$base  (删除失败)"
                    fi
                else
                    echo "PLAN  $AD/$base  (内容一致，可删除)"
                fi
            else
                echo "SKIP  $AD/$base  (内容不同，保留待人工)"
            fi
        done
    done
done

echo
echo "完成。真实模式请查看 $LOG 中的 [cleanup] 记录。"
