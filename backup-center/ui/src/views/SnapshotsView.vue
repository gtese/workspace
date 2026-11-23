<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { storeToRefs } from 'pinia'
import {
  Camera,
  Clock3,
  Pin,
  PinOff,
  RefreshCw,
  Trash2,
  UserRound,
} from 'lucide-vue-next'
import PageHeader from '../components/ui/PageHeader.vue'
import BaseButton from '../components/ui/BaseButton.vue'
import StatusBadge from '../components/ui/StatusBadge.vue'
import LoadingSkeleton from '../components/ui/LoadingSkeleton.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import SnapshotBrowser from '../components/SnapshotBrowser.vue'
import RestoreWizard from '../components/RestoreWizard.vue'
import { useAuthStore } from '../stores/auth.js'
import { useMetaStore } from '../stores/meta.js'
import { api } from '../api/index.js'
import { listOf } from '../lib/normalize.js'
import { confirm } from '../lib/confirm.js'
import { toast } from '../lib/toast.js'
import { formatBytes, formatDateTime, formatNumber } from '../lib/format.js'

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const meta = useMetaStore()
const { clients, repositories } = storeToRefs(meta)

const selectedClientId = ref(typeof route.query.client === 'string' ? route.query.client : '')
const selectedRepoId = ref(typeof route.query.repo === 'string' ? route.query.repo : '')
const snapshots = ref([])
const loading = ref(false)
const error = ref('')
const selectedSnapshotId = ref('')
const busyId = ref('')
const restoreState = ref(null)

const selectedSnapshot = computed(() => snapshots.value.find((snap) => snap.id === selectedSnapshotId.value) || null)

function normalizeSnapshot(raw) {
  const tags = Array.isArray(raw.tags) ? raw.tags : []
  const id = raw.id || raw.snapshot_id || raw.short_id || ''
  const pinned = raw.pinned === true || raw.pinned === 1 || tags.includes('pinned')
  return {
    ...raw,
    id,
    shortId: raw.short_id || String(id).slice(0, 8),
    time: raw.time || raw.created_at,
    size: raw.summary?.total_bytes_processed ?? raw.size ?? raw.total_bytes ?? 0,
    fileCount:
      raw.summary?.total_files_processed ??
      raw.summary?.total_files ??
      raw.files ??
      raw.total_files ??
      0,
    addedBytes: raw.summary?.total_bytes_added ?? raw.bytes_added ?? 0,
    tags: tags.filter((tag) => tag !== 'pinned'),
    pinned,
  }
}

async function loadSnapshots() {
  if (!selectedClientId.value) {
    snapshots.value = []
    return
  }
  loading.value = true
  error.value = ''
  try {
    const data = await api.snapshots.list(selectedClientId.value, selectedRepoId.value)
    snapshots.value = listOf(data, 'snapshots')
      .map(normalizeSnapshot)
      .sort((a, b) => new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime())
    if (selectedSnapshotId.value && !snapshots.value.some((snap) => snap.id === selectedSnapshotId.value)) {
      selectedSnapshotId.value = ''
    }
  } catch (err) {
    error.value = err?.message || '加载快照列表失败'
    snapshots.value = []
  } finally {
    loading.value = false
  }
}

function defaultRepoForClient(id) {
  const client = clients.value.find((c) => c.id === id)
  return client?.repository_id || ''
}

watch(
  selectedClientId,
  (id) => {
    selectedSnapshotId.value = ''
    restoreState.value = null
    if (id) {
      const want = defaultRepoForClient(id)
      if (want && (!selectedRepoId.value || !repositories.value.some((r) => r.id === selectedRepoId.value))) {
        selectedRepoId.value = want
      }
      if (route.query.client !== id || (selectedRepoId.value && route.query.repo !== selectedRepoId.value)) {
        router.replace({ name: 'snapshots', query: { ...route.query, client: id, repo: selectedRepoId.value || undefined } })
      }
      loadSnapshots()
    } else {
      snapshots.value = []
    }
  },
  { immediate: true },
)

watch(selectedRepoId, (repoId) => {
  selectedSnapshotId.value = ''
  restoreState.value = null
  if (selectedClientId.value) {
    router.replace({ name: 'snapshots', query: { ...route.query, client: selectedClientId.value, repo: repoId || undefined } })
    loadSnapshots()
  }
})

onMounted(async () => {
  await Promise.all([meta.loadClients(), meta.loadRepositories()])
  if (!selectedClientId.value && clients.value.length) {
    selectedClientId.value = clients.value[0].id
  } else if (selectedClientId.value && clients.value.length && !clients.value.some((c) => c.id === selectedClientId.value)) {
    selectedClientId.value = clients.value[0].id
  } else if (!selectedClientId.value) {
    loadSnapshots()
  }
})

