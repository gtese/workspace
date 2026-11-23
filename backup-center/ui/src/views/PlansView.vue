<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import {
  CalendarClock,
  Pencil,
  Play,
  Plus,
  Power,
  PowerOff,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-vue-next'
import PageHeader from '../components/ui/PageHeader.vue'
import BaseButton from '../components/ui/BaseButton.vue'
import Pagination from '../components/ui/Pagination.vue'
import LoadingSkeleton from '../components/ui/LoadingSkeleton.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import PlanEditor from '../components/PlanEditor.vue'
import { useAuthStore } from '../stores/auth.js'
import { useMetaStore } from '../stores/meta.js'
import { api } from '../api/index.js'
import { listOf } from '../lib/normalize.js'
import { confirm } from '../lib/confirm.js'
import { toast } from '../lib/toast.js'
import { compressionLabel, formatDateTime, shortId } from '../lib/format.js'

const router = useRouter()
const auth = useAuthStore()
const meta = useMetaStore()
const { clients, repositories } = storeToRefs(meta)

const plans = ref([])
const loading = ref(true)
const error = ref('')
const search = ref('')
const clientFilter = ref('')
const enabledFilter = ref('all')
const page = ref(1)
const pageSize = ref(10)
const runningId = ref('')

const editorOpen = ref(false)
const editingPlan = ref(null)

const filtered = computed(() => {
  const keyword = search.value.trim().toLowerCase()
  return plans.value.filter((plan) => {
    if (keyword) {
      const haystack = [plan.name, plan.cron, plan.client_id, plan.repository_id].filter(Boolean).join(' ').toLowerCase()
      if (!haystack.includes(keyword)) return false
    }
    if (clientFilter.value && plan.client_id !== clientFilter.value) return false
    if (enabledFilter.value === 'enabled' && !isEnabled(plan)) return false
    if (enabledFilter.value === 'disabled' && isEnabled(plan)) return false
    return true
  })
})

const paged = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})

function isEnabled(plan) {
  return plan.enabled !== false && plan.enabled !== 0
}

