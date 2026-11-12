#!/bin/bash
# pdk_mover.sh — PDK 中转区 → NAS 正式区 自动迁移（多项目通用版）
#
# 设计要点：
#   1. 项目级自动发现：遍历 PROJECTS（相对 SRC_ROOT），如 tsmc/n6、tsmc/n5、smic/40
#   2. 目录白名单：只扫描 ALLOW_DIRS 指定的叶子目录，其余目录（kits、ip 等只读区）永不触碰
#   3. 目标不覆盖：正式区已有同名文件时跳过并记录
#   4. 稳定期：仅处理写入完成超过 MIN_AGE 分钟的普通文件，避免搬运传输中的大文件
#   5. 原子落地：先 mv 到目标目录的隐藏临时名，再 rename 为正式名，中断不留半截文件占用正式名
#   6. 单实例：flock 防止上一轮未结束时重入
#   7. DRYRUN=1 只打印计划，不移动任何文件
#
# 配置：/etc/pdk_mover.conf（可用 CONF=<路径> 覆盖）

set -u

# 环境变量优先于配置文件（便于临时演练，不改线上配置）
ENV_DRYRUN="${DRYRUN-}"
ENV_MIN_AGE="${MIN_AGE-}"

CONF="${CONF:-/etc/pdk_mover.conf}"
if [ -r "$CONF" ]; then
    # shellcheck disable=SC1090
    . "$CONF"
else
    echo "$(date '+%F %T') [fatal] config not readable: $CONF" >&2
    exit 1
fi

[ -n "$ENV_DRYRUN" ] && DRYRUN="$ENV_DRYRUN"
[ -n "$ENV_MIN_AGE" ] && MIN_AGE="$ENV_MIN_AGE"

SRC_ROOT="${SRC_ROOT:-/eda/workspace/transfer/backend/nas_cifs/pdk/release}"
DST_ROOT="${DST_ROOT:-/nas_cifs/pdk/release}"
PROJECTS="${PROJECTS:-tsmc/n6}"
ALLOW_DIRS="${ALLOW_DIRS:-io/cdl io/db io/gds io/lef io/lib ram/avm ram/cdl ram/db ram/gds ram/lef ram/libs rom/avm rom/cdl rom/db rom/gds rom/lef rom/libs}"

LOG="${LOG:-/var/log/pdk_mover.log}"
WORK="${WORK:-/var/lib/pdk_mover}"
LOCK="${LOCK:-$WORK/.lock}"
MAILER="${MAILER:-/usr/local/sbin/pdk_mover_mailer.py}"

SMTP_HOST="${SMTP_HOST:-smtp.qiye.aliyun.com}"
SMTP_PORT="${SMTP_PORT:-25}"
MAIL_FROM="${MAIL_FROM:-noreply@example.com}"
SMTP_USER="${SMTP_USER:-noreply@example.com}"
SMTP_PASS="${SMTP_PASS:-}"

MAIL_TO="${MAIL_TO_OVERRIDE-${MAIL_TO:-ops-pdk@example.com}}"
MAIL_CC="${MAIL_CC_OVERRIDE-${MAIL_CC:-ops-oncall@example.com}}"

DRYRUN="${DRYRUN:-0}"
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"

MIN_AGE="${MIN_AGE:-2}"
case "$MIN_AGE" in ''|*[!0-9]*) MIN_AGE=2 ;; esac
[ "$MIN_AGE" -lt 1 ] && MIN_AGE=1

mkdir -p "$WORK"
exec 9>"$LOCK"
if ! flock -n 9; then
    echo "$STAMP [skip] previous run still in progress" >> "$LOG"
    exit 0
fi

REPORT="$WORK/report.$$"
BODY="$WORK/body.$$"
: > "$REPORT"
: > "$BODY"

TOTAL=0; MOVED=0; CONFLICT=0; FAILED=0
ACTIVE_PROJECTS=""

log() { echo "$STAMP $*" >> "$LOG"; }
rec() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$REPORT"; }

