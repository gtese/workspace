<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import {
  Activity,
  CalendarClock,
  Camera,
  ChevronDown,
  ChevronRight,
  Database,
  HardDriveDownload,
  LayoutDashboard,
  LogOut,
  Menu,
  RotateCcw,
  ScrollText,
  Server,
  Settings,
  ShieldCheck,
  UserCheck,
  Users,
  X,
} from 'lucide-vue-next'
import { useAuthStore } from '../stores/auth.js'
import { confirm } from '../lib/confirm.js'
import { roleLabel } from '../lib/format.js'
import { toast } from '../lib/toast.js'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const sidebarOpen = ref(false)
const userMenuOpen = ref(false)
const userMenuRef = ref(null)

const NAV_GROUPS = [
  {
    section: '总览',
    items: [{ nav: 'dashboard', route: 'dashboard', label: '概览', icon: LayoutDashboard }],
  },
  {
    section: '资产',
    items: [
      { nav: 'clients', route: 'clients', label: '节点管理', icon: Server },
      { nav: 'enroll', route: 'enroll', label: '待审批节点', icon: UserCheck },
      { nav: 'repositories', route: 'repositories', label: '存储库', icon: Database },
    ],
  },
  {
    section: '备份',
    items: [
      { nav: 'plans', route: 'plans', label: '备份计划', icon: CalendarClock },
      { nav: 'runs', route: 'runs', label: '运行任务', icon: Activity },
      { nav: 'snapshots', route: 'snapshots', label: '快照', icon: Camera },
      { nav: 'restores', route: 'restores', label: '恢复任务', icon: RotateCcw },
    ],
  },
  {
    section: '系统',
    items: [
      { nav: 'users', route: 'users', label: '用户与角色', icon: Users, roles: ['admin'] },
      { nav: 'audit', route: 'audit', label: '审计日志', icon: ScrollText, roles: ['admin', 'auditor'] },
      { nav: 'settings', route: 'settings', label: '设置', icon: Settings },
    ],
  },
]

const navGroups = computed(() =>
  NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => !item.roles || item.roles.includes(auth.role)),
  })).filter((group) => group.items.length > 0),
)

const crumbs = computed(() => {
  const items = []
  if (route.name !== 'dashboard') {
    items.push({ label: '首页', to: { name: 'dashboard' } })
  }
  if (route.meta?.parent) {
    items.push({
      label: route.meta.parent.title,
      to: route.meta.parent.name ? { name: route.meta.parent.name } : null,
    })
  }
  items.push({ label: route.meta?.title || '页面', to: null })
  return items
})

function isActive(item) {
  return route.meta?.nav === item.nav
}

function onDocumentClick(e) {
  if (userMenuRef.value && !userMenuRef.value.contains(e.target)) {
    userMenuOpen.value = false
  }
}

onMounted(() => document.addEventListener('click', onDocumentClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocumentClick))

watch(
  () => route.fullPath,
  () => {
    sidebarOpen.value = false
    userMenuOpen.value = false
  },
)

async function handleLogout() {
  userMenuOpen.value = false
  const ok = await confirm({
    title: '退出登录',
    message: '确认退出当前账号？',
    confirmText: '退出',
    danger: true,
  })
  if (!ok) return
  await auth.logout()
  toast.success('已退出登录')
  router.replace({ name: 'login' })
}
</script>

