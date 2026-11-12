# SECURITY — 凭据管理约定

本仓库**不得**包含任何真实凭据。以下规则对所有提交生效。

## 禁止入库的内容

| 类型 | 正确做法 |
|---|---|
| SMTP 口令 | 只存在于线上 `/etc/pdk_mover.conf`（0600 root）；脚本用 `SMTP_PASS="${SMTP_PASS:-}"` 读取 |
| sudo / 登录口令 | 任何脚本、README、提交信息中均不得出现；运维脚本运行时从 `~/.mm`（0600）读取 |
| API Key / Token | 走环境变量或 `/etc` 外部配置，不写默认值 |
| 私钥 | `*.pem` / `*.key` / `id_rsa` 一律不入库（`.gitignore` 已排除） |
| 线上配置 | `etc/pdk_mover.conf` 已被 `.gitignore` 排除，只提交 `*.conf.example` |

## 提交前自检

```bash
grep -rnE "SMTP_PASS=[^\"'\$]|password *= *[^ ]|api[_-]?key *= *[A-Za-z0-9]|sshpass|set pw " \
     --exclude-dir=.git . || echo clean
```

零命中才可提交。

## 历史遗留（需处理）

- 提交 `5d21288`（v1）中 `bin/pdk_n6_mover.sh` 与 `README.md` 曾硬编码 SMTP 口令，`7b7ca76`（v2）起已移除。
- 当前工作树无明文，但旧提交仍可被检出，**视为已泄露**。

处置建议（按顺序）：

1. **立即更换该邮箱账号的口令**（阿里企业邮后台），这一条比清历史更重要。
2. 新口令只写入线上 `/etc/pdk_mover.conf`，不再进入任何仓库。
3. 如需清除历史（会重写所有提交哈希，需通知协作者重新克隆）：

```bash
pip install git-filter-repo
# 把旧口令写入替换表（此处不写明文，替换表本身也不要提交）
printf '%s==>__CHANGE_ME__\n' "$OLD_SMTP_PASS" > /tmp/replace.txt
git clone --mirror https://git.tri.local/it/filetran.git filetran-mirror.git
cd filetran-mirror.git
git filter-repo --replace-text /tmp/replace.txt --force
git push --force --all && git push --force --tags
rm -f /tmp/replace.txt
```

4. 完成后让所有克隆方删除本地副本重新克隆，避免旧对象残留。
