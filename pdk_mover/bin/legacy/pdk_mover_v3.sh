#!/bin/bash
# pdk_mover.sh — PDK 中转区 → NAS 正式区 自动迁移（多项目通用版 v3）
#
# v3 相对 v2 的唯一行为变更：目标端已存在同名文件时，不再无条件跳过（v2 会让源文件
# 永久冻结在中转区，日志里每轮 conflict=N、moved=0），改为按 CONFLICT_POLICY 处置：
#
#   dedup      （默认）内容一致 → 删除源文件；内容不一致 → 旧文件改名 .prev.YYYYMMDD
#                      备份后，用新文件覆盖
#   overwrite          不比对内容，旧文件改名 .prev.YYYYMMDD 备份后直接覆盖
#   drop               内容一致 → 删除源文件；内容不一致 → 覆盖且不备份（有数据丢失风险）
#   keep               保持 v2 行为：跳过并告警，源文件留在中转区（不推荐）
#
# 其余设计要点（与 v2 相同）：
#   1. 项目级自动发现：遍历 PROJECTS（相对 SRC_ROOT），如 tsmc/n6、tsmc/n5、smic/40
#   2. 目录白名单：只扫描 ALLOW_DIRS 指定的叶子目录，其余目录（kits、ip 等只读区）永不触碰
#   3. 稳定期：仅处理写入完成超过 MIN_AGE 分钟的普通文件，避免搬运传输中的大文件
#   4. 原子落地：先 mv 到目标目录的隐藏临时名，再 rename 为正式名，中断不留半截文件占用正式名
#   5. 单实例：flock 防止上一轮未结束时重入
#   6. DRYRUN=1 只打印计划，不移动/删除任何文件
#
# 配置：/etc/pdk_mover.conf（可用 CONF=<路径> 覆盖）

set -u

# 环境变量优先于配置文件（便于临时演练，不改线上配置）
ENV_DRYRUN="${DRYRUN-}"
ENV_MIN_AGE="${MIN_AGE-}"
ENV_POLICY="${CONFLICT_POLICY-}"

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
[ -n "$ENV_POLICY" ] && CONFLICT_POLICY="$ENV_POLICY"

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
CONFLICT_POLICY="${CONFLICT_POLICY:-dedup}"
case "$CONFLICT_POLICY" in
    dedup|overwrite|drop|keep) ;;
    *) CONFLICT_POLICY=dedup ;;
esac
STAMP="$(date '+%Y-%m-%d %H:%M:%S')"
TODAY="$(date '+%Y%m%d')"

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

TOTAL=0; MOVED=0; CONFLICT=0; DEDUP=0; REPLACED=0; FAILED=0
ACTIVE_PROJECTS=""

log() { echo "$STAMP $*" >> "$LOG"; }
rec() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$REPORT"; }

