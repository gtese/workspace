# innovus-gui-15x.sh 注释指南

> 脚本位置：`/eda/workspace/share/innovus-gui-15x.sh`（383 行，可执行，全用户可读）
> 本文档：逐段注解脚本实现，说明设计意图、依赖事实与已知细节，便于用户理解与运维维护。
> 适用集群：tricluster ｜ 分区 `eda15x` ｜ 节点 `eda151-eda155`（`172.16.50.151-155`）

---

## 1. 它解决什么问题

Innovus 是 Cadence 的图形化布局布线工具，必须在**图形界面**里操作。集群的图形算力在 `eda151-155`，而用户的桌面（RDP 会话）跑在 `131-133/150` 上。

传统做法要手工三件事：登录计算节点、`export DISPLAY`、配 X11 转发，既麻烦又容易把作业占成"孤儿节点"。

本脚本把这三件事自动化成**一次向导**：

```
当前 RDP 桌面
   │  ① salloc 向 Slurm 申请 1 个节点（显式 CPU / 内存 / 时长）
   ▼
eda15X 计算节点
   │  ② 在该节点上 cd 到你的工作目录，启动 innovus
   ▼
   │  ③ 窗口通过 ssh -Y（X11 转发）回传到你当前桌面
你眼前看到 Innovus GUI
```

**关键设计**：`innovus` 进程是 ssh 会话的子进程，ssh 会话又绑定在 Slurm 作业上。因此**关掉 Innovus（或 Ctrl-C 脚本）→ ssh 退出 → 脚本 `trap` 触发 `scancel` → 节点立即释放**，不会出现"人走了节点还占着"的情况。

---

## 2. 前置条件

| 条件 | 说明 | 缺失时的表现 |
|---|---|---|
| **在有 DISPLAY 的终端里运行** | 即你自己的 RDP 桌面里的终端（GNOME Terminal / xterm） | 脚本直接报错退出（见 5.5 节） |
| 提交节点上有 `salloc`/`squeue` | `150` 是提交节点，`131-133` 也可（同一 Slurm 集群） | 报"找不到 salloc" |
| 工作目录在 `/eda/workspace` 下 | 各计算节点本地 `/home` **不共享**，只有 `/eda/workspace` 是共享存储 | 会警告，且启动后可能找不到文件 |
| 计算节点开启 X11 转发 | 已实测 151-155 全部 `X11Forwarding yes` | ssh 会提示 X11 forwarding 被拒 |
| 域账号密码 | `ssh -Y` 首次连接需要交互输入 | 提示"首次使用请确认密码正确" |

> **不需要** `sbatch`，本脚本用的是 `salloc`（交互式分配），所以**不必写作业脚本**。

---

## 3. 三种用法

### 3.1 交互式向导（推荐给新用户）

```bash
/eda/workspace/share/innovus-gui-15x.sh
```

会依次问 6 个问题，**每一步直接回车 = 用默认值**，输入 `q` 随时退出：

```
[1/6] 选择运行节点      → 打印 151-155 的实时 CPU/内存/作业数表格，默认选空闲 CPU 最多的
[2/6] CPU 核数          → 默认 2；Innovus 多线程用，调研/小设计 2 核够
[3/6] 内存              → 默认 32GB；【必填项，原因见 5.8】
[4/6] 运行时长          → 默认 128 小时（= 集群硬上限）
[5/6] 工作目录          → 默认 /eda/workspace/users/$USER
[6/6] Innovus 启动参数  → 默认空会话；也可填 -files run.tcl 等
```

### 3.2 全参数一次到位（熟练用户）

```bash
# 指定 154 节点、4 核、64G、24 小时、免确认
innovus-gui-15x.sh -n 154 -c 4 -m 64 -t 24 -y

# 带 Innovus 参数（-- 之后全部原样透传）
innovus-gui-15x.sh -n 153 -c 8 -m 128 -t 48 -y -- -files run.tcl -legacy_ui

# 打开已有设计数据库
innovus-gui-15x.sh -n 152 -c 4 -m 64 -y -- -db /eda/workspace/users/$USER/proj/DB
```

### 3.3 只看不跑（预演）

```bash
innovus-gui-15x.sh --dry-run
```

走到向导结束、打印出等价 `salloc` 命令后退出，**不分配资源**。适合确认参数是否正确。

### 3.4 查帮助

```bash
innovus-gui-15x.sh -h
```

---

## 4. 命令行参数速查

| 参数 | 含义 | 取值范围 | 默认 |
|---|---|---|---|
| `-n <151-155>` | 指定节点 | 151-155 | 空闲 CPU 最多者 |
| `-c <N>` | CPU 核数 | 1-112 | 2 |
| `-m <GB>` | 内存 | 1-1900 | 32 |
| `-t <小时>` | 运行时长 | 1-128 | 128 |
| `-d <目录>` | 工作目录 | 建议 `/eda/workspace/...` | `/eda/workspace/users/$USER` |
| `-y` / `--yes` | 跳过确认 | - | 关 |
| `--dry-run` | 只预演不提交 | - | 关 |
| `--` | 其后全部透传给 innovus | - | 无 |
| `-h` / `--help` | 显示帮助 | - | 无 |

