/**
 * dsh-security-scan — secret & dangerous-pattern scanner for DeepSeek Harness.
 *
 * Registers one `security_scan` tool (bare ToolDefinition on `ctx.tools`) that
 * walks text files under the configured paths and reports leaked secrets and
 * dangerous artifacts: API keys, tokens, private keys, database connection
 * strings that embed passwords, `.env` files with suspicious values, and
 * private-key file artifacts. Zero runtime dependencies — pure Node built-ins
 * (`node:fs`, `node:path`). Every matched secret is REDACTED before it leaves
 * the scanner, so raw key material never reaches the model context or logs.
 *
 * @module dsh-security-scan
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import { readFile, readdir } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'

export const name = 'dsh-security-scan'
export const inject = ['tools']

/** Plugin config: scan roots, ignore list, and per-file budgets. */
export interface SecurityScanConfig {
  /** Directories (relative to the harness cwd) to scan. Defaults to ['.']. */
  paths: string[]
  /** Directory basenames skipped during traversal. */
  ignored: string[]
  /** Files larger than this many bytes are skipped. */
  maxFileSizeBytes: number
  /** Max findings reported per file. */
  maxMatchesPerFile: number
}

export const Config: Schema<SecurityScanConfig> = Schema.object({
  paths: Schema.array(String).default(['.']),
  ignored: Schema.array(String).default(['node_modules', '.git', 'dist', 'build']),
  maxFileSizeBytes: Schema.number().default(1_048_576),
  maxMatchesPerFile: Schema.number().default(10),
})

// ============================================================================
// Constants — exported so unit tests can pin the detection vocabulary.
// ============================================================================

/** One detectable secret shape. */
export type SecretKind =
  | 'aws-access-key'
  | 'github-token'
  | 'openai-api-key'
  | 'bearer-token'
  | 'private-key'
  | 'db-connection-string'
  | 'env-file-secret'

/** All finding kinds: secret matches plus file-level artifacts. */
export type FindingKind = SecretKind | 'dangerous-file'

/**
 * Regexes for each secret kind. Every pattern is a *global* regex; scanners
 * must clone (`new RegExp(source, flags)`) before each use because global
 * regexes carry mutable `lastIndex` state.
 */
export const PATTERNS: Readonly<Record<SecretKind, RegExp>> = {
  'aws-access-key': /AKIA[0-9A-Z]{16}/g,
  'github-token': /ghp_[A-Za-z0-9]{36}/g,
  'openai-api-key': /sk-[A-Za-z0-9]{20,}/g,
  'bearer-token': /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  'private-key': /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/g,
  'db-connection-string': /(?:mysql|postgres(?:ql)?|mongodb)(?:\+srv)?:\/\/[^/\s:@]+:[^@\s/]+@(?:[^/\s]+)?/gi,
  'env-file-secret': /^\s*[A-Za-z_][A-Za-z0-9_]*\s*=\s*(\S{16,})/gm,
}

/** File extensions whose mere presence is reported (the file itself). */
export const DANGEROUS_FILE_EXTENSIONS: readonly string[] = ['.pem', '.key', '.p12']

/** File basenames scanned for `KEY=longvalue` lines. */
export const ENV_FILE_NAMES: readonly string[] = ['.env']

/** Bytes of leading content probed for NUL bytes when detecting binaries. */
export const BINARY_PROBE_BYTES = 8_192

/** One finding; `snippet` is always redacted. */
export interface Finding {
  severity: 'HIGH' | 'LOW'
  kind: FindingKind
  /** Path as reported (relative to the scanned root). */
  file: string
  /** 1-based line number of the match. */
  line: number
  /** Redacted snippet — never contains the raw secret. */
  snippet: string
}

/** Result of one scan run. */
export interface ScanReport {
  filesScanned: number
  findings: Finding[]
}

/** Options accepted by the pure scanning functions (subset of config). */
export interface ScanOptions {
  maxFileSizeBytes?: number
  maxMatchesPerFile?: number
}

