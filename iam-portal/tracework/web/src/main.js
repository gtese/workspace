import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import { useAppStore } from './store.js';
import { setUnauthorizedHandler } from './api.js';
import './styles.css';

const routes = [
  { path: '/login', name: 'login', component: () => import('./views/LoginView.vue'), meta: { public: true } },
  { path: '/', redirect: '/dashboard' },
  { path: '/dashboard', name: 'dashboard', component: () => import('./views/DashboardView.vue') },
  { path: '/fill', name: 'fill', component: () => import('./views/FillView.vue') },
  // 审批中心对所有登录用户开放：审批人看待办，员工看「我提交的」
  { path: '/approve', name: 'approve', component: () => import('./views/ApproveView.vue'), meta: { role: 'myApprovals' } },
  { path: '/summary', name: 'summary', component: () => import('./views/SummaryView.vue'), meta: { role: 'approver' } },
  { path: '/it-assets', name: 'assets', component: () => import('./views/AssetsView.vue') },
  { path: '/projects', name: 'projects', component: () => import('./views/ProjectView.vue'), meta: { role: 'projectAdmin' } },
  { path: '/archive', name: 'archive', component: () => import('./views/ArchiveView.vue') },
  { path: '/workflow-settings', name: 'workflowSettings', component: () => import('./views/WorkflowSettingsView.vue'), meta: { role: 'admin' } },
  { path: '/rules', name: 'rules', component: () => import('./views/RulesView.vue') },
  { path: '/admin', name: 'admin', component: () => import('./views/AdminView.vue'), meta: { role: 'admin' } },
  { path: '/hr', name: 'hr', component: () => import('./views/HrView.vue'), meta: { role: 'hr' } },
  { path: '/finance', name: 'finance', component: () => import('./views/FinanceView.vue'), meta: { role: 'finance' } },
  { path: '/deduction', name: 'deduction', component: () => import('./views/DeductionView.vue'), meta: { role: 'finance' } },
  { path: '/ledgers', name: 'ledgers', component: () => import('./views/LedgerView.vue'), meta: { role: 'finance' } },
  { path: '/docs', name: 'docs', component: () => import('./views/DocsView.vue'), meta: { role: 'finance' } },
  { path: '/:pathMatch(.*)*', redirect: '/dashboard' },
];

const router = createRouter({ history: createWebHistory(), routes });
const pinia = createPinia();

const app = createApp(App);
app.use(pinia);
app.use(router);

const store = useAppStore(pinia);

// 启动时探测认证模式，供 401 处理与登出使用
// 注意：必须先声明再被下面的 handler 引用，否则会触发 TDZ（暂时性死区）错误
let authMode = 'ldap';
fetch('/api/auth/mode', { headers: { accept: 'application/json' } })
  .then((r) => (r.ok ? r.json() : null))
  .then((d) => { if (d?.mode === 'oidc') authMode = 'oidc'; })
  .catch(() => {});

/**
 * 会话失效处理。
 *
 * OIDC 模式：直接跳统一身份登录（带 returnTo），若 IdP 已有会话会**秒回**，
 *           用户体验是「无感续期」；若没有会话才需要输入口令。
 * LDAP 模式：回本地登录页（原有行为）。
 */
setUnauthorizedHandler(() => {
  store.clear();
  const cur = router.currentRoute.value;
  if (cur.name === 'login') return;

  if (authMode === 'oidc') {
    const back = encodeURIComponent(cur.fullPath || '/');
    window.location.href = `/api/auth/login?returnTo=${back}`;
    return;
  }
  router.replace({ name: 'login', query: { redirect: cur.fullPath } });
});


router.beforeEach(async (to) => {
  if (!store.booted) await store.bootstrap();

  if (to.meta.public) {
    // 已登录访问登录页 -> 回首页
    return store.isLoggedIn ? { name: 'dashboard' } : true;
  }
  if (!store.isLoggedIn) {
    return { name: 'login', query: { redirect: to.fullPath } };
  }
  if (to.meta.role === 'admin' && !store.permissions.canAdmin) {
    return { name: 'dashboard' };
  }
  if (to.meta.role === 'hr' && !store.permissions.canHr) {
    return { name: 'dashboard' };
  }
  if (to.meta.role === 'approver' && !store.permissions.canApprove) {
    return { name: 'dashboard' };
  }
  // 「我的审批」只要登录即可访问（员工查看自己提交的进度）
  if (to.meta.role === 'myApprovals' && !store.isLoggedIn) {
    return { name: 'login' };
  }
  // 项目管理需要审批/财务/人事任一权限
  if (to.meta.role === 'projectAdmin'
      && !(store.permissions.canApprove || store.permissions.canFinance || store.permissions.canHr)) {
    return { name: 'dashboard' };
  }
  if (to.meta.role === 'finance' && !store.permissions.canFinance) {
    return { name: 'dashboard' };
  }
  return true;
});

app.mount('#app');