> 参数取值范围不是随手写的：`112` = 节点 CPUTot，`1900` ≈ RealMemory 1945600MB，`128` = 分区 TIMELIMIT `5-08:00:00`。详见第 7 节实测数据。

---

## 5. 逐段代码注解

### 5.1 文件头：帮助文本即代码（第 1-24 行）

```bash
#!/bin/bash
# ---------------------------------------------------------------------------
# innovus-gui-15x.sh
#   在 eda15x（eda151-eda155）申请 1 节点，然后把 Innovus 图形界面通过
#   ssh -Y 显示到"你当前所在的桌面"。
#   ...（用法、选项、说明）
# ---------------------------------------------------------------------------
```

注意结尾那行 `# ------...-----` **不是装饰**，它是帮助文本的结束标记，被下面的 `usage()` 用来截断：

```bash
usage() { awk 'NR>2 && /^# -----/{exit} NR>2{sub(/^# ?/,""); print}' "$0"; }
```

**逐段解释**：
- `NR>2`：跳过第 1 行 shebang 和第 2 行标题
- `/^# -----/{exit}`：遇到第一条分隔线就停止 → **头注释就是 `-h` 的输出**
- `sub(/^# ?/,"")`：去掉每行开头的 `# ` 或 `#`

✅ **好处**：改帮助只需改注释，不会出现"文档和代码不同步"。
⚠️ **注意**：修改头部注释时**不要动那条分隔线**，否则 `-h` 输出会被截断。

### 5.2 Shell 选项与配色（第 25-37 行）

```bash
set -uo pipefail
```

三个开关的取舍：

| 开关 | 作用 | 为什么这么选 |
|---|---|---|
| `-u` | 引用未定义变量即报错 | 防止 `$CPUS` 拼错变成空串导致提交错误参数 |
| `-o pipefail` | 管道中任一环失败即整体失败 | 脚本大量用 `sed -n '...' <<<"$line"`，需要能感知失败 |
| **没有 `-e`** | 不因单条命令失败就退出 | 有意为之：`scontrol` 探测失败要能继续，`salloc` 失败要自己打印完整输出后再退出 |

配色部分：

```bash
BOLD=$'\033[1m'; DIM=$'\033[2m'; RED=$'\033[31m'; ... RST=$'\033[0m'
[[ -t 1 ]] || { BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; CYN=""; RST=""; }
```

`[[ -t 1 ]]` 判断 stdout 是不是终端。**不是终端（例如输出重定向到日志）就把颜色清空**，避免日志里出现一堆 `^[[1m` 乱码。这是写可自动化脚本的良好习惯。

辅助函数（第 40-43、102 行）：

```bash
die()  { echo "${RED}错误: $*${RST}" >&2; exit 1; }   # 错误走 stderr + 非 0 退出码
info() { echo "${CYN}$*${RST}"; }                      # 青=信息
ok()   { echo "${GRN}$*${RST}"; }                      # 绿=成功
warn() { echo "${YEL}$*${RST}"; }                      # 黄=警告（不退出）
hr()   { printf '%s\n' "${DIM}----...----${RST}"; }    # 分隔线
```

### 5.3 参数解析（第 45-58 行）

```bash
while [[ $# -gt 0 ]]; do
  case "$1" in
    -n) NODE_NUM="${2:-}"; shift 2 ;;
    -c) CPUS="${2:-}";     shift 2 ;;
    ...
    -y|--yes) ASSUME_YES=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --) shift; EXTRA=("$@"); break ;;      # 关键：把剩余参数整体收进数组
    -h|--help) usage; exit 0 ;;
    *) die "未知参数: $1（-h 查看用法）" ;;
  esac
done
```

**重点是 `--)` 这一支**：`EXTRA=("$@")` 把 `--` 之后的**全部内容原样**存进数组，随后又 `break` 跳出解析。

这样设计的好处是：Innovus 自己的参数（`-files`、`-db`、`-legacy_ui`……）**不需要在脚本里逐个知道**，也不会和脚本自己的 `-c/-m/-t` 冲突——加 `--` 就能隔离开。

用 `"${2:-}"` 而不是 `"$2"`，是为了在 `-n` 后面忘记给值时不会因 `set -u` 直接崩溃，而是走后面的范围校验给出友好提示。

### 5.4 三个提问函数（第 60-100 行）

**`ask()` — 带默认值、允许 q 退出**

