#!/bin/bash
# pdk_mover.sh — PDK 中转区 → NAS 正式区 自动迁移（v4 简化规则版）
#
# 规则只有一条：
#   中转区白名单目录下的文件，只要正式区存在对应的目标目录，就 move 过去（同名直接覆盖），
#   源端一律不留；正式区没有对应目录则不动，记录告警，等人工建目录。
#   子目录递归处理：源端 ram/db/sub/x.db → 正式区 ram/db/sub/x.db（前提是该子目录已存在）。
#
# 其余设计要点：
#   1. 项目级自动发现：遍历 PROJECTS（相对 SRC_ROOT），如 tsmc/n6、tsmc/n5
#   2. 目录白名单 ALLOW_DIRS：只扫描这些目录（含其子目录），kits、ip 等只读区永不触碰
#   3. 稳定期 MIN_AGE：仅处理写入完成超过 N 分钟的普通文件，避免搬运传输中的大文件
#   4. 原子落地：先 mv 到目标目录隐藏临时名，再 rename 为正式名，中断不留半截文件占正式名
#   5. 空目录回收：搬运完成后清理中转区留下的空子目录
#   6. 单实例：flock 防止上一轮未结束时重入
#   7. DRYRUN=1 只打印计划，不移动/删除任何文件
#
# 注意：同名覆盖不保留被覆盖的旧文件，正式区旧版会被新版替换且不可回滚。
#
# 配置：/etc/pdk_mover.conf（可用 CONF=<路径> 覆盖）

set -u

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

TOTAL=0; MOVED=0; OVER=0; FAILED=0
ACTIVE_PROJECTS=""

log() { echo "$STAMP $*" >> "$LOG"; }
rec() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$REPORT"; }

# 原子落地：源文件 → 目标正式名（可覆盖）。失败时清临时名，源文件保持原样。
place() { # $1=源文件 $2=目标目录 $3=目标名
    local f="$1" ddir="$2" base="$3" tmp
    tmp="$ddir/.${base}.part.$$"
    mv -f -- "$f" "$tmp" 2>/dev/null || { [ -e "$tmp" ] && rm -f -- "$tmp" 2>/dev/null; return 1; }
    mv -f -- "$tmp" "$ddir/$base" 2>/dev/null || { rm -f -- "$tmp" 2>/dev/null; return 1; }
    return 0
}

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

    p_scanned=0; p_moved=0; p_over=0; p_failed=0
    MISS_DIRS=""

    for AD in $ALLOW_DIRS; do
        SDIR="$SRC/$AD"
        DDIR="$DST/$AD"
        [ -d "$SDIR" ] || continue

        if [ ! -d "$DDIR" ]; then
            p_failed=$((p_failed + 1)); FAILED=$((FAILED + 1))
            rec "$PROJ" fail "目标目录不存在，未创建: $AD"
            log "[fail] $PROJ/$AD target dir missing"
            continue
        fi

        LIST="$WORK/list.$$"
        # 递归：白名单目录下任意深度的普通文件
        find "$SDIR" -type f -mmin +"$MIN_AGE" -print > "$LIST" 2>/dev/null

        while IFS= read -r f; do
            [ -z "$f" ] && continue
            rel="${f#$SRC/}"
            tpath="$DST/$rel"
            ddir="$(dirname "$tpath")"
            base="$(basename "$f")"
            p_scanned=$((p_scanned + 1)); TOTAL=$((TOTAL + 1))

            # 目标父目录不存在：不自动创建，记一次告警后跳过该目录下的其余文件
            if [ ! -d "$ddir" ]; then
                case " $MISS_DIRS " in
                    *" ${ddir#$DST/} "*)
                        p_failed=$((p_failed + 1)); FAILED=$((FAILED + 1))
                        ;;
                    *)
                        MISS_DIRS="$MISS_DIRS ${ddir#$DST/}"
                        p_failed=$((p_failed + 1)); FAILED=$((FAILED + 1))
                        rec "$PROJ" warn "目标目录不存在，其中的文件未搬运: ${ddir#$DST/}"
                        log "[warn] $PROJ target dir missing: ${ddir#$DST/}"
                        ;;
                esac
                continue
            fi

            if [ "$DRYRUN" = "1" ]; then
                if [ -e "$tpath" ]; then
                    p_over=$((p_over + 1)); OVER=$((OVER + 1))
                    rec "$PROJ" overwrite "$rel | 同名已存在，计划覆盖"
                else
                    p_moved=$((p_moved + 1)); MOVED=$((MOVED + 1))
                    rec "$PROJ" moved "$rel"
                fi
                continue
            fi

            if [ -e "$tpath" ]; then
                if place "$f" "$ddir" "$base"; then
                    p_over=$((p_over + 1)); OVER=$((OVER + 1))
                    rec "$PROJ" overwrite "$rel | 同名已覆盖"
                else
                    p_failed=$((p_failed + 1)); FAILED=$((FAILED + 1))
                    rec "$PROJ" fail "$rel | 覆盖失败"
                fi
            else
                if place "$f" "$ddir" "$base"; then
                    p_moved=$((p_moved + 1)); MOVED=$((MOVED + 1))
                    rec "$PROJ" moved "$rel"
                else
                    p_failed=$((p_failed + 1)); FAILED=$((FAILED + 1))
                    rec "$PROJ" fail "$rel | 移动失败"
                fi
            fi
        done < "$LIST"
        rm -f "$LIST"

        # 回收中转区残留的空目录（仅限白名单目录之下）
        if [ "$DRYRUN" != "1" ]; then
            find "$SDIR" -mindepth 1 -type d -empty -delete 2>/dev/null
        fi
    done

    log "[project] $PROJ scanned=$p_scanned moved=$p_moved overwritten=$p_over failed=$p_failed"
    if [ $((p_scanned + p_moved + p_over + p_failed)) -gt 0 ]; then
        ACTIVE_PROJECTS="$ACTIVE_PROJECTS $PROJ"
    fi
