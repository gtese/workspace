<script setup>
import { computed, ref, watch } from 'vue'
import {
  ChevronRight,
  File,
  Folder,
  FolderOpen,
  HardDrive,
  Home,
  Link2,
  Loader2,
  Plus,
  RotateCw,
  Search,
  X,
} from 'lucide-vue-next'
import Modal from './ui/Modal.vue'
import BaseButton from './ui/BaseButton.vue'
import EmptyState from './ui/EmptyState.vue'
import ErrorState from './ui/ErrorState.vue'
import { api } from '../api/index.js'
import { toast } from '../lib/toast.js'
import { formatBytes, formatDateTime } from '../lib/format.js'

const props = defineProps({
  open: { type: Boolean, default: false },
  clientId: { type: String, default: '' },
  initialPath: { type: String, default: '/' },
  title: { type: String, default: '选择备份目录或文件' },
})

const emit = defineEmits(['update:open', 'close', 'confirm'])

const currentPath = ref('/')
const data = ref(null)
const loading = ref(false)
const error = ref('')
const selected = ref([])
const keyword = ref('')
const manualInput = ref('')
const displayLimit = ref(200)

const DIR_TYPES = ['dir', 'directory']

const mounts = computed(() => data.value?.mounts || [])

const normalizedEntries = computed(() => {
  const list = Array.isArray(data.value?.entries) ? data.value.entries : []
  return list
    .filter((entry) => entry && entry.path !== currentPath.value && entry.name !== '.' && entry.name !== '..')
    .map((entry) => {
      const rawType = String(entry.type || '').toLowerCase()
      const type = DIR_TYPES.includes(rawType) ? 'dir' : rawType === 'link' ? 'link' : 'file'
      return {
        ...entry,
        type,
        name: entry.name || entry.path?.split('/').filter(Boolean).pop() || '—',
      }
    })
    .sort((a, b) => {
      if (a.type === 'dir' && b.type !== 'dir') return -1
      if (a.type !== 'dir' && b.type === 'dir') return 1
      return String(a.name).localeCompare(String(b.name), 'zh-CN')
    })
})

const filteredEntries = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  if (!kw) return normalizedEntries.value
  return normalizedEntries.value.filter(
    (entry) => String(entry.name).toLowerCase().includes(kw) || String(entry.path).toLowerCase().includes(kw),
  )
})

const visibleEntries = computed(() => filteredEntries.value.slice(0, displayLimit.value))
const hasMore = computed(() => filteredEntries.value.length > displayLimit.value)

const breadcrumbs = computed(() => {
  if (currentPath.value === '/') return [{ label: '/', path: '/' }]
  const parts = currentPath.value.split('/').filter(Boolean)
  const items = [{ label: '/', path: '/' }]
  parts.forEach((part, index) => {
    items.push({ label: part, path: `/${parts.slice(0, index + 1).join('/')}` })
  })
  return items
})

const selectedPaths = computed(() => selected.value.map((item) => item.path))

const allVisibleSelected = computed(
  () => visibleEntries.value.length > 0 && visibleEntries.value.every((entry) => isSelected(entry.path)),
)

watch(
  () => props.open,
  (open) => {
    if (!open) return
    selected.value = []
    keyword.value = ''
    manualInput.value = ''
    displayLimit.value = 200
    loadPath(props.initialPath || '/')
  },
)

watch(
  () => props.clientId,
  () => {
    if (!props.open) return
    selected.value = []
    loadPath('/')
  },
)

async function loadPath(path) {
  if (!props.clientId) {
    error.value = '请先选择节点后再浏览目录'
    return
  }
  const target = path && path.startsWith('/') ? path : '/'
  loading.value = true
  error.value = ''
  try {
    const res = await api.clients.fs(props.clientId, target)
    data.value = res || { entries: [], mounts: [] }
    currentPath.value = res?.path || target
    displayLimit.value = 200
    keyword.value = ''
  } catch (err) {
    error.value =
      err?.status === 504
        ? '目录读取超时（服务端 15 秒限制），请稍后重试或选择更小的目录。'
        : err?.message || '读取目录失败'
  } finally {
    loading.value = false
  }
}

function isDir(entry) {
  return entry.type === 'dir'
}

function isSelected(path) {
  return selected.value.some((item) => item.path === path)
}

function toggle(entry) {
  if (isSelected(entry.path)) {
    selected.value = selected.value.filter((item) => item.path !== entry.path)
  } else {
    selected.value.push({
      path: entry.path,
      name: entry.name,
      type: isDir(entry) ? 'dir' : 'file',
    })
  }
}

function toggleAllVisible() {
  if (allVisibleSelected.value) {
    const visibleSet = new Set(visibleEntries.value.map((entry) => entry.path))
    selected.value = selected.value.filter((item) => !visibleSet.has(item.path))
  } else {
    for (const entry of visibleEntries.value) {
      if (!isSelected(entry.path)) {
        selected.value.push({ path: entry.path, name: entry.name, type: isDir(entry) ? 'dir' : 'file' })
      }
    }
  }
}

