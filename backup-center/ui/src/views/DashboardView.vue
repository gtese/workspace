<script setup>
import { computed, onMounted, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  Database,
  HardDrive,
  RefreshCw,
  Server,
  UserCheck,
  XCircle,
} from 'lucide-vue-next'
import PageHeader from '../components/ui/PageHeader.vue'
import BaseButton from '../components/ui/BaseButton.vue'
import StatusBadge from '../components/ui/StatusBadge.vue'
import ProgressBar from '../components/ui/ProgressBar.vue'
import LoadingSkeleton from '../components/ui/LoadingSkeleton.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import Chart from '../components/ui/Chart.vue'
import { api } from '../api/index.js'
import { listOf } from '../lib/normalize.js'
import {
  durationBetween,
  formatBytes,
  formatDateTime,
  formatRelative,
  isWithinHours,
  percent,
  shortId,
  statusMeta,
  triggerLabel,
} from '../lib/format.js'

const router = useRouter()

const clients = ref([])
const repositories = ref([])
const runs = ref([])
const loading = ref(true)
const error = ref('')
const refreshedAt = ref(null)

const ONLINE_WINDOW_MS = 5 * 60 * 1000

function isOnline(client) {
  if (client.status === 'disabled') return false
  if (client.status && client.status !== 'active') return false
  const seen = client.last_seen_at || client.last_seen
  if (!seen) return true
  const t = new Date(seen).getTime()
  if (Number.isNaN(t)) return true
  return Date.now() - t <= ONLINE_WINDOW_MS
}

const onlineCount = computed(() => clients.value.filter(isOnline).length)
const disabledCount = computed(() => clients.value.filter((c) => c.status === 'disabled').length)

const runs24h = computed(() =>
  runs.value.filter((r) => isWithinHours(r.started_at || r.finished_at || r.created_at, 24)),
)
const success24h = computed(() => runs24h.value.filter((r) => r.status === 'success').length)
const failed24h = computed(() => runs24h.value.filter((r) => r.status === 'failed').length)
const runningNow = computed(() => runs.value.filter((r) => ['running', 'queued'].includes(r.status)).length)

const totalCapacity = computed(() =>
  repositories.value.reduce((sum, r) => sum + (Number(r.total_bytes) || 0), 0),
)
const freeCapacity = computed(() =>
  repositories.value.reduce((sum, r) => sum + (Number(r.free_bytes) || 0), 0),
)
const usedCapacity = computed(() => Math.max(0, totalCapacity.value - freeCapacity.value))

const capacityOption = computed(() => {
  const valid = repositories.value.filter((r) => Number(r.total_bytes) > 0)
  if (!valid.length) return null
  const names = valid.map((r) => r.name)
  const used = valid.map((r) => {
    const total = Number(r.total_bytes) || 0
    const free = Number(r.free_bytes) || 0
    return Math.max(0, total - free) / 1024 ** 3
  })
  const free = valid.map((r) => Math.max(0, Number(r.free_bytes) || 0) / 1024 ** 3)
  return {
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (value) => `${Number(value).toFixed(1)} GiB`,
    },
    legend: { bottom: 0, icon: 'circle', textStyle: { color: '#64748b', fontSize: 11 } },
    grid: { left: 8, right: 36, top: 16, bottom: 36, containLabel: true },
    xAxis: {
      type: 'value',
      axisLabel: {
        color: '#94a3b8',
        formatter: (value) => (value >= 1024 ? `${(value / 1024).toFixed(1)} TiB` : `${value} GiB`),
      },
      splitLine: { lineStyle: { color: '#f1f5f9' } },
    },
    yAxis: {
      type: 'category',
      data: names,
      axisLabel: { color: '#475569' },
      axisLine: { lineStyle: { color: '#e2e8f0' } },
      axisTick: { show: false },
    },
    series: [
      {
        name: '已用',
        type: 'bar',
        stack: 'capacity',
        barMaxWidth: 22,
        data: used,
        itemStyle: { color: '#4f46e5', borderRadius: [4, 0, 0, 4] },
      },
      {
        name: '可用',
        type: 'bar',
        stack: 'capacity',
        barMaxWidth: 22,
        data: free,
        itemStyle: { color: '#e2e8f0', borderRadius: [0, 4, 4, 0] },
      },
    ],
  }
})

const STATUS_COLORS = {
  queued: '#94a3b8',
  running: '#3b82f6',
  success: '#10b981',
  failed: '#ef4444',
  canceled: '#f59e0b',
  skipped: '#cbd5e1',
}

const runChartOption = computed(() => {
  const entries = Object.entries(
    runs24h.value.reduce((acc, run) => {
      acc[run.status] = (acc[run.status] || 0) + 1
      return acc
    }, {}),
  ).filter(([, value]) => value > 0)
  if (!entries.length) return null
  return {
    tooltip: { trigger: 'item', formatter: '{b}：{c}（{d}%）' },
    legend: { bottom: 0, icon: 'circle', textStyle: { color: '#64748b', fontSize: 11 } },
    series: [
      {
        type: 'pie',
        radius: ['55%', '76%'],
        center: ['50%', '43%'],
        avoidLabelOverlap: true,
        itemStyle: { borderColor: '#ffffff', borderWidth: 2 },
        label: { show: false },
        data: entries.map(([status, value]) => ({
          name: statusMeta(status, 'run').label,
          value,
          itemStyle: { color: STATUS_COLORS[status] || '#94a3b8' },
        })),
      },
    ],
  }
})