done

log "[total] scanned=$TOTAL moved=$MOVED overwritten=$OVER failed=$FAILED dryrun=$DRYRUN"

if [ $((MOVED + OVER + FAILED)) -gt 0 ]; then
    {
        echo "PDK 文件同步通知"
        [ "$DRYRUN" = "1" ] && echo "** 本次为 DRYRUN 演练，未实际移动任何文件 **"
        echo "执行时间: $STAMP"
        echo "源目录  : $SRC_ROOT"
        echo "目标目录: $DST_ROOT"
        echo "合计    : 扫描 $TOTAL / 迁移 $MOVED / 同名覆盖 $OVER / 失败或跳过 $FAILED"
        echo

        for PROJ in $ACTIVE_PROJECTS; do
            echo "== 项目 $PROJ =="
            awk -F'\t' -v p="$PROJ" '
                $1 == p && $2 == "moved"     { m[++im] = $3 }
                $1 == p && $2 == "overwrite" { o[++io_] = $3 }
                $1 == p && $2 == "fail"      { f[++if_] = $3 }
                $1 == p && $2 == "warn"      { w[++iw] = $3 }
                END {
                    printf "  迁移 %d / 同名覆盖 %d / 失败或跳过 %d / 告警 %d\n", im, io_, if_, iw
                    if (iw) { print "  [告警]"; for (i = 1; i <= iw; i++) print "    " w[i] }
                    if (im) { print "  [已迁移]"; lim = (im > 200 ? 200 : im); for (i = 1; i <= lim; i++) print "    " m[i]; if (im > 200) printf "    ... 其余 %d 条见日志\n", im - 200 }
                    if (io_) { print "  [同名已覆盖]"; lio = (io_ > 200 ? 200 : io_); for (i = 1; i <= lio; i++) print "    " o[i]; if (io_ > 200) printf "    ... 其余 %d 条见日志\n", io_ - 200 }
                    if (if_) { print "  [失败]"; lif = (if_ > 200 ? 200 : if_); for (i = 1; i <= lif; i++) print "    " f[i]; if (if_ > 200) printf "    ... 其余 %d 条见日志\n", if_ - 200 }
                }' "$REPORT"
            echo
        done

        echo "本邮件由 $(hostname -s) 上的 pdk_mover.sh 自动发送，日志文件：${LOG} ；请勿直接回复。"
    } > "$BODY"

    SUBJECT="[PDK同步] $STAMP 迁移 $MOVED / 覆盖 $OVER 个文件"
    [ "$DRYRUN" = "1" ] && SUBJECT="[PDK同步-DRYRUN] $STAMP 计划迁移 $MOVED 个文件"

    python3 "$MAILER" "$SMTP_HOST" "$SMTP_PORT" "$MAIL_FROM" "$SMTP_USER" "$SMTP_PASS" \
        "$MAIL_TO" "$MAIL_CC" "$SUBJECT" "$BODY" >> "$LOG" 2>&1 \
        && log "[mail] sent to $MAIL_TO cc=$MAIL_CC" \
        || log "[mail] FAILED to send"
fi

rm -f "$REPORT" "$BODY"
exit 0
