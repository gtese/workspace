# 同步信息

- **源仓库**：https://git.tri.local/it/dsh
- **同步提交**：`ae8e437`
- **同步时间**：2026-11-12 12:53（Asia/Shanghai）
- **项目状态**：服务器 dsh 0.2.2-rc.1，trivm131/132/133 已验证通过

## 同步范围

从源仓库同步：`README.md`、`docs/`（含 `用户手册.md`）、`config/`（含 `dsh.env.deployed.sanitized` 脱敏样例，不含 `config/pki/*.pem`）、`scripts/`、`data/`、`archive/`、`.gitignore`。

未同步：`config/pki/tri-enterprise-root.pem`（workspace 仓库 `.gitignore` 忽略 `*.pem`；证书原件在源仓库及 `/eda/apps/deepseek/certs/`）。

## 后续同步步骤

```bash
cd /Users/linyiyao/deepseek/dsh-git
git pull --ff-only

rsync -a --delete --exclude='.git' \
  --exclude='config/pki' --exclude='.DS_Store' --exclude='SYNC.md' \
  ./ ../workspace/dsh/

# 更新本文件里的提交号与时间后提交
cd ../workspace
git add dsh
git commit -m "docs: sync dsh project materials"
```

> 本目录不是独立仓库，属于上层 `workspace` git 仓库的一部分；真源是 https://git.tri.local/it/dsh。