<template>
  <div class="min-h-screen bg-slate-100">
    <!-- 移动端遮罩 -->
    <div
      v-if="sidebarOpen"
      class="fixed inset-0 z-30 bg-slate-900/60 backdrop-blur-[1px] lg:hidden"
      @click="sidebarOpen = false"
    />

    <!-- 深色侧边栏 -->
    <aside
      class="fixed inset-y-0 left-0 z-40 flex w-60 flex-col bg-slate-900 text-slate-300 transition-transform duration-200 lg:translate-x-0"
      :class="sidebarOpen ? 'translate-x-0' : '-translate-x-full'"
    >
      <div class="flex h-14 shrink-0 items-center gap-2.5 border-b border-slate-800 px-4">
        <span class="flex h-8 w-8 items-center justify-center rounded-lg bg-brand-600 text-white">
          <HardDriveDownload class="h-4.5 w-4.5" style="width: 18px; height: 18px" />
        </span>
        <div class="min-w-0 flex-1">
          <p class="truncate text-sm font-semibold tracking-tight text-white">backup-center</p>
          <p class="truncate text-[10px] text-slate-500">集中备份管理平台</p>
        </div>
        <button
          type="button"
          class="rounded-md p-1 text-slate-400 hover:bg-slate-800 hover:text-white lg:hidden"
          aria-label="关闭菜单"
          @click="sidebarOpen = false"
        >
          <X class="h-4 w-4" />
        </button>
      </div>

      <nav class="flex-1 overflow-y-auto px-3 py-4">
        <div v-for="group in navGroups" :key="group.section" class="mb-4">
          <p class="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
            {{ group.section }}
          </p>
          <RouterLink
            v-for="item in group.items"
            :key="item.nav"
            :to="{ name: item.route }"
            class="group mb-0.5 flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm transition"
            :class="
              isActive(item)
                ? 'bg-slate-800 font-medium text-white'
                : 'text-slate-400 hover:bg-slate-800/60 hover:text-slate-100'
            "
          >
            <component
              :is="item.icon"
              class="h-4 w-4 shrink-0"
              :class="isActive(item) ? 'text-brand-400' : 'text-slate-500 group-hover:text-slate-300'"
            />
            <span class="flex-1 truncate">{{ item.label }}</span>
            <span v-if="isActive(item)" class="h-1.5 w-1.5 rounded-full bg-brand-400" />
          </RouterLink>
        </div>
      </nav>

      <div class="shrink-0 border-t border-slate-800 px-4 py-3">
        <div class="flex items-center gap-2 text-[11px] text-slate-500">
          <ShieldCheck class="h-3.5 w-3.5 text-slate-600" />
          <span class="flex-1">会话受 CSRF 保护</span>
          <span class="font-mono">v1.0</span>
        </div>
      </div>
    </aside>

    <!-- 主区域 -->
    <div class="flex min-h-screen flex-col lg:pl-60">
      <header class="sticky top-0 z-20 border-b border-slate-200 bg-white/90 backdrop-blur">
        <div class="flex h-14 items-center gap-3 px-4 sm:px-6 lg:px-8">
          <button
            type="button"
            class="rounded-lg p-1.5 text-slate-500 hover:bg-slate-100 lg:hidden"
            aria-label="打开菜单"
            @click="sidebarOpen = true"
          >
            <Menu class="h-5 w-5" />
          </button>

          <nav class="flex min-w-0 items-center gap-1.5 text-sm">
            <template v-for="(crumb, index) in crumbs" :key="index">
              <ChevronRight v-if="index > 0" class="h-3.5 w-3.5 shrink-0 text-slate-300" />
              <RouterLink
                v-if="crumb.to"
                :to="crumb.to"
                class="shrink-0 rounded px-1 py-0.5 text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
              >
                {{ crumb.label }}
              </RouterLink>
              <span
                v-else
                class="truncate px-1 py-0.5"
                :class="index === crumbs.length - 1 ? 'font-medium text-slate-800' : 'text-slate-500'"
              >
                {{ crumb.label }}
              </span>
            </template>
          </nav>

          <div class="ml-auto flex items-center gap-2">
            <div ref="userMenuRef" class="relative">
              <button
                type="button"
                class="flex items-center gap-2 rounded-lg px-2 py-1.5 transition hover:bg-slate-100"
                @click.stop="userMenuOpen = !userMenuOpen"
              >
                <span class="flex h-8 w-8 items-center justify-center rounded-full bg-brand-600 text-sm font-semibold text-white">
                  {{ (auth.displayName || '?').slice(0, 1).toUpperCase() }}
                </span>
                <span class="hidden text-left sm:block">
                  <span class="block max-w-[10rem] truncate text-sm font-medium leading-4 text-slate-700">{{ auth.displayName }}</span>
                  <span class="block text-[11px] leading-4 text-slate-400">{{ roleLabel(auth.role) }}</span>
                </span>
                <ChevronDown class="h-4 w-4 text-slate-400" />
              </button>

              <Transition
                enter-active-class="transition duration-100 ease-out"
                enter-from-class="opacity-0 -translate-y-1"
                leave-active-class="transition duration-75 ease-in"
                leave-to-class="opacity-0 -translate-y-1"
              >
                <div
                  v-if="userMenuOpen"
                  class="absolute right-0 mt-2 w-64 overflow-hidden rounded-xl border border-slate-200 bg-white shadow-xl"
                  @click.stop
                >
                  <div class="border-b border-slate-100 px-4 py-3">
                    <p class="truncate text-sm font-medium text-slate-800">{{ auth.displayName }}</p>
                    <p class="truncate text-xs text-slate-500">{{ auth.user?.username }} · {{ roleLabel(auth.role) }}</p>
                  </div>
                  <button
                    type="button"
                    class="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-slate-600 transition hover:bg-slate-50 hover:text-slate-900"
                    @click="handleLogout"
                  >
                    <LogOut class="h-4 w-4" />
                    退出登录
                  </button>
                </div>
              </Transition>
            </div>
          </div>
        </div>
      </header>

      <main class="mx-auto w-full max-w-screen-2xl flex-1 px-4 py-6 sm:px-6 lg:px-8">
        <RouterView />
      </main>
    </div>
  </div>
</template>
