/** 全局状态（Pinia）。 */
import { defineStore } from 'pinia';
import { api } from './api.js';

export const useAppStore = defineStore('app', {
  state: () => ({
    user: null,
    permissions: { canFill: false, canApprove: false, canViewMyApprovals: false, canAdmin: false, canHr: false, canFinance: false },
    pendingApprovals: 0,
    meta: { projects: [], holidays: {}, currentPeriod: '', approvalSlaWorkdays: 2 },
    booted: false,
    loading: false,
  }),

  getters: {
    isLoggedIn: (s) => !!s.user,
    roleLabel: (s) => ({
      admin: '系统管理员', hr: '人力资源部', finance: '财务部',
      pm: '项目负责人', employee: '研发人员',
    }[s.user?.role] ?? '用户'),
    activeProjects: (s) => s.meta.projects.filter((p) => p.isActive),
    rndProjects: (s) => s.meta.projects.filter((p) => p.isRnd),
  },

  actions: {
    async bootstrap() {
      try {
        const me = await api.me();
        this.user = me.user;
        this.permissions = me.permissions;
        this.pendingApprovals = me.pendingApprovals;
        await this.loadMeta();
        return true;
      } catch {
        this.user = null;
        return false;
      } finally {
        this.booted = true;
      }
    },

    async loadMeta() {
      try {
        const meta = await api.meta();
        this.meta = meta;
      } catch { /* 元数据失败不阻断 */ }
    },

    async login(username, password) {
      const r = await api.login(username, password);
      this.user = r.user;
      await this.refreshMe();
      await this.loadMeta();
      return r;
    },

    async refreshMe() {
      try {
        const me = await api.me();
        this.user = me.user;
        this.permissions = me.permissions;
        this.pendingApprovals = me.pendingApprovals;
      } catch { /* 忽略 */ }
    },

    /**
     * 登出。
     *
     * OIDC 模式：需要整页跳转 IdP 的 end_session_endpoint，
     *   否则只清了本系统 cookie，统一身份会话仍在 —— 再打开别的系统仍是登录态。
     * LDAP 模式：清本地会话后回登录页。
     */
    async logout() {
      let logoutUrl = null;
      try {
        const r = await api.logout();
        logoutUrl = r?.logoutUrl ?? null;
      } catch { /* 忽略 */ }
      this.user = null;
      this.pendingApprovals = 0;
      if (logoutUrl) {
        window.location.href = logoutUrl;   // 必须整页跳转，不能 fetch
        return;
      }
      window.location.href = '/login';
    },

    clear() {
      this.user = null;
      this.permissions = { canFill: false, canApprove: false, canViewMyApprovals: false, canAdmin: false, canHr: false, canFinance: false };
      this.pendingApprovals = 0;
    },
  },
});