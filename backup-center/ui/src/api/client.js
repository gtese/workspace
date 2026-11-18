import { toast } from '../lib/toast.js'

let csrfToken = ''
let unauthorizedHandler = null

export function setCsrfToken(token) {
  csrfToken = token || ''
}

export function getCsrfToken() {
  return csrfToken
}

export function setUnauthorizedHandler(fn) {
  unauthorizedHandler = typeof fn === 'function' ? fn : null
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = '', details = null } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
    this.details = details
  }
}

function buildQuery(query) {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item !== undefined && item !== null && item !== '') params.append(key, String(item))
      }
    } else {
      params.append(key, String(value))
    }
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

async function parseResponse(res) {
  if (res.status === 204) return null
  const contentType = res.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    try {
      return await res.json()
    } catch {
      return null
    }
  }
  const text = await res.text()
  return text || null
}

/**
 * 统一 fetch 封装：Cookie 会话、CSRF、401 跳转、错误 Toast、JSON 解析。
 * @param {'GET'|'POST'|'PATCH'|'PUT'|'DELETE'} method
 * @param {string} path
 * @param {{body?: any, query?: object, headers?: object, toastError?: boolean, redirectOn401?: boolean, signal?: AbortSignal}} options
 */
export async function request(method, path, options = {}) {
  const { body, query, headers = {}, toastError = true, redirectOn401 = true, signal } = options
  const url = `${path}${buildQuery(query)}`
  const upperMethod = method.toUpperCase()
  const init = {
    method: upperMethod,
    credentials: 'include',
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    signal,
  }

  if (body !== undefined && body !== null) {
    if (body instanceof FormData) {
      init.body = body
    } else {
      init.headers['Content-Type'] = 'application/json'
      init.body = JSON.stringify(body)
    }
  }

  if (csrfToken && !['GET', 'HEAD', 'OPTIONS'].includes(upperMethod)) {
    init.headers['x-csrf-token'] = csrfToken
  }

  let res
  try {
    res = await fetch(url, init)
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    const apiErr = new ApiError('网络连接失败，请检查网络或服务是否可用', { code: 'network' })
    if (toastError) toast.error(apiErr.message)
    throw apiErr
  }

  const data = await parseResponse(res)

  if (!res.ok) {
    const errBody = data && typeof data === 'object' && !Array.isArray(data) ? data.error : null
    const message =
      errBody?.message ||
      (typeof data === 'string' && data.trim() ? data : '') ||
      `请求失败（HTTP ${res.status}）`
    const apiErr = new ApiError(message, {
      status: res.status,
      code: errBody?.code || '',
      details: data,
    })

    if (res.status === 401) {
      csrfToken = ''
      if (redirectOn401 && unauthorizedHandler) unauthorizedHandler()
      if (toastError) toast.error('登录状态已失效，请重新登录')
    } else if (toastError) {
      toast.error(message)
    }
    throw apiErr
  }

  return data
}

export const http = {
  get: (path, options) => request('GET', path, options),
  post: (path, body, options) => request('POST', path, { ...options, body }),
  patch: (path, body, options) => request('PATCH', path, { ...options, body }),
  put: (path, body, options) => request('PUT', path, { ...options, body }),
  del: (path, options) => request('DELETE', path, options),
}
