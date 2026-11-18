<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  Ban,
  CheckCircle2,
  CircleDot,
  Loader2,
  RefreshCw,
  ScrollText,
  Terminal,
  Wifi,
  WifiOff,
} from 'lucide-vue-next'
import Modal from './ui/Modal.vue'
import BaseButton from './ui/BaseButton.vue'
import StatusBadge from './ui/StatusBadge.vue'
import ProgressBar from './ui/ProgressBar.vue'
import LoadingSkeleton from './ui/LoadingSkeleton.vue'
import ErrorState from './ui/ErrorState.vue'
import { useAuthStore } from '../stores/auth.js'
import { useMetaStore } from '../stores/meta.js'
import { api } from '../api/index.js'
import { openEventStream } from '../api/sse.js'
import { confirm } from '../lib/confirm.js'
import { toast } from '../lib/toast.js'
import {
  durationBetween,
  formatBytes,
  formatDateTime,
  formatNumber,
  overwriteLabel,
  percent,
  shortId,
  triggerLabel,
} from '../lib/format.js'

const props = defineProps({
  kind: { type: String, default: 'run' },
  id: { type: String, required: true },
  planName: { type: String, default: '' },
})

const emit = defineEmits(['close', 'changed'])

const auth = useAuthStore()
const meta = useMetaStore()
const isRun = computed(() => props.kind === 'run')
const title = computed(() => (isRun.value ? '运行任务详情' : '恢复任务详情'))
const statusKind = computed(() => (isRun.value ? 'run' : 'restore'))

const detail = ref(null)
const loading = ref(true)
const error = ref('')
const cancelling = ref(false)
const logs = ref([])
const connected = ref(false)
const sseError = ref('')
const autoScroll = ref(true)
const logEl = ref(null)
let sse = null

const progress = reactive({
  percent: 0,
  bytes_done: 0,
  bytes_total: 0,
  files_done: 0,
  files_total: 0,
  current_path: '',
  message: '',
})

const status = computed(() => detail.value?.status || '')
const isActive = computed(() => ['queued', 'running'].includes(status.value))
const clientLabel = computed(() => meta.clientName(detail.value?.client_id))
const repositoryLabel = computed(() => meta.repositoryName(detail.value?.repository_id))
const planLabel = computed(() => props.planName || detail.value?.plan_id || '—')
const progressBytesLabel = computed(() => {
  if (progress.bytes_total > 0) return `${formatBytes(progress.bytes_done)} / ${formatBytes(progress.bytes_total)}`
  if (isRun.value && Number(detail.value?.bytes_processed) > 0) return `处理 ${formatBytes(detail.value.bytes_processed)}`
  if (!isRun.value) return '—'
  return '—'
})
const progressHint = computed(() => {
  if (progress.current_path) return progress.current_path
  if (progress.message) return progress.message
  if (isActive.value) return '等待代理上报进度…'
  if (status.value === 'success') return '任务执行成功'
  if (status.value === 'failed') return '任务执行失败'
  if (status.value === 'canceled') return '任务已取消'
  return '任务已结束'
})
const filesLabel = computed(() => {
  if (progress.files_total) {
    return `文件 ${formatNumber(progress.files_done)} / ${formatNumber(progress.files_total)}`
  }
  if (isRun.value && (detail.value?.files_new || detail.value?.files_changed)) {
    return `文件 ${formatNumber(detail.value.files_new)} 新增 / ${formatNumber(detail.value.files_changed)} 变更`
  }
  return ''
})
const progressPercent = computed(() => {
  if (status.value === 'success') return 100
  if (progress.percent) return Math.min(100, Math.max(0, Number(progress.percent)))
  return percent(progress.bytes_done, progress.bytes_total)
})

const restoreIncludes = computed(() => {
  const raw = detail.value?.includes ?? detail.value?.includes_json
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }
  return []
})

function normalizeDetail(data) {
  if (!data) return null
  return data.run || data.restore || data
}

function appendLog(line) {
  const text = typeof line === 'string' ? line : JSON.stringify(line)
  if (!text) return
  logs.value.push(text)
  if (logs.value.length > 2000) logs.value.splice(0, logs.value.length - 2000)
}

function initLogs(logTail) {
  if (!logTail) return
  const lines = Array.isArray(logTail) ? logTail : String(logTail).split(/\r?\n/)
  logs.value = lines.filter((line) => line !== '').slice(-500)
  scrollToBottom()
}