```bash
ans="${ans#"${ans%%[![:space:]]*}"}"    # 去掉前导空白
ans="${ans%"${ans##*[![:space:]]}"}"    # 去掉尾随空白
[[ -z "$ans" ]] && ans="$default"        # 空 = 用默认值
case "$ans" in q|Q|quit|exit) echo "  已取消。"; exit 0 ;; esac
```

那两行 `${ans#...}` 是纯 Bash 的**字符串裁剪技巧**（不依赖 `sed`/`tr`）：
- `${ans%%[![:space:]]*}` 取出"从开头到第一个非空白"的前缀 → 即前导空白
- `${ans#<前导空白>}` 把它删掉

**`ask_int()` — 循环校验直到合法**

```bash
while :; do
  ask "${prompt}${unit:+（$unit）}" "$default"
  ans="$REPLY_VAL"
  if ! check_int "$ans"; then warn "  请输入整数"; continue; fi
  if (( ans < min || ans > max )); then warn "  取值范围 ${min}-${max}"; continue; fi
  REPLY_VAL="$ans"; return 0
done
```

`${unit:+（$unit）}` 是"有则展开"语法：给了单位就显示「（GB）」，没给就不显示括号。

⚠️ 注意 `ans < min` 用的是 `(( ))` 算术上下文，此时 `ans` 会被当变量名求值；前面 `check_int` 已保证是纯数字，所以安全。

**`ask_opt()` — 允许空串**

和 `ask()` 的区别：**不填也返回空串**，用于"[6/6] Innovus 启动参数"这种可以什么都不填的场合。

**`REPLY_VAL` 而非 `REPLY`**：因为 Bash 内置的 `read` 在没有 `-r -p` 组合时会往 `REPLY` 写值，用独立变量名避免互相踩。

### 5.5 环境自检（第 104-124 行）

```bash
[[ -n "${DISPLAY:-}" ]] || die "当前终端没有 DISPLAY。请在你自己的图形桌面（RDP 会话）里的终端中运行本脚本。"
command -v salloc >/dev/null 2>&1 || die "找不到 salloc，请确认在集群节点上运行"
command -v squeue >/dev/null 2>&1 || die "找不到 squeue，请确认在集群节点上运行"

if [[ -t 0 ]]; then INTERACTIVE=1; else INTERACTIVE=0; fi
if [[ $INTERACTIVE -eq 0 && $ASSUME_YES -eq 0 && -z "$NODE_NUM" ]]; then
  die "当前不是交互终端，请用参数运行，例如：$0 -n 154 -c 2 -m 32 -t 128 -y"
fi
```

两个关键判断：

1. **`$DISPLAY` 必须非空**——否则后面 `ssh -Y` 就算成功，窗口也没地方显示。提前失败比"申请完节点才发现看不到界面"体验好得多。
2. **`[[ -t 0 ]]` 判断 stdin 是不是终端**——用于支持"在脚本/CI 里调用"。非交互时**必须**给全参数，否则会给出示例而不是卡在 `read` 上等输入（在管道里 `read` 会立刻读到 EOF 死循环）。

### 5.6 第 1 步：探测节点并智能推荐（第 126-178 行）

这是全脚本最有价值的一段。它对 151-155 逐个做：

```bash
line=$(scontrol show node -o "$ip" 2>/dev/null)          # -o = 单行输出，便于解析
cput=$(sed -n 's/.* CPUTot=\([0-9]*\).*/\1/p' <<<"$line")
cpua=$(sed -n 's/.* CPUAlloc=\([0-9]*\).*/\1/p' <<<"$line")
memr=$(sed -n 's/.* RealMemory=\([0-9]*\).*/\1/p' <<<"$line")   # 单位 MB
mema=$(sed -n 's/.* AllocMem=\([0-9]*\).*/\1/p' <<<"$line")
st=$(sed -n 's/.* State=\([A-Z+]*\).*/\1/p' <<<"$line")

N_CPU_FREE[$n]=$(( cput - cpua )); (( N_CPU_FREE[$n] < 0 )) && N_CPU_FREE[$n]=0
N_MEM_TOT[$n]=$(( memr / 1024 ))                                   # MB → GB
N_MEM_FREE[$n]=$(( (memr - mema) / 1024 ))
N_JOBS[$n]=$(squeue -h -w "$ip" -t RUNNING -o '%i' 2>/dev/null | wc -l)
if (( N_CPU_FREE[$n] > best_free )); then best_free=${N_CPU_FREE[$n]}; best_node=$n; fi
```

**几个细节**：

