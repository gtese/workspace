# dsh-security-scan

**Secret & dangerous-pattern scanner for DeepSeek Harness** — one `security_scan` tool that walks your files and reports leaked API keys, tokens, private keys, and credential-bearing connection strings. Zero runtime dependencies (pure Node built-ins).

## Overview

dsh-security-scan gives the harness a model-facing security hygiene tool. Point it at a checkout (or your whole workspace) and it finds secrets that should never have been committed — then reports them **redacted**, so raw key material never reaches the model context or the logs.

**Who is it for?**

- Anyone who has ever pushed a `.env` or pasted a token into a config file.
- Teams that want a cheap, built-in secret gate before commits or before handing a repo to an agent.
- Developers who want a readable reference for writing a model-facing tool plugin (bare `ToolDefinition`, no framework).

**What it detects**

| Kind | Pattern (examples) |
|---|---|
| AWS access key | `AKIA` + 16 base62 chars |
| GitHub token | `ghp_` + 36 chars |
| OpenAI-style key | `sk-` + 20+ chars |
| Bearer token | generic `Bearer` inline credentials |
| Private key | `-----BEGIN ... PRIVATE KEY-----` blocks |
| DB connection string | `mysql://` / `postgres://` / `mongodb://` with an embedded password |
| Dangerous file | `.env` with suspicious values; `*.pem` / `*.key` / `*.p12` artifacts |

**What it does not do (yet)**

- No git-history scan, no remediation, no network checks. This is a filesystem scanner, not a full security audit suite.
- No `tools/pre-execute` enforcement gate (planned: block writes that would re-introduce a known secret). See Development.

## Compatibility

- Requires **Node.js ≥ 22.19** (uses `node:fs/promises` and global `fetch`-free built-ins only).
- Built and verified against `@deepseek-ai/dsh@0.1.0-rc.6` / `@deepseek-ai/cordis@^4.0.1`.
- **Last verified:** 2026-08-14.
- dsh is in developer preview; re-verify after harness updates. The plugin only depends on `ctx.tools.register` (a stable extension point) and `@deepseek-ai/dsh-tools` types.

## Install / Uninstall

Install into a dsh profile (local checkout):

```sh
cd /path/to/deepseek-harness
pnpm dsh plugin --profile web add /path/to/dsh-security-scan
```

From GitHub (source install — pnpm runs the `prepare` script, so allow it once):

```sh
pnpm dsh plugin --profile web add github:<you>/dsh-security-scan
# pnpm ≥10 blocks the build script on first install; copy the printed package key
# into <profile>/pnpm-workspace.yaml under allowBuilds, then re-run.
```

Uninstall:

```sh
pnpm dsh plugin --profile web remove dsh-security-scan
```

## Quick start

Install the bundle, then ask the agent:

```text
Run security_scan on this repository and summarize the high-severity findings.
```

Or trigger it directly through the harness tools. Default behavior: scan `.` (relative to the harness cwd), skip `node_modules`/`.git`/`dist`/`build`, skip files over 1 MB, and cap 10 findings per file.

Example output shape (secrets redacted):

```
[HIGH] github-token        config/keys.ts:12  ghp_ab12****yz
[HIGH] private-key         deploy/keys.pem (file artifact)
[LOW]  db-connection-string src/db.ts:88      postgres://user:****@host/db
Scan complete: 412 files scanned, 3 findings (HIGH: 2, LOW: 1)
```

## Configuration

All keys live under the `dsh-security-scan` row's `config`:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `paths` | string[] | `['.']` | Directories to scan (relative to harness cwd). |
| `ignored` | string[] | `['node_modules','.git','dist','build']` | Directory basenames skipped during traversal. |
| `maxFileSizeBytes` | number | `1048576` | Files larger than this are skipped. |
| `maxMatchesPerFile` | number | `10` | Max findings reported per file. |

## Permissions & data

- **Read-only:** the scanner only reads files; it never writes, edits, or deletes.
- **Redaction:** every matched secret is masked before it leaves the scanner (first 4 / last 2 characters shown). Raw key material does not reach the model context or logs.
- **Scope:** scanning is bounded to the configured `paths` and respects the ignore list; it does not follow symlinks out of the tree.
- **No network:** detection is purely local regex scanning; nothing is uploaded or sent anywhere.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Tool reports zero files scanned | `paths` points at a non-existent directory relative to harness cwd | Use an absolute path or run from the intended directory |
| False positives on example keys | Test fixtures often contain placeholder keys (`AKIAIOSFODNN7EXAMPLE` is AWS's documented example) | Review findings manually; the tool reports, it does not judge intent |
| Slow scan on huge repos | Regex over many files | Raise `ignored` coverage (e.g. add `vendor`, `third_party`) or reduce `paths` |
| `security_scan` not visible to the model | Plugin loaded without the tools service | Verify `inject: ['tools']` is present in the installed `lib/index.js` (rebuild after edits) |

## Development

```sh
pnpm install
pnpm run typecheck     # tsc --noEmit
pnpm run build         # tsc → lib/
pnpm run test          # vitest (19 tests)
```

Structure:

- `src/index.ts` — plugin entry, scanner, and the `security_scan` tool; detection regexes and the redaction helper are exported for unit tests.
- `tests/` — redaction, ignore-directory, and detection-vocabulary coverage.
- `cordis.patch.yml` — the bundle patch layer that mounts the plugin row.

Design notes:

- Detection is intentionally regex-based and conservative — better to flag a false positive than to miss a real secret. Add patterns as new `SecretKind`s and pin them in tests.
- Roadmap: a `tools/pre-execute` enforcement gate (reject writes that reintroduce a known secret) and git-history scanning.

## License & security

MIT. Report security issues privately via the repository's security advisory (or open an issue without secrets). The scanner runs entirely on the operator's machine with read-only access; it sends nothing anywhere.
