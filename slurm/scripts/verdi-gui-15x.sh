#!/bin/bash
# ---------------------------------------------------------------------------
# verdi-gui-15x.sh
#   在 eda15x（eda151-eda155）申请 1 节点，然后把 Verdi 图形界面通过
#   ssh -Y 显示到"你当前所在的桌面"。
#
#   直接运行 = 交互式向导，一步步询问：节点 → CPU 核数 → 内存 → 时长 →
#   工作目录 → Verdi 启动参数 → 确认后提交。
#
# 用法：
#   verdi-gui-15x.sh                                 # 交互式向导（推荐）
#   verdi-gui-15x.sh -n 154 -c 2 -m 32 -t 24 -y      # 全参数 + 免确认
#   verdi-gui-15x.sh --dry-run                       # 只走到向导结束，打印提交命令，不真跑
#   verdi-gui-15x.sh -h                              # 查看帮助
#
# 常用启动方式（放在 -- 之后）：
#   -- -ssf wave.fsdb                      打开波形文件
#   -- -f filelist.f -ssf wave.fsdb        载入设计 + 波形
#   -- -dbdir simv.daidir -ssf wave.fsdb   载入 VCS 编译好的数据库 + 波形
#   -- -sv -f filelist.f                   SystemVerilog 设计
#   -- -nologo -ssf wave.fsdb              跳过欢迎页
#   （不写 -- xxx 则打开空的 Verdi，进去再 File → Open）
#
# 选项（给了就跳过对应提问）：
#   -n 151-155   节点        -c 核数(1-112)   -m 内存GB(1-1900)
#   -t 小时(1-128)  -d 工作目录   -y 免确认   -- 后面全部透传给 verdi
#
# 说明：
#   * 必须在"有 DISPLAY 的终端"里运行（你当前 RDP 桌面里的终端即可）。
#   * 关掉 Verdi（或 Ctrl-C 本脚本）会释放 Slurm 作业，不会占着节点。
#   * 集群单作业硬上限 128 小时；到期作业结束，重新运行本脚本即可。
#   * Verdi 需要 license（VERDI-* 系列特性）；license 占满时会启动失败。
#   * 日志默认写到 <工作目录>/verdiLog（可用 -- -logdir 自己指定）。
# ---------------------------------------------------------------------------
set -uo pipefail

CPUS=""
MEM=""
HOURS=""
NODE_NUM=""
WORKDIR=""
EXTRA=()
ASSUME_YES=0
DRY_RUN=0

BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; GRN=$'\033[32m'; YEL=$'\033[33m'; CYN=$'\033[36m'; RST=$'\033[0m'
[[ -t 1 ]] || { BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; CYN=""; RST=""; }

usage() { awk 'NR>2 && /^# -----/{exit} NR>2{sub(/^# ?/,""); print}' "$0"; }
die()   { echo "${RED}错误: $*${RST}" >&2; exit 1; }
info()  { echo "${CYN}$*${RST}"; }
ok()    { echo "${GRN}$*${RST}"; }
warn()  { echo "${YEL}$*${RST}"; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    -n) NODE_NUM="${2:-}"; shift 2 ;;
    -c) CPUS="${2:-}";     shift 2 ;;
    -m) MEM="${2:-}";      shift 2 ;;
    -t) HOURS="${2:-}";    shift 2 ;;
    -d) WORKDIR="${2:-}";  shift 2 ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --) shift; EXTRA=("$@"); break ;;
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（-h 查看用法）" ;;
  esac
done

check_int() { [[ "$1" =~ ^[0-9]+$ ]]; }

