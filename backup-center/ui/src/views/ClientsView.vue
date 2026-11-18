<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import {
  ArrowRight,
  Eye,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Server,
  Trash2,
} from 'lucide-vue-next'
import PageHeader from '../components/ui/PageHeader.vue'
import BaseButton from '../components/ui/BaseButton.vue'
import StatusBadge from '../components/ui/StatusBadge.vue'
import Pagination from '../components/ui/Pagination.vue'
import LoadingSkeleton from '../components/ui/LoadingSkeleton.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import { useMetaStore } from '../stores/meta.js'
import { useAuthStore } from '../stores/auth.js'
import { api } from '../api/index.js'
import { confirm } from '../lib/confirm.js'
import { toast } from '../lib/toast.js'
import { formatDateTime, formatRelative, shortId } from '../lib/format.js'

const router = useRouter()
const meta = useMetaStore()
const auth = useAuthStore()
const { clients, loadingClients: loading, clientsError: error } = storeToRefs(meta)

const search = ref('')
const statusFilter = ref('all')
const page = ref(1)
const pageSize = ref(10)
const busyId = ref('')

const filtered = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return clients.value.filter((client) => {
    if (keyword) {
      const haystack = [
        client.hostname,
        client.ip,
        client.os,
        client.arch,
        client.tags,
        client.agent_version,
        client.id,
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    if (statusFilter.value === 'online') return client.status !== 'disabled'
    if (statusFilter.value === 'disabled') return client.status === 'disabled'
    return true
  })
})

const paged = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})

watch([search, statusFilter], () => {
  page.value = 1
})

watch(
  () => filtered.value.length,
  (len) => {
    const max = Math.max(1, Math.ceil(len / pageSize.value))
    if (page.value > max) page.value = max
  },
)

onMounted(() => {
  meta.loadClients()
  meta.loadRepositories()
})

