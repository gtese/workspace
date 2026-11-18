import { http } from './client.js'

const enc = encodeURIComponent

export const api = {
  auth: {
    me: (options = {}) => http.get('/api/auth/me', { toastError: false, redirectOn401: false, ...options }),
    login: (username, password) =>
      http.post('/api/auth/login', { username, password }, { redirectOn401: false, toastError: true }),
    logout: () => http.post('/api/auth/logout', undefined, { toastError: false }),
    config: () => http.get('/api/auth/config', { toastError: false, redirectOn401: false }),
  },

  clients: {
    list: (query, options) => http.get('/api/clients', { query, ...(options || {}) }),
    get: (id) => http.get(`/api/clients/${enc(id)}`),
    update: (id, body) => http.patch(`/api/clients/${enc(id)}`, body),
    enable: (id) => http.post(`/api/clients/${enc(id)}/enable`),
    disable: (id) => http.post(`/api/clients/${enc(id)}/disable`),
    remove: (id) => http.del(`/api/clients/${enc(id)}`),
    fs: (id, path) => http.get(`/api/clients/${enc(id)}/fs`, { query: { path: path || '/' } }),
  },

  enroll: {
    list: (status, options) => http.get('/api/enroll-requests', { query: status ? { status } : undefined, ...(options || {}) }),
    get: (id) => http.get(`/api/enroll-requests/${enc(id)}`),
    create: (body) => http.post('/api/enroll-requests', body),
    approve: (id, body) => http.post(`/api/enroll-requests/${enc(id)}/approve`, body || {}),
    reject: (id, body) => http.post(`/api/enroll-requests/${enc(id)}/reject`, body || {}),
  },

  repositories: {
    list: (options) => http.get('/api/repositories', options || {}),
    create: (body) => http.post('/api/repositories', body),
    update: (id, body) => http.patch(`/api/repositories/${enc(id)}`, body),
    remove: (id) => http.del(`/api/repositories/${enc(id)}`),
    validate: (id) => http.post(`/api/repositories/${enc(id)}/validate`),
    usage: (id) => http.get(`/api/repositories/${enc(id)}/usage`),
  },

  plans: {
    list: (query, options) => http.get('/api/plans', { query, ...(options || {}) }),
    create: (body) => http.post('/api/plans', body),
    update: (id, body) => http.patch(`/api/plans/${enc(id)}`, body),
    remove: (id) => http.del(`/api/plans/${enc(id)}`),
    run: (id, body) => http.post(`/api/plans/${enc(id)}/run`, body || {}),
    enable: (id) => http.post(`/api/plans/${enc(id)}/enable`),
    disable: (id) => http.post(`/api/plans/${enc(id)}/disable`),
  },

  runs: {
    list: (query, options) => http.get('/api/runs', { query, ...(options || {}) }),
    get: (id) => http.get(`/api/runs/${enc(id)}`),
    cancel: (id) => http.post(`/api/runs/${enc(id)}/cancel`),
    eventsPath: (id) => `/api/runs/${enc(id)}/events`,
  },

  snapshots: {
    list: (clientId, repositoryId, options) =>
      http.get(`/api/clients/${enc(clientId)}/snapshots`, {
        query: repositoryId ? { repository_id: repositoryId } : undefined,
        ...(options || {}),
      }),
    ls: (clientId, snapshotId, path, repositoryId) =>
      http.get(`/api/snapshots/${enc(clientId)}/${enc(snapshotId)}/ls`, {
        query: { path: path || '/', ...(repositoryId ? { repository_id: repositoryId } : {}) },
      }),
    search: (clientId, snapshotId, q, repositoryId) =>
      http.get(`/api/snapshots/${enc(clientId)}/${enc(snapshotId)}/search`, {
        query: { q, ...(repositoryId ? { repository_id: repositoryId } : {}) },
      }),
    restore: (clientId, snapshotId, body) =>
      http.post(`/api/snapshots/${enc(clientId)}/${enc(snapshotId)}/restore`, body),
    pin: (clientId, snapshotId, pinned, repositoryId) =>
      http.post(`/api/snapshots/${enc(clientId)}/${enc(snapshotId)}/pin`, {
        pinned, ...(repositoryId ? { repository_id: repositoryId } : {}),
      }),
    remove: (clientId, snapshotId, repositoryId) =>
      http.del(`/api/snapshots/${enc(clientId)}/${enc(snapshotId)}`, {
        query: repositoryId ? { repository_id: repositoryId } : undefined,
      }),
    downloadUrl: (clientId, snapshotId, path, repositoryId) =>
      `/api/snapshots/${enc(clientId)}/${enc(snapshotId)}/download?path=${enc(path || '/')}${repositoryId ? `&repository_id=${enc(repositoryId)}` : ''}`,
  },

  restores: {
    list: (query, options) => http.get('/api/restores', { query, ...(options || {}) }),
    get: (id) => http.get(`/api/restores/${enc(id)}`),
    cancel: (id) => http.post(`/api/restores/${enc(id)}/cancel`),
    eventsPath: (id) => `/api/restores/${enc(id)}/events`,
  },

  users: {
    list: (options) => http.get('/api/users', options || {}),
    create: (body) => http.post('/api/users', body),
    update: (id, body) => http.patch(`/api/users/${enc(id)}`, body),
    remove: (id) => http.del(`/api/users/${enc(id)}`),
  },

  audit: {
    list: (query, options) => http.get('/api/audit', { query, ...(options || {}) }),
  },

  settings: {
    getAlerts: () => http.get('/api/settings/alerts'),
    putAlerts: (body) => http.put('/api/settings/alerts', body),
    testAlerts: (body) => http.post('/api/settings/alerts/test', body || {}),
    getGeneral: () => http.get('/api/settings/general'),
  },

  health: {
    get: () => http.get('/healthz', { toastError: false, redirectOn401: false }),
  },
}