function applyProgress(payload) {
  if (!payload || typeof payload !== 'object') return
  const data = payload.progress && typeof payload.progress === 'object' ? { ...payload, ...payload.progress } : payload
  for (const key of ['percent', 'bytes_done', 'bytes_total', 'files_done', 'files_total', 'current_path', 'message']) {
    if (data[key] !== undefined && data[key] !== null) progress[key] = data[key]
  }
  if (data.status && detail.value) detail.value.status = data.status
}

async function loadDetail() {
  loading.value = true
  error.value = ''
  try {
    const data = isRun.value ? await api.runs.get(props.id) : await api.restores.get(props.id)
    detail.value = normalizeDetail(data)
    if (detail.value?.progress) applyProgress(detail.value.progress)
    if (!logs.value.length) initLogs(detail.value?.log_tail)
  } catch (err) {
    error.value = err?.message || '加载任务详情失败'
  } finally {
    loading.value = false
  }
}

async function startSse() {
  if (!detail.value) return
  if (!isActive.value) return
  sse?.close()
  connected.value = true
  sseError.value = ''
  const path = isRun.value ? api.runs.eventsPath(props.id) : api.restores.eventsPath(props.id)
  sse = openEventStream(path, {
    onOpen: () => {
      connected.value = true
      sseError.value = ''
    },
    onEvent: (event) => {
      const payload = event.data
      let type = event.event === 'message' ? payload?.type : event.event
      if (!type && payload && typeof payload === 'object') {
        if (payload.line !== undefined || payload.log !== undefined) type = 'log'
        else if (payload.percent !== undefined || payload.bytes_total !== undefined) type = 'progress'
        else if (payload.status && ['success', 'failed', 'canceled', 'skipped'].includes(payload.status)) type = 'done'
      }
      if (type === 'progress') {
        applyProgress(payload)
      } else if (type === 'log') {
        appendLog(payload?.line ?? payload?.log ?? payload?.message ?? event.raw)
      } else if (type === 'done') {
        appendLog(`任务结束：${payload?.status || payload?.run?.status || payload?.restore?.status || 'done'}`)
        const finalStatus = payload?.status || payload?.run?.status || payload?.restore?.status
        if (finalStatus && detail.value) detail.value.status = finalStatus
        connected.value = false
        sse?.close()
        if (finalStatus === 'success') toast.success('任务执行成功')
        else if (finalStatus === 'failed') toast.error('任务执行失败')
        else if (finalStatus === 'canceled') toast.info('任务已取消')
        loadDetail().then(() => emit('changed'))
      } else if (payload?.status && detail.value) {
        detail.value.status = payload.status
      }
    },
    onError: (err) => {
      connected.value = false
      sseError.value = err?.message || '实时事件连接已断开'
    },
    autoReconnect: true,
    maxRetries: 3,
    reconnectDelay: 1500,
  })
}

async function refresh() {
  await loadDetail()
  if (isActive.value) startSse()
}

async function cancelTask() {
  const ok = await confirm({
    title: isRun.value ? '取消备份任务' : '取消恢复任务',
    message: isRun.value ? '确认取消当前备份任务？' : '确认取消当前恢复任务？',
    detail: '服务端会标记任务为已取消并通知代理终止执行，已写入的数据保留。',
    confirmText: '取消任务',
    danger: true,
  })
  if (!ok) return
  cancelling.value = true
  try {
    if (isRun.value) await api.runs.cancel(props.id)
    else await api.restores.cancel(props.id)
    toast.success('已请求取消任务')
    await loadDetail()
    emit('changed')
  } finally {
    cancelling.value = false
  }
}

function scrollToBottom() {
  nextTick(() => {
    if (autoScroll.value && logEl.value) {
      logEl.value.scrollTop = logEl.value.scrollHeight
    }
  })
}

watch(
  () => logs.value.length,
  () => scrollToBottom(),
)

onMounted(async () => {
  meta.loadClients()
  meta.loadRepositories()
  await loadDetail()
  if (isActive.value) startSse()
})

onBeforeUnmount(() => {
  sse?.close()
  sse = null
})
</script>