function refresh() {
  loadSnapshots()
  meta.loadClients(true)
}

function selectSnapshot(snapshot) {
  selectedSnapshotId.value = snapshot.id
}

async function togglePin(snapshot) {
  busyId.value = snapshot.id
  try {
    await api.snapshots.pin(selectedClientId.value, snapshot.id, !snapshot.pinned, selectedRepoId.value)
    toast.success(snapshot.pinned ? '已取消钉住' : '快照已钉住，保留策略不会删除')
    await loadSnapshots()
  } finally {
    busyId.value = ''
  }
}

async function removeSnapshot(snapshot) {
  const ok = await confirm({
    title: '删除快照',
    message: `确认删除快照「${formatDateTime(snapshot.time)}」？`,
    detail: `快照 ID：${snapshot.id}\n删除前会先解除钉住；删除操作不可恢复，且会写入审计日志。`,
    confirmText: '删除快照',
    danger: true,
  })
  if (!ok) return
  busyId.value = snapshot.id
  try {
    await api.snapshots.remove(selectedClientId.value, snapshot.id, selectedRepoId.value)
    toast.success('快照已删除')
    if (selectedSnapshotId.value === snapshot.id) selectedSnapshotId.value = ''
    await loadSnapshots()
  } finally {
    busyId.value = ''
  }
}

function openRestore(payload) {
  restoreState.value = payload
}

function onRestoreSubmitted(restore) {
  restoreState.value = null
  const restoreId = restore?.id
  router.push({ name: 'restores', query: restoreId ? { restore: restoreId } : {} })
}

function tagLabel(tag) {
  return String(tag).replace(/^plan:/, '计划 ')
}
</script>

