<script setup>
import { computed, ref, watch } from 'vue'
import {
  Check,
  Cloud,
  Database,
  FolderOpen,
  HardDrive,
  Network,
  Search,
  Server,
  X,
} from 'lucide-vue-next'
import Modal from './ui/Modal.vue'
import BaseButton from './ui/BaseButton.vue'
import EmptyState from './ui/EmptyState.vue'
import { formatBytes } from '../lib/format.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  repositories: { type: Array, default: () => [] },
  selectedId: { type: String, default: '' },
  title: { type: String, default: '选择存储库 / 备份池' },
})
const emit = defineEmits(['close', 'confirm'])

const keyword = ref('')
const picked = ref(props.selectedId || '')

watch(
  () => props.open,
  (open) => {
    if (open) {
      picked.value = props.selectedId || ''
      keyword.value = ''
    }
  },
)

const TYPE_META = {
  local: { label: '本地目录', icon: HardDrive, tone: 'text-brand-600 bg-brand-50' },
  nfs: { label: 'NFS', icon: Network, tone: 'text-sky-600 bg-sky-50' },
  cifs: { label: 'SMB/CIFS', icon: Server, tone: 'text-violet-600 bg-violet-50' },
  ftp: { label: 'FTP(S)', icon: Cloud, tone: 'text-amber-600 bg-amber-50' },
}

function metaOf(repo) {
  return TYPE_META[repo?.type] || { label: repo?.type || '存储', icon: Database, tone: 'text-slate-600 bg-slate-100' }
}

function pathOf(repo) {
  return repo?.mountpoint || repo?.config?.path || repo?.config?.export || repo?.config?.share || repo?.config?.dir || ''
}

const filtered = computed(() => {
  const q = keyword.value.trim().toLowerCase()
  if (!q) return props.repositories
  return props.repositories.filter((r) =>
    [r.name, r.type, pathOf(r), r.status].some((v) => String(v || '').toLowerCase().includes(q)),
  )
})

const pickedRepo = computed(() => props.repositories.find((r) => r.id === picked.value) || null)

function choose(repo) {
  picked.value = repo.id
}

function confirm() {
  if (!picked.value) return
  emit('confirm', picked.value)
}
</script>

<template>
  <Modal :open="open" :title="title" size="lg" :z-index="70" @close="$emit('close')">
    <div class="space-y-3">
      <p class="text-xs text-slate-500">
        存储库就是“备份池”。选择一个对象作为该计划的目标，备份数据会写入该池下本节点独立仓库。
      </p>
      <div class="relative">
        <Search class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input v-model="keyword" class="bc-input pl-9" placeholder="搜索存储库名称 / 类型 / 路径" />
      </div>

      <EmptyState v-if="!filtered.length" title="没有可用存储库" description="请先在「存储库」页面创建备份池。" />

      <div v-else class="max-h-[22rem] space-y-2 overflow-y-auto pr-1">
        <button
          v-for="repo in filtered"
          :key="repo.id"
          type="button"
          class="flex w-full items-start gap-3 rounded-xl border px-3 py-3 text-left transition"
          :class="
            picked === repo.id
              ? 'border-brand-300 bg-brand-50/70 ring-1 ring-brand-200'
              : 'border-slate-200 bg-white hover:border-slate-300 hover:bg-slate-50'
          "
          @click="choose(repo)"
        >
          <span class="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg" :class="metaOf(repo).tone">
            <component :is="metaOf(repo).icon" class="h-4 w-4" />
          </span>
          <span class="min-w-0 flex-1">
            <span class="flex flex-wrap items-center gap-2">
              <span class="text-sm font-semibold text-slate-800">{{ repo.name }}</span>
              <span class="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{{ metaOf(repo).label }}</span>
              <span
                class="rounded px-1.5 py-0.5 text-[10px]"
                :class="repo.status === 'active' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'"
              >{{ repo.status === 'active' ? '可用' : '异常' }}</span>
            </span>
            <span class="mt-1 flex items-center gap-1 truncate font-mono text-[11px] text-slate-400">
              <FolderOpen class="h-3 w-3" />
              {{ pathOf(repo) || '—' }}
            </span>
            <span v-if="repo.total_bytes" class="mt-1 block text-[11px] text-slate-400">
              共 {{ formatBytes(repo.total_bytes) }} · 剩余 {{ formatBytes(repo.free_bytes || 0) }}
            </span>
            <span v-if="repo.last_error" class="mt-1 block text-[11px] text-red-500">{{ repo.last_error }}</span>
          </span>
          <Check v-if="picked === repo.id" class="mt-1 h-4 w-4 shrink-0 text-brand-600" />
        </button>
      </div>
    </div>

    <template #footer>
      <div class="flex w-full items-center justify-between gap-3">
        <span class="truncate text-xs text-slate-400">
          {{ pickedRepo ? `已选择：${pickedRepo.name}` : '请选择一个存储库' }}
        </span>
        <div class="flex items-center gap-2">
          <BaseButton variant="secondary" @click="$emit('close')">取消</BaseButton>
          <BaseButton :disabled="!picked" @click="confirm">使用该存储库</BaseButton>
        </div>
      </div>
    </template>
  </Modal>
</template>