const clientMap = computed(() => Object.fromEntries(clients.value.map((c) => [c.id, c])))

const latestHeartbeat = computed(() => {
  const times = clients.value
    .map((client) => new Date(client.last_seen_at || 0).getTime())
    .filter((time) => Number.isFinite(time) && time > 0)
  return times.length ? new Date(Math.max(...times)).toISOString() : null
})

const recentRuns = computed(() => {
  const sorted = [...runs.value].sort((a, b) => {
    const ta = new Date(a.started_at || a.created_at || 0).getTime() || 0
    const tb = new Date(b.started_at || b.created_at || 0).getTime() || 0
    return tb - ta
  })
  return sorted.slice(0, 8)
})

async function load() {
  loading.value = true
  error.value = ''
  const results = await Promise.allSettled([
    api.clients.list(undefined, { toastError: false }),
    api.repositories.list({ toastError: false }),
    api.runs.list({ limit: 100 }, { toastError: false }),
  ])
  const failed = []
  if (results[0].status === 'fulfilled') clients.value = listOf(results[0].value, 'clients')
  else failed.push('节点')
  if (results[1].status === 'fulfilled') repositories.value = listOf(results[1].value, 'repositories')
  else failed.push('存储库')
  if (results[2].status === 'fulfilled') runs.value = listOf(results[2].value, 'runs')
  else failed.push('运行任务')
  if (failed.length) {
    error.value = `${failed.join('、')}数据加载失败，请检查后端服务是否可用`
  }
  refreshedAt.value = new Date()
  loading.value = false
}

onMounted(load)

function openRun(run) {
  router.push({ name: 'runs', query: { run: run.id } })
}
</script>

