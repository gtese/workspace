<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { Eye, RefreshCw, RotateCcw } from 'lucide-vue-next'
import PageHeader from '../components/ui/PageHeader.vue'
import BaseButton from '../components/ui/BaseButton.vue'
import StatusBadge from '../components/ui/StatusBadge.vue'
import Pagination from '../components/ui/Pagination.vue'
import LoadingSkeleton from '../components/ui/LoadingSkeleton.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import TaskDrawer from '../components/TaskDrawer.vue'
import { useMetaStore } from '../stores/meta.js'
import { api } from '../api/index.js'
import { listOf } from '../lib/normalize.js'
import { formatDateTime, overwriteLabel, shortId } from '../lib/format.js'

const route = useRoute()
const router = useRouter()
const meta = useMetaStore()
const { clients } = storeToRefs(meta)

const restores = ref([])
const loading = ref(true)
const error = ref('')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(20)
const selectedRestoreId = ref(typeof route.query.restore === 'string' ? route.query.restore : '')

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '恢复中' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'canceled', label: '已取消' },
]

const clientMap = computed(() => Object.fromEntries(clients.value.map((client) => [client.id, client])))
const sorted = computed(() =>
  [...restores.value].sort(
    (a, b) => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime(),
  ),
)
const paged = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return sorted.value.slice(start, start + pageSize.value)
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.restores.list(statusFilter.value ? { status: statusFilter.value } : undefined)
    restores.value = listOf(data, 'restores')
  } catch (err) {
    error.value = err?.message || '加载恢复任务失败'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
  meta.loadClients()
})

watch(statusFilter, () => {
  page.value = 1
  load()
})

watch(
  () => sorted.value.length,
  (len) => {
    const max = Math.max(1, Math.ceil(len / pageSize.value))
    if (page.value > max) page.value = max
  },
)

function refresh() {
  load()
  meta.loadClients(true)
}

function openRestore(restore) {
  selectedRestoreId.value = restore.id
}

function closeDrawer() {
  selectedRestoreId.value = ''
  if (route.query.restore) {
    const query = { ...route.query }
    delete query.restore
    router.replace({ name: 'restores', query })
  }
}

function clientName(id) {
  return clientMap.value[id]?.hostname || id || '—'
}

function includesCount(restore) {
  const raw = restore.includes ?? restore.includes_json
  if (Array.isArray(raw)) return raw.length
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.length : 0
    } catch {
      return 0
    }
  }
  return 0
}
</script>

<template>
  <div>
    <PageHeader title="恢复任务" description="查看文件级恢复任务状态、进度与日志">
      <template #actions>
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="refresh">
          <RefreshCw v-if="!loading" class="h-3.5 w-3.5" />
          刷新
        </BaseButton>
      </template>
    </PageHeader>

    <div class="mb-4 flex flex-wrap items-center gap-2">
      <select v-model="statusFilter" class="bc-input w-auto min-w-[8rem]">
        <option v-for="option in STATUS_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <span class="ml-auto text-xs text-slate-400">共 {{ sorted.length }} 个恢复任务</span>
    </div>

    <div class="bc-card overflow-hidden">
      <LoadingSkeleton v-if="loading && !restores.length" variant="table" :rows="6" />
      <ErrorState v-else-if="error && !restores.length" :message="error" @retry="load" />
      <EmptyState
        v-else-if="!restores.length"
        title="暂无恢复任务"
        description="在「快照」页面选择文件或目录发起恢复后，任务会显示在这里。"
      />

      <template v-else>
        <div class="overflow-x-auto">
          <table class="bc-table">
            <thead>
              <tr>
                <th>任务 ID</th>
                <th>节点</th>
                <th>快照</th>
                <th>恢复路径</th>
                <th>目标 / 覆盖</th>
                <th>模式</th>
                <th>状态</th>
                <th>创建 / 完成</th>
                <th class="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="restore in paged" :key="restore.id" class="cursor-pointer" @click="openRestore(restore)">
                <td class="font-mono text-xs text-slate-600">{{ shortId(restore.id, 16) }}</td>
                <td>
                  <div class="text-sm text-slate-700">{{ clientName(restore.client_id) }}</div>
                  <div class="font-mono text-[11px] text-slate-400">{{ shortId(restore.client_id, 14) }}</div>
                </td>
                <td class="font-mono text-xs text-slate-500" :title="restore.snapshot_id">
                  {{ shortId(restore.snapshot_id, 12) }}
                </td>
                <td class="max-w-[14rem]">
                  <span class="truncate text-xs text-slate-600" :title="restore.includes_json">
                    {{ includesCount(restore) }} 个路径
                  </span>
                </td>
                <td>
                  <div class="max-w-[12rem] truncate font-mono text-xs text-slate-600" :title="restore.target">
                    {{ restore.target || '/' }}
                  </div>
                  <div class="text-[11px] text-slate-400">{{ overwriteLabel(restore.overwrite) }}</div>
                </td>
                <td>
                  <span
                    class="inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium"
                    :class="restore.dry_run ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700'"
                  >
                    {{ restore.dry_run ? '干跑' : '实际恢复' }}
                  </span>
                </td>
                <td><StatusBadge :status="restore.status" kind="restore" dot /></td>
                <td class="whitespace-nowrap">
                  <div class="text-xs text-slate-600">{{ formatDateTime(restore.created_at) }}</div>
                  <div class="text-[11px] text-slate-400">{{ formatDateTime(restore.finished_at) }}</div>
                </td>
                <td class="text-right" @click.stop>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-brand-600 transition hover:bg-brand-50"
                    @click="openRestore(restore)"
                  >
                    <Eye class="h-3.5 w-3.5" />
                    详情
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <Pagination
          :page="page"
          :page-size="pageSize"
          :total="sorted.length"
          @update:page="page = $event"
          @update:page-size="pageSize = $event"
        />
      </template>
    </div>

    <div class="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
      <RotateCcw class="h-3.5 w-3.5" />
      恢复任务进度与日志通过 SSE 实时更新；恢复操作会写入审计日志。
    </div>

    <TaskDrawer
      v-if="selectedRestoreId"
      kind="restore"
      :id="selectedRestoreId"
      @close="closeDrawer"
      @changed="load"
    />
  </div>
</template>