- **`scontrol show node -o`**：普通模式是多行 Key=Value，`-o` 压成一行，才能用 `sed` 精准取字段。
- **`sed -n 's/...\([0-9]*\).../\1/p'`**：只打印捕获组。匹配不到时输出空，所以后面都用 `${cput:-0}` 兜底——**这正是 `set -u` 与"探测失败也要能继续"的折中**。
- **内存单位**：`RealMemory` 是 **MB**，除 1024 得 GB，和用户输入的 `-m 32`（GB）对齐。
- **负数保护**：`CPUAlloc` 可能因 Slurm 统计口径略超 `CPUTot`，`< 0` 归零，避免表格里出现 `-/95/112` 这种怪值。
- **`squeue -h -w`**：`-h` 去掉表头，`-w` 只看该节点，`-t RUNNING` 只看在跑的。
- **`best_node` 选的是"空闲 CPU 最多"**，不是"空闲内存最多"或"作业数最少"。因为 Innovus 图形主要吃 CPU 渲染；内存通常申请量小（默认 32G），而节点有 1900G。

用关联数组 `declare -A` 存五列数据，再统一 `printf` 出表格，避免边探测边打印造成输出错乱。

### 5.7 第 2-4 步：CPU / 内存 / 时长（第 180-226 行）

三步结构完全对称，都是"命令行给了就校验并跳过提问，没给就进向导"：

```bash
if [[ -z "$CPUS" ]]; then
  ... ask_int "CPU 核数" 2 1 112 ""
  CPUS="$REPLY_VAL"
else
  check_int "$CPUS" || die "-c 必须是整数"
  (( CPUS >= 1 && CPUS <= 112 )) || die "-c 取值 1-112"
fi
```

**范围值的来历**（已实测，见第 7 节）：

| 项 | 范围 | 依据 |
|---|---|---|
| CPU | 1-112 | `scontrol show node` 的 `CPUTot=112` |
| 内存 | 1-1900 | `RealMemory=1945600MB ≈ 1900GB` |
| 时长 | 1-128 | 分区 `TIMELIMIT=5-08:00:00` = 5×24+8 = **128 小时** |

> 时长超过 128 会被 `job_submit.lua` / Slurm 直接拒绝，实测报错原文：
> `提交被拒绝：作业时长上限为 128 小时（5-08:00:00）`

**默认值的设计意图**：CPU=2、内存=32G 是"调研/看数据库"这类轻量用途的够用值；时长=128 是上限，因为作业会随 Innovus 关闭自动释放，**填上限不会造成浪费**（不会因为申请 128h 就真占 128h）。

### 5.8 第 3 步的特殊性：内存为什么必须显式申请

```bash
echo "${BOLD}[3/6] 内存${RST}  ${DIM}每个作业必须显式申请，Slurm 按此计费/隔离${RST}"
ask_int "内存大小" 32 1 1900 "GB"
```

这不是"礼貌性询问"，而是**集群强制策略**：`job_submit.lua` 对 `eda15x`（及默认分区）执行：

```
提交到新节点分区(eda15x)的作业必须显式指定内存(--mem 或 --mem-per-cpu)，
否则拒绝提交，避免"未记账作业"多用户并发
```

被拒时的报错会提示：
```
请在作业脚本中加入: #SBATCH --mem=<大小>   例如: --mem=32G
或命令行加: --mem=32G / --mem-per-cpu=4G
```

因此脚本无论如何都会给 `salloc` 加上 `--mem=${MEM}G`（第 300 行），**不会出现"漏填内存被拒"的情况**。

### 5.9 第 5 步：工作目录（第 228-247 行）

```bash
ask "工作目录" "/eda/workspace/users/$USER"
WORKDIR="$REPLY_VAL"
[[ "$WORKDIR" == "~"* ]] && WORKDIR="${HOME}${WORKDIR#\~}"     # 展开 ~
if [[ "$WORKDIR" != /eda/workspace/* ]]; then
  warn "  ⚠ 该目录不在 /eda/workspace 下，计算节点可能访问不到；继续请回车，重新输入请改"
  ask "确认工作目录" "$WORKDIR"
  WORKDIR="$REPLY_VAL"
fi
```

**为什么必须警告**：`151-155` 的本地 `/home` 与提交节点**不是同一份**（NFS 只共享 `/eda/workspace`）。如果把工作目录设成 `/home/xxx`，`mkdir -p` 会在计算节点上建一个**空目录**，Innovus 起来后看不到设计文件，用户会以为"设计丢了"。

⚠️ **注意这里有个交互逻辑上的小坑**：警告后重新 `ask` 一次，但**没有再次校验**新输入是否仍在 `/eda/workspace` 之外。若用户第二次仍填 `/home/xxx`，脚本会照用。属于"提醒位"而非"硬拦截"，符合"高级用户可能有意为之（如节点本地临时盘）"的容忍设计。

非交互模式下（`INTERACTIVE=0`）直接取默认 `/eda/workspace/users/$USER`，不做此校验。

### 5.10 第 6 步：Innovus 参数（第 249-259 行）

```bash
if [[ ${#EXTRA[@]} -eq 0 && $ASSUME_YES -eq 0 ]]; then
  ask_opt "Innovus 启动参数"
  if [[ -n "$REPLY_VAL" ]]; then
    # shellcheck disable=SC2206
    EXTRA=( $REPLY_VAL )      # 故意不加引号：按空格拆成多个参数
  fi
fi
```