# ---------------------------------------------------------------------------
# 交互提问工具
# ---------------------------------------------------------------------------
ask() {           # <提示> <默认值>  -> REPLY_VAL
  local prompt="$1" default="${2:-}" ans
  while :; do
    if [[ -n "$default" ]]; then
      read -r -p "  ${BOLD}${prompt}${RST} [${default}]: " ans || { echo; die "输入中断"; }
    else
      read -r -p "  ${BOLD}${prompt}${RST}: " ans || { echo; die "输入中断"; }
    fi
    ans="${ans#"${ans%%[![:space:]]*}"}"; ans="${ans%"${ans##*[![:space:]]}"}"
    [[ -z "$ans" ]] && ans="$default"
    case "$ans" in
      q|Q|quit|exit) echo "  已取消。"; exit 0 ;;
    esac
    [[ -n "$ans" ]] && { REPLY_VAL="$ans"; return 0; }
    warn "  不能为空，请重新输入（输入 q 退出）"
  done
}

ask_int() {       # <提示> <默认> <最小> <最大> <单位说明> -> REPLY_VAL
  local prompt="$1" default="$2" min="$3" max="$4" unit="${5:-}" ans
  while :; do
    ask "${prompt}${unit:+（$unit）}" "$default"
    ans="$REPLY_VAL"
    if ! check_int "$ans"; then warn "  请输入整数"; continue; fi
    if (( ans < min || ans > max )); then warn "  取值范围 ${min}-${max}"; continue; fi
    REPLY_VAL="$ans"; return 0
  done
}

ask_opt() {       # 允许空回答，空 = 不填 -> REPLY_VAL 为空串
  local prompt="$1" ans
  read -r -p "  ${BOLD}${prompt}${RST}（回车=空）: " ans || { echo; die "输入中断"; }
  ans="${ans#"${ans%%[![:space:]]*}"}"; ans="${ans%"${ans##*[![:space:]]}"}"
  case "$ans" in q|Q|quit|exit) echo "  已取消。"; exit 0 ;; esac
  REPLY_VAL="$ans"
}

hr() { printf '%s\n' "${DIM}--------------------------------------------------------------------${RST}"; }

# ===========================================================================
# 0. 环境自检
# ===========================================================================
[[ -n "${DISPLAY:-}" ]] || die "当前终端没有 DISPLAY。请在你自己的图形桌面（RDP 会话）里的终端中运行本脚本。"
command -v salloc >/dev/null 2>&1 || die "找不到 salloc，请确认在集群节点上运行"
command -v squeue >/dev/null 2>&1 || die "找不到 squeue，请确认在集群节点上运行"

if [[ -t 0 ]]; then INTERACTIVE=1; else INTERACTIVE=0; fi
if [[ $INTERACTIVE -eq 0 && $ASSUME_YES -eq 0 && -z "$NODE_NUM" ]]; then
  die "当前不是交互终端，请用参数运行，例如：$0 -n 154 -c 2 -m 32 -t 128 -y"
fi

# 统一用户名：部分节点 $USER 带域后缀（如 linyiyao@tri.local），
# 而共享工作区目录是 /eda/workspace/users/linyiyao —— 去掉后缀保证默认目录一致
USER_SHORT="${USER:-$(id -un)}"; USER_SHORT="${USER_SHORT%%@*}"

# ===========================================================================
# 1. 交互向导
# ===========================================================================
echo
info "===================================================================="
info " Verdi 图形界面启动向导  —  分区 eda15x（eda151 - eda155）"
info " 每一步直接回车 = 使用方括号里的默认值，输入 q = 退出"
info "===================================================================="
echo

