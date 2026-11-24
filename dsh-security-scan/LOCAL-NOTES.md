# dsh-security-scan（本地构建版）

DSH 插件：注册 `security_scan` 工具，扫描本地目录中的泄露密钥与危险文件特征（AWS / GitHub /
OpenAI 风格密钥、Bearer 令牌、私钥、内嵌口令的数据库连接串、`.env` 可疑值、`.pem/.key/.p12`
文件），所有命中项在返回给模型前均已打码。

- 上游仓库：<https://github.com/ben7am1n/dsh-security-scan>
- 上游提交：`b212b9a`（feat: dsh-security-scan secret & dangerous-pattern scanner (v0.1.0)）
- 许可证：MIT（上游）
- 本地安装日期：2026-11-24

## 为什么不直接 `pnpm add github:...`

1. **npm 包名被他人占用。** registry 上的 `dsh-security-scan`（维护者 `tudamu`，
   版本 0.0.1）是另一个插件（扫描 *DSH profile 的插件风险*），不是本仓库。按名字从 npm
   安装会装错东西。
2. **仓库不含 `lib/`。** `main` 指向 `lib/index.js`，源码只有 `src/index.ts`，必须先用
   `tsc` 构建；从 git 安装要跑 `prepare` 构建脚本，pnpm 11 默认拦截该脚本。
3. **上游 peer 范围已过期。** 上游按 `@deepseek-ai/dsh@0.1.0-rc.6` 编写，声明
   `@deepseek-ai/dsh-tools ^0.1.0-rc.6`。当前 runtime 为 `0.2.2-rc.1`，DSH 的兼容性门禁会
   直接拒绝加载（`evaluatesPluginCompatibility` 检查 `dsh` / `dsh-*` peer 范围），除非申请
   版本豁免——但那只是绕过门禁，不能证明 API 兼容。

因此在本目录做本地构建 + `link:` 安装：先对真实 runtime 版本做类型检查，确认代码确实兼容，
再把 peer 范围对齐到实机版本，避免使用「豁免」这种带崩溃风险的做法。

## 相对上游的改动

- **仅 `package.json` 的依赖声明**，源码 `src/`、`tests/`、`cordis.patch.yml`、README 未改动：
  - `peerDependencies`：`@deepseek-ai/cordis ^4.1.0`、`@deepseek-ai/dsh-tools ^0.2.2-rc.1`、
    `@deepseek-ai/dsh-llm ^0.2.2-rc.1`（原为 cordis ^4.0.1 / dsh-* ^0.1.0-rc.6）。
  - `devDependencies`：`dsh-tools`、`dsh-llm` 精确锁定 `0.2.2-rc.1`，保证类型检查针对实机版本。
  - `dependencies`：`@deepseek-ai/schemastery ^3.19.0`（运行时唯一的非内置依赖）。
- 新增本文件 `LOCAL-NOTES.md`。

## 验证结果（0.2.2-rc.1 runtime，Node 24.21.0）

- `tsc --noEmit -p tsconfig.json`：通过（`ToolDefinition`、`ctx.tools.register`、`Schema` 均与
  0.2.2-rc.1 一致，无需改源码）。
- `vitest run`：19/19 通过（打码、忽略目录、命中词表）。
- 实机：profile 中 `include:dsh-security-scan` 为 `active`，模型可见 `security_scan` 工具；
  对含伪造密钥的目录扫描返回 3 条 HIGH，密钥已打码（`sk-a***23`、`Bearer abcd***89`、
  `postgres://admin:***@db.internal:5432`）。

## 安装位置与配置

- 代码目录：`~/deepseek/workspace/dsh-security-scan`
- profile：`~/.dsh/profiles/desktop`，`package.json` 中
  `"dsh-security-scan": "link:/Users/linyiyao/deepseek/workspace/dsh-security-scan"`，
  并已加入 `dsh.profile.bundles`。
- 运行配置（`paths` / `ignored` / `maxFileSizeBytes` / `maxMatchesPerFile`）在 profile 的
  `cordis.patch.yml` 里对 row id `dsh-security-scan` 追加覆盖即可；默认 `paths: ['.']`
  相对 harness 当前工作目录。

## 升级

```sh
cd ~/deepseek/workspace/dsh-security-scan
# 拉取上游新 commit 后，把 src/ tests/ tsconfig.json cordis.patch.yml 覆盖过来，
# 重新对齐 package.json 的 peer/dev 版本，然后：
node "/Volumes/DeepSeek Harness 0.2.2-rc.1-arm64/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.cjs" install
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/vitest/vitest.mjs run
```

改动 `lib/` 后需重启 DSH 或触发 profile 重载才能让运行中的进程用上新构建。
