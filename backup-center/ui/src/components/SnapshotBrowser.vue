<script setup>
import { computed, ref, watch } from 'vue'
import {
  ChevronRight,
  Download,
  FileArchive,
  File as FileIcon,
  Folder,
  Home,
  Link2,
  Loader2,
  RotateCcw,
  RotateCw,
  Search,
  X,
} from 'lucide-vue-next'
import BaseButton from './ui/BaseButton.vue'
import EmptyState from './ui/EmptyState.vue'
import ErrorState from './ui/ErrorState.vue'
import { api } from '../api/index.js'
import { useAuthStore } from '../stores/auth.js'
import { listOf } from '../lib/normalize.js'
import { toast } from '../lib/toast.js'
import { formatBytes, formatDateTime } from '../lib/format.js'

const props = defineProps({
  clientId: { type: String, required: true },
  repositoryId: { type: String, default: '' },
  snapshotId: { type: String, required: true },
})

const emit = defineEmits(['restore'])
const auth = useAuthStore()

const currentPath = ref('/')
const data = ref(null)
const loading = ref(false)
const error = ref('')
const selection = ref([])
const searchOpen = ref(false)
const searchQuery = ref('')
const searching = ref(false)
const searchError = ref('')
const searchResults = ref([])

const DIR_TYPES = ['dir', 'directory']

const entries = computed(() => {
  const list = Array.isArray(data.value?.entries) ? data.value.entries : []
  return list
    .filter((entry) => entry && entry.path !== currentPath.value && entry.name !== '.' && entry.name !== '..')
    .map((entry) => {
      const rawType = String(entry.type || '').toLowerCase()
      return {
        ...entry,
        name: entry.name || entry.path?.split('/').filter(Boolean).pop() || '—',
        type: DIR_TYPES.includes(rawType) ? 'dir' : rawType === 'link' ? 'link' : 'file',
      }
    })
    .sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1
      if (a.type !== 'dir' && b.type === 'dir') return 1
      return String(a.name).localeCompare(String(b.name), 'zh-CN')
    })
})

const breadcrumbs = computed(() => {
  if (!currentPath.value || currentPath.value === '/') return [{ label: '/', path: '/' }]
  const parts = currentPath.value.split('/').filter(Boolean)
  const items = [{ label: '/', path: '/' }]
  parts.forEach((part, index) => {
    items.push({ label: part, path: `/${parts.slice(0, index + 1).join('/')}` })
  })
  return items
})

const selectedPaths = computed(() => selection.value.map((item) => item.path))

watch(
  () => [props.clientId, props.snapshotId],
  () => {
    currentPath.value = '/'
    selection.value = []
    searchOpen.value = false
    searchQuery.value = ''
    searchResults.value = []
    loadPath('/')
  },
  { immediate: true },
)

async function loadPath(path) {
  loading.value = true
  error.value = ''
  try {
    const res = await api.snapshots.ls(props.clientId, props.snapshotId, path, props.repositoryId)
    data.value = res || { entries: [] }
    currentPath.value = res?.path || path || '/'
  } catch (err) {
    error.value = err?.message || '读取快照目录失败'
  } finally {
    loading.value = false
  }
}

function isDir(entry) {
  return entry.type === 'dir'
}

function isSelected(path) {
  return selection.value.some((item) => item.path === path)
}

function toggle(entry) {
  if (isSelected(entry.path)) {
    selection.value = selection.value.filter((item) => item.path !== entry.path)
  } else {
    selection.value.push({ path: entry.path, type: isDir(entry) ? 'dir' : 'file' })
  }
}

function addEntry(entry) {
  if (!isSelected(entry.path)) {
    selection.value.push({ path: entry.path, type: isDir(entry) ? 'dir' : 'file' })
  }
}

function removeSelected(path) {
  selection.value = selection.value.filter((item) => item.path !== path)
}

function downloadUrl(path) {
  return api.snapshots.downloadUrl(props.clientId, props.snapshotId, path, props.repositoryId)
}

function openSearchResult(item) {
  const path = item.path || item
  const isDirectory = DIR_TYPES.includes(String(item.type || '').toLowerCase())
  if (isDirectory) {
    searchOpen.value = false
    loadPath(path)
    return
  }
  addEntry({ path, type: 'file' })
  toast.success('已加入恢复选择')
}

function locateSearchResult(item) {
  const path = item.path || item
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) || '/' : '/'
  searchOpen.value = false
  loadPath(dir)
}

async function doSearch() {
  const q = searchQuery.value.trim()
  if (!q) {
    toast.error('请输入要搜索的文件名')
    return
  }
  searching.value = true
  searchError.value = ''
  searchResults.value = []
  try {
    const res = await api.snapshots.search(props.clientId, props.snapshotId, q, props.repositoryId)
    searchResults.value = listOf(res, 'results', 'entries', 'matches', 'nodes')
  } catch (err) {
    searchError.value = err?.message || '搜索失败'
  } finally {
    searching.value = false
  }
}

