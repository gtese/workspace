import { defineStore } from 'pinia'
import { api } from '../api/index.js'

/**
 * 节点/存储库公共缓存：多个页面与目录选择器复用，避免重复请求。
 */
export const useMetaStore = defineStore('meta', {
  state: () => ({
    clients: [],
    repositories: [],
    loadedClients: false,
    loadedRepositories: false,
    loadingClients: false,
    loadingRepositories: false,
    clientsError: '',
    repositoriesError: '',
  }),
  getters: {
    clientMap: (state) => Object.fromEntries(state.clients.map((c) => [c.id, c])),
    repositoryMap: (state) => Object.fromEntries(state.repositories.map((r) => [r.id, r])),
    activeClients: (state) => state.clients.filter((c) => c.status !== 'disabled'),
    clientName: (state) => (id) => state.clients.find((c) => c.id === id)?.hostname || id || '—',
    repositoryName: (state) => (id) => state.repositories.find((r) => r.id === id)?.name || id || '—',
  },
  actions: {
    async loadClients(force = false) {
      if (this.loadingClients) return this.clients
      if (this.loadedClients && !force) return this.clients
      this.loadingClients = true
      this.clientsError = ''
      try {
        const data = await api.clients.list()
        this.clients = Array.isArray(data) ? data : data?.clients || data?.items || []
        this.loadedClients = true
      } catch (err) {
        this.clientsError = err?.message || '加载节点列表失败'
      } finally {
        this.loadingClients = false
      }
      return this.clients
    },
    async loadRepositories(force = false) {
      if (this.loadingRepositories) return this.repositories
      if (this.loadedRepositories && !force) return this.repositories
      this.loadingRepositories = true
      this.repositoriesError = ''
      try {
        const data = await api.repositories.list()
        this.repositories = Array.isArray(data) ? data : data?.repositories || data?.items || []
        this.loadedRepositories = true
      } catch (err) {
        this.repositoriesError = err?.message || '加载存储库失败'
      } finally {
        this.loadingRepositories = false
      }
      return this.repositories
    },
    async refreshAll() {
      await Promise.all([this.loadClients(true), this.loadRepositories(true)])
    },
  },
})