function removeSelected(path) {
  selected.value = selected.value.filter((item) => item.path !== path)
}

function addCurrentDir() {
  if (!currentPath.value) return
  if (isSelected(currentPath.value)) {
    toast.info('当前目录已在选择列表中')
    return
  }
  selected.value.push({
    path: currentPath.value,
    name: currentPath.value === '/' ? '/' : currentPath.value.split('/').filter(Boolean).pop(),
    type: 'dir',
  })
  toast.success('已添加当前目录')
}

function jumpManual() {
  const path = manualInput.value.trim()
  if (!path) {
    toast.error('请输入要跳转的路径')
    return
  }
  if (!path.startsWith('/')) {
    toast.error('路径必须以 / 开头')
    return
  }
  loadPath(path)
}

function addManual() {
  const path = manualInput.value.trim()
  if (!path) {
    toast.error('请输入路径')
    return
  }
  if (!path.startsWith('/')) {
    toast.error('路径必须以 / 开头')
    return
  }
  if (isSelected(path)) {
    toast.info('该路径已在选择列表中')
    return
  }
  selected.value.push({
    path,
    name: path === '/' ? '/' : path.split('/').filter(Boolean).pop(),
    type: 'dir',
  })
}

function openEntry(entry) {
  if (isDir(entry)) loadPath(entry.path)
}

function close() {
  emit('update:open', false)
  emit('close')
}

function confirmSelection() {
  if (!selected.value.length) {
    toast.error('请至少选择一个目录或文件')
    return
  }
  emit(
    'confirm',
    selected.value.map((item) => item.path),
  )
  emit('update:open', false)
}
</script>

