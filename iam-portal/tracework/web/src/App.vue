<template>
  <div v-if="isLogin" class="app-plain">
    <router-view />
  </div>

  <div v-else class="app">
    <!-- 侧栏（桌面） -->
    <aside class="sidebar">
      <div class="brand">
        <svg width="34" height="34" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="#006185"/>
          <path d="M16 6v10l7 4" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="16" cy="16" r="11" stroke="#fff" stroke-width="2.2" fill="none"/>
        </svg>
        <div>
          <div class="brand-name">TraceWork</div>
          <div class="brand-sub">科研项目职能支持系统</div>
        </div>
      </div>

      <nav class="nav">
        <template v-for="(n, i) in navItems" :key="n.name">
          <div v-if="i === 0 || navItems[i-1].group !== n.group" class="nav-group">{{ n.group }}</div>
          <button class="nav-item" :class="{ active: route.name === n.name }" @click="go(n.name)">
            <span v-html="n.icon"></span>
            <span>{{ n.label }}</span>
            <span v-if="n.badge" class="badge">{{ n.badge }}</span>
          </button>
        </template>
      </nav>

      <div class="user-chip">
        <div class="avatar">{{ initial }}</div>
        <div class="user-meta">
          <div class="user-name">{{ store.user?.displayName || store.user?.username }}</div>
          <div class="user-role">{{ store.roleLabel }}</div>
        </div>
        <button class="x-btn" title="退出登录" @click="doLogout">⏻</button>
      </div>
      <div class="side-foot">v{{ appVersion }} · work.tri.local</div>
    </aside>

    <!-- 顶栏（移动） -->
    <div class="topbar">
      <button v-for="n in navItems" :key="'m' + n.name"
              class="nav-item" :class="{ active: route.name === n.name }"
              @click="go(n.name)">
        <span>{{ n.label }}</span>
        <span v-if="n.badge" class="badge">{{ n.badge }}</span>
      </button>
      <button class="nav-item" @click="doLogout">退出</button>
    </div>

    <main class="main">
      <router-view :key="route.fullPath" />
    </main>
  </div>

  <div id="toast" :class="[toastKind, { show: toastShow }]">{{ toastMsg }}</div>
</template>

<script setup>
// 版本号由 vite.config.js 从 package.json 注入，避免手工维护导致不一致
const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'dev';
import { computed, ref, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useAppStore } from './store.js';

const store = useAppStore();
const route = useRoute();
const router = useRouter();

const isLogin = computed(() => route.name === 'login');
const initial = computed(() => {
  const n = store.user?.displayName || store.user?.username || '';
  return n ? n.charAt(0).toUpperCase() : '?';
});

const ICONS = {
  dash: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg>',
  fill: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="4" width="18" height="17" rx="2.5"/><path d="M8 2v4M16 2v4M3 9.5h18"/><path d="M8 14h4M8 17.5h7"/></svg>',
  flow: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8.5 6h7M7 8.5l3.5 7M17 8.5l-3.5 7"/></svg>',
  projects: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2V7z"/></svg>',
  archive: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="4" width="18" height="4" rx="1"/><path d="M5 8v11a1 1 0 001 1h12a1 1 0 001-1V8M10 12h4"/></svg>',
  approve: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M8.5 12.3l2.4 2.4 4.6-5"/></svg>',
  summary: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  rules: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M6 2h9l4 4v16H6z"/><path d="M14 2v5h5M9 12h6M9 16h6"/></svg>',
  hr: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6"/><path d="M18 8h4M20 6v4"/></svg>',
  finance: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M12 7v10M9.5 9.5h3.2a2 2 0 0 1 0 4H9.5h3.6"/></svg>',
  chart: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M3 3v18h18"/><path d="M7 14l3.5-4 3 3L20 6"/></svg>',
  ledger: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v18M11 8h5M11 12h5M11 16h3"/></svg>',
  docs: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><path d="M14 2H7a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7z"/><path d="M14 2v5h5M9 13h6M9 17h4"/></svg>',
  asset: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="2.5" y="4" width="19" height="13" rx="2"/><path d="M8 21h8M12 17v4"/></svg>',
  staff: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="8" r="3.2"/><path d="M5 21c0-3.8 3.1-6.5 7-6.5s7 2.7 7 6.5"/></svg>',
  admin: '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 9 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 9a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z"/></svg>',
};