function tagsOf(value) {
  return String(value || '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function toggleClient(client) {
  const enable = client.status === 'disabled'
  const ok = await confirm({
    title: enable ? '启用节点' : '停用节点',
    message: `确认${enable ? '启用' : '停用'}节点「${client.hostname}」？`,
    detail: enable ? '启用后代理证书恢复可用。' : '停用后代理证书立即失效，该节点将无法继续备份。',
    confirmText: enable ? '启用' : '停用',
    danger: !enable,
  })
  if (!ok) return
  busyId.value = client.id
  try {
    if (enable) {
      await api.clients.enable(client.id)
      toast.success(`节点「${client.hostname}」已启用`)
    } else {
      await api.clients.disable(client.id)
      toast.success(`节点「${client.hostname}」已停用`)
    }
    await meta.loadClients(true)
  } finally {
    busyId.value = ''
  }
}

async function removeClient(client) {
  const ok = await confirm({
    title: '删除节点',
    message: `确认删除节点「${client.hostname}」？`,
    detail: '节点将被软删除，历史快照仍会保留，但该节点无法继续备份。',
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  busyId.value = client.id
  try {
    await api.clients.remove(client.id)
    toast.success(`节点「${client.hostname}」已删除`)
    await meta.loadClients(true)
  } finally {
    busyId.value = ''
  }
}

function refresh() {
  meta.loadClients(true)
}

function openClient(client) {
  router.push({ name: 'client-detail', params: { id: client.id } })
}
</script>

<template>
  <div>
    <PageHeader title="节点管理" description="查看代理节点状态、系统信息与最近心跳">
      <template #actions>
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="refresh">
          <RefreshCw v-if="!loading" class="h-3.5 w-3.5" />
          刷新
        </BaseButton>
        <RouterLink
          :to="{ name: 'enroll', query: { create: '1' } }"
          class="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-700"
        >
          <Plus class="h-3.5 w-3.5" />
          接入新节点
        </RouterLink>
      </template>
    </PageHeader>

    <div class="mb-4 flex flex-wrap items-center gap-2">
      <div class="relative w-full max-w-xs">
        <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input v-model="search" type="search" class="bc-input pl-9" placeholder="搜索主机名 / IP / 标签 / 版本" />
      </div>
      <select v-model="statusFilter" class="bc-input w-auto min-w-[8rem]">
        <option value="all">全部状态</option>
        <option value="online">启用中</option>
        <option value="disabled">已停用</option>
      </select>
      <span class="ml-auto text-xs text-slate-400">共 {{ filtered.length }} 个节点</span>
    </div>

    <div class="bc-card overflow-hidden">
      <LoadingSkeleton v-if="loading && !clients.length" variant="table" :rows="6" />

      <ErrorState
        v-else-if="error && !clients.length"
        :message="error"
        description="无法获取节点列表，请确认后端服务已启动并已登录。"
        @retry="refresh"
      />

      <EmptyState
        v-else-if="!filtered.length"
        :title="clients.length ? '没有匹配的节点' : '尚未接入任何节点'"
        :description="
          clients.length
            ? '尝试调整搜索关键字或状态筛选。'
            : '在「待审批节点」页面生成接入命令，在目标主机上运行代理安装命令完成审批接入。'
        "
      >
        <RouterLink
          :to="{ name: 'enroll' }"
          class="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
        >
          <Plus class="h-3.5 w-3.5" />
          生成接入命令
        </RouterLink>
      </EmptyState>

      <template v-else>
        <div class="overflow-x-auto">
          <table class="bc-table">
            <thead>
              <tr>
                <th>主机名</th>
                <th>系统</th>
                <th>代理版本</th>
                <th>IP 地址</th>
                <th>存储库</th>
                <th>标签</th>
                <th>状态</th>
                <th>最近心跳</th>
                <th class="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="client in paged" :key="client.id" class="cursor-pointer" @click="openClient(client)">
                <td>
                  <div class="flex items-center gap-2">
                    <span class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-slate-100 text-slate-500">
                      <Server class="h-4 w-4" />
                    </span>
                    <div class="min-w-0">
                      <div class="truncate font-medium text-slate-800">{{ client.hostname || '—' }}</div>
                      <div class="font-mono text-[11px] text-slate-400">{{ shortId(client.id, 14) }}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <span class="capitalize">{{ client.os || '—' }}</span>
                  <span v-if="client.arch" class="text-xs text-slate-400"> / {{ client.arch }}</span>
                </td>
                <td class="font-mono text-xs text-slate-600">{{ client.agent_version || '—' }}</td>
                <td class="font-mono text-xs text-slate-600">{{ client.ip || '—' }}</td>
                <td class="max-w-[10rem] truncate text-slate-600">
                  {{ meta.repositoryName(client.repository_id) }}
                </td>
                <td>
                  <div class="flex max-w-[10rem] flex-wrap gap-1">
                    <span
                      v-for="tag in tagsOf(client.tags).slice(0, 2)"
                      :key="tag"
                      class="rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-500"
                    >
                      {{ tag }}
                    </span>
                    <span v-if="tagsOf(client.tags).length > 2" class="text-[11px] text-slate-400">
                      +{{ tagsOf(client.tags).length - 2 }}
                    </span>
                    <span v-if="!tagsOf(client.tags).length" class="text-slate-300">—</span>
                  </div>
                </td>
                <td><StatusBadge :status="client.status" kind="client" dot /></td>
                <td>
                  <span class="text-slate-600" :title="formatDateTime(client.last_seen_at)">
                    {{ formatRelative(client.last_seen_at) }}
                  </span>
                </td>
                <td class="text-right" @click.stop>
                  <div class="flex items-center justify-end gap-1">
                    <button
                      type="button"
                      class="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-brand-600"
                      title="查看详情"
                      @click="openClient(client)"
                    >
                      <Eye class="h-4 w-4" />
                    </button>
                    <button
                      v-if="auth.canWrite"
                      type="button"
                      class="rounded-lg p-1.5 transition hover:bg-slate-100"
                      :class="client.status === 'disabled' ? 'text-slate-400 hover:text-emerald-600' : 'text-slate-400 hover:text-amber-600'"
                      :title="client.status === 'disabled' ? '启用' : '停用'"
                      :disabled="busyId === client.id"
                      @click="toggleClient(client)"
                    >
                      <Power v-if="client.status === 'disabled'" class="h-4 w-4" />
                      <PowerOff v-else class="h-4 w-4" />
                    </button>
                    <button
                      v-if="auth.isAdmin"
                      type="button"
                      class="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                      title="删除节点"
                      :disabled="busyId === client.id"
                      @click="removeClient(client)"
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

    <p class="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
      <ArrowRight class="h-3 w-3" />
      点击节点行进入详情，可查看磁盘、证书状态、最近运行并编辑标签与允许的备份根目录。
    </p>
  </div>
</template>
