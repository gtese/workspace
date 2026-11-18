# check.sh（流媒体/游戏区域限制检测脚本）优化说明

## 这是什么

`check.sh` 是 [lmc999/RegionRestrictionCheck](https://github.com/lmc999/RegionRestrictionCheck) v1.0.1 的副本
（与上游 main 分支 `check.sh` 逐字节相同），用途是**检测当前出口 IP 在流媒体、游戏、AI 网站等平台上的区域限制情况**：

- 支持跨国平台（Netflix / Disney+ / YouTube / ChatGPT / Claude 等）与按地区分组的平台（台湾、香港、日本、北美、欧洲、韩国、东南亚等）；
- 支持 IPv4 / IPv6 / 代理 / 指定网卡 / `X-Forwarded-For`；
- 按区域并行（区块内后台任务）执行，结果按固定顺序汇总输出；
- 结束时统计运行次数（第三方计数器）。

本次在原版基础上做了**兼容性、正确性和安全性优化**，检测项本身保持不变。

## 用法

```bash
# 交互菜单（直接回车 = 全部区域）
bash check.sh

# 只测某个区域（跳过菜单）
bash check.sh -R 3          # 日本
bash check.sh -R 66         # 全部平台
bash check.sh -R 0          # 仅跨国平台
bash check.sh -R 88         # Instagram 音乐
bash check.sh -R 99         # 体育平台

# 只测 IPv4 / 只测 IPv6，英文输出
bash check.sh -M 4 -E en

# 代理 / 指定网卡
bash check.sh -P socks5://user:pass@1.2.3.4:1080
bash check.sh -I en0

# 帮助 / 版本
bash check.sh -h
bash check.sh -V
```

其他选项见 `bash check.sh -h`。

## 主要改动

### 1. macOS / BSD 可运行（关键修复）

原版大量使用 `grep -P`（PCRE），而 macOS/BSD 自带 `grep` 不支持 `-P`，脚本一启动就报
`command 'grep' function is incomplete` 退出；同时原版还要求 macOS 默认没有的 `md5sum` / `sha256sum`。

现在：

- 有 GNU grep 时行为与原版完全一致；
- 没有 GNU grep 时，自动用 `perl` 实现 `grep -P / -oP / -woP`（含 GNU `-w` 的
  `(?<!\w)(?:PAT)(?!\w)` 语义，已用 GNU grep 3.11 做过 696 组逐字节对比）；
- MD5 依次尝试 `md5sum` / `md5` / `openssl`，不再强制 `sha256sum`；
- `date +%s%N`（BSD date 不支持）改为 `now_ms`，逐级降级到 perl `Time::HiRes`。

### 2. 逻辑缺陷修复

| 问题 | 修复 |
| --- | --- |
| 菜单有 69（广告位），但 `validate_region_id` 不接受 69，选了会无限循环 | 校验器加入 69 |
| `checkIPConn` 默认网络分支的 `ipv4Support`/`ipv6Support` 未初始化，`[ "$x" == 0 ]` 永远不成立：无网络时不报错、IPv4 失败时不会回退 IPv6 | 显式初始化为 0；无网络真正退出，IPv6-only 能正确回退 |
| 代理端口判断 `-ge 65535`，合法的 65535 被拒；端口 0 被接受；`grep -woP ':\K[0-9]+$'` 在 GNU grep 下也匹配不到端口 | 重写 `validate_proxy`：支持域名/IPv4/`[IPv6]`，端口范围 1–65535，不再依赖 `grep -P` |
| IPv6 校验正则缺少整体锚定（`grep -Eq`），`zzzz::1` 也会被当成 IPv6 | 改为 `grep -Eqx` |
| iSH 的 uname 同时含 Darwin/Linux，可能被误判为 macOS | iSH 判断提前 |
| `resolve_ip_address` 的 ping 兜底用 `grep -woP '\s\(\K...'`，GNU grep 的 `-w` 要求前一个字符非单词字符，实际永远匹配不到 | 去掉 `-w` |
| Naver TV 使用了不存在的 `UA_SecCHUA` / `UA_Browser` 变量，请求头和 UA 为空；Kayo Sports / Māori TV 使用了未定义的 `${SEC_CH_UA}` | 统一改为 `UA_SEC_CH_UA` / `UA_BROWSER` |
| LineTV.TW 提取不到 main js 时会用空字符串当 URL 调 curl（`curl: option : blank argument`） | 增加空值判断，返回明确的 PAGE ERROR；相对路径自动补全域名 |
| WOWOW / CoupangPlay 用 `date +%s%N`、`date +%s%3N`，BSD date 下时间戳错误 | 统一用 `now_ms` |
| Bahamut 测试把 cookie 写到当前目录的 `bahamut_cookie.txt` | 改用 `mktemp` 并 `trap` 清理 |
| `[ -z $1 ]`、`sleep $val`、`awk 'BEGIN{print '$val'...}'` 拼接 | 统一加引号/改用 `awk -v` |

### 3. 安全加固

- **结尾广告**：原版从 GitHub 下载 bash 脚本后直接 `bash <(...)` 执行。现在默认**不执行**，
  需要时用 `--ads` 或 `SHOW_ADS=1` 恢复原行为。
- **Instagram 音乐测试**：原版下载上游二进制写到 `./ins` 并执行，非 x86_64/aarch64 平台直接
  `exit 1` 终止整个脚本。现在改为：仅 Linux/Termux/Android 执行，临时目录中下载并清理，
  不支持的平台打印提示后继续。
- 代理模式增加连通性预检查，代理不可用时快速失败，避免几百个检测项全部超时。

### 4. 精简与性能

- `runScript` 中 11 段完全重复的“IPv4/IPv6 + 区域函数”代码（约 200 行）改为
  `case` 映射 + `runRegionTests`；
- `checkIPConn` 中英双份逻辑合并为 `msg` 双语助手（约 150 行 → 90 行）；
- `echo_result` 由“每个标签一个 `grep` + `sleep 0.03`”改为**单次 awk**，按标签顺序输出，
  固定字符串匹配（避免 `+` 等正则元字符误匹配）；
- `check_os_type` 只取一次 `uname -a`；
- 非终端输出时不再执行 `clear`，日志/重定向更干净。

## 验证情况

- `bash -n` 通过；ShellCheck 0.10.0 警告数低于原版（SC2128/SC2046 等已消失）。
- 兼容层：用本地编译的 GNU grep 3.11 对 116 个可自动生成的 PCRE 模式 × 6 种上下文
  共 **696 组** 做逐字节对比，0 差异；另对 13 个手工样本（代理正则、ping、brightcove、
  cookie 等）× 4 种上下文共 52 组做对比，0 差异。
- 行为对比（桩件）：9 个检测函数在“原版+GNU grep”和“优化版+perl 兼容层”下输出逐字节一致；
  `runScript` 在 0–11、66、88、99、69 等区域编号下，函数调用序列与原版完全一致。
- 端到端（真实网络）：`-R 69`、交互菜单选 69、`-R 88`、`-R 3 -M 4 -E en`、`-R 1 -M 4`、
  `-R 0`（跨国 IPv4+IPv6 全量）均正常退出（rc=0），无脚本报错；TW 区 11 个测试单独检查 stderr，
  无 `curl: option` 之类报错；GNU grep 模式下同样通过。

## 许可证

上游 [lmc999/RegionRestrictionCheck](https://github.com/lmc999/RegionRestrictionCheck) 采用
**AGPL-3.0**，本修改版作为其衍生作品，同样遵循 AGPL-3.0，许可证全文见同目录 `LICENSE`。

## 说明

- 所有平台检测逻辑、URL、User-Agent、请求头与上游一致（仅修复了上述明确 bug）。
- 检测结果依赖网络与目标平台策略，可能随时间变化。
- 新文件当前位于 `~/deepseek/workspace/check-sh/check.sh`，与原文件 `~/check.sh` 的差异见
  `check.diff`。