`EXTRA=( $REPLY_VAL )` **故意不加引号**——这样用户输入的字符串 `-files run.tcl -legacy_ui` 会被按空格拆成 3 个数组元素。这正是 `# shellcheck disable=SC2206` 要压掉告警的地方（SC2206 就是"避免未加引号的单词拆分"）。

如果加了引号，`-files run.tcl` 会变成一个整体参数传给 innovus，直接报错。

**若用 `-y` 且没给 `--`**，这里整段跳过，`EXTRA` 保持空 → 打开空白会话。

### 5.11 汇总确认（第 261-298 行）

```bash
TIME_SPEC=$(printf '%d-%02d:00:00' $((HOURS / 24)) $((HOURS % 24)))
```

**这是脚本里最容易看错的一行**：把"小时数"翻译成 Slurm 的 `D-HH:MM:SS` 格式。

- `HOURS=24` → `1-00:00:00`（1 天 0 小时）
- `HOURS=128` → `5-08:00:00`（5 天 8 小时）
- `HOURS=1` → `0-01:00:00`

`%02d` 保证小时两位补零，Slurm 对这个格式敏感。

接着打印作业摘要，并做**资源可行性预警**：

```bash
nc_free=$(( ${nc_tot:-0} - ${nc_alc:-0} )); nm_free=$(( (${nm_tot:-0} - ${nm_alc:-0}) / 1024 ))
(( nc_free < CPUS )) && SHORTAGE+="  ⚠ eda${NODE_NUM} 当前空闲 CPU 只有 ${nc_free} 核（申请 ${CPUS} 核），可能要排队；"$'\n'
(( nm_free < MEM ))  && SHORTAGE+="  ⚠ eda${NODE_NUM} 当前空闲内存只有 ${nm_free}G（申请 ${MEM}G），可能要排队；"$'\n'
```

**注意 `&&` 而非 `||`，"要排队"而不是"拒绝"**：Slurm 是排队系统，资源暂时不够**不是错误**，作业会等。所以这里只提示、不阻止提交——这是与 `die` 的关键区别，避免"明明可以排队等却报错退出"。

确认环节：

```bash
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
```

`${yn:-Y}` 让**直接回车等于 Y**（大写 Y 表示默认项），符合惯例。

### 5.12 组装并提交作业（第 300-322 行）

```bash
ALLOC=(-p eda15x -N1 -n1 -c "$CPUS" --mem="${MEM}G" --time="$TIME_SPEC" -J "innovus-gui")
ALLOC+=(-w "172.16.50.${NODE_NUM}")
```

逐个参数含义：

| 参数 | 含义 | 说明 |
|---|---|---|
| `-p eda15x` | 分区 | 显式指定（虽然是默认分区，写出来更清晰） |
| `-N1` | 节点数 | 1 个节点 |
| `-n1` | 任务数 | 1 个任务 |
| `-c $CPUS` | 每任务 CPU 数 | 总 CPU = `-n1 × -c CPUS` = CPUS 核 |
| `--mem=${MEM}G` | 内存 | **必需**（job_submit.lua 强制） |
| `--time=$TIME_SPEC` | 时长 | `D-HH:MM:SS` |
| `-J innovus-gui` | 作业名 | 在 `squeue` 里一眼看得出来 |
| `-w 172.16.50.N` | 指定节点 | **用 IP 精确锁定**，因为节点在 Slurm 中以 IP 注册 |

**为什么用 `-w` 而不是 `-p ... -N1` 让 Slurm 自己挑**：用户在第 1 步已经看过负载表并做了选择，`-w` 保证"选哪台就是哪台"，不会因为调度策略挑到别的机器。

dry-run 分支：

```bash
if [[ $DRY_RUN -eq 1 ]]; then
  ok "dry-run：不会真正提交。等价命令："
  echo "  salloc --no-shell ${ALLOC[*]}"
  exit 0
fi
```

⚠️ 这里 `${ALLOC[*]}` 未加引号展开，如果作业名或目录含空格会拼错；当前取值（`innovus-gui`、纯数字）都无空格，实际无影响。

真正提交：

```bash
out=$(salloc --no-shell "${ALLOC[@]}" 2>&1)
rc=$?
if [[ $rc -ne 0 ]]; then
  echo "$out" >&2
  die "salloc 失败（节点满载时会一直排队；可用 sinfo 查看空闲情况）"
fi
JOBID=$(sed -n 's/.*job allocation \([0-9]\+\).*/\1/p' <<<"$out" | tail -1)
```

**`--no-shell` 是关键**（已实测 Slurm 20.11.9 支持，man 页原文："immediately exit after allocating resources, without running a command"）：

