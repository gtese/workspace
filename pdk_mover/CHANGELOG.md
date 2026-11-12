---
AIGC:
    Label: "1"
    ContentProducer: 001191440300708461136T1XGW3
    ProduceID: 8c4394cfff83f2eb5d568afaa7d5d896_522be03ade3911f1997d52540024e231
    ReservedCode1: Tq0eZKDUjG2Omw+ko7+i+4XdQdLhhptJftHWOtaYhtmZE9tyYPKcWKWA8GtgWB3Iuut++oxMZE6PIYMNGnW2ha2tRF7mYM/CRy4tSD1S60VOCfx0klEs6wxG/Q94ySEl7JL8DgLRag28fIaQ8ls/uL0BfYMVlID96xlbazyqp3lvMRonT4+M9eGiDh4=
    ContentPropagator: 001191440300708461136T1XGW3
    PropagateID: 8c4394cfff83f2eb5d568afaa7d5d896_522be03ade3911f1997d52540024e231
    ReservedCode2: Tq0eZKDUjG2Omw+ko7+i+4XdQdLhhptJftHWOtaYhtmZE9tyYPKcWKWA8GtgWB3Iuut++oxMZE6PIYMNGnW2ha2tRF7mYM/CRy4tSD1S60VOCfx0klEs6wxG/Q94ySEl7JL8DgLRag28fIaQ8ls/uL0BfYMVlID96xlbazyqp3lvMRonT4+M9eGiDh4=
---

# CHANGELOG

## v4 — 2026-11-04

规则简化为一条：**目标存在即 move 覆盖，源端不留**。

- 删除 `CONFLICT_POLICY` 及全部冲突分支（skip / dedup / overwrite 三选一逻辑退场）。
- 目标同名文件直接覆盖，不再比对内容，不再产生 conflict 计数。
- 保留 v3 的递归子目录扫描与空目录回收。
- 目标父目录不存在时保留源文件、记一条告警（同目录只报一次），不自动建目录。
- 日志与邮件计数口径由 `moved/conflict/failed` 改为 `moved/overwritten/failed`。
- 线上部署：`/usr/local/sbin/pdk_mover.sh`，备份 `pdk_mover.sh.bak.20261104_112957`（v3）。
- 部署前已在 opsnas `/root/pdk_v4_test_20261104_112957` 完成沙箱验证（新建 / 覆盖 / 递归 / 空目录回收 / 缺目录告警）。

风险：同名覆盖不可逆、无备份。

## v3 — 2026-11-03

- 支持递归子目录。
- 引入内容去重：目标存在同名文件且大小 + md5 一致时删源，避免中转区堆积重复件。
- 引入 `CONFLICT_POLICY` 处理同名不同内容（skip / overwrite / 人工）。
- 搬运后回收中转区空目录。

## v2 — 2026-10-27

- 多项目支持 + 17 个叶子目录白名单（`io`/`ram`/`rom` 下二级目录）。
- 配置外置 `/etc/pdk_mover.conf`，SMTP 口令从脚本移出。
- 原子落地：临时名 + rename，避免半截文件占正式名。
- `DRYRUN` 演练模式；环境变量优先于配置文件的回写机制。
- 目标目录缺失只告警不创建。
- 邮件按项目分节，发信器 `pdk_mover_mailer.py` 与主脚本解耦。

## v1 — 2026-10-26

- 单项目（`tsmc/n6`）迁移，cron 每 15 分钟，邮件通知。
*（内容由AI生成，仅供参考）*