<template>
  <Modal :open="open" :title="title" size="xl" :z-index="60" @close="close">
    <div class="space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <div class="relative min-w-[14rem] flex-1">
          <input
            v-model="manualInput"
            class="bc-input pl-3 font-mono text-xs"
            placeholder="手动输入路径，如 /home/docs"
            @keyup.enter="jumpManual"
          />
        </div>
        <BaseButton variant="secondary" size="sm" @click="jumpManual">跳转</BaseButton>
        <BaseButton variant="secondary" size="sm" @click="addManual">
          <Plus class="h-3.5 w-3.5" />
          添加路径
        </BaseButton>
        <BaseButton variant="secondary" size="sm" @click="addCurrentDir">
          <FolderOpen class="h-3.5 w-3.5" />
          选择当前目录
        </BaseButton>
      </div>

      <div class="flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-1.5">
        <button
          v-for="(crumb, index) in breadcrumbs"
          :key="crumb.path"
          type="button"
          class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs transition hover:bg-slate-200/70"
          :class="index === breadcrumbs.length - 1 ? 'font-medium text-slate-800' : 'text-slate-500'"
          @click="loadPath(crumb.path)"
        >
          <Home v-if="index === 0" class="h-3.5 w-3.5" />
          <span v-if="index > 0" class="text-slate-300">/</span>
          {{ crumb.label }}
        </button>
        <span class="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            class="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs text-slate-500 transition hover:bg-slate-200/70"
            :disabled="loading"
            @click="loadPath(currentPath)"
          >
            <RotateCw class="h-3.5 w-3.5" :class="loading ? 'animate-spin' : ''" />
            刷新
          </button>
        </span>
      </div>

      <div v-if="mounts.length" class="flex flex-wrap items-center gap-1.5">
        <span class="text-[11px] text-slate-400">挂载点：</span>
        <button
          v-for="mount in mounts"
          :key="mount.path"
          type="button"
          class="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[11px] text-slate-600 transition hover:border-brand-300 hover:bg-brand-50 hover:text-brand-700"
          :title="`${mount.path} · ${mount.fs || ''}${mount.total ? ` · ${formatBytes(mount.free)} / ${formatBytes(mount.total)}` : ''}`"
          @click="loadPath(mount.path)"
        >
          <HardDrive class="h-3 w-3" />
          {{ mount.path }}
          <span v-if="mount.total" class="text-slate-400">{{ formatBytes(mount.free) }} 可用</span>
        </button>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <div class="relative flex-1 min-w-[12rem]">
          <Search class="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input v-model="keyword" class="bc-input py-1.5 pl-8 text-xs" placeholder="在当前目录中筛选名称" />
        </div>
        <label class="inline-flex cursor-pointer select-none items-center gap-1.5 text-xs text-slate-600">
          <input
            type="checkbox"
            class="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            :checked="allVisibleSelected"
            @change="toggleAllVisible"
          />
          全选当前列表
        </label>
        <span class="text-xs text-slate-400">已选 {{ selected.length }} 项</span>
      </div>

      <div class="overflow-hidden rounded-xl border border-slate-200">
        <div v-if="loading" class="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
          <Loader2 class="h-5 w-5 animate-spin text-brand-500" />
          正在读取目录…
        </div>

        <ErrorState
          v-else-if="error"
          :message="error"
          description="目录浏览经代理实时回传，超时或节点离线时会失败。"
          compact
          @retry="loadPath(currentPath)"
        />

        <EmptyState
          v-else-if="!visibleEntries.length"
          :title="keyword ? '没有匹配的目录或文件' : '目录为空'"
          :description="keyword ? '尝试修改筛选关键字。' : '该目录下没有可选择的条目。'"
        />

        <div v-else class="max-h-[46vh] overflow-y-auto">
          <table class="bc-table">
            <thead class="sticky top-0 z-10">
              <tr>
                <th class="w-10"></th>
                <th>名称</th>
                <th class="w-28">类型</th>
                <th class="w-28">大小</th>
                <th class="w-24">权限</th>
                <th class="w-40">修改时间</th>
                <th class="w-20 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="entry in visibleEntries"
                :key="entry.path"
                class="cursor-pointer"
                :class="isSelected(entry.path) ? 'bg-brand-50/60' : ''"
                @click="toggle(entry)"
              >
                <td @click.stop>
                  <input
                    type="checkbox"
                    class="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
                    :checked="isSelected(entry.path)"
                    @change="toggle(entry)"
                  />
                </td>
                <td>
                  <div class="flex items-center gap-2">
                    <Folder v-if="entry.type === 'dir'" class="h-4 w-4 shrink-0 text-amber-500" />
                    <Link2 v-else-if="entry.type === 'link'" class="h-4 w-4 shrink-0 text-sky-500" />
                    <File v-else class="h-4 w-4 shrink-0 text-slate-400" />
                    <span class="truncate font-mono text-xs" :title="entry.path">{{ entry.name }}</span>
                  </div>
                </td>
                <td class="text-xs text-slate-500">
                  {{ entry.type === 'dir' ? '目录' : entry.type === 'link' ? '符号链接' : '文件' }}
                </td>
                <td class="text-xs text-slate-500">{{ entry.type === 'dir' ? '—' : formatBytes(entry.size) }}</td>
                <td class="font-mono text-[11px] text-slate-500">{{ entry.mode || '—' }}</td>
                <td class="whitespace-nowrap text-[11px] text-slate-500">{{ formatDateTime(entry.mtime) }}</td>
                <td class="text-right" @click.stop>
                  <button
                    v-if="entry.type === 'dir'"
                    type="button"
                    class="inline-flex items-center gap-0.5 whitespace-nowrap rounded px-1.5 py-0.5 text-xs text-brand-600 transition hover:bg-brand-50"
                    @click="openEntry(entry)"
                  >
                    打开
                    <ChevronRight class="h-3 w-3" />
                  </button>
                  <button
                    v-else
                    type="button"
                    class="rounded px-1.5 py-0.5 text-xs text-slate-500 transition hover:bg-slate-100"
                    @click="toggle(entry)"
                  >
                    {{ isSelected(entry.path) ? '取消' : '选择' }}
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div v-if="hasMore" class="text-center">
        <BaseButton variant="secondary" size="xs" @click="displayLimit += 200">
          加载更多（已显示 {{ visibleEntries.length }} / {{ filteredEntries.length }}）
        </BaseButton>
      </div>

      <div v-if="selected.length" class="rounded-xl border border-brand-100 bg-brand-50/50 px-3 py-2.5">
        <div class="mb-1.5 flex items-center justify-between">
          <span class="text-xs font-medium text-slate-600">已选择路径（{{ selected.length }}）</span>
          <button type="button" class="text-[11px] text-slate-400 hover:text-slate-600" @click="selected = []">清空</button>
        </div>
        <div class="flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">
          <span
            v-for="item in selected"
            :key="item.path"
            class="inline-flex max-w-full items-center gap-1 rounded-full border border-brand-200 bg-white px-2 py-0.5 font-mono text-[11px] text-slate-700"
          >
            <Folder v-if="item.type === 'dir'" class="h-3 w-3 text-amber-500" />
            <File v-else class="h-3 w-3 text-slate-400" />
            <span class="truncate">{{ item.path }}</span>
            <button type="button" class="text-slate-400 hover:text-red-500" @click="removeSelected(item.path)">
              <X class="h-3 w-3" />
            </button>
          </span>
        </div>
      </div>
    </div>

    <template #footer>
      <span class="mr-auto text-xs text-slate-400">已选 {{ selected.length }} 项</span>
      <BaseButton variant="secondary" size="sm" @click="close">取消</BaseButton>
      <BaseButton size="sm" :disabled="!selected.length" @click="confirmSelection">
        添加到备份目录
      </BaseButton>
    </template>
  </Modal>
</template>