- 不加：`salloc` 会**开一个交互 shell 挂在那里**，脚本无法继续，必须人工 `exit`。
- 加了：拿到分配后**立即返回**，作业保持 active 并占住资源，输出的 `salloc: Granted job allocation 12345` 里就有作业号。

脚本用 `sed` 从这句提示里抠出作业号，`tail -1` 防止多条提示干扰。

### 5.13 清理与信号处理（第 324-334 行）

```bash
CLEANED=0
cleanup() {
  [[ $CLEANED -eq 1 ]] && return       # 幂等：只清理一次
  CLEANED=1
  echo
  echo ">>> 释放作业 $JOBID"
  scancel "$JOBID" 2>/dev/null
}
trap cleanup EXIT
trap 'exit 130' INT      # Ctrl-C  → 130 (128+SIGINT)
trap 'exit 143' TERM     # kill    → 143 (128+SIGTERM)
```

**这是"不占着节点"的核心保障**：

- `trap cleanup EXIT` 覆盖**所有**退出路径（正常结束、`die`、意外错误）
- `INT`/`TERM` 先转成正常 `exit`，从而**触发 EXIT 里的 cleanup**，再带着正确的退出码结束
- `CLEANED` 标志防止重复 `scancel`

没有这段，用户 `Ctrl-C` 掉脚本后作业会一直挂着直到 128 小时到期。

### 5.14 等待资源并解析主机名（第 336-356 行）

```bash
NODELIST=""
waited=0
while (( waited < 600 )); do
  NODELIST=$(squeue -h -j "$JOBID" -o '%N' 2>/dev/null)
  if [[ -n "$NODELIST" && "$NODELIST" != "(null)" ]]; then break; fi
  st=$(squeue -h -j "$JOBID" -o '%T' 2>/dev/null)
  if [[ -z "$st" ]]; then NODELIST=""; break; fi          # 作业消失（被取消/失败）
  (( waited % 10 == 0 )) && echo "    作业 $JOBID 排队中（${st}，已等 $((waited/2)) 秒）…"
  sleep 2; waited=$((waited + 2))
done
```

逻辑要点：

- `squeue -o '%N'` 只有在**分配完成**后才有值；排队阶段是 `(null)` 或空
- `st` 为空说明作业已不在队列 → 跳出并报错（而不是死等）
- 上限 600 秒（10 分钟）；超时后仍无节点则 `die`
- 每 10 秒打印一次排队状态，避免用户以为卡死

> 🐛 **已知小瑕疵**（不影响功能）：`waited` 每轮 `+2`，实际等价于"秒数"，但打印时又写成 `$((waited/2))`，于是显示的时间**只有实际等待的一半**。真要修就是把 `$((waited/2))` 改成 `$((waited))`。

主机名解析（第 350-356 行）：

```bash
NODE_HOST=$(getent hosts "$NODELIST" 2>/dev/null | awk '{print $2}')
if [[ -z "$NODE_HOST" ]]; then
  guess="eda${NODELIST##*.}"                       # 172.16.50.154 → eda154
  if getent hosts "$guess" >/dev/null 2>&1; then NODE_HOST="$guess"; else NODE_HOST="$NODELIST"; fi
fi
```

`squeue %N` 返回的节点名**可能是 IP**（本集群节点以 `172.16.50.x` 注册），而 `ssh` 用主机名更稳定（便于 sshd 配置、known_hosts 管理）。所以三级兜底：

1. `getent hosts <NODELIST>` 反查主机名
2. 猜 `eda` + 最后一节 IP（`172.16.50.154` → `eda154`）
3. 都不行就用原始标识（IP 也能直连）

### 5.15 启动 Innovus：ssh -Y（第 358-373 行）

```bash
remote="mkdir -p $(printf '%q' "$WORKDIR") && cd $(printf '%q' "$WORKDIR") && export PATH=/eda/env/commands/bin:\$PATH && exec innovus"
for a in ${EXTRA+"${EXTRA[@]}"}; do remote+=" $(printf '%q' "$a")"; done
```

**远程命令拼装**：

- `printf '%q'` 对路径做 **Shell 转义**——目录名若有空格/中文/特殊字符，能被远端正确解析
- `mkdir -p`：工作目录不存在就创建
- `export PATH=/eda/env/commands/bin:$PATH`：**关键**，`innovus` 是 `/eda/env/commands/bin/` 下的包装脚本（内部经 `dispatch.py` 按 `defaults.json` 注入厂商环境与 license），不先加进 PATH 会找不到命令
- `exec innovus`：用 `exec` 让 innovus **替换** shell 进程，这样 ssh 的退出码就是 innovus 的退出码，语义更准
- `\$PATH` 里的反斜杠：表示**在远端**展开 `$PATH`，而不是在本地就被替换掉

ssh 参数（第 364-372 行）：

