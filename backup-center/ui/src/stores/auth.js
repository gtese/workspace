import { defineStore } from 'pinia'
import { api } from '../api/index.js'
import { setCsrfToken } from '../api/client.js'

export const useAuthStore = defineStore('auth', {
  state: () => ({
    user: null,
    csrf: '',
    loaded: false,
    loading: false,
    loggingIn: false,
  }),
  getters: {
    isAuthenticated: (state) => !!state.user,
    role: (state) => state.user?.role || '',
    displayName: (state) => state.user?.display_name || state.user?.username || '',
    isAdmin: (state) => state.user?.role === 'admin',
    canWrite: (state) => ['admin', 'operator'].includes(state.user?.role),
    canAudit: (state) => ['admin', 'auditor'].includes(state.user?.role),
  },
  actions: {
    setSession(user, csrf) {
      this.user = user || null
      this.csrf = csrf || ''
      setCsrfToken(this.csrf)
    },
    reset() {
      this.user = null
      this.csrf = ''
      setCsrfToken('')
    },
    async fetchMe() {
      this.loading = true
      try {
        const data = await api.auth.me()
        this.setSession(data?.user, data?.csrf)
        return this.user
      } catch {
        this.reset()
        return null
      } finally {
        this.loaded = true
        this.loading = false
      }
    },
    async ensureLoaded() {
      if (this.loaded) return this.user
      return this.fetchMe()
    },
    async login(username, password) {
      this.loggingIn = true
      try {
        await api.auth.login(username, password)
        await this.fetchMe()
        return this.user
      } finally {
        this.loggingIn = false
      }
    },
    async logout() {
      try {
        await api.auth.logout()
      } catch {
        // 本地会话清理优先
      } finally {
        this.reset()
      }
    },
    hasRole(...roles) {
      return roles.flat().includes(this.user?.role)
    },
  },
})
