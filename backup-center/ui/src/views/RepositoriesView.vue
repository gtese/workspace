<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { storeToRefs } from 'pinia'
import {
  Cloud,
  Database,
  FolderTree,
  HardDrive,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wrench,
} from 'lucide-vue-next'
import PageHeader from '../components/ui/PageHeader.vue'
import BaseButton from '../components/ui/BaseButton.vue'
import StatusBadge from '../components/ui/StatusBadge.vue'
import ProgressBar from '../components/ui/ProgressBar.vue'
import Modal from '../components/ui/Modal.vue'
import LoadingSkeleton from '../components/ui/LoadingSkeleton.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import { useMetaStore } from '../stores/meta.js'
import { useAuthStore } from '../stores/auth.js'
import { api } from '../api/index.js'
import { listOf } from '../lib/normalize.js'
import { confirm } from '../lib/confirm.js'
import { toast } from '../lib/toast.js'
import { formatBytes, formatDateTime, percent, shortId } from '../lib/format.js'

const meta = useMetaStore()
const auth = useAuthStore()
const { repositories, loadingRepositories: loading, repositoriesError: error } = storeToRefs(meta)

const TYPE_META = {
  local: { label: '本地目录', icon: HardDrive, class: 'bg-slate-100 text-slate-600' },
  nfs: { label: 'NFS', icon: Network, class: 'bg-blue-50 text-blue-700' },
  cifs: { label: 'SMB / CIFS', icon: FolderTree, class: 'bg-amber-50 text-amber-700' },
  ftp: { label: 'FTP(S)', icon: Cloud, class: 'bg-violet-50 text-violet-700' },
}

const editOpen = ref(false)
const editing = ref(null)
const saving = ref(false)
const form = reactive({
  name: '',
  type: 'local',
  path: '',
  server: '',
  export: '',
  options: 'rw,hard,vers=4.1',
  share: '',
  username: '',
  password: '',
  domain: '',
  vers: '3.0',
  host: '',
  port: 21,
  tls: true,
  dir: '/backup',
})

const usageOpen = ref(false)
const usageLoading = ref(false)
const usageError = ref('')
const usage = ref(null)
const usageRepo = ref(null)

const validateOpen = ref(false)
const validating = ref(false)
const validateResult = ref(null)
const validateTarget = ref(null)

const isEditing = computed(() => !!editing.value)

onMounted(() => {
  meta.loadRepositories()
})

function typeMeta(type) {
  return TYPE_META[type] || { label: type || '未知', icon: Database, class: 'bg-slate-100 text-slate-600' }
}

function parseConfig(repo) {
  if (!repo) return {}
  let config = repo.config
  if (typeof config === 'string') {
    try {
      config = JSON.parse(config)
    } catch {
      config = {}
    }
  }
  return config || {}
}

function mountpointOf(repo) {
  if (repo.mountpoint) return repo.mountpoint
  const config = parseConfig(repo)
  if (config.path) return config.path
  if (config.server && config.export) return `${config.server}:${config.export}`
  if (config.server && config.share) return `//${config.server}/${config.share}`
  if (config.host) return `${config.host}:${config.port || 21}${config.dir || ''}`
  return '—'
}

function usedBytes(repo) {
  const total = Number(repo.total_bytes)
  const free = Number(repo.free_bytes)
  if (!Number.isFinite(total)) return 0
  return Math.max(0, total - (Number.isFinite(free) ? free : 0))
}

function openCreate() {
  editing.value = null
  Object.assign(form, {
    name: '',
    type: 'local',
    path: '/data2/backup/restic',
    server: '',
    export: '',
    options: 'rw,hard,vers=4.1',
    share: '',
    username: '',
    password: '',
    domain: '',
    vers: '3.0',
    host: '',
    port: 21,
    tls: true,
    dir: '/backup',
  })
  editOpen.value = true
}