<template>
  <div>
    <PageHeader title="快照" description="按节点浏览备份时间点，浏览与下载文件，发起文件级恢复">
      <template #actions>
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="refresh">
          <RefreshCw v-if="!loading" class="h-3.5 w-3.5" />
          刷新
        </BaseButton>
      </template>
    </PageHeader>

    <div class="grid grid-cols-1 gap-4 xl:grid-cols-[20rem_1fr]">
      <!-- 快照时间点列表 -->
      <div class="bc-card flex min-h-[28rem] flex-col">
        <div class="border-b border-slate-100 px-4 py-3">
          <label class="bc-label">选择节点</label>
          <select v-model="selectedClientId" class="bc-input">
            <option value="">请选择节点</option>
            <option v-for="client in clients" :key="client.id" :value="client.id">
              {{ client.hostname }}（{{ client.status === 'disabled' ? '停用' : '在线' }}）
            </option>
          </select>
          <label class="bc-label mt-3">备份池 / 存储库</label>
          <select v-model="selectedRepoId" class="bc-input">
            <option value="">请选择存储库</option>
            <option v-for="repo in repositories" :key="repo.id" :value="repo.id">{{ repo.name }}</option>
          </select>
          <p class="mt-2 text-[11px] text-slate-400">
            {{ snapshots.length }} 个快照 · 按时间倒序
          </p>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto p-2">
          <LoadingSkeleton v-if="loading && !snapshots.length" variant="block" />
          <ErrorState v-else-if="error" :message="error" compact @retry="loadSnapshots" />
          <EmptyState
            v-else-if="!selectedClientId"
            title="请选择节点"
            description="选择节点后加载其快照时间点。"
          />
          <EmptyState
            v-else-if="!snapshots.length"
            title="暂无快照"
            description="该节点还没有成功备份产生的快照。"
          />
          <div v-else class="space-y-1.5">
            <button
              v-for="snapshot in snapshots"
              :key="snapshot.id"
              type="button"
              class="w-full rounded-lg border px-3 py-2.5 text-left transition"
              :class="
                selectedSnapshotId === snapshot.id
                  ? 'border-brand-300 bg-brand-50/70 ring-1 ring-brand-200'
                  : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
              "
              @click="selectSnapshot(snapshot)"
            >
              <div class="flex items-center justify-between gap-2">
                <span class="text-sm font-medium text-slate-800">{{ formatDateTime(snapshot.time) }}</span>
                <Pin v-if="snapshot.pinned" class="h-3.5 w-3.5 shrink-0 text-brand-500" />
              </div>
              <div class="mt-1 flex items-center justify-between gap-2 text-[11px] text-slate-400">
                <span class="font-mono">{{ snapshot.shortId }}</span>
                <span>{{ formatBytes(snapshot.size) }} · {{ formatNumber(snapshot.fileCount) }} 文件</span>
              </div>
              <div v-if="snapshot.tags.length" class="mt-1 flex flex-wrap gap-1">
                <span
                  v-for="tag in snapshot.tags.slice(0, 2)"
                  :key="tag"
                  class="rounded bg-slate-100 px-1 py-0.5 text-[10px] text-slate-500"
                >
                  {{ tagLabel(tag) }}
                </span>
                <span v-if="snapshot.tags.length > 2" class="text-[10px] text-slate-400">+{{ snapshot.tags.length - 2 }}</span>
              </div>
            </button>
          </div>
        </div>
      </div>

      <!-- 快照浏览 -->
      <div class="bc-card flex min-h-[28rem] min-w-0 flex-col">
        <template v-if="!selectedClientId">
          <EmptyState title="请选择节点" description="在左侧选择节点，然后选择一个快照时间点浏览文件。" />
        </template>
        <template v-else-if="!selectedSnapshot">
          <div class="border-b border-slate-100 px-4 py-3">
            <h2 class="text-sm font-semibold text-slate-800">快照文件浏览</h2>
            <p class="text-xs text-slate-400">选择左侧时间点后浏览目录、下载文件或发起恢复</p>
          </div>
          <EmptyState
            :icon="Camera"
            title="尚未选择快照"
            description="在左侧时间点列表中点击一个快照，即可浏览该快照的目录结构。"
          />
        </template>
        <template v-else>
          <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-4 py-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-2">
                <h2 class="text-sm font-semibold text-slate-800">{{ formatDateTime(selectedSnapshot.time) }}</h2>
                <StatusBadge v-if="selectedSnapshot.pinned" status="ok" label="已钉住" />
                <span class="max-w-[16rem] truncate font-mono text-[11px] text-slate-400" :title="selectedSnapshot.id">{{ selectedSnapshot.id }}</span>
              </div>
              <div class="mt-0.5 flex flex-wrap items-center gap-3 text-[11px] text-slate-400">
                <span class="inline-flex items-center gap-1">
                  <UserRound class="h-3 w-3" />
                  {{ selectedSnapshot.hostname || meta.clientName(selectedClientId) }}
                </span>
                <span class="inline-flex items-center gap-1">
                  <Clock3 class="h-3 w-3" />
                  {{ formatBytes(selectedSnapshot.size) }} · {{ formatNumber(selectedSnapshot.fileCount) }} 文件
                </span>
                <span v-if="selectedSnapshot.tags.length">{{ selectedSnapshot.tags.map(tagLabel).join(' · ') }}</span>
              </div>
            </div>
            <div class="flex items-center gap-1.5">
              <BaseButton
                v-if="auth.isAdmin"
                variant="secondary"
                size="sm"
                :loading="busyId === selectedSnapshot.id"
                @click="togglePin(selectedSnapshot)"
              >
                <PinOff v-if="selectedSnapshot.pinned" class="h-3.5 w-3.5" />
                <Pin v-else class="h-3.5 w-3.5" />
                {{ selectedSnapshot.pinned ? '取消钉住' : '钉住' }}
              </BaseButton>
              <BaseButton
                v-if="auth.isAdmin"
                variant="danger-outline"
                size="sm"
                :disabled="busyId === selectedSnapshot.id"
                @click="removeSnapshot(selectedSnapshot)"
              >
                <Trash2 class="h-3.5 w-3.5" />
                删除
              </BaseButton>
            </div>
          </div>

          <SnapshotBrowser
            :client-id="selectedClientId"
            :repository-id="selectedRepoId"
            :snapshot-id="selectedSnapshot.id"
            class="min-h-0 flex-1"
            @restore="openRestore"
          />
        </template>
      </div>
    </div>

    <div class="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
      <Camera class="h-3.5 w-3.5" />
      快照文件下载直接复用当前登录 Cookie；下载目录时服务端以 zip 流返回，大目录可能需要较长时间。
    </div>

    <RestoreWizard
      v-if="restoreState"
      :client-id="selectedClientId"
      :repository-id="selectedRepoId"
      :snapshot-id="selectedSnapshotId"
      :includes="restoreState.includes"
      :snapshot-label="selectedSnapshot ? `${selectedSnapshot.shortId} · ${formatDateTime(selectedSnapshot.time)}` : ''"
      @close="restoreState = null"
      @submitted="onRestoreSubmitted"
    />
  </div>
</template>