function restoreSelected() {
  if (!selection.value.length) {
    toast.error('请先选择要恢复的文件或目录')
    return
  }
  emit('restore', { includes: selectedPaths.value, suggestedTarget: '/' })
}

function restoreCurrentDir() {
  emit('restore', { includes: [currentPath.value || '/'], suggestedTarget: '/' })
}

function selectedSizeInfo(item) {
  return item.type === 'dir' ? '—' : formatBytes(item.size)
}
</script>

<template>
  <div class="flex h-full min-h-0 flex-col">
    <div class="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2.5">
      <div class="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        <button
          v-for="(crumb, index) in breadcrumbs"
          :key="crumb.path"
          type="button"
          class="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs transition hover:bg-slate-100"
          :class="index === breadcrumbs.length - 1 ? 'font-medium text-slate-800' : 'text-slate-500'"
          @click="loadPath(crumb.path)"
        >
          <Home v-if="index === 0" class="h-3.5 w-3.5" />
          <span v-if="index > 0" class="text-slate-300">/</span>
          {{ crumb.label }}
        </button>
      </div>
      <div class="flex items-center gap-1.5">
        <button
          type="button"
          class="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-slate-500 transition hover:bg-slate-100"
          :disabled="loading"
          @click="loadPath(currentPath)"
        >
          <RotateCw class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" />
          刷新
        </button>
        <a
          :href="downloadUrl(currentPath)"
          class="inline-flex items-center gap-1 rounded-lg px-2 py-1.5 text-xs text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
          title="将当前目录打包为 zip 下载"
        >
          <FileArchive class="h-3.5 w-3.5" />
          下载目录 zip
        </a>
        <BaseButton v-if="auth.canWrite" size="xs" :disabled="!selection.length" @click="restoreSelected">
          <RotateCcw class="h-3.5 w-3.5" />
          恢复所选
          <span v-if="selection.length">（{{ selection.length }}）</span>
        </BaseButton>
      </div>
    </div>

    <div class="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2">
      <button
        type="button"
        class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-slate-500 transition hover:bg-white hover:text-brand-600"
        @click="searchOpen = !searchOpen"
      >
        <Search class="h-3.5 w-3.5" />
        {{ searchOpen ? '收起文件搜索' : '在快照中搜索文件' }}
      </button>
      <span class="ml-auto text-[11px] text-slate-400">
        本目录 {{ entries.length }} 项 · 已选 {{ selection.length }} 项
      </span>
    </div>

    <div v-if="searchOpen" class="border-b border-slate-100 px-4 py-2.5">
      <div class="flex items-center gap-2">
        <input
          v-model="searchQuery"
          class="bc-input py-1.5 text-xs"
          placeholder="输入文件名关键字（restic find）"
          @keyup.enter="doSearch"
        />
        <BaseButton size="sm" :loading="searching" @click="doSearch">搜索</BaseButton>
      </div>
      <div v-if="searchError" class="mt-2 text-xs text-red-600">{{ searchError }}</div>
      <div v-else-if="searching" class="mt-2 flex items-center gap-2 text-xs text-slate-500">
        <Loader2 class="h-3.5 w-3.5 animate-spin" />
        正在全量搜索快照…
      </div>
      <div v-else-if="searchResults.length" class="mt-2 max-h-44 overflow-y-auto rounded-lg border border-slate-200">
        <div
          v-for="(item, index) in searchResults"
          :key="item.path || index"
          class="flex items-center gap-2 border-b border-slate-100 px-2.5 py-1.5 text-xs last:border-0 hover:bg-slate-50"
        >
          <Folder v-if="['dir', 'directory'].includes(String(item.type || '').toLowerCase())" class="h-3.5 w-3.5 text-amber-500" />
          <FileIcon v-else class="h-3.5 w-3.5 text-slate-400" />
          <span class="min-w-0 flex-1 truncate font-mono text-slate-600" :title="item.path">{{ item.path }}</span>
          <span class="text-[11px] text-slate-400">{{ formatBytes(item.size) }}</span>
          <button type="button" class="rounded px-1.5 py-0.5 text-brand-600 hover:bg-brand-50" @click="locateSearchResult(item)">
            定位
          </button>
          <button type="button" class="rounded px-1.5 py-0.5 text-slate-500 hover:bg-slate-100" @click="openSearchResult(item)">
            选择
          </button>
        </div>
      </div>
      <div v-else-if="searchQuery && !searching" class="mt-2 text-xs text-slate-400">未找到匹配文件。</div>
    </div>

    <div class="min-h-0 flex-1 overflow-y-auto">
      <div v-if="loading" class="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
        <Loader2 class="h-5 w-5 animate-spin text-brand-500" />
        正在读取快照目录…
      </div>

      <ErrorState
        v-else-if="error"
        :message="error"
        description="读取快照目录失败，可能是仓库不可用或快照已被删除。"
        compact
        @retry="loadPath(currentPath)"
      />

      <EmptyState
        v-else-if="!entries.length"
        title="目录为空"
        description="当前目录在快照中没有条目。"
      />

      <table v-else class="bc-table">
        <thead class="sticky top-0 z-10">
          <tr>
            <th class="w-10"></th>
            <th>名称</th>
            <th class="w-20">类型</th>
            <th class="w-28">大小</th>
            <th class="w-24">权限</th>
            <th class="w-40">修改时间</th>
            <th class="w-40 text-right">操作</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="entry in entries"
            :key="entry.path"
            :class="isSelected(entry.path) ? 'bg-brand-50/50' : ''"
          >
            <td>
              <input
                type="checkbox"
                class="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                :checked="isSelected(entry.path)"
                @change="toggle(entry)"
              />
            </td>
            <td>
              <button
                v-if="isDir(entry)"
                type="button"
                class="flex items-center gap-2 text-left"
                @click="loadPath(entry.path)"
              >
                <Folder class="h-4 w-4 shrink-0 text-amber-500" />
                <span class="truncate font-mono text-xs text-slate-700 hover:text-brand-600" :title="entry.path">
                  {{ entry.name }}
                </span>
                <ChevronRight class="h-3 w-3 text-slate-300" />
              </button>
              <div v-else class="flex items-center gap-2">
                <Link2 v-if="entry.type === 'link'" class="h-4 w-4 shrink-0 text-sky-500" />
                <FileIcon v-else class="h-4 w-4 shrink-0 text-slate-400" />
                <span class="truncate font-mono text-xs text-slate-700" :title="entry.path">{{ entry.name }}</span>
              </div>
            </td>
            <td class="text-xs text-slate-500">
              {{ isDir(entry) ? '目录' : entry.type === 'link' ? '链接' : '文件' }}
            </td>
            <td class="text-xs text-slate-500">{{ selectedSizeInfo(entry) }}</td>
            <td class="font-mono text-[11px] text-slate-500">{{ entry.mode || '—' }}</td>
            <td class="whitespace-nowrap text-[11px] text-slate-500">{{ formatDateTime(entry.mtime) }}</td>
            <td class="text-right">
              <div class="flex items-center justify-end gap-1">
                <button
                  type="button"
                  class="rounded px-1.5 py-0.5 text-[11px] transition hover:bg-slate-100"
                  :class="isSelected(entry.path) ? 'text-slate-500' : 'text-brand-600'"
                  @click="toggle(entry)"
                >
                  {{ isSelected(entry.path) ? '取消' : '选择' }}
                </button>
                <a
                  v-if="entry.type === 'file' || entry.type === 'link'"
                  :href="downloadUrl(entry.path)"
                  class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                  title="下载该文件"
                >
                  <Download class="h-3 w-3" />
                  下载
                </a>
                <a
                  v-else
                  :href="downloadUrl(entry.path)"
                  class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-700"
                  title="将该目录打包为 zip 下载"
                >
                  <FileArchive class="h-3 w-3" />
                  zip
                </a>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="selection.length" class="border-t border-slate-100 bg-brand-50/40 px-4 py-2.5">
      <div class="mb-1.5 flex items-center justify-between">
        <span class="text-xs font-medium text-slate-600">恢复选择（{{ selection.length }}）</span>
        <button type="button" class="text-[11px] text-slate-400 hover:text-slate-600" @click="selection = []">清空</button>
      </div>
      <div class="flex max-h-20 flex-wrap gap-1.5 overflow-y-auto">
        <span
          v-for="item in selection"
          :key="item.path"
          class="inline-flex max-w-full items-center gap-1 rounded-full border border-brand-200 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-700"
        >
          <Folder v-if="item.type === 'dir'" class="h-3 w-3 text-amber-500" />
          <FileIcon v-else class="h-3 w-3 text-slate-400" />
          <span class="truncate">{{ item.path }}</span>
          <button type="button" class="text-slate-400 hover:text-red-500" @click="removeSelected(item.path)">
            <X class="h-3 w-3" />
          </button>
        </span>
      </div>
      <div class="mt-2 flex items-center gap-2">
        <BaseButton v-if="auth.canWrite" size="xs" @click="restoreSelected">
          <RotateCcw class="h-3 w-3" />
          恢复所选（{{ selection.length }}）
        </BaseButton>
        <BaseButton v-if="auth.canWrite" variant="secondary" size="xs" @click="restoreCurrentDir">
          恢复当前目录
        </BaseButton>
      </div>
    </div>
  </div>
</template>