function openEdit(repo) {
  editing.value = repo
  const config = parseConfig(repo)
  Object.assign(form, {
    name: repo.name || '',
    type: repo.type || config.type || 'local',
    path: config.path || '',
    server: config.server || '',
    export: config.export || '',
    options: config.options || 'rw,hard,vers=4.1',
    share: config.share || '',
    username: config.username || '',
    password: '',
    domain: config.domain || '',
    vers: config.vers || '3.0',
    host: config.host || '',
    port: config.port || 21,
    tls: config.tls !== false,
    dir: config.dir || '/backup',
  })
  editOpen.value = true
}

function buildConfig() {
  switch (form.type) {
    case 'nfs':
      return {
        type: 'nfs',
        server: form.server.trim(),
        export: form.export.trim(),
        options: form.options.trim(),
      }
    case 'cifs': {
      const config = {
        type: 'cifs',
        server: form.server.trim(),
        share: form.share.trim(),
        username: form.username.trim(),
        domain: form.domain.trim(),
        vers: form.vers.trim(),
      }
      if (form.password) config.password = form.password
      return config
    }
    case 'ftp': {
      const config = {
        type: 'ftp',
        host: form.host.trim(),
        port: Number(form.port) || 21,
        tls: !!form.tls,
        username: form.username.trim(),
        dir: form.dir.trim() || '/',
      }
      if (form.password) config.password = form.password
      return config
    }
    case 'local':
    default:
      return { type: 'local', path: form.path.trim() }
  }
}

function validateForm() {
  if (!form.name.trim()) return '请填写存储库名称'
  if (form.type === 'local' && !form.path.trim()) return '请填写本地存储路径'
  if (form.type === 'nfs' && (!form.server.trim() || !form.export.trim())) return '请填写 NFS 服务器与导出路径'
  if (form.type === 'cifs' && (!form.server.trim() || !form.share.trim())) return '请填写 CIFS 服务器与共享名'
  if (form.type === 'ftp' && !form.host.trim()) return '请填写 FTP 主机地址'
  return ''
}

async function save() {
  const message = validateForm()
  if (message) {
    toast.error(message)
    return
  }
  saving.value = true
  try {
    const config = buildConfig()
    if (isEditing.value) {
      await api.repositories.update(editing.value.id, { name: form.name.trim(), config })
      toast.success('存储库已更新')
    } else {
      await api.repositories.create({ name: form.name.trim(), type: form.type, config })
      toast.success('存储库已创建')
    }
    editOpen.value = false
    await meta.loadRepositories(true)
  } finally {
    saving.value = false
  }
}

async function validateRepo(repo) {
  validateOpen.value = true
  validateTarget.value = repo
  validateResult.value = null
  validating.value = true
  try {
    validateResult.value = await api.repositories.validate(repo.id)
    toast.success('存储库校验完成')
  } catch (err) {
    validateResult.value = { error: err?.message || '校验失败' }
  } finally {
    validating.value = false
  }
}

async function openUsage(repo) {
  usageOpen.value = true
  usageRepo.value = repo
  usage.value = null
  usageError.value = ''
  usageLoading.value = true
  try {
    usage.value = await api.repositories.usage(repo.id)
  } catch (err) {
    usageError.value = err?.message || '加载使用量失败'
  } finally {
    usageLoading.value = false
  }
}

async function removeRepo(repo) {
  const ok = await confirm({
    title: '删除存储库',
    message: `确认删除存储库「${repo.name}」？`,
    detail: '仅当没有客户端引用时可删除；已有备份数据不会被自动删除，请自行确认数据处置方式。',
    confirmText: '删除',
    danger: true,
  })
  if (!ok) return
  try {
    await api.repositories.remove(repo.id)
    toast.success(`存储库「${repo.name}」已删除`)
    await meta.loadRepositories(true)
  } catch {
    // 错误已由统一请求层 toast
  }
}

function refresh() {
  meta.loadRepositories(true)
}

const usageClients = computed(() => listOf(usage.value?.clients, 'clients'))
</script>