```bash
ssh -F /dev/null \
    -o ForwardX11=yes -o ForwardX11Trusted=yes \
    -o PreferredAuthentications=password,gssapi-with-mic,publickey \
    -o ServerAliveInterval=60 -o ServerAliveCountMax=3 \
    -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15 \
    "$NODE_HOST" "$remote"
```

| 参数 | 作用 | 为什么需要 |
|---|---|---|
| `-F /dev/null` | **忽略用户的 `~/.ssh/config`** | 防止用户个人配置（如 `ProxyJump`、`ForwardX11 no`）破坏脚本行为 |
| `ForwardX11=yes` | 开启 X11 转发 | 等价 `ssh -X` |
| `ForwardX11Trusted=yes` | 信任模式 | 等价 `ssh -Y`，允许 Innovus 使用完整 X 扩展（非信任模式会限制部分操作，GUI 可能异常） |
| `PreferredAuthentications=password,...` | 优先密码认证 | 域用户直接用 AD 密码，不要求先配密钥 |
| `ServerAliveInterval=60` + `CountMax=3` | 每 60 秒探活，3 次失败断开 | 网络瞬断时能快速发现，而不是僵死占用节点 |
| `StrictHostKeyChecking=accept-new` | 首次自动接受主机密钥 | 免得用户手工敲 `yes` |
| `ConnectTimeout=15` | 连接超时 15 秒 | 节点异常时快速失败 |

### 5.16 结果处理与退出码（第 373-383 行）

```bash
SSH_RC=$?
if [[ $SSH_RC -eq 255 ]]; then
  warn "提示: ssh 没能建立连接（首次使用请确认输入的域账号密码正确）。"
  warn "      若提示 X11 forwarding 被拒绝，说明该节点未开 X11Forwarding，"
  warn "      可改用 OOD EDA Desktop：https://edas.tri.local → Interactive Apps → EDA Desktop"
elif [[ $SSH_RC -eq 0 ]]; then
  ok ">>> Innovus 已退出，作业 $JOBID 已释放。"
else
  warn ">>> ssh 退出码 $SSH_RC，作业 $JOBID 已释放。"
fi
exit $SSH_RC
```

**退出码 255 是 ssh 的专用错误码**（连接层失败，区别于远端命令的退出码）。脚本把它单独识别出来，给出"密码错 / X11 未开"这两个最常见原因，并提供 OOD 兜底方案。

无论哪种情况，`EXIT` 的 `trap` 都会执行 `scancel`，所以三条分支都印了"作业已释放"。

---

## 6. 完整交互示例

```
$ /eda/workspace/share/innovus-gui-15x.sh

====================================================================
 Innovus 图形界面启动向导  —  分区 eda15x（eda151 - eda155）
 每一步直接回车 = 使用方括号里的默认值，输入 q = 退出
====================================================================

[1/6] 选择运行节点
  正在读取 151-155 的实时负载…
  编号 状态   CPU 空闲/已用/总    内存空闲/已用/总(GB)   作业数
  151  MIXED  14/98/112           1268/632/1900          12
  152  MIXED  22/90/112           1310/590/1900          9
  153  MIXED  8/104/112           1092/808/1900          15
  154  MIXED  30/82/112           1401/499/1900          7
  155  MIXED  3/109/112           980/920/1900           18
  提示：空闲 CPU 最多的是 154
  选择节点编号（151-155） [154]:

[2/6] CPU 核数   Innovus 多线程用；调研/小设计 2 核够用
  CPU 核数 [2]:

[3/6] 内存   每个作业必须显式申请，Slurm 按此计费/隔离
  内存大小（GB） [32]:

[4/6] 运行时长   集群硬上限 128 小时，到期作业自动结束
  运行时长（小时） [128]:

[5/6] 工作目录   必须放共享存储；各节点本地 /home 不共享
  工作目录 [/eda/workspace/users/zhoutao]:

[6/6] Innovus 启动参数
  直接回车 = 空会话；也可以填 -files run.tcl、-db <设计目录>、-legacy_ui 等
  Innovus 启动参数（回车=空）:

--------------------------------------------------------------------
将要提交的作业：
  分区      : eda15x
  节点      : 172.16.50.154  (eda154)
  CPU / 内存: 2 核 / 32G
  时长      : 128 小时  (Slurm 写法 5-08:00:00)
  工作目录  : /eda/workspace/users/zhoutao
  innovus   : （空会话）
  画面      : 通过 ssh -Y 显示到当前桌面 DISPLAY=:10.0
--------------------------------------------------------------------
  确认提交？[Y/n]:

>>> 提交作业…
>>> 作业 12345 已运行在 172.16.50.154 (eda154)
>>> 正在通过 ssh -Y 打开 Innovus，首次连接请输入你的域账号密码

zhoutao@eda154's password:
...（Innovus 界面出现在你的桌面上）...

>>> Innovus 已退出，作业 12345 已释放。
```

---

## 7. 实测集群事实（2026-11-25 核对）