# 一次性把文件搬到目标正式名（原子：先临时名再 rename）
# 返回 0 成功，非 0 失败；失败时清理临时名，源文件保持原样
place() { # $1=源文件 $2=目标目录 $3=目标文件名
    local f="$1" ddir="$2" base="$3" tmp
    tmp="$ddir/.${base}.part.$$"
    if mv -n -- "$f" "$tmp" 2>/dev/null && mv -n -- "$tmp" "$ddir/$base" 2>/dev/null; then
        return 0
    fi
    [ -e "$tmp" ] && rm -f -- "$tmp" 2>/dev/null
    return 1
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

    p_scanned=0; p_moved=0; p_conflict=0; p_dedup=0; p_replaced=0; p_failed=0

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
            target="$DDIR/$base"

            # ---------- 无同名：正常迁移 ----------
            if [ ! -e "$target" ]; then
                if [ "$DRYRUN" = "1" ]; then
                    p_moved=$((p_moved + 1)); MOVED=$((MOVED + 1))
                    rec "$PROJ" dryrun "$AD/$base"
                    continue
                fi
                if place "$f" "$DDIR" "$base"; then
                    p_moved=$((p_moved + 1)); MOVED=$((MOVED + 1))
                    rec "$PROJ" moved "$AD/$base"
                else
                    p_failed=$((p_failed + 1)); FAILED=$((FAILED + 1))
                    rec "$PROJ" fail "$AD/$base | move failed"
                fi
                continue
            fi

            # ---------- 有同名：按 CONFLICT_POLICY 处置 ----------
            p_conflict=$((p_conflict + 1)); CONFLICT=$((CONFLICT + 1))

            if [ "$CONFLICT_POLICY" = "keep" ]; then
                rec "$PROJ" conflict "$AD/$base"
                continue
            fi

            # 内容判定：大小 + md5 双校验
            same=0
            if [ "$(stat -c %s "$f")" = "$(stat -c %s "$target")" ]; then
                if [ "$(md5sum "$f" | cut -d' ' -f1)" = "$(md5sum "$target" | cut -d' ' -f1)" ]; then
                    same=1
                fi
            fi

            if [ "$same" = "1" ]; then
                # 内容完全一致：源端这份是重复上传，直接清掉，正式区不动
                if [ "$DRYRUN" = "1" ]; then
                    p_dedup=$((p_dedup + 1)); DEDUP=$((DEDUP + 1))
                    rec "$PROJ" dedup "$AD/$base | 内容一致，计划删除源文件"
                    continue
                fi
                if rm -f -- "$f" 2>/dev/null; then
                    p_dedup=$((p_dedup + 1)); DEDUP=$((DEDUP + 1))
                    rec "$PROJ" dedup "$AD/$base | 内容一致已删除源文件"
                else
                    p_failed=$((p_failed + 1)); FAILED=$((FAILED + 1))
                    rec "$PROJ" fail "$AD/$base | 重复文件删除失败"
                fi
                continue
            fi

            # 内容不同
            if [ "$CONFLICT_POLICY" = "dedup" ] || [ "$CONFLICT_POLICY" = "overwrite" ]; then
                # 旧版改名备份，再落地新版
                if [ "$DRYRUN" = "1" ]; then
                    p_replaced=$((p_replaced + 1)); REPLACED=$((REPLACED + 1))
                    rec "$PROJ" replaced "$AD/$base | 内容不同，计划备份旧版为 ${base}.prev.${TODAY} 后覆盖"
                    continue
                fi
                if mv -f -- "$target" "$target.prev.$TODAY" 2>/dev/null; then
                    if place "$f" "$DDIR" "$base"; then
                        p_replaced=$((p_replaced + 1)); REPLACED=$((REPLACED + 1))
                        rec "$PROJ" replaced "$AD/$base | 旧版备份为 ${base}.prev.${TODAY}，已用新版覆盖"
                    else
                        # 落地失败：把备份还原，源文件保留，避免正式区出现空档
                        mv -f -- "$target.prev.$TODAY" "$target" 2>/dev/null
                        p_failed=$((p_failed + 1)); FAILED=$((FAILED + 1))
                        rec "$PROJ" fail "$AD/$base | 内容不同但覆盖失败，旧版已还原"
                    fi
                else
                    p_failed=$((p_failed + 1)); FAILED=$((FAILED + 1))
                    rec "$PROJ" fail "$AD/$base | 旧版备份失败（权限？），未覆盖"
                fi
                continue
            fi

            # CONFLICT_POLICY=drop：直接覆盖，不留备份
            if [ "$DRYRUN" = "1" ]; then
                p_replaced=$((p_replaced + 1)); REPLACED=$((REPLACED + 1))
                rec "$PROJ" replaced "$AD/$base | 内容不同，计划直接覆盖（不备份）"
                continue
            fi
            if mv -f -- "$f" "$target" 2>/dev/null; then
                p_replaced=$((p_replaced + 1)); REPLACED=$((REPLACED + 1))
                rec "$PROJ" replaced "$AD/$base | 内容不同，已直接覆盖（未备份）"
            else
                p_failed=$((p_failed + 1)); FAILED=$((FAILED + 1))
                rec "$PROJ" fail "$AD/$base | 直接覆盖失败"
            fi
        done < "$LIST"
        rm -f "$LIST"
    done

    log "[project] $PROJ scanned=$p_scanned moved=$p_moved dedup=$p_dedup replaced=$p_replaced conflict=$p_conflict failed=$p_failed policy=$CONFLICT_POLICY"
    if [ $((p_scanned + p_moved + p_conflict + p_failed)) -gt 0 ]; then
        ACTIVE_PROJECTS="$ACTIVE_PROJECTS $PROJ"
    fi
done

log "[total] scanned=$TOTAL moved=$MOVED dedup=$DEDUP replaced=$REPLACED conflict=$CONFLICT failed=$FAILED dryrun=$DRYRUN policy=$CONFLICT_POLICY"

if [ $((MOVED + FAILED + DEDUP + REPLACED)) -gt 0 ]; then
    {
        echo "PDK 文件同步通知"
        [ "$DRYRUN" = "1" ] && echo "** 本次为 DRYRUN 演练，未实际移动/删除任何文件 **"
        echo "执行时间: $STAMP"
        echo "源目录  : $SRC_ROOT"
        echo "目标目录: $DST_ROOT"
        echo "冲突策略: $CONFLICT_POLICY"
        echo "合计    : 扫描 $TOTAL / 迁移 $MOVED / 重复清理 $DEDUP / 覆盖 $REPLACED / 未处置 $CONFLICT / 失败 $FAILED"
        echo

        for PROJ in $ACTIVE_PROJECTS; do
            echo "== 项目 $PROJ =="
            awk -F'\t' -v p="$PROJ" '
                $1 == p && $2 == "moved"    { m[++im] = $3 }
                $1 == p && $2 == "dryrun"   { m[++im] = $3 "  (dryrun)" }
                $1 == p && $2 == "dedup"    { d[++id] = $3 }
                $1 == p && $2 == "replaced" { r[++ir] = $3 }
                $1 == p && $2 == "conflict" { c[++ic] = $3 }
                $1 == p && $2 == "fail"     { f[++if_] = $3 }
                $1 == p && $2 == "warn"     { w[++iw] = $3 }
                END {
                    printf "  迁移 %d / 重复清理 %d / 覆盖 %d / 未处置 %d / 失败 %d / 告警 %d\n", im, id, ir, ic, if_, iw
                    if (iw) { print "  [告警]"; for (i = 1; i <= iw; i++) print "    " w[i] }
                    if (im) { print "  [已迁移]"; lim = (im > 200 ? 200 : im); for (i = 1; i <= lim; i++) print "    " m[i]; if (im > 200) printf "    ... 其余 %d 条见日志\n", im - 200 }
                    if (id) { print "  [重复文件已清理，正式区未改动]"; lid = (id > 200 ? 200 : id); for (i = 1; i <= lid; i++) print "    " d[i]; if (id > 200) printf "    ... 其余 %d 条见日志\n", id - 200 }
                    if (ir) { print "  [内容不同，旧版已备份后覆盖]"; lir = (ir > 200 ? 200 : ir); for (i = 1; i <= lir; i++) print "    " r[i]; if (ir > 200) printf "    ... 其余 %d 条见日志\n", ir - 200 }
                    if (ic) { print "  [未处置，仍留在中转区]"; lic = (ic > 200 ? 200 : ic); for (i = 1; i <= lic; i++) print "    " c[i]; if (ic > 200) printf "    ... 其余 %d 条见日志\n", ic - 200 }
                    if (if_) { print "  [失败]"; lif = (if_ > 200 ? 200 : if_); for (i = 1; i <= lif; i++) print "    " f[i]; if (if_ > 200) printf "    ... 其余 %d 条见日志\n", if_ - 200 }
                }' "$REPORT"
            echo
        done

        echo "本邮件由 $(hostname -s) 上的 pdk_mover.sh 自动发送，日志 $LOG，请勿直接回复。"
    } > "$BODY"

    SUBJECT="[PDK同步] $STAMP 迁移 $MOVED / 重复清理 $DEDUP / 覆盖 $REPLACED 个文件"
    [ "$DRYRUN" = "1" ] && SUBJECT="[PDK同步-DRYRUN] $STAMP 计划迁移 $MOVED 个文件"

    python3 "$MAILER" "$SMTP_HOST" "$SMTP_PORT" "$MAIL_FROM" "$SMTP_USER" "$SMTP_PASS" \
        "$MAIL_TO" "$MAIL_CC" "$SUBJECT" "$BODY" >> "$LOG" 2>&1 \
        && log "[mail] sent to $MAIL_TO cc=$MAIL_CC" \
        || log "[mail] FAILED to send"
fi

rm -f "$REPORT" "$BODY"
exit 0
