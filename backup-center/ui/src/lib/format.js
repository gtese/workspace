const STATUS_MAP = {
  run: {
    queued: { label: '排队中', class: 'bg-slate-100 text-slate-600 ring-slate-200' },
    running: { label: '运行中', class: 'bg-blue-50 text-blue-700 ring-blue-200' },
    success: { label: '成功', class: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    failed: { label: '失败', class: 'bg-red-50 text-red-700 ring-red-200' },
    canceled: { label: '已取消', class: 'bg-amber-50 text-amber-700 ring-amber-200' },
    skipped: { label: '已跳过', class: 'bg-slate-100 text-slate-500 ring-slate-200' },
  },
  client: {
    active: { label: '在线', class: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    disabled: { label: '已停用', class: 'bg-slate-100 text-slate-500 ring-slate-200' },
    unknown: { label: '未知', class: 'bg-slate-100 text-slate-500 ring-slate-200' },
  },
  enroll: {
    pending: { label: '待审批', class: 'bg-amber-50 text-amber-700 ring-amber-200' },
    approved: { label: '已批准', class: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    rejected: { label: '已拒绝', class: 'bg-red-50 text-red-700 ring-red-200' },
    expired: { label: '已过期', class: 'bg-slate-100 text-slate-500 ring-slate-200' },
  },
  repo: {
    active: { label: '正常', class: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    ready: { label: '正常', class: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    online: { label: '正常', class: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    mounted: { label: '已挂载', class: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    degraded: { label: '降级', class: 'bg-amber-50 text-amber-700 ring-amber-200' },
    error: { label: '异常', class: 'bg-red-50 text-red-700 ring-red-200' },
    failed: { label: '异常', class: 'bg-red-50 text-red-700 ring-red-200' },
    offline: { label: '离线', class: 'bg-red-50 text-red-700 ring-red-200' },
  },
  restore: {
    queued: { label: '排队中', class: 'bg-slate-100 text-slate-600 ring-slate-200' },
    running: { label: '恢复中', class: 'bg-blue-50 text-blue-700 ring-blue-200' },
    success: { label: '成功', class: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    failed: { label: '失败', class: 'bg-red-50 text-red-700 ring-red-200' },
    canceled: { label: '已取消', class: 'bg-amber-50 text-amber-700 ring-amber-200' },
  },
  generic: {
    ok: { label: '正常', class: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    success: { label: '成功', class: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
    error: { label: '异常', class: 'bg-red-50 text-red-700 ring-red-200' },
    failed: { label: '失败', class: 'bg-red-50 text-red-700 ring-red-200' },
    pending: { label: '待处理', class: 'bg-amber-50 text-amber-700 ring-amber-200' },
  },
}

export function statusMeta(status, kind = 'generic') {
  const key = String(status || '').toLowerCase()
  const map = STATUS_MAP[kind] || STATUS_MAP.generic
  return map[key] || {
    label: status || '未知',
    class: 'bg-slate-100 text-slate-500 ring-slate-200',
  }
}

const ROLE_LABELS = {
  admin: '管理员',
  operator: '操作员',
  viewer: '只读用户',
  auditor: '审计员',
}

export function roleLabel(role) {
  return ROLE_LABELS[role] || role || '—'
}

const TRIGGER_LABELS = {
  schedule: '定时',
  manual: '手动',
  cron: '定时',
  api: 'API',
  retry: '重试',
}

export function triggerLabel(trigger) {
  return TRIGGER_LABELS[String(trigger || '').toLowerCase()] || trigger || '—'
}

const COMPRESSION_LABELS = {
  auto: '自动（zstd）',
  off: '不压缩',
  max: '最大压缩',
  zstd: 'zstd',
}

export function compressionLabel(value) {
  return COMPRESSION_LABELS[value] || value || '自动（zstd）'
}

const OVERWRITE_LABELS = {
  always: '总是覆盖',
  'if-changed': '仅内容变化时覆盖',
  never: '从不覆盖（保留现有文件）',
}

export function overwriteLabel(value) {
  return OVERWRITE_LABELS[value] || value || '—'
}

export function formatBytes(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 0) return '—'
  if (n === 0) return '0 B'
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v >= 100 ? v.toFixed(0) : v.toFixed(1)} ${units[i]}`
}

export function formatNumber(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return n.toLocaleString('zh-CN')
}

export function parseDate(value) {
  if (!value) return null
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

export function formatDateTime(value, withSeconds = true) {
  const d = parseDate(value)
  if (!d) return '—'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}${
    withSeconds ? `:${pad(d.getSeconds())}` : ''
  }`
}

export function formatRelative(value) {
  const d = parseDate(value)
  if (!d) return '—'
  const diff = Date.now() - d.getTime()
  if (diff < 0) return formatDateTime(value)
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return '刚刚'
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  return formatDateTime(value, false)
}

export function durationBetween(start, end) {
  const s = parseDate(start)
  const e = parseDate(end)
  if (!s || !e) return '—'
  const sec = Math.max(0, Math.round((e.getTime() - s.getTime()) / 1000))
  return formatDuration(sec)
}

export function formatDuration(totalSec) {
  const sec = Number(totalSec)
  if (!Number.isFinite(sec) || sec < 0) return '—'
  if (sec < 60) return `${Math.round(sec)} 秒`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分 ${Math.round(sec % 60)} 秒`
  const hour = Math.floor(min / 60)
  if (hour < 24) return `${hour} 小时 ${min % 60} 分`
  return `${Math.floor(hour / 24)} 天 ${hour % 24} 小时`
}

export function shortId(id, len = 10) {
  const s = String(id || '')
  if (s.length <= len) return s || '—'
  return `${s.slice(0, len)}…`
}

export function percent(part, total) {
  const p = Number(part)
  const t = Number(total)
  if (!Number.isFinite(p) || !Number.isFinite(t) || t <= 0) return 0
  return Math.min(100, Math.max(0, Math.round((p / t) * 100)))
}

export function isWithinHours(value, hours) {
  const d = parseDate(value)
  if (!d) return false
  return Date.now() - d.getTime() <= hours * 3600 * 1000
}

export function splitLines(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export function joinLines(arr) {
  return Array.isArray(arr) ? arr.join('\n') : ''
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const el = document.createElement('textarea')
      el.value = text
      el.style.position = 'fixed'
      el.style.opacity = '0'
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      return true
    } catch {
      return false
    }
  }
}

export const CRON_PRESETS = [
  { label: '每天 02:00', value: '0 2 * * *' },
  { label: '每天 22:00', value: '0 22 * * *' },
  { label: '工作日 01:30', value: '30 1 * * 1-5' },
  { label: '每周日 03:00', value: '0 3 * * 0' },
  { label: '每月 1 日 03:00', value: '0 3 1 * *' },
]
