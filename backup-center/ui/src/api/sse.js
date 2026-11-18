/**
 * SSE 封装（fetch 流，自动携带 Cookie）。
 * fetch 无法设置跨域头但同源 Cookie 会带上，因此本封装等价于 EventSource 且能读取
 * HTTP 状态码、在 401 时触发统一跳转，也支持 AbortController 主动关闭。
 */
export function openEventStream(path, options = {}) {
  const {
    onOpen,
    onEvent,
    onError,
    autoReconnect = true,
    maxRetries = 5,
    reconnectDelay = 1500,
  } = options

  let closed = false
  let retries = 0
  let controller = null
  let retryTimer = null

  function emit(rawEvent) {
    const dataText = rawEvent.data.join('\n')
    let payload = null
    if (dataText) {
      try {
        payload = JSON.parse(dataText)
      } catch {
        payload = null
      }
    }
    const eventName = rawEvent.event || 'message'
    onEvent?.({
      event: eventName,
      id: rawEvent.id || '',
      data: payload,
      raw: dataText,
    })
  }

  function parseBlock(block) {
    if (!block.trim()) return null
    const out = { event: '', id: '', data: [] }
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(':')) continue
      const idx = line.indexOf(':')
      const field = idx === -1 ? line : line.slice(0, idx)
      let value = idx === -1 ? '' : line.slice(idx + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'data') out.data.push(value)
      else if (field === 'event') out.event = value.trim()
      else if (field === 'id') out.id = value
    }
    if (!out.data.length && !out.event) return null
    return out
  }

  async function connect() {
    if (closed) return
    controller = new AbortController()
    try {
      const res = await fetch(path, {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'text/event-stream', 'Cache-Control': 'no-cache' },
        signal: controller.signal,
      })
      if (!res.ok) {
        const err = new Error(
          res.status === 401 ? '登录状态已失效，无法接收实时事件' : `实时事件连接失败（HTTP ${res.status}）`,
        )
        err.status = res.status
        throw err
      }
      if (!res.body) throw new Error('当前浏览器不支持流式响应')

      retries = 0
      onOpen?.()

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (!closed) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        let idx
        while ((idx = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, idx)
          buffer = buffer.slice(idx + 2)
          const rawEvent = parseBlock(block)
          if (!rawEvent) continue
          emit(rawEvent)
          if (rawEvent.event === 'done') {
            closed = true
            return
          }
        }
      }
      if (!closed) throw new Error('实时事件连接已断开')
    } catch (err) {
      if (closed || err?.name === 'AbortError') return
      onError?.(err)
      if (autoReconnect && retries < maxRetries) {
        retries += 1
        retryTimer = setTimeout(connect, reconnectDelay * retries)
      }
    }
  }

  connect()

  return {
    close() {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      controller?.abort()
    },
  }
}