# --- 1/6 节点 --------------------------------------------------------------
if [[ -z "$NODE_NUM" ]]; then
  [[ $INTERACTIVE -eq 1 ]] && echo "${BOLD}[1/6] 选择运行节点${RST}"
  echo "  正在读取 151-155 的实时负载…"
  declare -A N_STATE N_CPU_FREE N_CPU_TOT N_MEM_FREE N_MEM_TOT N_JOBS
  best_node=""; best_free=-1
  for n in 151 152 153 154 155; do
    ip="172.16.50.$n"
    line=$(scontrol show node -o "$ip" 2>/dev/null)
    if [[ -z "$line" ]]; then
      N_STATE[$n]="?"; N_CPU_FREE[$n]=0; N_CPU_TOT[$n]=0
      N_MEM_FREE[$n]=0; N_MEM_TOT[$n]=0; N_JOBS[$n]=0
      continue
    fi
    cput=$(sed -n 's/.* CPUTot=\([0-9]*\).*/\1/p' <<<"$line")
    cpua=$(sed -n 's/.* CPUAlloc=\([0-9]*\).*/\1/p' <<<"$line")
    memr=$(sed -n 's/.* RealMemory=\([0-9]*\).*/\1/p' <<<"$line")
    mema=$(sed -n 's/.* AllocMem=\([0-9]*\).*/\1/p' <<<"$line")
    st=$(sed -n 's/.* State=\([A-Z+]*\).*/\1/p' <<<"$line")
    cput=${cput:-0}; cpua=${cpua:-0}; memr=${memr:-0}; mema=${mema:-0}
    N_STATE[$n]="${st:-?}"
    N_CPU_TOT[$n]=$cput
    N_CPU_FREE[$n]=$(( cput - cpua )); (( N_CPU_FREE[$n] < 0 )) && N_CPU_FREE[$n]=0
    N_MEM_TOT[$n]=$(( memr / 1024 ))
    N_MEM_FREE[$n]=$(( (memr - mema) / 1024 )); (( N_MEM_FREE[$n] < 0 )) && N_MEM_FREE[$n]=0
    N_JOBS[$n]=$(squeue -h -w "$ip" -t RUNNING -o '%i' 2>/dev/null | wc -l)
    if (( N_CPU_FREE[$n] > best_free )); then best_free=${N_CPU_FREE[$n]}; best_node=$n; fi
  done
  best_node=${best_node:-151}

  printf '  %-4s %-6s %-18s %-22s %-6s\n' "编号" "状态" "CPU 空闲/已用/总" "内存空闲/已用/总(GB)" "作业数"
  for n in 151 152 153 154 155; do
    cpu_used=$(( N_CPU_TOT[$n] - N_CPU_FREE[$n] ));  (( cpu_used < 0 )) && cpu_used=0
    mem_used=$(( N_MEM_TOT[$n] - N_MEM_FREE[$n] )); (( mem_used < 0 )) && mem_used=0
    printf '  %-4s %-6s %-18s %-22s %-6s\n' \
      "$n" "${N_STATE[$n]}" \
      "${N_CPU_FREE[$n]}/${cpu_used}/${N_CPU_TOT[$n]}" \
      "${N_MEM_FREE[$n]}/${mem_used}/${N_MEM_TOT[$n]}" \
      "${N_JOBS[$n]}"
  done
  if [[ $INTERACTIVE -eq 1 ]]; then
    echo "${DIM}  提示：空闲 CPU 最多的是 ${best_node}${RST}"
    ask_int "选择节点编号（151-155）" "$best_node" 151 155 ""
  else
    REPLY_VAL="$best_node"
    echo "${DIM}[1/6] 自动选择空闲 CPU 最多的节点：eda${best_node}${RST}"
  fi
  NODE_NUM="$REPLY_VAL"
  echo
else
  [[ "$NODE_NUM" =~ ^15[1-5]$ ]] || die "-n 只能是 151-155"
  echo "${DIM}[1/6] 节点：eda${NODE_NUM}（命令行指定）${RST}"
fi

# --- 2/6 CPU ---------------------------------------------------------------
if [[ -z "$CPUS" ]]; then
  if [[ $INTERACTIVE -eq 1 ]]; then
    echo "${BOLD}[2/6] CPU 核数${RST}  ${DIM}Verdi 看波形以单线程为主，2 核通常够用${RST}"
    ask_int "CPU 核数" 2 1 112 ""
  else
    REPLY_VAL=2; echo "${DIM}[2/6] CPU：2 核（非交互，用默认值）${RST}"
  fi
  CPUS="$REPLY_VAL"
  echo
