/**
 * @linyiyao/dsh-standing-rules
 *
 * Inject user-maintained "standing rules" into every DSH conversation as a
 * system-prompt section. The rules live in a plain Markdown file outside the
 * package (`$DSH_HOME/rules.md` by default) so they can be edited at any time;
 * the plugin only reads and renders them.
 *
 * This module deliberately imports only Node built-ins: the package is linked
 * into a DSH profile, where DSH's own packages are provided by the runtime
 * resolution and must not be imported by a bundle plugin.
 *
 * Registers one system-prompt section (order 100, right after the deployment
 * persona). The section text is re-read from disk on every assembly, so edits
 * to the rules file apply to the next model request — no restart needed
 * (subject to the section text being re-assembled, which DSH does per step).
 */

import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'

/** Stable Cordis plugin name (used by the bundle patch row id/name pairing). */
export const name = 'standing-rules'

/** The prompt registry this plugin contributes to. */
export const inject = ['systemPrompt']

/** Prompt-section name; kept in the `user:` namespace to avoid first-party collisions. */
export const SECTION_NAME = 'user:standing-rules'

const DEFAULT_RULES_FILE = '~/.dsh/rules.md'
const DEFAULT_MAX_BYTES = 32 * 1024
const DEFAULT_ORDER = 100
const TRUNCATION_NOTICE = (maxBytes, file) =>
  `\n\n[Truncated: the rules file exceeds the ${maxBytes}-byte limit. Shorten ${file}.]`

const HEADING = '## Standing rules (user-defined; apply to every conversation)'

/**
 * Expand `~`, `$HOME`, `$DSH_HOME` and `${DSH_HOME}` in a configured path.
 * Relative paths resolve against the DSH home directory.
 * @param {string} input - configured path.
 * @returns {string} absolute path.
 */
export function resolveRulesPath(input) {
  const home = process.env.HOME || homedir()
  const dshHome = process.env.DSH_HOME || join(home, '.dsh')
  let path = String(input)
  path = path.replace(/^~(?=$|\/)/, home)
  path = path.replace(/^\$\{DSH_HOME\}(?=$|\/)/, dshHome)
  path = path.replace(/^\$DSH_HOME(?=$|\/)/, dshHome)
  path = path.replace(/^\$\{HOME\}(?=$|\/)/, home)
  path = path.replace(/^\$HOME(?=$|\/)/, home)
  return isAbsolute(path) ? path : resolve(dshHome, path)
}

/**
 * Normalize the plugin row configuration.
 * @param {object} [raw] - config object from the bundle patch.
 * @returns {{ rulesFile: string, maxBytes: number, order: number }}
 */
export function resolveConfig(raw = {}) {
  const rawFile =
    typeof raw.rulesFile === 'string' && raw.rulesFile.trim() !== ''
      ? raw.rulesFile.trim()
      : DEFAULT_RULES_FILE
  const rawMax = raw.maxBytes
  const rawOrder = raw.order
  return {
    rulesFile: resolveRulesPath(rawFile),
    maxBytes:
      typeof rawMax === 'number' && Number.isFinite(rawMax) && rawMax > 0
        ? Math.floor(rawMax)
        : DEFAULT_MAX_BYTES,
    order: typeof rawOrder === 'number' && Number.isFinite(rawOrder) ? rawOrder : DEFAULT_ORDER,
  }
}

/**
 * Read a file up to `maxBytes` bytes without loading an unbounded file into
 * memory. Returns the decoded text and whether it was truncated.
 * @param {string} file - absolute path.
 * @param {number} maxBytes - byte budget.
 * @returns {{ text: string, truncated: boolean }}
 */
function readBounded(file, maxBytes) {
  const info = statSync(file)
  if (!info.isFile()) throw new Error(`not a regular file: ${file}`)
  const length = Math.min(info.size, maxBytes)
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  let read = 0
  try {
    while (read < length) {
      const n = readSync(fd, buffer, read, length - read, read)
      if (n === 0) break
      read += n
    }
  } finally {
    closeSync(fd)
  }
  let text = buffer.subarray(0, read).toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  if (info.size > maxBytes) {
    // A byte cut can split a multi-byte character; drop the replacement char.
    text = text.replace(/\uFFFD+$/, '')
  }
  return { text, truncated: info.size > maxBytes }
}

/**
 * Create a reader that caches the rendered rules by file identity (mtime+size)
 * and returns the current section text on each assembly call.
 * @param {{ rulesFile: string, maxBytes: number }} config - resolved config.
 * @returns {() => string} section text provider.
 */
export function createRulesReader({ rulesFile, maxBytes }) {
  let cache = { mtimeMs: -1, size: -1, text: '' }
  return function readRules() {
    let info
    try {
      info = statSync(rulesFile)
    } catch {
      cache = { mtimeMs: -1, size: -1, text: '' }
      return ''
    }
    if (cache.mtimeMs === info.mtimeMs && cache.size === info.size) return cache.text
    let rendered
    try {
      const { text, truncated } = readBounded(rulesFile, maxBytes)
      const body = text.trim()
      if (body === '') {
        rendered = ''
      } else {
        rendered = `${HEADING}\n\nSource: \`${rulesFile}\`\n\n${body}${truncated ? TRUNCATION_NOTICE(maxBytes, rulesFile) : ''}\n`
      }
    } catch {
      // An unreadable rules file must never fail prompt assembly: skip it.
      rendered = ''
    }
    cache = { mtimeMs: info.mtimeMs, size: info.size, text: rendered }
    return rendered
  }
}

/**
 * Mount the standing-rules section.
 * @param {object} ctx - Cordis context with the `systemPrompt` service.
 * @param {object} [config] - row config: `rulesFile`, `maxBytes`, `order`.
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config)
  const readRules = createRulesReader(resolved)
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: resolved.order,
    interpolate: false,
    text: readRules,
  })
  try {
    statSync(resolved.rulesFile)
  } catch {
    try {
      ctx.logger?.warn(
        `[standing-rules] rules file not found: ${resolved.rulesFile} — create it to inject standing rules`,
      )
    } catch {
      // Logging is best-effort.
    }
  }
}
