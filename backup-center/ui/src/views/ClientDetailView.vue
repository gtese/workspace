<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { RouterLink, useRoute } from 'vue-router'
import { storeToRefs } from 'pinia'
import {
  ArrowLeft,
  Camera,
  Copy,
  HardDrive,
  Pencil,
  Power,
  PowerOff,
  RefreshCw,
  RotateCw,
  Server,
  ShieldCheck,
} from 'lucide-vue-next'
import BaseButton from '../components/ui/BaseButton.vue'
import StatusBadge from '../components/ui/StatusBadge.vue'
import ProgressBar from '../components/ui/ProgressBar.vue'
import LoadingSkeleton from '../components/ui/LoadingSkeleton.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import Modal from '../components/ui/Modal.vue'
import { useAuthStore } from '../stores/auth.js'
import { useMetaStore } from '../stores/meta.js'
import { api } from '../api/index.js'
import { listOf } from '../lib/normalize.js'
import { confirm } from '../lib/confirm.js'
import { toast } from '../lib/toast.js'
import {
  copyText,
  durationBetween,
  formatBytes,
  formatDateTime,
  formatRelative,
  percent,
  shortId,
} from '../lib/format.js'

const route = useRoute()
const auth = useAuthStore()
const meta = useMetaStore()
const { repositories } = storeToRefs(meta)

const clientId = computed(() => String(route.params.id || ''))
const detail = ref(null)
const runs = ref([])
const loading = ref(true)
const runsLoading = ref(false)
const error = ref('')
const runsError = ref('')
const busy = ref(false)

const editOpen = ref(false)
const saving = ref(false)
const editForm = reactive({ hostname: '', tags: '', allowed_roots: '', repository_id: '' })

const disks = computed(() => detail.value?.disks || detail.value?.system?.disks || detail.value?.heartbeat?.disks || [])
const mounts = computed(() => detail.value?.mounts || detail.value?.system?.mounts || detail.value?.heartbeat?.mounts || [])