else
  check_int "$CPUS" || die "-c 必须是整数"
  (( CPUS >= 1 && CPUS <= 112 )) || die "-c 取值 1-112"
  echo "${DIM}[2/6] CPU：${CPUS} 核（命令行指定）${RST}"
fi

# --- 3/6 内存 --------------------------------------------------------------
if [[ -z "$MEM" ]]; then
  if [[ $INTERACTIVE -eq 1 ]]; then
    echo "${BOLD}[3/6] 内存${RST}  ${DIM}Verdi 载入 FSDB 靠内存，波形大就多给（64G/128G）${RST}"
    ask_int "内存大小" 32 1 1900 "GB"
  else
    REPLY_VAL=32; echo "${DIM}[3/6] 内存：32G（非交互，用默认值）${RST}"
  fi
  MEM="$REPLY_VAL"
  echo
else
  check_int "$MEM" || die "-m 必须是整数"
  (( MEM >= 1 && MEM <= 1900 )) || die "-m 取值 1-1900"
  echo "${DIM}[3/6] 内存：${MEM}G（命令行指定）${RST}"
fi

# --- 4/6 时长 --------------------------------------------------------------
if [[ -z "$HOURS" ]]; then
  if [[ $INTERACTIVE -eq 1 ]]; then
    echo "${BOLD}[4/6] 运行时长${RST}  ${DIM}集群硬上限 128 小时，到期作业自动结束${RST}"
    ask_int "运行时长" 128 1 128 "小时"
  else
    REPLY_VAL=128; echo "${DIM}[4/6] 时长：128 小时（非交互，用默认值）${RST}"
  fi
  HOURS="$REPLY_VAL"
  echo
else
  check_int "$HOURS" || die "-t 必须是整数"
  (( HOURS >= 1 && HOURS <= 128 )) || die "-t 取值 1-128（集群硬上限）"
  echo "${DIM}[4/6] 时长：${HOURS} 小时（命令行指定）${RST}"
fi

