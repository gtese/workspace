import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  apply,
  createInstructionsMessage,
  inject,
  isAssessmentTrigger,
  name,
  renderSkillContent,
  resolveSkillFile,
  SKILL_NAME,
} from '../lib/index.js'

const dirs = []

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'project-assessment-test-'))
  dirs.push(dir)
  return dir
}

/** A mock Cordis context that records the provider and the pre-step listener. */
function mockCtx() {
  const state = {
    provider: undefined,
    listener: undefined,
    invalidates: 0,
  }
  const controller = new AbortController()
  return {
    state,
    ctx: {
      skills: {
        registerProvider(factory) {
          state.provider = factory({
            signal: controller.signal,
            invalidate() {
              state.invalidates += 1
            },
          })
          return () => {}
        },
      },
      on(event, listener) {
        if (event === 'agent/pre-step') state.listener = listener
        return () => {}
      },
      logger: { warn() {} },
    },
  }
}

function userMessage(text) {
  return { id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } }
}

function nonUserMessage(text) {
  return {
    id: 'm2',
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'skill-invocation', name: 'x', form: 'instructions' },
  }
}

const ENTER = { kind: 'enter', messages: [] }

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('plugin module shape', () => {
  it('is a Cordis plugin injecting the skill registry', () => {
    assert.equal(name, 'project-assessment')
    assert.deepEqual(inject, ['skills'])
    assert.equal(SKILL_NAME, 'project-assessment')
  })
})

describe('skill path handling', () => {
  it('expands ~ at the start of a configured path', () => {
    const home = process.env.HOME
    assert.ok(home)
    assert.equal(resolveSkillFile('~/x/skill.md'), join(home, 'x/skill.md'))
    assert.equal(resolveSkillFile('/tmp/x/skill.md'), '/tmp/x/skill.md')
  })
})

describe('skill provider', () => {
  it('advertises the skill and serves the current Markdown body', async () => {
    const dir = tempDir()
    const file = join(dir, 'skill.md')
    writeFileSync(file, '# 评估规范\n\n正文内容\n')
    const { ctx, state } = mockCtx()
    apply(ctx, { skillFile: file })

    const candidates = await state.provider.list()
    assert.equal(candidates.length, 1)
    assert.equal(candidates[0].name, SKILL_NAME)
    assert.equal(candidates[0].provider, 'project-assessment')
    assert.deepEqual(candidates[0].invocation, { modelInvocable: true, userInvocable: true })

    const skill = await state.provider.get(candidates[0])
    assert.equal(skill.name, SKILL_NAME)
    assert.ok(skill.content.includes('正文内容'))
    assert.equal(skill.provider, 'project-assessment')
  })

  it('omits the skill while the file is missing', async () => {
    const dir = tempDir()
    const { ctx, state } = mockCtx()
    apply(ctx, { skillFile: join(dir, 'missing.md') })
    assert.deepEqual(await state.provider.list(), [])
    assert.equal(await state.provider.get({}), undefined)
  })
})

describe('trigger detection', () => {
  it('matches direct user input starting with /评估', () => {
    assert.equal(isAssessmentTrigger(userMessage('/评估')), true)
    assert.equal(isAssessmentTrigger(userMessage('  /评估 pdk_mover 重点看权限  ')), true)
    assert.equal(isAssessmentTrigger(userMessage('／评估')), true)
    assert.equal(isAssessmentTrigger(userMessage('/评估，看看回滚')), true)
  })

  it('ignores other slash tokens, normal prose, and non-user sources', () => {
    assert.equal(isAssessmentTrigger(userMessage('/project-assessment')), false)
    assert.equal(isAssessmentTrigger(userMessage('/评估x')), false)
    assert.equal(isAssessmentTrigger(userMessage('评估一下这个项目')), false)
    assert.equal(isAssessmentTrigger(nonUserMessage('/评估')), false)
    assert.equal(isAssessmentTrigger(undefined), false)
  })
})

describe('pre-step injection', () => {
  it('injects the full spec once for a /评估 message', async () => {
    const dir = tempDir()
    const file = join(dir, 'skill.md')
    writeFileSync(file, '# 评估规范\n\n请按规范评估。\n')
    const { ctx, state } = mockCtx()
    apply(ctx, { skillFile: file })

    const decision = await state.listener(
      { agent: {}, messages: [userMessage('/评估 demo')], signal: new AbortController().signal },
      async () => ENTER,
    )
    assert.equal(decision.messages.length, 1)
    const injected = decision.messages[0]
    assert.equal(injected.role, 'user')
    assert.equal(injected.source.kind, 'skill-invocation')
    assert.equal(injected.source.name, SKILL_NAME)
    assert.ok(injected.content[0].text.startsWith(`<skill_content name="${SKILL_NAME}">`))
    assert.ok(injected.content[0].text.includes('请按规范评估。'))
    assert.ok(typeof injected.id === 'string' && injected.id.length > 0)
  })

  it('leaves unrelated steps untouched', async () => {
    const dir = tempDir()
    const file = join(dir, 'skill.md')
    writeFileSync(file, '# 评估规范\n')
    const { ctx, state } = mockCtx()
    apply(ctx, { skillFile: file })

    for (const messages of [
      [userMessage('帮我看看这个项目的测试')],
      [userMessage('/project-assessment')],
      [nonUserMessage('/评估')],
      [],
    ]) {
      const decision = await state.listener(
        { agent: {}, messages, signal: new AbortController().signal },
        async () => ENTER,
      )
      assert.equal(decision.messages.length, 0)
    }
  })

  it('never fails the step when the spec file is unreadable', async () => {
    const dir = tempDir()
    const { ctx, state } = mockCtx()
    apply(ctx, { skillFile: join(dir, 'missing.md') })
    const decision = await state.listener(
      { agent: {}, messages: [userMessage('/评估')], signal: new AbortController().signal },
      async () => ENTER,
    )
    assert.equal(decision.messages.length, 0)
  })

  it('does not touch rejected steps', async () => {
    const dir = tempDir()
    const file = join(dir, 'skill.md')
    writeFileSync(file, '# 评估规范\n')
    const { ctx, state } = mockCtx()
    apply(ctx, { skillFile: file })
    const rejected = { kind: 'reject', reason: 'nope' }
    const decision = await state.listener(
      { agent: {}, messages: [userMessage('/评估')], signal: new AbortController().signal },
      async () => rejected,
    )
    assert.equal(decision, rejected)
  })
})

describe('rendering', () => {
  it('wraps the spec in the canonical skill_content envelope', () => {
    const text = renderSkillContent('正文', '/tmp/skill.md')
    assert.ok(text.startsWith('<skill_content name="project-assessment">'))
    assert.ok(text.includes('<skill_instructions>'))
    assert.ok(text.includes('正文'))
    assert.ok(text.endsWith('</skill_content>'))
  })

  it('builds a frozen message with a fresh identity', () => {
    const dir = tempDir()
    const file = join(dir, 'skill.md')
    writeFileSync(file, '# 评估规范\n')
    const a = createInstructionsMessage(file)
    const b = createInstructionsMessage(file)
    assert.ok(Object.isFrozen(a))
    assert.notEqual(a.id, b.id)
  })
})