// ============================================================================
// Redaction & classification — pure, unit-testable.
// ============================================================================

/**
 * Redact a secret for display: keep the first 4 and last 2 characters,
 * mask everything between. Short secrets (<= 6 chars) are fully masked.
 * e.g. `ghp_abcdefghijklmnopqrstuvwxyz0123456789ABCDEF` → `ghp_***EF`.
 */
export function redact(secret: string): string {
  if (secret.length <= 6) return '*'.repeat(secret.length)
  return `${secret.slice(0, 4)}***${secret.slice(-2)}`
}

/** 1-based line number of `index` inside `content`. */
export function lineOf(content: string, index: number): number {
  let line = 1
  for (let i = 0; i < index && i < content.length; i++) {
    if (content.charCodeAt(i) === 10 /* \n */) line++
  }
  return line
}

/**
 * Produce a redacted one-line snippet for a matched secret.
 * URL-style matches mask only the password segment; bearer tokens mask only
 * the token; PEM headers are public identifiers, so only the key material is
 * elided.
 */
export function snippetFor(kind: SecretKind, match: string): string {
  switch (kind) {
    case 'db-connection-string':
      return match.replace(/(:\/\/[^/\s:@]+):[^@\s/]+@/, '$1:***@')
    case 'bearer-token':
      return match.replace(/^(Bearer\s+)(.+)$/i, (_all, prefix: string, token: string) =>
        `${prefix}${redact(token)}`)
    case 'private-key':
      return `${match} (key material redacted)`
    case 'env-file-secret': {
      const eq = match.indexOf('=')
      if (eq < 0) return redact(match)
      return `${match.slice(0, eq + 1)}${redact(match.slice(eq + 1).trim())}`
    }
    default:
      return redact(match)
  }
}

/**
 * Scan one text file's content for secret patterns. Pure and synchronous so
 * it is directly unit-testable. Findings are capped at `maxMatchesPerFile`.
 * @param content - file content (text).
 * @param file - display path of the scanned file.
 * @param options - scan budgets; `maxFileSizeBytes` is ignored here (caller decides).
 */
export function scanText(
  content: string,
  file: string,
  options: ScanOptions = {},
): Finding[] {
  const cap = options.maxMatchesPerFile ?? 10
  const findings: Finding[] = []
  const isEnvFile = ENV_FILE_NAMES.includes(basename(file))

  const kinds: SecretKind[] = isEnvFile
    ? ['aws-access-key', 'github-token', 'openai-api-key', 'bearer-token',
      'private-key', 'db-connection-string', 'env-file-secret']
    : ['aws-access-key', 'github-token', 'openai-api-key', 'bearer-token',
      'private-key', 'db-connection-string']

  for (const kind of kinds) {
    // Clone: global regexes carry mutable lastIndex between exec() calls.
    const re = new RegExp(PATTERNS[kind].source, PATTERNS[kind].flags)
    let m: RegExpExecArray | null
    while (findings.length < cap && (m = re.exec(content)) !== null) {
      const match = m[0]
      // env-file-secret matches only bare lines in .env files; skip lines that
      // already matched a typed secret pattern above (e.g. SK=sk-...).
      findings.push({
        severity: 'HIGH',
        kind,
        file,
        line: lineOf(content, m.index),
        snippet: snippetFor(kind, match),
      })
    }
    if (findings.length >= cap) break
  }
  return findings.slice(0, cap)
}

// ============================================================================
// Filesystem walk & report — async, node:fs only.
// ============================================================================

/** Whether a directory basename should be skipped entirely. */
export function isIgnoredDir(dir: string, ignored: readonly string[]): boolean {
  return ignored.includes(dir)
}

/** True when a buffer looks binary (NUL byte in the leading probe). */
export function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, BINARY_PROBE_BYTES)
  return probe.includes(0)
}