# --- 5/6 工作目录 ----------------------------------------------------------
if [[ -z "$WORKDIR" ]]; then
  if [[ $INTERACTIVE -eq 0 ]]; then
    WORKDIR="/eda/workspace/users/$USER_SHORT"
    echo "${DIM}[5/6] 工作目录：${WORKDIR}（非交互，用默认值）${RST}"
  else
  echo "${BOLD}[5/6] 工作目录${RST}  ${DIM}必须放共享存储；各节点本地 /home 不共享${RST}"
  ask "工作目录" "/eda/workspace/users/$USER_SHORT"
  WORKDIR="$REPLY_VAL"
  [[ "$WORKDIR" == "~"* ]] && WORKDIR="${HOME}${WORKDIR#\~}"
  if [[ "$WORKDIR" != /eda/workspace/* ]]; then
    warn "  ⚠ 该目录不在 /eda/workspace 下，计算节点可能访问不到；继续请回车，重新输入请改"
    ask "确认工作目录" "$WORKDIR"
    WORKDIR="$REPLY_VAL"
  fi
  echo
  fi
else
  echo "${DIM}[5/6] 工作目录：${WORKDIR}（命令行指定）${RST}"
fi

# --- 6/6 verdi 参数 --------------------------------------------------------
if [[ ${#EXTRA[@]} -eq 0 && $ASSUME_YES -eq 0 ]]; then
  echo "${BOLD}[6/6] Verdi 启动参数${RST}"
  echo "  ${DIM}直接回车 = 空的 Verdi，进去再 File → Open${RST}"
  echo "  ${DIM}常用：-ssf wave.fsdb | -f filelist.f -ssf wave.fsdb | -dbdir simv.daidir -ssf wave.fsdb${RST}"
  ask_opt "Verdi 启动参数"
  if [[ -n "$REPLY_VAL" ]]; then
    # shellcheck disable=SC2206
    EXTRA=( $REPLY_VAL )
  fi
  echo
fi

# 若用户没自己指定日志位置，把 Verdi 日志放进工作目录
# （151-155 的 /home 各自独立，默认写 ~/verdiLog 会留在计算节点上找不到）
has_logopt=0
for a in ${EXTRA+"${EXTRA[@]}"}; do
  case "$a" in -logdir|-logDir|-logfile|-logFile) has_logopt=1 ;; esac
done
if [[ $has_logopt -eq 0 ]]; then
  EXTRA+=(-logdir "$WORKDIR/verdiLog")
fi

# ===========================================================================
# 2. 汇总确认
# ===========================================================================
TIME_SPEC=$(printf '%d-%02d:00:00' $((HOURS / 24)) $((HOURS % 24)))

# 资源可行性提醒（不阻止提交，Slurm 会按真实空闲排队）
node_line=$(scontrol show node -o "172.16.50.${NODE_NUM}" 2>/dev/null)
SHORTAGE=""
if [[ -n "$node_line" ]]; then
  nc_tot=$(sed -n 's/.* CPUTot=\([0-9]*\).*/\1/p' <<<"$node_line"); nc_alc=$(sed -n 's/.* CPUAlloc=\([0-9]*\).*/\1/p' <<<"$node_line")
  nm_tot=$(sed -n 's/.* RealMemory=\([0-9]*\).*/\1/p' <<<"$node_line"); nm_alc=$(sed -n 's/.* AllocMem=\([0-9]*\).*/\1/p' <<<"$node_line")
  nc_free=$(( ${nc_tot:-0} - ${nc_alc:-0} )); nm_free=$(( (${nm_tot:-0} - ${nm_alc:-0}) / 1024 ))
  (( nc_free < CPUS )) && SHORTAGE+="  ⚠ eda${NODE_NUM} 当前空闲 CPU 只有 ${nc_free} 核（申请 ${CPUS} 核），可能要排队；"$'\n'
  (( nm_free < MEM ))  && SHORTAGE+="  ⚠ eda${NODE_NUM} 当前空闲内存只有 ${nm_free}G（申请 ${MEM}G），可能要排队；"$'\n'
fi

hr
echo "${BOLD}将要提交的作业：${RST}"
echo "  分区      : eda15x"
echo "  节点      : 172.16.50.${NODE_NUM}  (eda${NODE_NUM})"
echo "  CPU / 内存: ${CPUS} 核 / ${MEM}G"
echo "  时长      : ${HOURS} 小时  (Slurm 写法 ${TIME_SPEC})"
echo "  工作目录  : ${WORKDIR}"
echo "  verdi     : ${EXTRA[*]:-（空会话）}"
echo "  画面      : 通过 ssh -Y 显示到当前桌面 DISPLAY=${DISPLAY}"
hr
[[ -n "$SHORTAGE" ]] && { warn "$SHORTAGE"; }

if [[ $ASSUME_YES -eq 0 && $DRY_RUN -eq 0 ]]; then
  while :; do
    read -r -p "  确认提交？[Y/n] " yn || die "输入中断"
    case "${yn:-Y}" in
      y|Y|yes|YES) break ;;
      n|N|no|NO) echo "  已取消，未提交任何作业。"; exit 0 ;;
      *) warn "  请输入 y 或 n" ;;
    esac
  done
fi

ALLOC=(-p eda15x -N1 -n1 -c "$CPUS" --mem="${MEM}G" --time="$TIME_SPEC" -J "verdi-gui")
ALLOC+=(-w "172.16.50.${NODE_NUM}")

if [[ $DRY_RUN -eq 1 ]]; then
  echo
  ok "dry-run：不会真正提交。等价命令："
  echo "  salloc --no-shell ${ALLOC[*]}"
  exit 0
