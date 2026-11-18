<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { storeToRefs } from 'pinia'
import {
  KeyRound,
  Pencil,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  ShieldCheck,
  Trash2,
  Users,
} from 'lucide-vue-next'
import PageHeader from '../components/ui/PageHeader.vue'
import BaseButton from '../components/ui/BaseButton.vue'
import StatusBadge from '../components/ui/StatusBadge.vue'
import Pagination from '../components/ui/Pagination.vue'
import Modal from '../components/ui/Modal.vue'
import LoadingSkeleton from '../components/ui/LoadingSkeleton.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import { useAuthStore } from '../stores/auth.js'
import { api } from '../api/index.js'
import { listOf } from '../lib/normalize.js'
import { confirm } from '../lib/confirm.js'
import { toast } from '../lib/toast.js'
import { formatDateTime, roleLabel } from '../lib/format.js'

const auth = useAuthStore()

const users = ref([])
const loading = ref(true)
const error = ref('')
const search = ref('')
const roleFilter = ref('')
const page = ref(1)
const pageSize = ref(10)
const busyId = ref('')

const modalOpen = ref(false)
const editing = ref(null)
const saving = ref(false)
const form = reactive({
  username: '',
  display_name: '',
  email: '',
  role: 'viewer',
  source: 'local',
  password: '',
  enabled: true,
})

const ROLE_OPTIONS = [
  { value: 'admin', label: '管理员', desc: '全部权限' },
  { value: 'operator', label: '操作员', desc: '管理节点/计划/运行/恢复（受节点范围限制）' },
  { value: 'viewer', label: '只读用户', desc: '只读查看' },
  { value: 'auditor', label: '审计员', desc: '只读 + 审计日志' },
]

const ROLE_CLASS = {
  admin: 'bg-indigo-50 text-indigo-700 ring-indigo-200',
  operator: 'bg-blue-50 text-blue-700 ring-blue-200',
  viewer: 'bg-slate-100 text-slate-600 ring-slate-200',
  auditor: 'bg-amber-50 text-amber-700 ring-amber-200',
}

const isEditing = computed(() => !!editing.value)

const filtered = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return users.value.filter((user) => {
    if (roleFilter.value && user.role !== roleFilter.value) return false
    if (keyword) {
      const haystack = [user.username, user.display_name, user.email, user.id].filter(Boolean).join(' ').toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    return true
  })
})

const paged = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})

watch([search, roleFilter], () => {
  page.value = 1
})

