import { reactive } from 'vue'

let seq = 0
export const toastState = reactive({ items: [] })

const ICONS = {
  success: '✓',
  error: '!',
  info: 'i',
  warning: '!',
}

export function pushToast(type, message, timeout = 4000) {
  const id = ++seq
  toastState.items.push({ id, type, message: String(message || ''), icon: ICONS[type] || 'i' })
  if (timeout > 0) {
    setTimeout(() => removeToast(id), timeout)
  }
  return id
}

export function removeToast(id) {
  const idx = toastState.items.findIndex((t) => t.id === id)
  if (idx >= 0) toastState.items.splice(idx, 1)
}

export const toast = {
  success: (msg, timeout) => pushToast('success', msg, timeout),
  error: (msg, timeout) => pushToast('error', msg, timeout),
  info: (msg, timeout) => pushToast('info', msg, timeout),
  warning: (msg, timeout) => pushToast('warning', msg, timeout),
}