fi

# ===========================================================================
# 3. 提交并等待资源
# ===========================================================================
echo
info ">>> 提交作业…"
out=$(salloc --no-shell "${ALLOC[@]}" 2>&1)
rc=$?
if [[ $rc -ne 0 ]]; then
  echo "$out" >&2
  die "salloc 失败（节点满载时会一直排队；可用 sinfo 查看空闲情况）"
fi
JOBID=$(sed -n 's/.*job allocation \([0-9]\+\).*/\1/p' <<<"$out" | tail -1)
[[ -n "$JOBID" ]] || { echo "$out" >&2; die "无法解析作业号"; }

CLEANED=0
cleanup() {
  [[ $CLEANED -eq 1 ]] && return
  CLEANED=1
  echo
  echo ">>> 释放作业 $JOBID"
  scancel "$JOBID" 2>/dev/null
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

NODELIST=""
waited=0
while (( waited < 600 )); do
  NODELIST=$(squeue -h -j "$JOBID" -o '%N' 2>/dev/null)
  if [[ -n "$NODELIST" && "$NODELIST" != "(null)" ]]; then break; fi
  st=$(squeue -h -j "$JOBID" -o '%T' 2>/dev/null)
  if [[ -z "$st" ]]; then NODELIST=""; break; fi
  (( waited % 10 == 0 )) && echo "    作业 $JOBID 排队中（${st}，已等 ${waited} 秒）…"
  sleep 2; waited=$((waited + 2))
done
[[ -n "$NODELIST" ]] || die "作业 $JOBID 没有分到节点（squeue -j $JOBID 查看原因）"

NODE_HOST=$(getent hosts "$NODELIST" 2>/dev/null | awk '{print $2}')
if [[ -z "$NODE_HOST" ]]; then
  guess="eda${NODELIST##*.}"
  if getent hosts "$guess" >/dev/null 2>&1; then NODE_HOST="$guess"; else NODE_HOST="$NODELIST"; fi
fi

ok ">>> 作业 $JOBID 已运行在 $NODELIST ($NODE_HOST)"
echo ">>> 正在通过 ssh -Y 打开 Verdi，首次连接请输入你的域账号密码"
echo

# ===========================================================================
# 4. 启动 verdi
# ===========================================================================
remote="mkdir -p $(printf '%q' "$WORKDIR") $(printf '%q' "$WORKDIR/verdiLog") && cd $(printf '%q' "$WORKDIR") && export PATH=/eda/env/commands/bin:\$PATH && exec verdi"
for a in ${EXTRA+"${EXTRA[@]}"}; do remote+=" $(printf '%q' "$a")"; done

ssh -F /dev/null \
    -o ForwardX11=yes -o ForwardX11Trusted=yes \
    -o PreferredAuthentications=password,gssapi-with-mic,publickey \
    -o ServerAliveInterval=60 -o ServerAliveCountMax=3 \
    -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
    "$NODE_HOST" "$remote"
SSH_RC=$?

echo
if [[ $SSH_RC -eq 255 ]]; then
  warn "提示: ssh 没能建立连接（首次使用请确认输入的域账号密码正确）。"
  warn "      若提示 X11 forwarding 被拒绝，说明该节点未开 X11Forwarding，"
  warn "      可改用 OOD EDA Desktop：https://edas.tri.local → Interactive Apps → EDA Desktop"
  warn ">>> 作业 $JOBID 已释放。"
elif [[ $SSH_RC -eq 0 ]]; then
  ok ">>> Verdi 已退出，作业 $JOBID 已释放。"
else
  warn ">>> ssh 退出码 $SSH_RC，作业 $JOBID 已释放。"
  warn "    若刚启动就退出，常见原因是 Synopsys license 被占满，"
  warn "    用 lmstat -c 27100@eda -a 查看 VERDI-* 特性占用情况。"
fi
exit $SSH_RC
