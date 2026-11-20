/**
 * @linyiyao/dsh-project-assessment
 *
 * On-demand "project delivery assessment" capability for DSH.
 *
 * Two complementary entry points:
 *
 * 1. `/评估 [scope]` — typed into the composer. DSH command names are limited
 *    to lowercase ASCII, so `/评估` is not a host command; the Web client sends
 *    an unrecognized slash line as an ordinary user message. This plugin
 *    watches `agent/pre-step` and, when a direct user message starts with
 *    `/评估`, injects the full assessment instructions before the model step.
 *
 * 2. `/project-assessment` — a normal user-invocable skill (registered through
 *    a skill provider). DSH's own `tool-skill` pre-step listener injects the
 *    skill body deterministically, exactly like any other skill.
 *
 * The assessment spec lives in `skill/project-assessment.md` next to this
 * module, so it is editable without touching code; a file watcher invalidates
 * the skill catalog, and every injection re-reads the file.
 *
 * The module imports only Node built-ins: the bundle is linked into a DSH
 * profile where DSH packages are provided by the runtime resolution.
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, statSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Stable Cordis plugin name. */
export const name = 'project-assessment'

/** The skill registry is required to advertise the `/project-assessment` skill. */
export const inject = ['skills']

/** Skill name (must be kebab-case ASCII). */
export const SKILL_NAME = 'project-assessment'

/** Provider name registered in the skill registry. */
const PROVIDER_NAME = 'project-assessment'

/** Provider rank: below project skills (100/200), above user skills (400). */
const PROVIDER_RANK = 350

/** Source label attached to the skill and to injected messages. */
const SOURCE = 'plugin:@linyiyao/dsh-project-assessment'

const DEFAULT_SKILL_FILE = fileURLToPath(new URL('../skill/project-assessment.md', import.meta.url))

const DESCRIPTION =
  '企业级项目上线交付评估（/评估 触发）：以独立评估专家身份检查需求、功能、流程、体验、数据、权限、性能、容错、集成与运维，输出分级问题清单与 Go/Conditional Go/No-Go 结论。'

const WHEN_TO_USE =
  '当用户输入 /评估，或要求对某个项目做上线前评估、验收、交付评审、重大变更风险评审，或询问“能不能上线 / 是否值得交付”时使用。'

/** Matches a direct user message that starts with `/评估` (half- or full-width slash). */
const TRIGGER = /^[\/／]\s*评估(?=$|[\s，,。.；;：:、\-—])/u

/**
 * Expand `~` in a configured skill path.
 * @param {string} input - configured path.
 * @returns {string} absolute or cwd-relative path.
 */
export function resolveSkillFile(input) {
  const raw = String(input).trim()
  return raw.replace(/^~(?=$|\/)/, process.env.HOME || homedir())
}

/** Effective skill file, honoring the optional `skillFile` row config. */
function skillFileOf(config) {
  const configured = typeof config?.skillFile === 'string' && config.skillFile.trim() !== ''
  return resolveSkillFile(configured ? config.skillFile : DEFAULT_SKILL_FILE)
}

/** Whether the skill file currently exists as a regular file. */
function skillFileExists(file) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

/**
 * Read the current assessment spec.
 * @param {string} file - absolute skill file path.
 * @returns {string} raw Markdown.
 */
function readSkill(file) {
  return readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
}

/** Render the canonical `<skill_content>` block the model expects for skills. */
export function renderSkillContent(content, file) {
  return [
    `<skill_content name="${SKILL_NAME}">`,
    '<skill_resources>',
    `Base directory for this skill: ${dirname(file)}`,
    'Resolve relative paths mentioned by this skill against the base directory before using them. Load referenced resources only as needed.',
    '</skill_resources>',
    '',
    '<skill_instructions>',
    content.trim(),
    '</skill_instructions>',
    '</skill_content>',
  ].join('\n')
}

/** Concatenated text of a message (empty for non-user or contentless messages). */
function messageText(message) {
  if (message === undefined || message.role !== 'user' || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
    .trim()
}

/**
 * Whether one claimed message asks for an assessment.
 * Only direct user input can trigger: injected context must never re-trigger.
 * @param {object} message - claimed session message.
 * @returns {boolean}
 */
export function isAssessmentTrigger(message) {
  if (message?.source?.kind !== 'user') return false
  return TRIGGER.test(messageText(message))
}

/** Build the model-visible injection that carries the full assessment spec. */
export function createInstructionsMessage(file) {
  const message = {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: renderSkillContent(readSkill(file), file) }],
    source: { kind: 'skill-invocation', name: SKILL_NAME, form: 'instructions' },
  }
  return Object.freeze(message)
}

/**
 * Register the skill provider: the catalog advertises the skill and `get`
 * re-reads the Markdown file, so edits are visible on the next load.
 * A directory watcher invalidates the catalog when the file changes.
 */
function registerProvider(ctx, file) {
  ctx.skills.registerProvider((control) => {
    let watcher
    const close = () => {
      try {
        watcher?.close()
      } catch {
        // Watcher cleanup is best-effort.
      }
    }
    try {
      watcher = watch(dirname(file), { persistent: false }, (event, changed) => {
        if (changed === undefined || changed === basename(file)) {
          try {
            control.invalidate()
          } catch {
            // Invalidation is best-effort.
          }
        }
      })
    } catch {
      // A missing directory just means no live refresh of the catalog.
    }
    control.signal.addEventListener('abort', close, { once: true })

    const summary = {
      name: SKILL_NAME,
      description: DESCRIPTION,
      whenToUse: WHEN_TO_USE,
      invocation: { modelInvocable: true, userInvocable: true },
      source: SOURCE,
      rank: PROVIDER_RANK,
      provider: PROVIDER_NAME,
      locator: { path: file },
      path: file,
    }

    return {
      name: PROVIDER_NAME,
      async list() {
        if (!skillFileExists(file)) return []
        return [summary]
      },
      async get() {
        if (!skillFileExists(file)) return undefined
        let content
        try {
          content = readSkill(file)
        } catch {
          return undefined
        }
        return {
          name: SKILL_NAME,
          description: DESCRIPTION,
          whenToUse: WHEN_TO_USE,
          content,
          invocation: { modelInvocable: true, userInvocable: true },
          source: SOURCE,
          provider: PROVIDER_NAME,
          resourceBase: { kind: 'directory', path: dirname(file) },
          path: file,
        }
      },
    }
  })
}

/**
 * Mount the assessment capability.
 * @param {object} ctx - Cordis context with the `skills` service.
 * @param {object} [config] - row config: optional `skillFile`.
 */
export function apply(ctx, config = {}) {
  const file = skillFileOf(config)
  registerProvider(ctx, file)
  if (!skillFileExists(file)) {
    try {
      ctx.logger?.warn(
        `[project-assessment] assessment spec not found: ${file} — /评估 cannot inject instructions until it exists`,
      )
    } catch {
      // Logging is best-effort.
    }
  }

  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    if (signal?.aborted) return decision
    const batch = Array.isArray(messages) ? messages : []
    if (!batch.some(isAssessmentTrigger)) return decision
    let injected
    try {
      injected = createInstructionsMessage(file)
    } catch (error) {
      try {
        ctx.logger?.warn(`[project-assessment] failed to read ${file}: ${error instanceof Error ? error.message : String(error)}`)
      } catch {
        // Logging is best-effort.
      }
      return decision
    }
    return {
      ...decision,
      messages: [...decision.messages, injected],
    }
  })
}