const tags = computed(() =>
  String(detail.value?.tags || '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean),
)

async function load() {
  loading.value = true
  error.value = ''
  runsError.value = ''
  const [detailRes, runsRes] = await Promise.allSettled([
    api.clients.get(clientId.value),
    api.runs.list({ client_id: clientId.value, limit: 10 }, { toastError: false }),
  ])
  if (detailRes.status === 'fulfilled') {
    detail.value = detailRes.value?.client || detailRes.value
  } else {
    error.value = detailRes.reason?.message || '加载节点详情失败'
  }
  if (runsRes.status === 'fulfilled') {
    runs.value = listOf(runsRes.value, 'runs')
  } else {
    runsError.value = runsRes.reason?.message || '加载最近运行失败'
  }
  loading.value = false
}

async function loadRuns() {
  runsLoading.value = true
  runsError.value = ''
  try {
    const data = await api.runs.list({ client_id: clientId.value, limit: 10 })
    runs.value = listOf(data, 'runs')
  } catch (err) {
    runsError.value = err?.message || '加载最近运行失败'
  } finally {
    runsLoading.value = false
  }
}

onMounted(() => {
  load()
  meta.loadRepositories()
})

watch(clientId, () => {
  detail.value = null
  runs.value = []
  load()
})

function openEdit() {
  if (!detail.value) return
  editForm.hostname = detail.value.hostname || ''
  editForm.tags = detail.value.tags || ''
  editForm.allowed_roots = detail.value.allowed_roots || '/'
  editForm.repository_id = detail.value.repository_id || ''
  editOpen.value = true
}

async function saveEdit() {
  if (!editForm.hostname.trim()) {
    toast.error('主机名不能为空')
    return
  }
  saving.value = true
  try {
    await api.clients.update(clientId.value, {
      hostname: editForm.hostname.trim(),
      tags: editForm.tags,
      allowed_roots: editForm.allowed_roots || '/',
      repository_id: editForm.repository_id || null,
    })
    toast.success('节点信息已更新')
    editOpen.value = false
    await load()
    await meta.loadClients(true)
  } finally {
    saving.value = false
  }
}

async function toggleClient() {
  if (!detail.value) return
  const enable = detail.value.status === 'disabled'
  const ok = await confirm({
    title: enable ? '启用节点' : '停用节点',
    message: `确认${enable ? '启用' : '停用'}节点「${detail.value.hostname}」？`,
    detail: enable ? '启用后代理证书恢复可用。' : '停用后代理证书立即失效，该节点将无法继续备份。',
    confirmText: enable ? '启用' : '停用',
    danger: !enable,
  })
  if (!ok) return
  busy.value = true
  try {
    if (enable) await api.clients.enable(clientId.value)
    else await api.clients.disable(clientId.value)
    toast.success(enable ? '节点已启用' : '节点已停用')
    await load()
    await meta.loadClients(true)
  } finally {
    busy.value = false
  }
}

async function copy(value, label) {
  if (!value) return
  const ok = await copyText(String(value))
  if (ok) toast.success(`${label}已复制`)
  else toast.error('复制失败，请手动选择复制')
}
</script>

<template>
  <div>
    <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div class="flex min-w-0 items-start gap-3">
        <RouterLink
          :to="{ name: 'clients' }"
          class="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-300 bg-white text-slate-500 transition hover:bg-slate-50 hover:text-slate-700"
          title="返回节点列表"
        >
          <ArrowLeft class="h-4 w-4" />
        </RouterLink>
        <div class="min-w-0">
          <h1 class="truncate text-xl font-semibold tracking-tight text-slate-900">
            {{ detail?.hostname || '节点详情' }}
          </h1>
          <div class="mt-1 flex flex-wrap items-center gap-2 text-sm text-slate-500">
            <StatusBadge v-if="detail" :status="detail.status" kind="client" dot />
            <span v-if="detail?.os" class="capitalize">{{ detail.os }}<span v-if="detail.arch"> / {{ detail.arch }}</span></span>
            <span v-if="detail?.ip" class="font-mono text-xs">{{ detail.ip }}</span>
            <span class="font-mono text-xs text-slate-400">{{ clientId }}</span>
          </div>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="load">
          <RefreshCw v-if="!loading" class="h-3.5 w-3.5" />
          刷新
        </BaseButton>
        <RouterLink
          :to="{ name: 'snapshots', query: { client: clientId } }"
          class="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 transition hover:bg-slate-50"
        >
          <Camera class="h-3.5 w-3.5" />
          查看快照
        </RouterLink>
        <BaseButton v-if="auth.isAdmin" variant="secondary" size="sm" @click="openEdit">
          <Pencil class="h-3.5 w-3.5" />
          编辑信息
        </BaseButton>
        <BaseButton
          v-if="auth.isAdmin"
          :variant="detail?.status === 'disabled' ? 'success' : 'danger-outline'"
          size="sm"
          :loading="busy"
          @click="toggleClient"
        >
          <Power v-if="detail?.status === 'disabled'" class="h-3.5 w-3.5" />
          <PowerOff v-else class="h-3.5 w-3.5" />
          {{ detail?.status === 'disabled' ? '启用节点' : '停用节点' }}
        </BaseButton>
      </div>
    </div>

    <LoadingSkeleton v-if="loading && !detail" variant="block" />
    <div v-else-if="error && !detail" class="bc-card">
      <ErrorState :message="error" description="无法获取节点详情，请确认节点是否存在。" @retry="load" />
    </div>

    <template v-else-if="detail">
      <div class="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div class="bc-card xl:col-span-2">
          <div class="flex items-center gap-2 border-b border-slate-100 px-5 py-3.5">
            <Server class="h-4 w-4 text-slate-400" />
            <h2 class="text-sm font-semibold text-slate-800">系统信息</h2>
          </div>
          <dl class="grid grid-cols-1 gap-x-8 gap-y-4 px-5 py-4 sm:grid-cols-2">
            <div>
              <dt class="text-xs text-slate-400">节点 ID</dt>
              <dd class="mt-0.5 flex items-center gap-1.5 font-mono text-xs text-slate-700">
                <span class="break-all">{{ detail.id || clientId }}</span>
                <button type="button" class="text-slate-300 hover:text-slate-500" title="复制" @click="copy(detail.id || clientId, '节点 ID')">
                  <Copy class="h-3 w-3" />
                </button>
              </dd>
            </div>
            <div>
              <dt class="text-xs text-slate-400">主机名</dt>
              <dd class="mt-0.5 text-sm text-slate-700">{{ detail.hostname || '—' }}</dd>
            </div>
            <div>
              <dt class="text-xs text-slate-400">操作系统</dt>
              <dd class="mt-0.5 text-sm capitalize text-slate-700">{{ detail.os || '—' }}</dd>
            </div>
            <div>
              <dt class="text-xs text-slate-400">架构</dt>
              <dd class="mt-0.5 text-sm text-slate-700">{{ detail.arch || '—' }}</dd>
            </div>
            <div>
              <dt class="text-xs text-slate-400">代理版本</dt>
              <dd class="mt-0.5 font-mono text-xs text-slate-700">{{ detail.agent_version || '—' }}</dd>
            </div>
            <div>
              <dt class="text-xs text-slate-400">IP 地址</dt>
              <dd class="mt-0.5 font-mono text-xs text-slate-700">{{ detail.ip || '—' }}</dd>
            </div>
            <div>
              <dt class="text-xs text-slate-400">存储库</dt>
              <dd class="mt-0.5 text-sm text-slate-700">{{ meta.repositoryName(detail.repository_id) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-slate-400">允许的备份根目录</dt>
              <dd class="mt-0.5 break-all font-mono text-xs text-slate-700">{{ detail.allowed_roots || '/' }}</dd>
            </div>
            <div>
              <dt class="text-xs text-slate-400">标签</dt>
              <dd class="mt-1 flex flex-wrap gap-1">
                <span v-for="tag in tags" :key="tag" class="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">{{ tag }}</span>
                <span v-if="!tags.length" class="text-sm text-slate-400">—</span>
              </dd>
            </div>
            <div>
              <dt class="text-xs text-slate-400">最近心跳</dt>
              <dd class="mt-0.5 text-sm text-slate-700" :title="formatDateTime(detail.last_seen_at)">
                {{ formatRelative(detail.last_seen_at) }}
              </dd>
            </div>
            <div>
              <dt class="text-xs text-slate-400">接入时间</dt>
              <dd class="mt-0.5 text-sm text-slate-700">{{ formatDateTime(detail.created_at) }}</dd>
            </div>
            <div>
              <dt class="text-xs text-slate-400">任务状态</dt>
              <dd class="mt-0.5 text-sm text-slate-700">{{ detail.active_task_id || '空闲' }}</dd>
            </div>
          </dl>
        </div>

        <div class="bc-card">
          <div class="flex items-center gap-2 border-b border-slate-100 px-5 py-3.5">
            <ShieldCheck class="h-4 w-4 text-slate-400" />
            <h2 class="text-sm font-semibold text-slate-800">证书状态</h2>
          </div>
          <div class="space-y-4 px-5 py-4">
            <div class="flex items-center justify-between">
              <span class="text-sm text-slate-500">节点状态</span>
              <StatusBadge :status="detail.status" kind="client" dot />
            </div>
            <div>
              <p class="text-xs text-slate-400">证书序列号</p>
              <div class="mt-1 flex items-start gap-1.5">
                <code class="break-all text-xs text-slate-700">{{ detail.cert_serial || '—' }}</code>
                <button
                  v-if="detail.cert_serial"
                  type="button"
                  class="shrink-0 text-slate-300 hover:text-slate-500"
                  title="复制序列号"
                  @click="copy(detail.cert_serial, '证书序列号')"
                >
                  <Copy class="h-3 w-3" />
                </button>
              </div>
            </div>
            <div>
              <p class="text-xs text-slate-400">证书指纹（SHA-256）</p>
              <div class="mt-1 flex items-start gap-1.5">
                <code class="break-all text-[11px] leading-5 text-slate-600">{{ detail.cert_fp || '—' }}</code>
                <button
                  v-if="detail.cert_fp"
                  type="button"
                  class="shrink-0 text-slate-300 hover:text-slate-500"
                  title="复制指纹"
                  @click="copy(detail.cert_fp, '证书指纹')"
                >
                  <Copy class="h-3 w-3" />
                </button>
              </div>
            </div>
            <div v-if="detail.cert_expires_at">
              <p class="text-xs text-slate-400">证书到期时间</p>
              <p class="mt-1 text-sm text-slate-700">{{ formatDateTime(detail.cert_expires_at) }}</p>
            </div>
            <p class="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
              停用节点后证书立即失效；证书到期前 30 天代理会自动续期。
            </p>
          </div>
        </div>
      </div>

      <div class="mt-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="bc-card">
          <div class="flex items-center gap-2 border-b border-slate-100 px-5 py-3.5">
            <HardDrive class="h-4 w-4 text-slate-400" />
            <h2 class="text-sm font-semibold text-slate-800">磁盘</h2>
            <span class="text-xs text-slate-400">来自最近一次心跳</span>
          </div>
          <div v-if="disks.length" class="space-y-4 px-5 py-4">
            <div v-for="disk in disks" :key="disk.path || disk.mount" class="space-y-1.5">
              <div class="flex flex-wrap items-center justify-between gap-1 text-sm">
                <span class="font-mono text-xs text-slate-700">{{ disk.path || disk.mount || '—' }}</span>
                <span class="text-xs text-slate-500">
                  {{ formatBytes(disk.free) }} 可用 / {{ formatBytes(disk.total) }}
                </span>
              </div>
              <ProgressBar
                :value="percent((disk.total || 0) - (disk.free || 0), disk.total)"
                status="running"
                height="h-1.5"
                :show-label="false"
              />
            </div>
          </div>
          <EmptyState v-else title="暂无磁盘信息" description="代理下次心跳上报磁盘容量后会显示在这里。" />
        </div>

        <div class="bc-card">
          <div class="flex items-center gap-2 border-b border-slate-100 px-5 py-3.5">
            <RotateCw class="h-4 w-4 text-slate-400" />
            <h2 class="text-sm font-semibold text-slate-800">挂载点</h2>
          </div>
          <div v-if="mounts.length" class="overflow-x-auto">
            <table class="bc-table">
              <thead>
                <tr>
                  <th>路径</th>
                  <th>文件系统</th>
                  <th>容量</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(mount, index) in mounts" :key="mount.path || index">
                  <td class="font-mono text-xs">{{ mount.path || '—' }}</td>
                  <td class="text-xs">{{ mount.fs || mount.fstype || '—' }}</td>
                  <td class="text-xs text-slate-500">
                    <span v-if="mount.total">{{ formatBytes(mount.free) }} / {{ formatBytes(mount.total) }}</span>
                    <span v-else>—</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <EmptyState v-else title="暂无挂载点信息" description="代理心跳会带回本地挂载点信息。" />
        </div>
      </div>

      <div class="bc-card mt-4">
        <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-5 py-3.5">
          <div>
            <h2 class="text-sm font-semibold text-slate-800">最近运行</h2>
            <p class="text-xs text-slate-400">该节点最近 10 次备份任务</p>
          </div>
          <div class="flex items-center gap-3">
            <BaseButton variant="ghost" size="xs" :loading="runsLoading" @click="loadRuns">
              <RefreshCw v-if="!runsLoading" class="h-3 w-3" />
              刷新
            </BaseButton>
            <RouterLink :to="{ name: 'runs', query: { client: clientId } }" class="text-xs text-brand-600 hover:underline">
              查看全部
            </RouterLink>
          </div>
        </div>

        <LoadingSkeleton v-if="runsLoading && !runs.length" variant="table" :rows="3" />
        <ErrorState v-else-if="runsError" :message="runsError" compact @retry="loadRuns" />
        <EmptyState
          v-else-if="!runs.length"
          title="暂无运行记录"
          description="该节点还没有执行过备份任务。"
        />
        <div v-else class="overflow-x-auto">
          <table class="bc-table">
            <thead>
              <tr>
                <th>运行 ID</th>
                <th>状态</th>
                <th>开始时间</th>
                <th>耗时</th>
                <th>新增 / 变更</th>
                <th>新增数据</th>
                <th>快照</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="run in runs" :key="run.id">
                <td class="font-mono text-xs text-slate-500">{{ shortId(run.id, 12) }}</td>
                <td><StatusBadge :status="run.status" kind="run" /></td>
                <td class="whitespace-nowrap text-xs text-slate-600">{{ formatDateTime(run.started_at) }}</td>
                <td class="whitespace-nowrap text-xs text-slate-600">{{ durationBetween(run.started_at, run.finished_at) }}</td>
                <td class="text-xs text-slate-600">
                  {{ run.files_new ?? 0 }} / {{ run.files_changed ?? 0 }}
                </td>
                <td class="text-xs text-slate-600">{{ formatBytes(run.bytes_added) }}</td>
                <td class="font-mono text-xs text-slate-500">{{ shortId(run.snapshot_id, 10) }}</td>
                <td class="text-right">
                  <RouterLink :to="{ name: 'runs', query: { run: run.id } }" class="text-xs text-brand-600 hover:underline">
                    详情
                  </RouterLink>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </template>

    <Modal v-model:open="editOpen" title="编辑节点信息" subtitle="修改主机名、标签、允许的备份根目录与归属存储库">
      <div class="space-y-4">
        <div>
          <label class="bc-label">主机名</label>
          <input v-model="editForm.hostname" class="bc-input" placeholder="节点主机名" />
        </div>
        <div>
          <label class="bc-label">标签</label>
          <input v-model="editForm.tags" class="bc-input" placeholder="多个标签用英文逗号分隔，如：prod,db" />
        </div>
        <div>
          <label class="bc-label">允许的备份根目录</label>
          <input v-model="editForm.allowed_roots" class="bc-input font-mono" placeholder="/home,/data" />
          <p class="mt-1 text-xs text-slate-400">多个根目录用逗号分隔；目录选择器只能浏览这些根目录。</p>
        </div>
        <div>
          <label class="bc-label">归属存储库</label>
          <select v-model="editForm.repository_id" class="bc-input">
            <option value="">未指定</option>
            <option v-for="repo in repositories" :key="repo.id" :value="repo.id">{{ repo.name }}</option>
          </select>
        </div>
      </div>
      <template #footer>
        <BaseButton variant="secondary" size="sm" @click="editOpen = false">取消</BaseButton>
        <BaseButton size="sm" :loading="saving" @click="saveEdit">保存</BaseButton>
      </template>
    </Modal>
  </div>
</template>