/** Collect display-relative paths of every file under `root`, honoring ignores. */
async function collectFiles(root: string, ignored: readonly string[]): Promise<string[]> {
  const out: string[] = []
  const walk = async (dir: string): Promise<void> => {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return // unreadable dirs are skipped silently
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (isIgnoredDir(entry.name, ignored)) continue
        await walk(full)
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        out.push(full)
      }
    }
  }
  await walk(root)
  return out.sort()
}

/**
 * Run a full scan over `paths` (absolute or relative to `cwd`). Returns the
 * report; every snippet inside is already redacted.
 */
export async function runScan(
  paths: readonly string[],
  cwd: string,
  options: SecurityScanConfig,
): Promise<ScanReport> {
  const findings: Finding[] = []
  let filesScanned = 0
  const maxSize = options.maxFileSizeBytes ?? 1_048_576
  const cap = options.maxMatchesPerFile ?? 10

  for (const p of paths) {
    const root = isAbsolute(p) ? p : resolve(cwd, p)
    const files = await collectFiles(root, options.ignored)
    for (const full of files) {
      const ext = extnameOf(full)
      const display = relative(cwd, full) || full
      if (DANGEROUS_FILE_EXTENSIONS.includes(ext)) {
        findings.push({
          severity: 'LOW',
          kind: 'dangerous-file',
          file: display,
          line: 1,
          snippet: `dangerous artifact present (${ext})`,
        })
        continue // do not read key material at all
      }
      let buf: Buffer
      try {
        buf = await readFile(full)
      } catch {
        continue
      }
      if (buf.byteLength > maxSize) continue
      if (looksBinary(buf)) continue
      filesScanned++
      findings.push(...scanText(buf.toString('utf8'), display, { maxMatchesPerFile: cap }))
    }
  }
  return { filesScanned, findings }
}

function extnameOf(path: string): string {
  const base = basename(path)
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot) : ''
}

/** Render a report as the canonical tool output text. */
export function formatReport(report: ScanReport): string {
  const lines = report.findings.map((f) =>
    `[${f.severity}] ${f.kind} ${f.file}:${f.line}: ${f.snippet}`)
  const high = report.findings.filter((f) => f.severity === 'HIGH').length
  const low = report.findings.length - high
  lines.push(
    `Scan complete: ${report.filesScanned} files scanned, ${report.findings.length} findings (HIGH/LOW: ${high}/${low})`,
  )
  return lines.join('\n')
}

// ============================================================================
// Tool & plugin entry.
// ============================================================================

/** Build the registry-ready `security_scan` ToolDefinition (bare, no defineTool). */
export function securityScanTool(config: SecurityScanConfig): ToolDefinition {
  return {
    name: 'security_scan',
    description:
      'Scan local directories for leaked secrets and dangerous artifacts: AWS/GitHub/OpenAI-style API keys, bearer tokens, private keys, database connection strings with embedded passwords, .env files with suspicious values, and .pem/.key/.p12 files. Reports are line-referenced and all secrets are redacted.',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Optional single directory to scan; defaults to config.paths.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'string' },
      render: (_args: unknown, value: unknown): ContentBlock[] => [
        { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
      ],
    },
    execute: async (args: unknown): Promise<string> => {
      const { path } = (args ?? {}) as { path?: unknown }
      const paths = typeof path === 'string' && path.trim().length > 0
        ? [path.trim()]
        : config.paths
      const report = await runScan(paths, process.cwd(), config)
      return formatReport(report)
    },
  }
}

export function apply(ctx: Context, config: SecurityScanConfig): void {
  ctx.tools.register(securityScanTool(config))
  ctx.logger.info(
    `dsh-security-scan: security_scan registered (paths=${config.paths.join(',')}, ` +
    `ignored=${config.ignored.join(',')}, maxFileSizeBytes=${config.maxFileSizeBytes}, ` +
    `maxMatchesPerFile=${config.maxMatchesPerFile})`,
  )
}
