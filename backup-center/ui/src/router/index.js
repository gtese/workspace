import { createRouter, createWebHistory } from 'vue-router'
import { pinia } from '../stores/index.js'
import { useAuthStore } from '../stores/auth.js'
import { toast } from '../lib/toast.js'
import AppLayout from '../components/AppLayout.vue'

const routes = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../views/LoginView.vue'),
    meta: { public: true, title: '登录' },
  },
  {
    path: '/',
    component: AppLayout,
    children: [
      {
        path: '',
        name: 'dashboard',
        component: () => import('../views/DashboardView.vue'),
        meta: { title: '概览', nav: 'dashboard' },
      },
      {
        path: 'clients',
        name: 'clients',
        component: () => import('../views/ClientsView.vue'),
        meta: { title: '节点管理', nav: 'clients' },
      },
      {
        path: 'clients/:id',
        name: 'client-detail',
        component: () => import('../views/ClientDetailView.vue'),
        meta: { title: '节点详情', nav: 'clients', parent: { name: 'clients', title: '节点管理' } },
      },
      {
        path: 'enroll',
        name: 'enroll',
        component: () => import('../views/EnrollView.vue'),
        meta: { title: '待审批节点', nav: 'enroll' },
      },
      {
        path: 'repositories',
        name: 'repositories',
        component: () => import('../views/RepositoriesView.vue'),
        meta: { title: '存储库', nav: 'repositories' },
      },
      {
        path: 'plans',
        name: 'plans',
        component: () => import('../views/PlansView.vue'),
        meta: { title: '备份计划', nav: 'plans' },
      },
      {
        path: 'runs',
        name: 'runs',
        component: () => import('../views/RunsView.vue'),
        meta: { title: '运行任务', nav: 'runs' },
      },
      {
        path: 'snapshots',
        name: 'snapshots',
        component: () => import('../views/SnapshotsView.vue'),
        meta: { title: '快照', nav: 'snapshots' },
      },
      {
        path: 'restores',
        name: 'restores',
        component: () => import('../views/RestoresView.vue'),
        meta: { title: '恢复任务', nav: 'restores' },
      },
      {
        path: 'users',
        name: 'users',
        component: () => import('../views/UsersView.vue'),
        meta: { title: '用户与角色', nav: 'users', roles: ['admin'] },
      },
      {
        path: 'audit',
        name: 'audit',
        component: () => import('../views/AuditView.vue'),
        meta: { title: '审计日志', nav: 'audit', roles: ['admin', 'auditor'] },
      },
      {
        path: 'settings',
        name: 'settings',
        component: () => import('../views/SettingsView.vue'),
        meta: { title: '设置', nav: 'settings' },
      },
      {
        path: ':pathMatch(.*)*',
        name: 'not-found',
        component: () => import('../views/NotFoundView.vue'),
        meta: { title: '页面不存在' },
      },
    ],
  },
]

const router = createRouter({
  history: createWebHistory('/'),
  routes,
  scrollBehavior(to, from, savedPosition) {
    if (savedPosition) return savedPosition
    return { top: 0 }
  },
})

function safeRedirect(value) {
  if (typeof value !== 'string') return null
  if (!value.startsWith('/') || value.startsWith('//')) return null
  if (value.startsWith('/login')) return null
  return value
}

router.beforeEach(async (to) => {
  const auth = useAuthStore(pinia)
  await auth.ensureLoaded()

  if (to.meta.public) {
    if (to.name === 'login' && auth.isAuthenticated) {
      return safeRedirect(to.query.redirect) || { name: 'dashboard' }
    }
    return true
  }

  if (!auth.isAuthenticated) {
    const query = to.fullPath && to.fullPath !== '/' ? { redirect: to.fullPath } : undefined
    return { name: 'login', query }
  }

  if (Array.isArray(to.meta.roles) && !to.meta.roles.includes(auth.role)) {
    toast.error('当前账号无权访问该页面')
    return { name: 'dashboard' }
  }

  return true
})

router.afterEach((to) => {
  const title = to.meta?.title
  document.title = title ? `${title} · backup-center` : 'backup-center 集中备份管理'
})

export default router