watch(
  () => filtered.value.length,
  (len) => {
    const max = Math.max(1, Math.ceil(len / pageSize.value))
    if (page.value > max) page.value = max
  },
)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.users.list()
    users.value = listOf(data, 'users')
  } catch (err) {
    error.value = err?.message || '加载用户列表失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)

function openCreate() {
  editing.value = null
  Object.assign(form, {
    username: '',
    display_name: '',
    email: '',
    role: 'viewer',
    source: 'local',
    password: '',
    enabled: true,
  })
  modalOpen.value = true
}

function openEdit(user) {
  editing.value = user
  Object.assign(form, {
    username: user.username || '',
    display_name: user.display_name || '',
    email: user.email || '',
    role: user.role || 'viewer',
    source: user.source || 'local',
    password: '',
    enabled: user.enabled !== false && user.enabled !== 0,
  })
  modalOpen.value = true
}

async function save() {
  if (!form.username.trim()) {
    toast.error('请填写用户名')
    return
  }
  if (!isEditing.value && form.source === 'local' && form.password.length < 8) {
    toast.error('本地账号密码至少 8 位')
    return
  }
  if (isEditing.value && form.password && form.password.length < 8) {
    toast.error('重置密码至少 8 位')
    return
  }
  saving.value = true
  try {
    if (isEditing.value) {
      const body = {
        display_name: form.display_name.trim(),
        email: form.email.trim(),
        role: form.role,
        enabled: !!form.enabled,
      }
      if (form.password) body.password = form.password
      await api.users.update(editing.value.id, body)
      toast.success('用户信息已更新')
    } else {
      const body = {
        username: form.username.trim(),
        display_name: form.display_name.trim(),
        email: form.email.trim(),
        role: form.role,
        source: form.source,
        enabled: !!form.enabled,
      }
      if (form.source === 'local') body.password = form.password
      await api.users.create(body)
      toast.success('用户已创建')
    }
    modalOpen.value = false
    await load()
  } finally {
    saving.value = false
  }
}

async function toggleUser(user) {
  const enable = user.enabled === false || user.enabled === 0
  if (!enable) {
    const ok = await confirm({
      title: '停用用户',
      message: `确认停用用户「${user.username}」？`,
      detail: '停用后该用户无法登录，已建立的会话将在下次校验时失效。',
      confirmText: '停用',
      danger: true,
    })
    if (!ok) return
  }
  busyId.value = user.id
  try {
    await api.users.update(user.id, { enabled: enable })
    toast.success(enable ? '用户已启用' : '用户已停用')
    await load()
  } finally {
    busyId.value = ''
  }
}

async function removeUser(user) {
  const ok = await confirm({
    title: '删除用户',
    message: `确认删除用户「${user.username}」？`,
    detail: '删除后无法恢复；该用户的会话会立即失效。审计日志中的操作记录会保留。',
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  busyId.value = user.id
  try {
    await api.users.remove(user.id)
    toast.success('用户已删除')
    await load()
  } finally {
    busyId.value = ''
  }
}

function refresh() {
  load()
}
</script>

<template>
  <div>
    <PageHeader title="用户与角色" description="管理本地账号与 OIDC 用户角色，控制平台访问权限">
      <template #actions>
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="refresh">
          <RefreshCw v-if="!loading" class="h-3.5 w-3.5" />
          刷新
        </BaseButton>
        <BaseButton size="sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" />
          新建用户
        </BaseButton>
      </template>
    </PageHeader>

    <div class="mb-4 flex flex-wrap items-center gap-2">
      <div class="relative w-full max-w-xs">
        <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input v-model="search" type="search" class="bc-input pl-9" placeholder="搜索用户名 / 显示名 / 邮箱" />
      </div>
      <select v-model="roleFilter" class="bc-input w-auto min-w-[8rem]">
        <option value="">全部角色</option>
        <option v-for="option in ROLE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <span class="ml-auto text-xs text-slate-400">共 {{ filtered.length }} 个用户</span>
    </div>

    <div class="bc-card overflow-hidden">
      <LoadingSkeleton v-if="loading && !users.length" variant="table" :rows="5" />
      <ErrorState v-else-if="error && !users.length" :message="error" @retry="load" />
      <EmptyState v-else-if="!filtered.length" title="没有匹配的用户" description="调整搜索关键字或角色筛选。" />

      <template v-else>
        <div class="overflow-x-auto">
          <table class="bc-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>角色</th>
                <th>来源</th>
                <th>状态</th>
                <th>最近登录</th>
                <th>创建时间</th>
                <th class="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="user in paged" :key="user.id">
                <td>
                  <div class="flex items-center gap-2">
                    <span class="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-xs font-semibold text-slate-500">
                      {{ (user.display_name || user.username || '?').slice(0, 1).toUpperCase() }}
                    </span>
                    <div class="min-w-0">
                      <div class="flex items-center gap-1.5">
                        <span class="font-medium text-slate-800">{{ user.display_name || user.username }}</span>
                        <span v-if="user.id === auth.user?.id" class="rounded bg-brand-50 px-1 py-0.5 text-[10px] text-brand-600">当前登录</span>
                      </div>
                      <div class="text-[11px] text-slate-400">
                        {{ user.username }}<span v-if="user.email"> · {{ user.email }}</span>
                      </div>
                    </div>
                  </div>
                </td>
                <td>
                  <span
                    class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset"
                    :class="ROLE_CLASS[user.role] || ROLE_CLASS.viewer"
                  >
                    <ShieldCheck class="h-3 w-3" />
                    {{ roleLabel(user.role) }}
                  </span>
                </td>
                <td>
                  <span class="text-xs text-slate-600">{{ user.source === 'oidc' ? 'OIDC / SSO' : '本地账号' }}</span>
                </td>
                <td>
                  <StatusBadge
                    :status="user.enabled === false || user.enabled === 0 ? 'disabled' : 'active'"
                    kind="client"
                    dot
                    :label="user.enabled === false || user.enabled === 0 ? '已停用' : '启用中'"
                  />
                </td>
                <td class="whitespace-nowrap text-xs text-slate-600">{{ formatDateTime(user.last_login_at) }}</td>
                <td class="whitespace-nowrap text-xs text-slate-600">{{ formatDateTime(user.created_at) }}</td>
                <td class="text-right">
                  <div class="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      class="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-brand-600"
                      title="编辑用户"
                      @click="openEdit(user)"
                    >
                      <Pencil class="h-4 w-4" />
                    </button>
                    <button
                      type="button"
                      class="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100"
                      :class="user.enabled === false || user.enabled === 0 ? 'hover:text-emerald-600' : 'hover:text-amber-600'"
                      :title="user.enabled === false || user.enabled === 0 ? '启用' : '停用'"
                      :disabled="busyId === user.id"
                      @click="toggleUser(user)"
                    >
                      <Power v-if="user.enabled === false || user.enabled === 0" class="h-4 w-4" />
                      <PowerOff v-else class="h-4 w-4" />
                    </button>
                    <button
                      v-if="user.id !== auth.user?.id"
                      type="button"
                      class="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                      title="删除用户"
                      :disabled="busyId === user.id"
                      @click="removeUser(user)"
                    >
                      <Trash2 class="h-4 w-4" />
                    </button>
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <Pagination
          :page="page"
          :page-size="pageSize"
          :total="filtered.length"
          @update:page="page = $event"
          @update:page-size="pageSize = $event"
        />
      </template>
    </div>

    <div class="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
      <div v-for="option in ROLE_OPTIONS" :key="option.value" class="bc-card px-4 py-3">
        <div class="flex items-center gap-2">
          <Users class="h-3.5 w-3.5 text-slate-400" />
          <span class="text-sm font-medium text-slate-700">{{ option.label }}</span>
        </div>
        <p class="mt-1 text-xs leading-5 text-slate-500">{{ option.desc }}</p>
      </div>
    </div>

    <Modal
      v-model:open="modalOpen"
      :title="isEditing ? '编辑用户' : '新建用户'"
      :subtitle="isEditing ? `账号：${form.username}（来源 ${form.source === 'oidc' ? 'OIDC' : '本地'}）` : '创建本地账号或预置 OIDC 用户'"
      size="lg"
    >
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label class="bc-label">用户名 <span class="text-red-500">*</span></label>
          <input v-model="form.username" class="bc-input" :disabled="isEditing" placeholder="登录名" autocomplete="off" />
        </div>
        <div>
          <label class="bc-label">显示名称</label>
          <input v-model="form.display_name" class="bc-input" placeholder="姓名 / 备注" />
        </div>
        <div>
          <label class="bc-label">邮箱</label>
          <input v-model="form.email" type="email" class="bc-input" placeholder="user@example.com" autocomplete="off" />
        </div>
        <div>
          <label class="bc-label">角色</label>
          <select v-model="form.role" class="bc-input">
            <option v-for="option in ROLE_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
          </select>
        </div>
        <div v-if="!isEditing">
          <label class="bc-label">账号来源</label>
          <select v-model="form.source" class="bc-input">
            <option value="local">本地账号</option>
            <option value="oidc">OIDC / SSO 预置</option>
          </select>
        </div>
        <div v-if="!isEditing && form.source === 'local'">
          <label class="bc-label">初始密码 <span class="text-red-500">*</span></label>
          <input
            v-model="form.password"
            type="password"
            class="bc-input"
            placeholder="至少 8 位"
            autocomplete="new-password"
          />
        </div>
        <div v-if="isEditing" class="sm:col-span-2">
          <label class="bc-label">重置密码</label>
          <input
            v-model="form.password"
            type="password"
            class="bc-input"
            placeholder="留空表示不修改；填写则至少 8 位"
            autocomplete="new-password"
          />
          <p class="mt-1 flex items-center gap-1 text-xs text-slate-400">
            <KeyRound class="h-3 w-3" />
            密码不会回显，重置后旧密码立即失效。
          </p>
        </div>
        <div class="sm:col-span-2">
          <label class="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
            <input v-model="form.enabled" type="checkbox" class="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
            启用账号
          </label>
        </div>
        <p v-if="form.source === 'oidc' && !isEditing" class="sm:col-span-2 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
          OIDC 用户第一次通过 Keycloak 登录时由平台自动创建并映射角色；此处预置可不设密码，但用户名需与 IdP 一致。
        </p>
      </div>

      <template #footer>
        <BaseButton variant="secondary" size="sm" @click="modalOpen = false">取消</BaseButton>
        <BaseButton size="sm" :loading="saving" @click="save">{{ isEditing ? '保存修改' : '创建用户' }}</BaseButton>
      </template>
    </Modal>
  </div>
</template>
