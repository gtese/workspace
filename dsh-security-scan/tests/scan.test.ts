import { describe, expect, it } from 'vitest'
import {
  formatReport,
  isIgnoredDir,
  lineOf,
  redact,
  scanText,
  snippetFor,
  type Finding,
} from '../src/index.js'

describe('redact (打码逻辑)', () => {
  it('keeps the first 4 and last 2 characters of a long secret', () => {
    const token = 'ghp_' + 'abcdefghijklmnopqrstuvwxyz' + '0123456789ABCDEF'
    expect(token.length).toBe(46)
    expect(redact(token)).toBe('ghp_***EF')
  })

  it('fully masks short secrets', () => {
    expect(redact('abc123')).toBe('******')
    expect(redact('abc12345')).toBe('abc1***45')
  })

  it('handles empty input', () => {
    expect(redact('')).toBe('')
  })

  it('never leaks more than the first 4 / last 2 characters', () => {
    const token = 'sk-0123456789abcdef0123456789abcdef'
    const out = redact(token)
    expect(out).toBe('sk-0***ef')
    expect(token).not.toContain(out.slice(4, -2))
  })
})

describe('isIgnoredDir (忽略目录)', () => {
  const ignored = ['node_modules', '.git', 'dist', 'build']

  it('skips default ignore names', () => {
    expect(isIgnoredDir('node_modules', ignored)).toBe(true)
    expect(isIgnoredDir('.git', ignored)).toBe(true)
    expect(isIgnoredDir('dist', ignored)).toBe(true)
    expect(isIgnoredDir('build', ignored)).toBe(true)
  })

  it('keeps non-ignored names', () => {
    expect(isIgnoredDir('src', ignored)).toBe(false)
    expect(isIgnoredDir('lib', ignored)).toBe(false)
    expect(isIgnoredDir('node_modules_x', ignored)).toBe(false)
  })

  it('respects a custom ignore list', () => {
    expect(isIgnoredDir('vendor', ['vendor'])).toBe(true)
    expect(isIgnoredDir('vendor', [])).toBe(false)
  })
})

describe('scanText (匹配类型识别)', () => {
  const only = (f: Finding) => ({ kind: f.kind, severity: f.severity, line: f.line, snippet: f.snippet })

  it('detects an AWS access key', () => {
    const out = scanText('export AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE\n', 'config.ts')
    expect(out).toHaveLength(1)
    expect(only(out[0]!)).toEqual({
      kind: 'aws-access-key',
      severity: 'HIGH',
      line: 1,
      snippet: 'AKIA***LE',
    })
  })

  it('detects a GitHub token', () => {
    const token = 'ghp_' + 'a'.repeat(36)
    const out = scanText(`const t = '${token}'\n`, 'api/client.ts')
    expect(out).toHaveLength(1)
    expect(out[0]!.kind).toBe('github-token')
    expect(out[0]!.snippet).toBe('ghp_***aa')
    expect(out[0]!.snippet).not.toContain(token)
  })

  it('detects an OpenAI-style sk- token', () => {
    const token = 'sk-' + 'b'.repeat(40)
    const out = scanText(token, 'llm.ts')
    expect(out[0]!.kind).toBe('openai-api-key')
    expect(out[0]!.line).toBe(1)
    expect(out[0]!.snippet).toBe('sk-b***bb')
  })

  it('detects a bearer token and masks only the token part', () => {
    const out = scanText('Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123', 'req.ts')
    expect(out[0]!.kind).toBe('bearer-token')
    expect(out[0]!.snippet.startsWith('Bearer ')).toBe(true)
    expect(out[0]!.snippet).not.toContain('eyJhbGci')
  })

  it('detects a private key header', () => {
    const out = scanText(
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n',
      'certs/rsa.pem',
    )
    expect(out[0]!.kind).toBe('private-key')
    expect(out[0]!.snippet).toContain('BEGIN RSA PRIVATE KEY')
    expect(out[0]!.snippet).toContain('redacted')
  })

  it('detects DB connection strings and masks only the password', () => {
    const out = scanText('const uri = "postgres://app:s3cr3t-pass@db.internal:5432/main"\n', 'db.ts')
    expect(out[0]!.kind).toBe('db-connection-string')
    expect(out[0]!.snippet).toBe('postgres://app:***@db.internal:5432')
    expect(out[0]!.snippet).not.toContain('s3cr3t-pass')
  })

  it('detects suspicious KEY=value lines in .env files', () => {
    const out = scanText('DATABASE_PASSWORD=hunter2-secret-value-123\nAPI_TOKEN=abcdef0123456789abcdef0123456789\n', '.env')
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out.every((f) => f.kind === 'env-file-secret' || f.severity === 'HIGH')).toBe(true)
    for (const f of out) expect(f.snippet).not.toMatch(/hunter2-secret-value-123|abcdef0123456789abcdef0123456789/)
  })

  it('reports correct line numbers for multi-line files', () => {
    const content = 'line one\nline two\nconst k = "AKIAIOSFODNN7EXAMPLE"\n'
    const out = scanText(content, 'a.ts')
    expect(out[0]!.line).toBe(3)
    expect(lineOf(content, 30)).toBe(3)
  })

  it('caps findings per file at maxMatchesPerFile', () => {
    const content = Array.from({ length: 30 }, () => 'AKIA' + 'A'.repeat(16)).join('\n')
    const out = scanText(content, 'many.ts', { maxMatchesPerFile: 5 })
    expect(out).toHaveLength(5)
  })

  it('does not flag sk- style text when it is too short', () => {
    const out = scanText('sk-short\n', 'x.ts')
    expect(out).toHaveLength(0)
  })
})

describe('formatReport (输出格式)', () => {
  it('renders findings and the summary line', () => {
    const report = {
      filesScanned: 2,
      findings: [
        { severity: 'HIGH', kind: 'github-token', file: 'src/a.ts', line: 42, snippet: 'ghp_***EF' },
        { severity: 'LOW', kind: 'dangerous-file', file: 'certs/k.pem', line: 1, snippet: 'dangerous artifact present (.pem)' },
      ] as Finding[],
    }
    const text = formatReport(report)
    expect(text).toContain('[HIGH] github-token src/a.ts:42: ghp_***EF')
    expect(text).toContain('[LOW] dangerous-file certs/k.pem:1: dangerous artifact present (.pem)')
    expect(text).toContain('Scan complete: 2 files scanned, 2 findings (HIGH/LOW: 1/1)')
  })
})

describe('snippetFor (打码兜底)', () => {
  it('never returns the raw match for unknown kinds', () => {
    expect(snippetFor('aws-access-key', 'AKIAABCDEFGHIJKLMNOP')).toBe('AKIA***OP')
    expect(snippetFor('openai-api-key', 'sk-abcdefghijklmnopqrstuvwxyz0123456789abcdef')).not.toContain('sk-abcdef')
  })
})