/**
 * 导航结构：按「业务角色」分组，使工程师、财务、人事各自一眼看到自己要做的事。
 * 权限不足的项不渲染。
 */
const navItems = computed(() => {
  const items = [];

  // ---- 研发工作 ----
  items.push({ group: '研发工作', name: 'dashboard', label: '我的工作台', icon: ICONS.dash });
  items.push({ group: '研发工作', name: 'fill', label: '工时填报', icon: ICONS.fill });
  // 审批中心对所有登录用户开放：
  //   审批人看「待我审批」，普通员工看「我提交的」进度
  items.push({ group: '研发工作', name: 'approve', label: '审批中心', icon: ICONS.approve,
    badge: store.pendingApprovals || 0 });
  if (store.permissions.canApprove) {
    items.push({ group: '研发工作', name: 'summary', label: '月度工时与分摊', icon: ICONS.summary });
    items.push({ group: '研发工作', name: 'archive', label: '归档工时', icon: ICONS.archive });
  }

  // ---- 研发项目 ----
  // 项目接口（/api/admin/projects）仅对审批人/财务/人事开放；
  // 普通员工不需要项目管理入口，避免点了看到 403 空白页。
  if (store.permissions.canApprove || store.permissions.canFinance || store.permissions.canHr) {
    items.push({ group: '研发项目', name: 'projects', label: '项目管理', icon: ICONS.projects });
  }

  // ---- 费用管理 ----
  if (store.permissions.canFinance) {
    items.push({ group: '费用管理', name: 'finance', label: '费用归集', icon: ICONS.finance });
    items.push({ group: '费用管理', name: 'deduction', label: '多口径测算与申报', icon: ICONS.chart });
    items.push({ group: '费用管理', name: 'ledgers', label: '备查台账', icon: ICONS.ledger });
    items.push({ group: '费用管理', name: 'docs', label: '备查资料生成', icon: ICONS.docs });
  }

  // ---- 员工管理 ----
  if (store.permissions.canHr) {
    items.push({ group: '员工管理', name: 'hr', label: '员工管理', icon: ICONS.hr });
  }

  // ---- IT 资产 ----
  items.push({ group: 'IT 资产', name: 'assets', label: 'IT 资产管理', icon: ICONS.asset });

  // ---- 系统 ----
  items.push({ group: '系统', name: 'rules', label: '规则说明', icon: ICONS.rules });
  if (store.permissions.canAdmin) {
    items.push({ group: '系统', name: 'admin', label: '用户管理', icon: ICONS.admin });
    items.push({ group: '系统', name: 'workflowSettings', label: '流程设置', icon: ICONS.flow });
  }

  return items;
});

function go(name) { router.push({ name }); }

async function doLogout() {
  await store.logout();
  router.replace({ name: 'login' });
}

// ---- 全局 toast ----
const toastMsg = ref('');
const toastShow = ref(false);
const toastKind = ref('');
let toastTimer;
window.__toast = (msg, kind = '') => {
  toastMsg.value = msg;
  toastKind.value = kind;
  toastShow.value = true;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastShow.value = false; }, 3200);
};

// ---- 待办角标定时刷新 ----
let badgeTimer;
onMounted(() => {
  badgeTimer = setInterval(() => {
    if (store.isLoggedIn && store.permissions.canApprove) store.refreshMe();
  }, 120000);
});
onUnmounted(() => clearInterval(badgeTimer));
</script>

<style scoped>
.app-plain{min-height:100vh;}
#toast.show{opacity:1; transform:translateX(-50%) translateY(0);}
#toast.err{background:var(--bad);}
#toast.ok{background:var(--ok);}
</style>