<template>
  <div>
    <PageHeader title="存储库" description="管理本地、NFS、SMB/CIFS 与 FTP(S) 备份存储，监控容量与健康状态">
      <template #actions>
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="refresh">
          <RefreshCw v-if="!loading" class="h-3.5 w-3.5" />
          刷新
        </BaseButton>
        <BaseButton v-if="auth.canWrite" size="sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" />
          新建存储库
        </BaseButton>
      </template>
    </PageHeader>

    <div class="bc-card overflow-hidden">
      <LoadingSkeleton v-if="loading && !repositories.length" variant="table" :rows="4" />
      <ErrorState
        v-else-if="error && !repositories.length"
        :message="error"
        description="无法获取存储库列表，请确认后端服务已启动。"
        @retry="refresh"
      />
      <EmptyState
        v-else-if="!repositories.length"
        title="尚未创建存储库"
        description="备份数据需要写入至少一个存储库。支持本地目录、NFS、SMB/CIFS 与 FTP(S)。"
      >
        <BaseButton v-if="auth.canWrite" size="sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" />
          新建存储库
        </BaseButton>
      </EmptyState>

      <div v-else class="overflow-x-auto">
        <table class="bc-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>类型</th>
              <th>挂载点 / 路径</th>
              <th>端口</th>
              <th>状态</th>
              <th class="min-w-[13rem]">容量</th>
              <th>最近检查</th>
              <th class="text-right">操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="repo in repositories" :key="repo.id">
              <td>
                <div class="font-medium text-slate-800">{{ repo.name }}</div>
                <div class="font-mono text-[11px] text-slate-400">{{ shortId(repo.id, 14) }}</div>
              </td>
              <td>
                <span
                  class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium"
                  :class="typeMeta(repo.type).class"
                >
                  <component :is="typeMeta(repo.type).icon" class="h-3 w-3" />
                  {{ typeMeta(repo.type).label }}
                </span>
              </td>
              <td class="max-w-[16rem]">
                <span class="break-all font-mono text-xs text-slate-600" :title="mountpointOf(repo)">
                  {{ mountpointOf(repo) }}
                </span>
              </td>
              <td class="font-mono text-xs text-slate-600">{{ repo.rest_port || '—' }}</td>
              <td><StatusBadge :status="repo.status || 'active'" kind="repo" dot /></td>
              <td>
                <template v-if="Number(repo.total_bytes)">
                  <div class="flex items-center justify-between text-xs text-slate-500">
                    <span>已用 {{ formatBytes(usedBytes(repo)) }}</span>
                    <span>共 {{ formatBytes(repo.total_bytes) }}</span>
                  </div>
                  <ProgressBar
                    :value="percent(usedBytes(repo), repo.total_bytes)"
                    status="running"
                    height="h-1.5"
                    :show-label="false"
                    class="mt-1.5"
                  />
                </template>
                <span v-else class="text-xs text-slate-400">未获取</span>
              </td>
              <td class="whitespace-nowrap text-xs text-slate-600">{{ formatDateTime(repo.last_checked_at) }}</td>
              <td class="text-right">
                <div class="flex items-center justify-end gap-1">
                  <button
                    type="button"
                    class="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-emerald-600"
                    title="校验存储库"
                    @click="validateRepo(repo)"
                  >
                    <ShieldCheck class="h-4 w-4" />
                  </button>
                  <button
                    type="button"
                    class="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-blue-600"
                    title="查看使用量"
                    @click="openUsage(repo)"
                  >
                    <Database class="h-4 w-4" />
                  </button>
                  <button
                    v-if="auth.isAdmin"
                    type="button"
                    class="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-brand-600"
                    title="编辑存储库"
                    @click="openEdit(repo)"
                  >
                    <Pencil class="h-4 w-4" />
                  </button>
                  <button
                    v-if="auth.isAdmin"
                    type="button"
                    class="rounded-lg p-1.5 text-slate-400 transition hover:bg-red-50 hover:text-red-600"
                    title="删除存储库"
                    @click="removeRepo(repo)"
                  >
                    <Trash2 class="h-4 w-4" />
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- 新建/编辑存储库 -->
    <Modal
      v-model:open="editOpen"
      :title="isEditing ? '编辑存储库' : '新建存储库'"
      :subtitle="isEditing ? '修改名称或连接配置；密码留空表示不修改' : '选择存储类型并填写连接配置'"
      size="lg"
    >
      <div class="space-y-4">
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="bc-label">存储库名称</label>
            <input v-model="form.name" class="bc-input" placeholder="例如：backup-main" />
          </div>
          <div>
            <label class="bc-label">存储类型</label>
            <div class="flex flex-wrap gap-1.5">
              <button
                v-for="(metaInfo, key) in TYPE_META"
                :key="key"
                type="button"
                class="inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-2 text-xs font-medium transition"
                :class="
                  form.type === key
                    ? 'border-brand-500 bg-brand-50 text-brand-700'
                    : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
                "
                :disabled="isEditing && form.type !== key"
                @click="form.type = key"
              >
                <component :is="metaInfo.icon" class="h-3.5 w-3.5" />
                {{ metaInfo.label }}
              </button>
            </div>
          </div>
        </div>

        <template v-if="form.type === 'local'">
          <div>
            <label class="bc-label">本地路径</label>
            <input v-model="form.path" class="bc-input font-mono" placeholder="/data2/backup/restic" />
            <p class="mt-1 text-xs text-slate-400">服务端会在此路径下按节点 ID 创建子目录并启动 rest-server。</p>
          </div>
        </template>

        <template v-else-if="form.type === 'nfs'">
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label class="bc-label">NFS 服务器</label>
              <input v-model="form.server" class="bc-input font-mono" placeholder="nfs.example.com" />
            </div>
            <div>
              <label class="bc-label">导出路径</label>
              <input v-model="form.export" class="bc-input font-mono" placeholder="/fs/backup" />
            </div>
          </div>
          <div>
            <label class="bc-label">挂载选项</label>
            <input v-model="form.options" class="bc-input font-mono" placeholder="rw,hard,vers=4.1" />
          </div>
        </template>

        <template v-else-if="form.type === 'cifs'">
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label class="bc-label">服务器</label>
              <input v-model="form.server" class="bc-input font-mono" placeholder="smb.example.com" />
            </div>
            <div>
              <label class="bc-label">共享名</label>
              <input v-model="form.share" class="bc-input" placeholder="backup" />
            </div>
            <div>
              <label class="bc-label">用户名</label>
              <input v-model="form.username" class="bc-input" placeholder="服务账号" autocomplete="off" />
            </div>
            <div>
              <label class="bc-label">密码</label>
              <input
                v-model="form.password"
                type="password"
                class="bc-input"
                :placeholder="isEditing ? '留空表示不修改' : '服务账号密码'"
                autocomplete="new-password"
              />
            </div>
            <div>
              <label class="bc-label">域名 / 工作组</label>
              <input v-model="form.domain" class="bc-input" placeholder="EXAMPLE" />
            </div>
            <div>
              <label class="bc-label">SMB 协议版本</label>
              <select v-model="form.vers" class="bc-input">
                <option value="3.0">3.0</option>
                <option value="2.1">2.1</option>
                <option value="1.0">1.0（不推荐）</option>
              </select>
            </div>
          </div>
        </template>

        <template v-else-if="form.type === 'ftp'">
          <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label class="bc-label">FTP 主机</label>
              <input v-model="form.host" class="bc-input font-mono" placeholder="ftp.example.com" />
            </div>
            <div>
              <label class="bc-label">端口</label>
              <input v-model.number="form.port" type="number" class="bc-input" min="1" max="65535" />
            </div>
            <div>
              <label class="bc-label">用户名</label>
              <input v-model="form.username" class="bc-input" autocomplete="off" />
            </div>
            <div>
              <label class="bc-label">密码</label>
              <input
                v-model="form.password"
                type="password"
                class="bc-input"
                :placeholder="isEditing ? '留空表示不修改' : '账号密码'"
                autocomplete="new-password"
              />
            </div>
            <div>
              <label class="bc-label">远端目录</label>
              <input v-model="form.dir" class="bc-input font-mono" placeholder="/backup" />
            </div>
            <div class="flex items-end pb-1">
              <label class="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
                <input v-model="form.tls" type="checkbox" class="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
                使用 FTPS（TLS）
              </label>
            </div>
          </div>
        </template>

        <p class="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
          存储凭据加密保存于服务端，页面读取时不会回显明文。新建/修改存储库可能需要管理员权限。
        </p>
      </div>

      <template #footer>
        <BaseButton variant="secondary" size="sm" @click="editOpen = false">取消</BaseButton>
        <BaseButton size="sm" :loading="saving" @click="save">{{ isEditing ? '保存修改' : '创建存储库' }}</BaseButton>
      </template>
    </Modal>

    <!-- 使用量 -->
    <Modal v-model:open="usageOpen" title="存储库使用量" :subtitle="usageRepo?.name || ''" size="lg">
      <LoadingSkeleton v-if="usageLoading" variant="block" />
      <ErrorState v-else-if="usageError" :message="usageError" compact @retry="usageRepo && openUsage(usageRepo)" />
      <div v-else-if="usage" class="space-y-5">
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p class="text-xs text-slate-400">总容量</p>
            <p class="mt-1 text-lg font-semibold text-slate-800">{{ formatBytes(usage.total ?? usageRepo?.total_bytes) }}</p>
          </div>
          <div class="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p class="text-xs text-slate-400">可用空间</p>
            <p class="mt-1 text-lg font-semibold text-slate-800">{{ formatBytes(usage.free ?? usageRepo?.free_bytes) }}</p>
          </div>
          <div class="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3">
            <p class="text-xs text-slate-400">仓库数据量</p>
            <p class="mt-1 text-lg font-semibold text-slate-800">{{ formatBytes(usage.repo_bytes) }}</p>
          </div>
        </div>

        <div class="overflow-hidden rounded-xl border border-slate-200">
          <div class="border-b border-slate-100 bg-slate-50 px-4 py-2.5 text-sm font-medium text-slate-700">各节点占用</div>
          <div v-if="usageClients.length" class="overflow-x-auto">
            <table class="bc-table">
              <thead>
                <tr>
                  <th>节点</th>
                  <th>数据量</th>
                  <th>快照数</th>
                  <th>最近备份</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="item in usageClients" :key="item.client_id">
                  <td>
                    <span class="text-sm text-slate-700">{{ meta.clientName(item.client_id) }}</span>
                    <div class="font-mono text-[11px] text-slate-400">{{ item.client_id }}</div>
                  </td>
                  <td class="text-sm text-slate-600">{{ formatBytes(item.bytes) }}</td>
                  <td class="text-sm text-slate-600">{{ item.snapshots ?? '—' }}</td>
                  <td class="text-xs text-slate-600">{{ formatDateTime(item.last_backup) }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <EmptyState v-else title="暂无节点占用数据" description="尚无节点写入该存储库。" />
        </div>
      </div>
      <template #footer>
        <BaseButton variant="secondary" size="sm" @click="usageOpen = false">关闭</BaseButton>
      </template>
    </Modal>

    <!-- 校验结果 -->
    <Modal v-model:open="validateOpen" title="存储库校验" :subtitle="validateTarget?.name || ''" size="md">
      <div v-if="validating" class="flex items-center gap-3 py-6 text-sm text-slate-500">
        <Wrench class="h-5 w-5 animate-spin text-brand-500" />
        正在执行写测试与 restic 轻量校验，请稍候…
      </div>
      <div v-else-if="validateResult">
        <div
          class="mb-3 flex items-center gap-2 rounded-lg px-3 py-2 text-sm"
          :class="validateResult.error ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'"
        >
          <ShieldCheck class="h-4 w-4" />
          {{ validateResult.error ? validateResult.error : '校验完成' }}
        </div>
        <pre class="max-h-72 overflow-auto rounded-lg bg-slate-900 px-4 py-3 text-[11px] leading-5 text-slate-200"><code>{{ JSON.stringify(validateResult, null, 2) }}</code></pre>
      </div>
      <template #footer>
        <BaseButton variant="secondary" size="sm" @click="validateOpen = false">关闭</BaseButton>
        <BaseButton size="sm" :loading="validating" @click="validateTarget && validateRepo(validateTarget)">重新校验</BaseButton>
      </template>
    </Modal>
  </div>
</template>
