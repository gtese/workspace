<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import { Activity, Eye, RefreshCw } from 'lucide-vue-next'
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
import { durationBetween, formatBytes, formatDateTime, shortId, triggerLabel } from '../lib/format.js'

const route = useRoute()
const router = useRouter()
const meta = useMetaStore()
const { clients } = storeToRefs(meta)

const runs = ref([])
const plans = ref([])
const loading = ref(true)
const error = ref('')
const clientFilter = ref(typeof route.query.client === 'string' ? route.query.client : '')
const statusFilter = ref('')
const page = ref(1)
const pageSize = ref(20)
const hasNext = ref(false)
const selectedRunId = ref(typeof route.query.run === 'string' ? route.query.run : '')

const planMap = computed(() => Object.fromEntries(plans.value.map((plan) => [plan.id, plan])))
const selectedRunPlanName = computed(() => {
  const run = runs.value.find((item) => item.id === selectedRunId.value)
  return run ? planMap.value[run.plan_id]?.name || '' : ''
})
const clientMap = computed(() => Object.fromEntries(clients.value.map((client) => [client.id, client])))

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'queued', label: '排队中' },
  { value: 'running', label: '运行中' },
  { value: 'success', label: '成功' },
  { value: 'failed', label: '失败' },
  { value: 'canceled', label: '已取消' },
  { value: 'skipped', label: '已跳过' },
]

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.runs.list({
      client_id: clientFilter.value || undefined,
      status: statusFilter.value || undefined,
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
    })
    runs.value = listOf(data, 'runs')
    hasNext.value = runs.value.length === pageSize.value
  } catch (err) {
    error.value = err?.message || '加载运行任务失败'
  } finally {
    loading.value = false
  }
}

async function loadPlans() {
  try {
    const data = await api.plans.list(undefined, { toastError: false })
    plans.value = listOf(data, 'plans')
  } catch {
    plans.value = []
  }
}

onMounted(() => {
  load()
  loadPlans()
  meta.loadClients()
})

watch([clientFilter, statusFilter], () => {
  page.value = 1
  load()
})

watch([page, pageSize], () => {
  load()
})

function refresh() {
  load()
  loadPlans()
  meta.loadClients(true)
}

function openRun(run) {
  selectedRunId.value = run.id
}

function closeDrawer() {
  selectedRunId.value = ''
  if (route.query.run) {
    const query = { ...route.query }
    delete query.run
    router.replace({ name: 'runs', query })
  }
}

function planName(id) {
  return planMap.value[id]?.name || shortId(id, 12)
}

function clientName(id) {
  return clientMap.value[id]?.hostname || id
}
</script>

<template>
  <div>
    <PageHeader title="运行任务" description="查看备份任务执行状态、进度与实时日志，支持取消运行中的任务">
      <template #actions>
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="refresh">
          <RefreshCw v-if="!loading" class="h-3.5 w-3.5" />
          刷新
        </BaseButton>
      </template>
    </PageHeader>

    <div class="mb-4 flex flex-wrap items-center gap-2">
      <select v-model="clientFilter" class="bc-input w-auto min-w-[12rem]">
        <option value="">全部节点</option>
        <option v-for="client in clients" :key="client.id" :value="client.id">{{ client.hostname }}</option>
      </select>
      <select v-model="statusFilter" class="bc-input w-auto min-w-[8rem]">
        <option v-for="option in STATUS_OPTIONS" :key="option.value" :value="option.value">{{ option.label }}</option>
      </select>
      <span class="ml-auto text-xs text-slate-400">第 {{ page }} 页</span>
    </div>

    <div class="bc-card overflow-hidden">
      <LoadingSkeleton v-if="loading && !runs.length" variant="table" :rows="8" />
      <ErrorState v-else-if="error && !runs.length" :message="error" @retry="load" />
      <EmptyState
        v-else-if="!runs.length"
        title="暂无运行任务"
        description="备份计划按 cron 调度或手动触发后，运行记录会显示在这里。"
      />

      <template v-else>
        <div class="overflow-x-auto">
          <table class="bc-table">
            <thead>
              <tr>
                <th>运行 ID / 计划</th>
                <th>节点</th>
                <th>存储库</th>
                <th>触发</th>
                <th>状态</th>
                <th>开始时间</th>
                <th>耗时</th>
                <th>新增数据</th>
                <th class="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="run in runs" :key="run.id" class="cursor-pointer" @click="openRun(run)">
                <td>
                  <div class="font-mono text-xs text-slate-700">{{ shortId(run.id, 16) }}</div>
                  <div class="max-w-[12rem] truncate text-[11px] text-slate-400" :title="planMap[run.plan_id]?.name">
                    {{ planName(run.plan_id) }}
                  </div>
                </td>
                <td>
                  <div class="text-sm text-slate-700">{{ clientName(run.client_id) }}</div>
                  <div class="font-mono text-[11px] text-slate-400">{{ shortId(run.client_id, 14) }}</div>
                </td>
                <td class="max-w-[10rem] truncate text-xs text-slate-600">{{ meta.repositoryName(run.repository_id) }}</td>
                <td class="text-xs text-slate-600">{{ triggerLabel(run.trigger) }}</td>
                <td><StatusBadge :status="run.status" kind="run" dot /></td>
                <td class="whitespace-nowrap text-xs text-slate-600">{{ formatDateTime(run.started_at) }}</td>
                <td class="whitespace-nowrap text-xs text-slate-600">{{ durationBetween(run.started_at, run.finished_at) }}</td>
                <td class="whitespace-nowrap text-xs text-slate-600">{{ formatBytes(run.bytes_added) }}</td>
                <td class="text-right" @click.stop>
                  <button
                    type="button"
                    class="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs text-brand-600 transition hover:bg-brand-50"
                    @click="openRun(run)"
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
          :total="null"
          :has-next="hasNext"
          @update:page="page = $event"
          @update:page-size="pageSize = $event"
        />
      </template>
    </div>

    <div class="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
      <Activity class="h-3.5 w-3.5" />
      运行中的任务支持 SSE 实时进度与日志；关闭详情不会中断任务。
    </div>

    <TaskDrawer
      v-if="selectedRunId"
      kind="run"
      :id="selectedRunId"
      :plan-name="selectedRunPlanName"
      @close="closeDrawer"
      @changed="load"
    />
  </div>
</template>