<template>
  <div>
    <PageHeader title="概览" description="备份平台运行状态与存储容量总览">
      <template #actions>
        <span v-if="refreshedAt" class="hidden text-xs text-slate-400 sm:inline">
          更新于 {{ formatDateTime(refreshedAt) }}
        </span>
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="load">
          <RefreshCw v-if="!loading" class="h-3.5 w-3.5" />
          刷新
        </BaseButton>
        <RouterLink
          :to="{ name: 'enroll' }"
          class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
        >
          <UserCheck class="h-3.5 w-3.5" />
          审批节点
        </RouterLink>
        <RouterLink
          :to="{ name: 'plans' }"
          class="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-brand-700"
        >
          <ArrowRight class="h-3.5 w-3.5" />
          备份计划
        </RouterLink>
      </template>
    </PageHeader>

    <LoadingSkeleton v-if="loading && !clients.length && !repositories.length && !runs.length" variant="cards" :cards="4" />

    <template v-else>
      <div
        v-if="error"
        class="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800"
      >
        <span>{{ error }}</span>
        <BaseButton variant="secondary" size="xs" @click="load">重新加载</BaseButton>
      </div>

      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div class="bc-card p-5">
          <div class="flex items-center justify-between">
            <span class="text-sm text-slate-500">在线节点</span>
            <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
              <Server class="h-4.5 w-4.5" style="width: 18px; height: 18px" />
            </span>
          </div>
          <p class="mt-2 text-3xl font-semibold tracking-tight text-slate-900">
            {{ onlineCount }}
            <span class="text-base font-normal text-slate-400">/ {{ clients.length }}</span>
          </p>
          <p class="mt-1 text-xs text-slate-400">
            5 分钟内有心跳<span v-if="disabledCount" class="ml-1">· {{ disabledCount }} 台停用</span>
          </p>
        </div>

        <div class="bc-card p-5">
          <div class="flex items-center justify-between">
            <span class="text-sm text-slate-500">24h 成功任务</span>
            <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
              <CheckCircle2 class="h-4.5 w-4.5" style="width: 18px; height: 18px" />
            </span>
          </div>
          <p class="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{{ success24h }}</p>
          <p class="mt-1 text-xs text-slate-400">共 {{ runs24h.length }} 个任务在 24 小时内启动</p>
        </div>

        <div class="bc-card p-5">
          <div class="flex items-center justify-between">
            <span class="text-sm text-slate-500">24h 失败任务</span>
            <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-red-50 text-red-600">
              <XCircle class="h-4.5 w-4.5" style="width: 18px; height: 18px" />
            </span>
          </div>
          <p class="mt-2 text-3xl font-semibold tracking-tight" :class="failed24h ? 'text-red-600' : 'text-slate-900'">
            {{ failed24h }}
          </p>
          <p class="mt-1 text-xs text-slate-400">
            <template v-if="runningNow">当前 {{ runningNow }} 个任务排队/运行中</template>
            <template v-else>当前无排队或运行中任务</template>
          </p>
        </div>

        <div class="bc-card p-5">
          <div class="flex items-center justify-between">
            <span class="text-sm text-slate-500">仓库总容量</span>
            <span class="flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-50 text-brand-600">
              <Database class="h-4.5 w-4.5" style="width: 18px; height: 18px" />
            </span>
          </div>
          <p class="mt-2 text-3xl font-semibold tracking-tight text-slate-900">{{ formatBytes(totalCapacity) }}</p>
          <div class="mt-2">
            <ProgressBar
              :value="percent(usedCapacity, totalCapacity)"
              status="running"
              height="h-1.5"
              :show-label="false"
            />
            <p class="mt-1 text-xs text-slate-400">
              已用 {{ formatBytes(usedCapacity) }} · 可用 {{ formatBytes(freeCapacity) }}
            </p>
          </div>
        </div>
      </div>

      <div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div class="bc-card xl:col-span-2">
          <div class="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
            <div>
              <h2 class="text-sm font-semibold text-slate-800">存储库容量</h2>
              <p class="text-xs text-slate-400">按存储库统计已用与可用空间</p>
            </div>
            <RouterLink :to="{ name: 'repositories' }" class="text-xs text-brand-600 hover:underline">
              管理存储库
            </RouterLink>
          </div>
          <div class="px-3 py-3">
            <Chart v-if="capacityOption" :option="capacityOption" :height="280" />
            <EmptyState
              v-else
              title="暂无存储库容量数据"
              description="创建存储库后，这里会展示每个存储库的已用与可用容量。"
            >
              <RouterLink
                :to="{ name: 'repositories' }"
                class="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
              >
                <Database class="h-3.5 w-3.5" />
                新建存储库
              </RouterLink>
            </EmptyState>
          </div>
        </div>

        <div class="bc-card">
          <div class="border-b border-slate-100 px-5 py-3.5">
            <h2 class="text-sm font-semibold text-slate-800">24h 任务状态</h2>
            <p class="text-xs text-slate-400">最近 24 小时启动的备份任务分布</p>
          </div>
          <div class="px-3 py-3">
            <Chart v-if="runChartOption" :option="runChartOption" :height="280" />
            <EmptyState v-else title="暂无任务" description="最近 24 小时没有备份任务运行。" />
          </div>
        </div>
      </div>

      <div class="bc-card mt-4">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
          <div>
            <h2 class="text-sm font-semibold text-slate-800">最近运行</h2>
            <p class="text-xs text-slate-400">按启动时间倒序展示最近 8 个任务</p>
          </div>
          <RouterLink :to="{ name: 'runs' }" class="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline">
            查看全部
            <ArrowRight class="h-3.5 w-3.5" />
          </RouterLink>
        </div>

        <LoadingSkeleton v-if="loading" variant="table" :rows="4" />

        <ErrorState
          v-else-if="error && !recentRuns.length"
          message="最近运行加载失败"
          :description="error"
          @retry="load"
        />

        <EmptyState
          v-else-if="!recentRuns.length"
          title="暂无运行记录"
          description="创建备份计划并触发一次运行后，运行结果会显示在这里。"
        >
          <RouterLink
            :to="{ name: 'plans' }"
            class="inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-brand-700"
          >
            <Activity class="h-3.5 w-3.5" />
            前往备份计划
          </RouterLink>
        </EmptyState>

        <div v-else class="overflow-x-auto">
          <table class="bc-table">
            <thead>
              <tr>
                <th>状态</th>
                <th>节点</th>
                <th>触发</th>
                <th>开始时间</th>
                <th>耗时</th>
                <th>新增数据</th>
                <th class="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="run in recentRuns"
                :key="run.id"
                class="cursor-pointer"
                @click="openRun(run)"
              >
                <td><StatusBadge :status="run.status" kind="run" dot /></td>
                <td>
                  <div class="font-medium text-slate-800">
                    {{ clientMap[run.client_id]?.hostname || run.client_id || '—' }}
                  </div>
                  <div class="font-mono text-[11px] text-slate-400">{{ shortId(run.client_id, 14) }}</div>
                </td>
                <td>{{ triggerLabel(run.trigger) }}</td>
                <td class="whitespace-nowrap text-slate-600">{{ formatDateTime(run.started_at) }}</td>
                <td class="whitespace-nowrap text-slate-600">{{ durationBetween(run.started_at, run.finished_at) }}</td>
                <td class="whitespace-nowrap text-slate-600">{{ formatBytes(run.bytes_added) }}</td>
                <td class="text-right">
                  <span class="inline-flex items-center gap-1 text-xs text-brand-600">
                    详情
                    <ArrowRight class="h-3 w-3" />
                  </span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <div v-if="clients.length" class="flex items-center gap-2 border-t border-slate-100 px-5 py-3 text-xs text-slate-400">
          <HardDrive class="h-3.5 w-3.5" />
          {{ onlineCount }} 台节点在线 · 最近心跳 {{ formatRelative(latestHeartbeat) }}
        </div>
      </div>
    </template>
  </div>
</template>