for PROJ in $PROJECTS; do
    SRC="$SRC_ROOT/$PROJ"
    DST="$DST_ROOT/$PROJ"

    if [ ! -d "$SRC" ]; then
        log "[skip-project] source missing: $SRC"
        continue
    fi
    if [ ! -d "$DST" ]; then
        log "[warn-project] target missing, refuse to create: $DST"
        rec "$PROJ" warn "目标项目目录不存在，已跳过（不自动创建）: $DST"
        FAILED=$((FAILED + 1))
        continue
    fi

    p_scanned=0; p_moved=0; p_conflict=0; p_failed=0

    for AD in $ALLOW_DIRS; do
        SDIR="$SRC/$AD"
        DDIR="$DST/$AD"
        [ -d "$SDIR" ] || continue

        if [ ! -d "$DDIR" ]; then
            p_failed=$((p_failed + 1)); FAILED=$((FAILED + 1))
            rec "$PROJ" fail "目标子目录不存在，未创建: $AD"
            log "[fail] $PROJ/$AD target subdir missing"
            continue
        fi

        LIST="$WORK/list.$$"
        find "$SDIR" -maxdepth 1 -type f -mmin +"$MIN_AGE" -print > "$LIST" 2>/dev/null

        while IFS= read -r f; do
            [ -z "$f" ] && continue
            p_scanned=$((p_scanned + 1)); TOTAL=$((TOTAL + 1))
            base="$(basename "$f")"

            if [ -e "$DDIR/$base" ]; then
                p_conflict=$((p_conflict + 1)); CONFLICT=$((CONFLICT + 1))
                rec "$PROJ" conflict "$AD/$base"
                continue
            fi

            if [ "$DRYRUN" = "1" ]; then
                p_moved=$((p_moved + 1)); MOVED=$((MOVED + 1))
                rec "$PROJ" dryrun "$AD/$base"
                continue
            fi

            TMP="$DDIR/.${base}.part.$$"
            if mv -n -- "$f" "$TMP" 2>/dev/null && mv -n -- "$TMP" "$DDIR/$base" 2>/dev/null; then
                p_moved=$((p_moved + 1)); MOVED=$((MOVED + 1))
                rec "$PROJ" moved "$AD/$base"
            else
                [ -e "$TMP" ] && rm -f -- "$TMP" 2>/dev/null
                p_failed=$((p_failed + 1)); FAILED=$((FAILED + 1))
                rec "$PROJ" fail "$AD/$base | move failed"
            fi
        done < "$LIST"
        rm -f "$LIST"
    done

    log "[project] $PROJ scanned=$p_scanned moved=$p_moved conflict=$p_conflict failed=$p_failed"
    if [ $((p_scanned + p_moved + p_conflict + p_failed)) -gt 0 ]; then
        ACTIVE_PROJECTS="$ACTIVE_PROJECTS $PROJ"
    fi
done

log "[total] scanned=$TOTAL moved=$MOVED conflict=$CONFLICT failed=$FAILED dryrun=$DRYRUN"

if [ $((MOVED + FAILED)) -gt 0 ]; then
    {
        echo "PDK 文件同步通知"
        [ "$DRYRUN" = "1" ] && echo "** 本次为 DRYRUN 演练，未实际移动任何文件 **"
        echo "执行时间: $STAMP"
        echo "源目录  : $SRC_ROOT"
        echo "目标目录: $DST_ROOT"
        echo "合计    : 扫描 $TOTAL / 迁移 $MOVED / 未覆盖 $CONFLICT / 失败 $FAILED"
        echo

        for PROJ in $ACTIVE_PROJECTS; do
            echo "== 项目 $PROJ =="
            awk -F'\t' -v p="$PROJ" '
                $1 == p && $2 == "moved"    { m[++im] = $3 }
                $1 == p && $2 == "dryrun"   { m[++im] = $3 "  (dryrun)" }
                $1 == p && $2 == "conflict" { c[++ic] = $3 }
                $1 == p && $2 == "fail"     { f[++if_] = $3 }
                $1 == p && $2 == "warn"     { w[++iw] = $3 }
                END {
                    printf "  迁移 %d / 未覆盖 %d / 失败 %d / 告警 %d\n", im, ic, if_, iw
                    if (iw) { print "  [告警]"; for (i = 1; i <= iw; i++) print "    " w[i] }
                    if (im) { print "  [已迁移]"; lim = (im > 200 ? 200 : im); for (i = 1; i <= lim; i++) print "    " m[i]; if (im > 200) printf "    ... 其余 %d 条见日志\n", im - 200 }
                    if (ic) { print "  [目标已存在，未覆盖]"; lic = (ic > 200 ? 200 : ic); for (i = 1; i <= lic; i++) print "    " c[i]; if (ic > 200) printf "    ... 其余 %d 条见日志\n", ic - 200 }
                    if (if_) { print "  [失败]"; lif = (if_ > 200 ? 200 : if_); for (i = 1; i <= lif; i++) print "    " f[i]; if (if_ > 200) printf "    ... 其余 %d 条见日志\n", if_ - 200 }
                }' "$REPORT"
            echo
        done

        echo "本邮件由 $(hostname -s) 上的 pdk_mover.sh 自动发送，日志 $LOG，请勿直接回复。"
    } > "$BODY"

    SUBJECT="[PDK同步] $STAMP 迁移 $MOVED 个文件"
    [ "$DRYRUN" = "1" ] && SUBJECT="[PDK同步-DRYRUN] $STAMP 计划迁移 $MOVED 个文件"

    python3 "$MAILER" "$SMTP_HOST" "$SMTP_PORT" "$MAIL_FROM" "$SMTP_USER" "$SMTP_PASS" \
        "$MAIL_TO" "$MAIL_CC" "$SUBJECT" "$BODY" >> "$LOG" 2>&1 \
        && log "[mail] sent to $MAIL_TO cc=$MAIL_CC" \
        || log "[mail] FAILED to send"
fi

rm -f "$REPORT" "$BODY"
exit 0