写文档时对本脚本的所有硬编码取值做了实测验证，结果与代码一致：

| 项目 | 脚本中的值 | 实测结果 | 结论 |
|---|---|---|---|
| Slurm 版本 | 依赖 `--no-shell` | `slurm 20.11.9`，man 页含 `--no-shell` | ✅ 支持 |
| 节点数 | 151-155 | `172.16.50.[151-155]` | ✅ 一致 |
| 分区名 | `eda15x` | `PartitionName=eda15x Default=YES` | ✅ 且为默认分区 |
| CPUTot | `-c` 上限 112 | 每节点 `CPUTot=112` | ✅ 一致 |
| RealMemory | `-m` 上限 1900 | `RealMemory=1945600MB`（≈1900GB） | ✅ 一致 |
| TIMELIMIT | `-t` 上限 128 | `5-08:00:00` = 128 小时 | ✅ 一致 |
| X11Forwarding | 依赖 | 151-155 全部 `X11Forwarding yes` | ✅ 可用 |
| innovus 命令 | 依赖 | `/eda/env/commands/bin/innovus` 存在 | ✅ 可用 |
| 内存强制 | 依赖 | `job_submit.lua` 拒绝无 `--mem` 的 eda15x 作业 | ✅ 脚本已覆盖 |
| 依赖命令 | `salloc/squeue/scancel/scontrol/getent/ssh` | 均在 `/usr/bin` | ✅ 齐全 |

---

## 8. 常见问题

### Q1：报「当前终端没有 DISPLAY」

你是在 SSH 终端（而不是 RDP 桌面里的终端）里跑的。

**解决**：登录 RDP 桌面 → 在桌面里开一个终端再运行；或者 `ssh -Y` 进服务器后在图形终端里跑。

### Q2：卡在「作业排队中」

说明申请的资源在目标节点上暂时不够。看第 1 步的表格，换一个空闲 CPU 多的节点，或减小 `-c` / `-m`。

查全cluster空闲：
```bash
sinfo -p eda15x -o "%N %C %e %m %t"
```

### Q3：`ssh` 提示 X11 forwarding 被拒

理论上 151-155 都已开启。若真遇到，脚本会提示改用 OOD：
```
https://edas.tri.local → Interactive Apps → EDA Desktop
```

### Q4：Innovus 起来了但看不到设计文件

工作目录选错了。计算节点**只共享 `/eda/workspace`**，本地 `/home` 各节点独立。把 `-d` 指到 `/eda/workspace/users/$USER/...`。

### Q5：作业被拒「必须显式指定内存」

说明你在绕过本脚本直接用 `salloc`。请加 `--mem=32G` 或 `--mem-per-cpu=4G`。

### Q6：关掉窗口后节点还被占着？

正常情况下不会：`trap EXIT` 会自动 `scancel`。若确实残留：

```bash
squeue -u $USER                        # 找到作业号
scancel <作业号>
```

### Q7：128 小时到期了怎么办

作业会被 Slurm 终止，Innovus 随之退出。**重新运行脚本即可**，工作目录里的数据都在。

---

## 9. 二次开发提示

想改造本脚本时的几个注意点：

1. **改帮助文本**：只改第 3-23 行的 `#` 注释即可，`-h` 自动同步。**不要删那条 `# -----` 分隔线**。
2. **加新参数**：在 `while/case` 里加分支 + 在"第 2-4 步"的模式里加一段校验。注意保持"给了就跳过提问"的结构。
3. **改节点列表**：第 1 步的 `for n in 151 152 153 154 155`、`ask_int` 的 151-155、以及 `ALLOC` 的 `-w` 前缀都要一起改。
4. **换分区**：`-p eda15x` 与 `TIME_SPEC`/`MEM` 上限需按新分区的 `TIMELIMIT`/`RealMemory` 重算。
5. **别去掉 `trap`**：那是"不占节点"的唯一保障。
6. **别给 `EXTRA=( $REPLY_VAL )` 加引号**：会破坏参数拆分。
7. **`--no-shell` 不能省**：否则 `salloc` 会开交互 shell，脚本卡住。

**已知小瑕疵**（可选修）：第 5.14 节提到的排队时间显示只有实际值一半。

---

## 10. 相关文档

| 文档 | 内容 |
|---|---|
| [用户手册](02-用户手册.md) | 登录、分区、共享目录、License、FAQ |
| [新人快速上手](07-新人快速上手.md) | 堡垒机登录、建目录、提交作业 |
| [提交作业指南](06-提交作业指南.md) | EDA 作业示例与错误处理 |
| [配置文件说明](04-配置文件.md) | slurm.conf、cgroup、OOD、SELinux |
| [Slurm 项目 README](../README.md) | 架构、策略、变更记录 |

---

*本文档基于 `/eda/workspace/share/innovus-gui-15x.sh`（2026-11-20 版，383 行）整理，集群事实核对于 2026-11-25。*