function parseJson(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function pathsOf(plan) {
  const paths = Array.isArray(plan.paths) ? plan.paths : parseJson(plan.paths_json, [])
  return Array.isArray(paths) ? paths : []
}

function excludesCount(plan) {
  const excludes = Array.isArray(plan.excludes) ? plan.excludes : parseJson(plan.excludes_json, [])
  return Array.isArray(excludes) ? excludes.length : 0
}

watch([search, clientFilter, enabledFilter], () => {
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
    const data = await api.plans.list()
    plans.value = listOf(data, 'plans')
  } catch (err) {
    error.value = err?.message || '加载备份计划失败'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
  meta.loadClients()
  meta.loadRepositories()
})

function newPlan() {
  if (!clients.value.length) {
    toast.error('请先在「节点管理」中接入至少一个节点')
    return
  }
  if (!repositories.value.length) {
    toast.error('请先在「存储库」中创建至少一个存储库')
    return
  }
  editingPlan.value = null
  editorOpen.value = true
}

function editPlan(plan) {
  editingPlan.value = plan
  editorOpen.value = true
}

async function onSaved() {
  editorOpen.value = false
  editingPlan.value = null
  await load()
}

async function runPlan(plan) {
  const ok = await confirm({
    title: '立即运行备份',
    message: `确认立即执行计划「${plan.name}」？`,
    detail: `节点：${meta.clientName(plan.client_id)}\n路径：${pathsOf(plan).slice(0, 3).join('、') || '—'}${pathsOf(plan).length > 3 ? ' 等' : ''}`,
    confirmText: '立即运行',
  })
  if (!ok) return
  runningId.value = plan.id
  try {
    const result = await api.plans.run(plan.id, {})
    toast.success('已触发备份任务')
    const runId = result?.run?.id || result?.id
    if (runId) router.push({ name: 'runs', query: { run: runId } })
    else await load()
  } finally {
    runningId.value = ''
  }
}

async function togglePlan(plan) {
  const enable = !isEnabled(plan)
  try {
    if (enable) await api.plans.enable(plan.id)
    else await api.plans.disable(plan.id)
    toast.success(enable ? `计划「${plan.name}」已启用` : `计划「${plan.name}」已停用`)
    await load()
  } catch {
    // 统一请求层已提示
  }
}

async function removePlan(plan) {
  const ok = await confirm({
    title: '删除备份计划',
    message: `确认删除计划「${plan.name}」？`,
    detail: '删除计划不会删除已产生的快照。正在运行的任务不会被中断。',
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await api.plans.remove(plan.id)
    toast.success(`计划「${plan.name}」已删除`)
    await load()
  } catch {
    // 统一请求层已提示
  }
}

function refresh() {
  load()
  meta.refreshAll()
}
</script>

<template>
  <div>
    <PageHeader title="备份计划" description="配置节点备份范围、调度窗口、压缩与保留策略">
      <template #actions>
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="refresh">
          <RefreshCw v-if="!loading" class="h-3.5 w-3.5" />
          刷新
        </BaseButton>
        <BaseButton v-if="auth.isAdmin" size="sm" @click="newPlan">
          <Plus class="h-3.5 w-3.5" />
          新建计划
        </BaseButton>
      </template>
    </PageHeader>

    <div class="mb-4 flex flex-wrap items-center gap-2">
      <div class="relative w-full max-w-xs">
        <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input v-model="search" type="search" class="bc-input pl-9" placeholder="搜索计划名称 / cron" />
      </div>
      <select v-model="clientFilter" class="bc-input w-auto min-w-[10rem]">
        <option value="">全部节点</option>
        <option v-for="client in clients" :key="client.id" :value="client.id">{{ client.hostname }}</option>
      </select>
      <select v-model="enabledFilter" class="bc-input w-auto min-w-[7rem]">
        <option value="all">全部状态</option>
        <option value="enabled">已启用</option>
        <option value="disabled">已停用</option>
      </select>
      <span class="ml-auto text-xs text-slate-400">共 {{ filtered.length }} 个计划</span>
    </div>

    <div class="bc-card overflow-hidden">
      <LoadingSkeleton v-if="loading && !plans.length" variant="table" :rows="5" />
      <ErrorState v-else-if="error && !plans.length" :message="error" @retry="load" />
      <EmptyState
        v-else-if="!filtered.length"
        :title="plans.length ? '没有匹配的备份计划' : '尚未创建备份计划'"
        :description="
          plans.length
            ? '尝试调整搜索关键字或筛选条件。'
            : '创建计划后，可配置备份路径、cron 调度、备份窗口、压缩、限速、保留策略与钩子。'
        "
      >
        <BaseButton v-if="auth.isAdmin && !plans.length" size="sm" @click="newPlan">
          <Plus class="h-3.5 w-3.5" />
          新建计划
        </BaseButton>
      </EmptyState>

      <template v-else>
        <div class="overflow-x-auto">
          <table class="bc-table">
            <thead>
              <tr>
                <th>计划名称</th>
                <th>节点</th>
                <th>存储库</th>
                <th>调度</th>
                <th>备份范围</th>
                <th>压缩 / 保留</th>
                <th>状态</th>
                <th>下次 / 上次运行</th>
                <th class="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="plan in paged" :key="plan.id">
                <td>
                  <div class="font-medium text-slate-800">{{ plan.name }}</div>
                  <div class="font-mono text-[11px] text-slate-400">{{ shortId(plan.id, 14) }}</div>
                </td>
                <td class="text-slate-600">{{ meta.clientName(plan.client_id) }}</td>
                <td class="text-slate-600">{{ meta.repositoryName(plan.repository_id) }}</td>
                <td class="font-mono text-xs text-slate-600">{{ plan.cron || '—' }}</td>
                <td>
                  <div class="max-w-[13rem] truncate font-mono text-xs text-slate-600" :title="pathsOf(plan).join('\n')">
                    {{ pathsOf(plan)[0] || '—' }}
                  </div>
                  <div class="text-[11px] text-slate-400">
                    {{ pathsOf(plan).length }} 个路径
                    <span v-if="excludesCount(plan)">· {{ excludesCount(plan) }} 条排除</span>
                  </div>
                </td>
                <td>
                  <div class="text-xs text-slate-600">{{ compressionLabel(plan.compression) }}</div>
                  <div class="text-[11px] text-slate-400">
                    最近 {{ parseJson(plan.retention ?? plan.retention_json, {}).keep_last ?? '—' }} 份
                  </div>
                </td>
                <td>
                  <span
                    class="inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset"
                    :class="isEnabled(plan) ? 'bg-emerald-50 text-emerald-700 ring-emerald-200' : 'bg-slate-100 text-slate-500 ring-slate-200'"
                  >
                    <span class="h-1.5 w-1.5 rounded-full bg-current" />
                    {{ isEnabled(plan) ? '已启用' : '已停用' }}
                  </span>
                </td>
                <td class="whitespace-nowrap">
                  <div class="whitespace-nowrap text-xs text-slate-600">下次：{{ formatDateTime(plan.next_run_at, false) }}</div>
                  <div class="whitespace-nowrap text-[11px] text-slate-400">上次：{{ formatDateTime(plan.last_run_at, false) }}</div>
                </td>
                <td class="text-right">
                  <div class="flex items-center justify-end gap-1">
                    <button
                      v-if="auth.canWrite"
                      type="button"
                      class="rounded-lg p-1.5 text-slate-400 transition hover:bg-emerald-50 hover:text-emerald-600"
                      title="立即运行"
                      :disabled="runningId === plan.id"
                      @click="runPlan(plan)"
                    >
                      <Play class="h-4 w-4" />
                    </button>
                    <button
                      v-if="auth.isAdmin"
                      type="button"
                      class="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-brand-600"
                      title="编辑"
                      @click="editPlan(plan)"
                    >
                      <Pencil class="h-4 w-4" />
                    </button>
                    <button
                      v-if="auth.isAdmin"
                      type="button"
                      class="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100"
                      :class="isEnabled(plan) ? 'hover:text-amber-600' : 'hover:text-emerald-600'"
                      :title="isEnabled(plan) ? '停用' : '启用'"
                      @click="togglePlan(plan)"
                    >
                      <PowerOff v-if="isEnabled(plan)" class="h-4 w-4" />
                      <Power v-else class="h-4 w-4" />
                    </button>
                    <button
                      v-if="auth.isAdmin"
                      type="button"
                      class="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                      title="删除"
                      @click="removePlan(plan)"
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

    <div class="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
      <CalendarClock class="h-3.5 w-3.5" />
      cron 时区为 Asia/Shanghai；备份窗口外是否跳过由窗口配置决定。
    </div>

    <PlanEditor
      v-if="editorOpen"
      :plan="editingPlan"
      :clients="clients"
      :repositories="repositories"
      @close="editorOpen = false"
      @saved="onSaved"
    />
  </div>
</template>