<template>
  <Modal :open="true" :title="title" size="xl" :z-index="55" @close="emit('close')">
    <template #header-actions>
      <StatusBadge v-if="detail" :status="detail.status" :kind="statusKind" dot />
      <button
        type="button"
        class="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
        title="刷新"
        @click="refresh"
      >
        <RefreshCw class="h-4 w-4" :class="loading ? 'animate-spin' : ''" />
      </button>
    </template>

    <LoadingSkeleton v-if="loading && !detail" variant="block" />
    <ErrorState v-else-if="error && !detail" :message="error" @retry="refresh" />

    <div v-else-if="detail" class="space-y-5">
      <!-- 摘要 -->
      <dl class="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
        <div>
          <dt class="text-[11px] text-slate-400">任务 ID</dt>
          <dd class="mt-0.5 font-mono text-xs text-slate-700" :title="detail.id || id">{{ shortId(detail.id || id, 20) }}</dd>
        </div>
        <div>
          <dt class="text-[11px] text-slate-400">节点</dt>
          <dd class="mt-0.5 text-sm text-slate-700">{{ clientLabel }}</dd>
        </div>
        <div>
          <dt class="text-[11px] text-slate-400">存储库</dt>
          <dd class="mt-0.5 text-sm text-slate-700">{{ repositoryLabel }}</dd>
        </div>
        <div>
          <dt class="text-[11px] text-slate-400">{{ isRun ? '触发方式' : '创建人' }}</dt>
          <dd class="mt-0.5 text-sm text-slate-700">
            {{ isRun ? triggerLabel(detail.trigger) : detail.created_by || '—' }}
          </dd>
        </div>

        <template v-if="isRun">
          <div>
            <dt class="text-[11px] text-slate-400">所属计划</dt>
            <dd class="mt-0.5 text-sm text-slate-700">{{ planLabel }}</dd>
          </div>
          <div>
            <dt class="text-[11px] text-slate-400">快照</dt>
            <dd class="mt-0.5 font-mono text-xs text-slate-700" :title="detail.snapshot_id">{{ shortId(detail.snapshot_id, 16) }}</dd>
          </div>
          <div>
            <dt class="text-[11px] text-slate-400">开始 / 完成</dt>
            <dd class="mt-0.5 text-xs text-slate-700">
              {{ formatDateTime(detail.started_at) }}<br />{{ formatDateTime(detail.finished_at) }}
            </dd>
          </div>
          <div>
            <dt class="text-[11px] text-slate-400">耗时</dt>
            <dd class="mt-0.5 text-sm text-slate-700">{{ durationBetween(detail.started_at, detail.finished_at) }}</dd>
          </div>
        </template>

        <template v-else>
          <div class="col-span-2">
            <dt class="text-[11px] text-slate-400">快照</dt>
            <dd class="mt-0.5 font-mono text-xs text-slate-700" :title="detail.snapshot_id">{{ detail.snapshot_id || '—' }}</dd>
          </div>
          <div>
            <dt class="text-[11px] text-slate-400">目标路径</dt>
            <dd class="mt-0.5 break-all font-mono text-xs text-slate-700">{{ detail.target || '/' }}</dd>
          </div>
          <div>
            <dt class="text-[11px] text-slate-400">覆盖策略</dt>
            <dd class="mt-0.5 text-sm text-slate-700">{{ overwriteLabel(detail.overwrite) }}</dd>
          </div>
          <div>
            <dt class="text-[11px] text-slate-400">创建 / 完成</dt>
            <dd class="mt-0.5 text-xs text-slate-700">
              {{ formatDateTime(detail.created_at) }}<br />{{ formatDateTime(detail.finished_at) }}
            </dd>
          </div>
          <div>
            <dt class="text-[11px] text-slate-400">模式</dt>
            <dd class="mt-0.5">
              <span
                class="inline-flex rounded-full px-2 py-0.5 text-xs font-medium"
                :class="detail.dry_run ? 'bg-amber-50 text-amber-700' : 'bg-blue-50 text-blue-700'"
              >
                {{ detail.dry_run ? '干跑（不写入）' : '实际恢复' }}
              </span>
            </dd>
          </div>
        </template>
      </dl>

      <!-- 进度 -->
      <div class="rounded-xl border border-slate-200 bg-slate-50/60 px-4 py-3.5">
        <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2 text-sm font-medium text-slate-700">
            <Loader2 v-if="isActive" class="h-4 w-4 animate-spin text-brand-500" />
            <CheckCircle2 v-else-if="status === 'success'" class="h-4 w-4 text-emerald-500" />
            <CircleDot v-else class="h-4 w-4 text-slate-400" />
            {{ isActive ? (isRun ? '备份进行中' : '恢复进行中') : '任务已结束' }}
          </div>
          <span class="text-xs text-slate-500">{{ progressBytesLabel }}</span>
        </div>
        <ProgressBar :value="progressPercent" :status="status" height="h-2" />
        <div class="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500">
          <span class="min-w-0 truncate font-mono" :title="progressHint">{{ progressHint }}</span>
          <span v-if="filesLabel">{{ filesLabel }}</span>
        </div>
      </div>

      <!-- 运行摘要 -->
      <div v-if="isRun" class="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div class="rounded-lg border border-slate-200 px-3 py-2">
          <p class="text-[11px] text-slate-400">新增文件</p>
          <p class="mt-0.5 text-sm font-semibold text-slate-800">{{ formatNumber(detail.files_new) }}</p>
        </div>
        <div class="rounded-lg border border-slate-200 px-3 py-2">
          <p class="text-[11px] text-slate-400">变更文件</p>
          <p class="mt-0.5 text-sm font-semibold text-slate-800">{{ formatNumber(detail.files_changed) }}</p>
        </div>
        <div class="rounded-lg border border-slate-200 px-3 py-2">
          <p class="text-[11px] text-slate-400">未变文件</p>
          <p class="mt-0.5 text-sm font-semibold text-slate-800">{{ formatNumber(detail.files_unmodified) }}</p>
        </div>
        <div class="rounded-lg border border-slate-200 px-3 py-2">
          <p class="text-[11px] text-slate-400">新增数据</p>
          <p class="mt-0.5 text-sm font-semibold text-slate-800">{{ formatBytes(detail.bytes_added) }}</p>
        </div>
      </div>

      <!-- 恢复包含路径 -->
      <div v-if="!isRun && restoreIncludes.length" class="rounded-lg border border-slate-200 px-3 py-2">
        <p class="text-[11px] text-slate-400">恢复路径（{{ restoreIncludes.length }}）</p>
        <div class="mt-1 flex flex-wrap gap-1">
          <span
            v-for="item in restoreIncludes"
            :key="item"
            class="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600"
          >
            {{ item }}
          </span>
        </div>
      </div>

      <div v-if="detail.error" class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
        <p class="font-medium">错误信息</p>
        <p class="mt-0.5 whitespace-pre-wrap break-words text-xs">{{ detail.error }}</p>
      </div>

      <!-- 实时日志 -->
      <div>
        <div class="mb-1.5 flex flex-wrap items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <ScrollText class="h-4 w-4 text-slate-400" />
            <span class="text-sm font-medium text-slate-700">实时日志</span>
            <span
              class="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium"
              :class="connected ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'"
            >
              <Wifi v-if="connected" class="h-3 w-3" />
              <WifiOff v-else class="h-3 w-3" />
              {{ connected ? 'SSE 已连接' : 'SSE 未连接' }}
            </span>
            <span v-if="sseError" class="text-[11px] text-amber-600">{{ sseError }}</span>
          </div>
          <div class="flex items-center gap-3">
            <label class="inline-flex cursor-pointer items-center gap-1.5 text-[11px] text-slate-500">
              <input
                v-model="autoScroll"
                type="checkbox"
                class="h-3 w-3 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              自动滚动
            </label>
            <button type="button" class="text-[11px] text-slate-400 hover:text-slate-600" @click="logs = []">清空</button>
          </div>
        </div>
        <div
          ref="logEl"
          class="log-view h-56 overflow-y-auto rounded-xl bg-slate-900 px-4 py-3 text-slate-300"
        >
          <template v-if="logs.length">
            <div v-for="(line, index) in logs" :key="index" class="whitespace-pre-wrap break-all">{{ line }}</div>
          </template>
          <div v-else class="flex h-full flex-col items-center justify-center gap-2 text-xs text-slate-500">
            <Terminal class="h-5 w-5" />
            <span>{{ isActive ? '等待日志输出…' : '暂无日志' }}</span>
          </div>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="mr-auto text-xs text-slate-400">
        <template v-if="isActive">任务进行中，可随时取消；关闭窗口不会中断任务。</template>
        <template v-else>任务已结束。</template>
      </div>
      <BaseButton variant="secondary" size="sm" @click="emit('close')">关闭</BaseButton>
      <BaseButton variant="secondary" size="sm" :loading="loading" @click="refresh">
        <RefreshCw v-if="!loading" class="h-3.5 w-3.5" />
        刷新
      </BaseButton>
      <BaseButton
        v-if="isActive && auth.canWrite"
        variant="danger"
        size="sm"
        :loading="cancelling"
        @click="cancelTask"
      >
        <Ban class="h-3.5 w-3.5" />
        取消任务
      </BaseButton>
    </template>
  </Modal>
</template>
