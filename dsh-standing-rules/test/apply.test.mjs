import { mkdtempSync, rmSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  createRulesReader,
  inject,
  name,
  resolveConfig,
  resolveRulesPath,
  SECTION_NAME,
} from '../lib/index.js'

const dirs = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'standing-rules-test-'))
  dirs.push(dir)
  return dir
}

function mockCtx() {
  const sections = new Map()
  const warnings = []
  return {
    ctx: {
      systemPrompt: {
        section(spec) {
          sections.set(spec.name, spec)
          return () => sections.delete(spec.name)
        },
      },
      logger: { warn: (message) => warnings.push(message) },
    },
    sections,
    warnings,
  }
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('plugin module shape', () => {
  it('is a Cordis plugin with a stable name and injected service', () => {
    assert.equal(name, 'standing-rules')
    assert.deepEqual(inject, ['systemPrompt'])
  })
})

describe('resolveConfig', () => {
  it('uses the DSH home rules file, 32 KiB budget, and order 100 by default', () => {
    const resolved = resolveConfig({})
    assert.equal(resolved.maxBytes, 32 * 1024)
    assert.equal(resolved.order, 100)
    assert.ok(resolved.rulesFile.endsWith(join('.dsh', 'rules.md')))
  })

  it('expands ~ and $DSH_HOME', () => {
    const home = process.env.HOME
    assert.ok(home)
    assert.equal(resolveRulesPath('~/x/rules.md'), join(home, 'x/rules.md'))
    assert.equal(
      resolveRulesPath('$DSH_HOME/rules.md'),
      join(process.env.DSH_HOME || join(home, '.dsh'), 'rules.md'),
    )
  })

  it('rejects unusable budgets and orders instead of throwing', () => {
    assert.equal(resolveConfig({ maxBytes: -1 }).maxBytes, 32 * 1024)
    assert.equal(resolveConfig({ maxBytes: 'big' }).maxBytes, 32 * 1024)
    assert.equal(resolveConfig({ order: Number.NaN }).order, 100)
  })
})

describe('apply', () => {
  it('registers one non-interpolating system-prompt section', () => {
    const dir = tempDir()
    const rulesFile = join(dir, 'rules.md')
    writeFileSync(rulesFile, '- 密码放 ~/.mm\n')
    const { ctx, sections } = mockCtx()
    apply(ctx, { rulesFile })
    assert.deepEqual([...sections.keys()], [SECTION_NAME])
    const section = sections.get(SECTION_NAME)
    assert.equal(section.order, 100)
    assert.equal(section.interpolate, false)
  })

  it('renders heading, source path, and file content', () => {
    const dir = tempDir()
    const rulesFile = join(dir, 'rules.md')
    writeFileSync(rulesFile, '  规则一\n规则二  \n')
    const { ctx, sections } = mockCtx()
    apply(ctx, { rulesFile })
    const text = sections.get(SECTION_NAME).text({})
    assert.ok(text.startsWith('## Standing rules'))
    assert.ok(text.includes(`Source: \`${rulesFile}\``))
    assert.ok(text.includes('规则一\n规则二'))
    assert.ok(!text.includes('\uFFFD'))
  })

  it('omits the section for a missing or empty rules file', () => {
    const dir = tempDir()
    const { ctx, sections } = mockCtx()
    apply(ctx, { rulesFile: join(dir, 'missing.md') })
    assert.equal(sections.get(SECTION_NAME).text({}), '')
    const empty = join(dir, 'empty.md')
    writeFileSync(empty, '   \n\n')
    const second = mockCtx()
    apply(second.ctx, { rulesFile: empty })
    assert.equal(second.sections.get(SECTION_NAME).text({}), '')
  })

  it('re-reads edited rules without re-mounting the plugin', () => {
    const dir = tempDir()
    const rulesFile = join(dir, 'rules.md')
    writeFileSync(rulesFile, '第一版\n')
    const { ctx, sections } = mockCtx()
    apply(ctx, { rulesFile })
    assert.ok(sections.get(SECTION_NAME).text({}).includes('第一版'))
    writeFileSync(rulesFile, '第二版\n')
    // Ensure a different mtime even on coarse filesystems.
    const now = Date.now() / 1000
    utimesSync(rulesFile, now, now)
    const text = sections.get(SECTION_NAME).text({})
    assert.ok(text.includes('第二版'))
    assert.ok(!text.includes('第一版'))
  })

  it('truncates at the byte budget and says so', () => {
    const dir = tempDir()
    const rulesFile = join(dir, 'rules.md')
    writeFileSync(rulesFile, 'a'.repeat(100))
    const reader = createRulesReader({ rulesFile, maxBytes: 10 })
    const text = reader()
    assert.ok(text.includes('Truncated'))
    assert.ok(text.includes('aaaa'))
    assert.ok(!text.includes('a'.repeat(11)))
  })

  it('never throws when the rules path is a directory', () => {
    const dir = tempDir()
    const { ctx, sections } = mockCtx()
    apply(ctx, { rulesFile: dir })
    assert.equal(sections.get(SECTION_NAME).text({}), '')
  })
})
