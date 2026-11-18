export function listOf(data, ...keys) {
  if (Array.isArray(data)) return data
  for (const key of keys) {
    if (Array.isArray(data?.[key])) return data[key]
  }
  if (Array.isArray(data?.items)) return data.items
  return []
}

export function totalOf(data) {
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const candidates = [data.total, data.count, data.total_count]
    for (const value of candidates) {
      if (typeof value === 'number') return value
    }
  }
  return null
}

export function asNumber(value, fallback = 0) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}
