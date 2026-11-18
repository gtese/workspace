<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  Check,
  Copy,
  Fingerprint,
  Plus,
  RefreshCw,
  ShieldQuestion,
  Terminal,
  X,
} from 'lucide-vue-next'
import PageHeader from '../components/ui/PageHeader.vue'
import BaseButton from '../components/ui/BaseButton.vue'
import StatusBadge from '../components/ui/StatusBadge.vue'
import Pagination from '../components/ui/Pagination.vue'
import Modal from '../components/ui/Modal.vue'
import LoadingSkeleton from '../components/ui/LoadingSkeleton.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import { useAuthStore } from '../stores/auth.js'
import { useMetaStore } from '../stores/meta.js'
import { api } from '../api/index.js'
import { listOf } from '../lib/normalize.js'
import { confirm } from '../lib/confirm.js'
import { toast } from '../lib/toast.js'
import { copyText, formatDateTime, shortId } from '../lib/format.js'

const route = useRoute()
const auth = useAuthStore()
const meta = useMetaStore()

const requests = ref([])
const loading = ref(true)
const error = ref('')
const busyId = ref('')
const activeTab = ref('pending')
const page = ref(1)
const pageSize = ref(10)

const TABS = [
  { key: 'pending', label: '待审批' },
  { key: 'approved', label: '已批准' },
  { key: 'rejected', label: '已拒绝' },
  { key: 'expired', label: '已过期' },
  { key: 'all', label: '全部' },
]

const filtered = computed(() => {
  if (activeTab.value === 'all') return requests.value
  return requests.value.filter((r) => r.status === activeTab.value)
})

const paged = computed(() => {
  const start = (page.value - 1) * pageSize.value
  return filtered.value.slice(start, start + pageSize.value)
})

const counts = computed(() => {
  const map = { pending: 0, approved: 0, rejected: 0, expired: 0, all: requests.value.length }
  for (const r of requests.value) {
    map[r.status] = (map[r.status] || 0) + 1
  }
  return map
})

watch(activeTab, () => {
  page.value = 1
})

watch(
  () => filtered.value.length,
  (len) => {
    const max = Math.max(1, Math.ceil(len / pageSize.value))
    if (page.value > max) page.value = max
  },
)

// 创建接入请求
const createOpen = ref(false)
const creating = ref(false)
const createForm = reactive({ hostname_hint: '', ttl_minutes: 60, repository_id: '' })
const created = ref(null)

// 详情
const detailOpen = ref(false)
const detailLoading = ref(false)
const detailError = ref('')
const detail = ref(null)

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.enroll.list()
    requests.value = listOf(data, 'requests', 'enroll_requests')
  } catch (err) {
    error.value = err?.message || '加载待审批节点失败'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  load()
  meta.loadRepositories()
  if (route.query.create === '1' && auth.canWrite) {
    openCreate()
  }
})

function openCreate() {
  createForm.hostname_hint = ''
  createForm.ttl_minutes = 60
  createForm.repository_id = ''
  created.value = null
  createOpen.value = true
}

async function submitCreate() {
  creating.value = true
  try {
    const payload = {
      hostname_hint: createForm.hostname_hint.trim() || undefined,
      ttl_minutes: Number(createForm.ttl_minutes) || 60,
      repository_id: createForm.repository_id || undefined,
    }
    const data = await api.enroll.create(payload)
    created.value = data
    toast.success('接入请求已生成，请在有效期内运行安装命令')
    await load()
  } finally {
    creating.value = false
  }
}

async function approve(request) {
  const ok = await confirm({
    title: '批准节点接入',
    message: `确认批准主机「${request.hostname || '未知主机'}」接入备份平台？`,
    detail: [
      request.os ? `系统：${request.os} / ${request.arch || '—'}` : '',
      request.ip ? `来源 IP：${request.ip}` : '',
      request.fingerprint ? `证书指纹：${request.fingerprint}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    confirmText: '批准接入',
  })
  if (!ok) return
  busyId.value = request.id
  try {
    const result = await api.enroll.approve(request.id)
    const clientId = result?.client_id || result?.client?.id
    toast.success(clientId ? `节点已批准，节点 ID：${clientId}` : '节点已批准接入')
    if (detailOpen.value && detail.value?.id === request.id) detailOpen.value = false
    await load()
  } finally {
    busyId.value = ''
  }
}

async function reject(request) {
  const ok = await confirm({
    title: '拒绝节点接入',
    message: `确认拒绝主机「${request.hostname || '未知主机'}」的接入申请？`,
    detail: '拒绝后该一次性接入令牌立即失效，代理无法再使用该令牌完成注册。',
    confirmText: '拒绝',
    danger: true,
  })
  if (!ok) return
  busyId.value = request.id
  try {
    await api.enroll.reject(request.id)
    toast.success('已拒绝该节点接入')
    if (detailOpen.value && detail.value?.id === request.id) detailOpen.value = false
    await load()
  } finally {
    busyId.value = ''
  }
}

async function openDetail(request) {
  detailOpen.value = true
  detail.value = request
  detailError.value = ''
  detailLoading.value = true
  try {
    const data = await api.enroll.get(request.id)
    detail.value = data?.request || data
  } catch (err) {
    detailError.value = err?.message || '加载详情失败'
  } finally {
    detailLoading.value = false
  }
}

async function copy(value, label) {
  if (!value) return
  const ok = await copyText(String(value))
  if (ok) toast.success(`${label}已复制`)
  else toast.error('复制失败，请手动选择复制')
}

function copyCommand() {
  copy(created.value?.command, '安装命令')
}
</script>

<template>
  <div>
    <PageHeader title="待审批节点" description="审批代理注册请求，校验主机指纹后签发客户端证书">
      <template #actions>
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="load">
          <RefreshCw v-if="!loading" class="h-3.5 w-3.5" />
          刷新
        </BaseButton>
        <BaseButton v-if="auth.canWrite" size="sm" @click="openCreate">
          <Plus class="h-3.5 w-3.5" />
          生成接入命令
        </BaseButton>
      </template>
    </PageHeader>

    <div class="mb-4 flex flex-wrap gap-1.5">
      <button
        v-for="tab in TABS"
        :key="tab.key"
        type="button"
        class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium transition"
        :class="activeTab === tab.key ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50'"
        @click="activeTab = tab.key"
      >
        {{ tab.label }}
        <span
          v-if="counts[tab.key]"
          class="rounded-full px-1.5 py-0.5 text-[10px] leading-none"
          :class="activeTab === tab.key ? 'bg-white/20 text-white' : 'bg-slate-100 text-slate-500'"
        >
          {{ counts[tab.key] }}
        </span>
      </button>
    </div>

    <div class="bc-card overflow-hidden">
      <LoadingSkeleton v-if="loading && !requests.length" variant="table" :rows="5" />
      <ErrorState v-else-if="error && !requests.length" :message="error" @retry="load" />
      <EmptyState
        v-else-if="!filtered.length"
        :title="activeTab === 'pending' ? '暂无待审批节点' : '暂无记录'"
        :description="
          activeTab === 'pending'
            ? '在目标主机上安装代理并提交注册请求后，会出现在这里等待审批。也可以先生成一次性接入命令。'
            : '当前状态下没有节点注册记录。'
        "
      >
        <BaseButton v-if="auth.canWrite" size="sm" @click="openCreate">
          <Terminal class="h-3.5 w-3.5" />
          生成接入命令
        </BaseButton>
      </EmptyState>

      <template v-else>
        <div class="overflow-x-auto">
          <table class="bc-table">
            <thead>
              <tr>
                <th>主机 / 系统</th>
                <th>证书指纹</th>
                <th>来源 IP</th>
                <th>状态</th>
                <th>申请时间</th>
                <th>过期时间</th>
                <th class="text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="request in paged" :key="request.id">
                <td>
                  <div class="font-medium text-slate-800">{{ request.hostname || request.hostname_hint || '未知主机' }}</div>
                  <div class="text-xs text-slate-400">
                    {{ request.os || '—' }}<span v-if="request.arch"> / {{ request.arch }}</span>
                    <span v-if="request.agent_version" class="ml-1">· 代理 {{ request.agent_version }}</span>
                  </div>
                  <div class="font-mono text-[11px] text-slate-400">{{ shortId(request.id, 14) }}</div>
                </td>
                <td>
                  <div class="flex max-w-[15rem] items-center gap-1">
                    <code class="truncate font-mono text-[11px] text-slate-600" :title="request.fingerprint">
                      {{ request.fingerprint || '—' }}
                    </code>
                    <button
                      v-if="request.fingerprint"
                      type="button"
                      class="shrink-0 text-slate-300 hover:text-slate-500"
                      title="复制指纹"
                      @click="copy(request.fingerprint, '证书指纹')"
                    >
                      <Copy class="h-3 w-3" />
                    </button>
                  </div>
                </td>
                <td class="font-mono text-xs text-slate-600">{{ request.ip || '—' }}</td>
                <td><StatusBadge :status="request.status" kind="enroll" dot /></td>
                <td class="whitespace-nowrap text-xs text-slate-600">{{ formatDateTime(request.created_at) }}</td>
                <td class="whitespace-nowrap text-xs text-slate-600">{{ formatDateTime(request.expires_at) }}</td>
                <td class="text-right">
                  <div class="flex items-center justify-end gap-1">
                    <template v-if="request.status === 'pending' && auth.canWrite">
                      <BaseButton
                        variant="success"
                        size="xs"
                        :loading="busyId === request.id"
                        @click="approve(request)"
                      >
                        <Check class="h-3 w-3" />
                        批准
                      </BaseButton>
                      <BaseButton
                        variant="danger-outline"
                        size="xs"
                        :disabled="busyId === request.id"
                        @click="reject(request)"
                      >
                        <X class="h-3 w-3" />
                        拒绝
                      </BaseButton>
                    </template>
                    <button
                      type="button"
                      class="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-brand-600"
                      title="查看详情"
                      @click="openDetail(request)"
                    >
                      <ShieldQuestion class="h-4 w-4" />
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

    <p class="mt-3 flex items-center gap-1.5 text-xs text-slate-400">
      <Fingerprint class="h-3.5 w-3.5" />
      批准前请核对主机名、来源 IP 与证书指纹，避免错误授权。
    </p>

    <!-- 生成接入命令 -->
    <Modal
      v-model:open="createOpen"
      title="生成节点接入命令"
      subtitle="生成一次性令牌与代理安装命令，令牌仅在本次显示"
      size="lg"
    >
      <div v-if="!created" class="space-y-4">
        <div>
          <label class="bc-label">主机名提示（可选）</label>
          <input v-model="createForm.hostname_hint" class="bc-input" placeholder="例如：node-01" />
        </div>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="bc-label">令牌有效期（分钟）</label>
            <input v-model.number="createForm.ttl_minutes" type="number" min="5" max="1440" class="bc-input" />
            <p class="mt-1 text-xs text-slate-400">默认 60 分钟，最长 1440 分钟。</p>
          </div>
          <div>
            <label class="bc-label">归属存储库（可选）</label>
            <select v-model="createForm.repository_id" class="bc-input">
              <option value="">按默认配置</option>
              <option v-for="repo in meta.repositories" :key="repo.id" :value="repo.id">{{ repo.name }}</option>
            </select>
          </div>
        </div>
      </div>

      <div v-else class="space-y-4">
        <div class="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          令牌仅显示一次，请立即复制安装命令并在有效期内执行。过期后可重新生成。
        </div>
        <div>
          <div class="mb-1.5 flex items-center justify-between">
            <span class="text-sm font-medium text-slate-700">安装命令</span>
            <BaseButton variant="secondary" size="xs" @click="copyCommand">
              <Copy class="h-3 w-3" />
              复制命令
            </BaseButton>
          </div>
          <pre class="max-h-56 overflow-auto rounded-lg bg-slate-900 px-4 py-3 text-xs leading-6 text-slate-100"><code>{{ created.command || '—' }}</code></pre>
        </div>
        <dl class="grid grid-cols-1 gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt class="text-xs text-slate-400">请求 ID</dt>
            <dd class="mt-0.5 font-mono text-xs text-slate-700">{{ created.id || '—' }}</dd>
          </div>
          <div>
            <dt class="text-xs text-slate-400">有效期至</dt>
            <dd class="mt-0.5 text-slate-700">{{ formatDateTime(created.expires_at) }}</dd>
          </div>
          <div>
            <dt class="text-xs text-slate-400">令牌</dt>
            <dd class="mt-0.5 font-mono text-xs text-slate-700">{{ created.token ? '已生成（仅显示一次）' : '—' }}</dd>
          </div>
        </dl>
      </div>

      <template #footer>
        <template v-if="!created">
          <BaseButton variant="secondary" size="sm" @click="createOpen = false">取消</BaseButton>
          <BaseButton size="sm" :loading="creating" @click="submitCreate">生成命令</BaseButton>
        </template>
        <template v-else>
          <BaseButton variant="secondary" size="sm" @click="createOpen = false">关闭</BaseButton>
          <BaseButton size="sm" @click="created = null">再生成一个</BaseButton>
        </template>
      </template>
    </Modal>

    <!-- 审批详情 -->
    <Modal v-model:open="detailOpen" title="节点注册详情" size="lg">
      <LoadingSkeleton v-if="detailLoading && !detail" variant="block" />
      <ErrorState v-else-if="detailError" :message="detailError" compact @retry="detail && openDetail(detail)" />
      <div v-else-if="detail" class="space-y-4">
        <dl class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <dt class="text-xs text-slate-400">主机名</dt>
            <dd class="mt-0.5 text-sm text-slate-800">{{ detail.hostname || '—' }}</dd>
          </div>
          <div>
            <dt class="text-xs text-slate-400">状态</dt>
            <dd class="mt-0.5"><StatusBadge :status="detail.status" kind="enroll" dot /></dd>
          </div>
          <div>
            <dt class="text-xs text-slate-400">系统 / 架构</dt>
            <dd class="mt-0.5 text-sm text-slate-800">{{ detail.os || '—' }} / {{ detail.arch || '—' }}</dd>
          </div>
          <div>
            <dt class="text-xs text-slate-400">代理版本</dt>
            <dd class="mt-0.5 font-mono text-xs text-slate-700">{{ detail.agent_version || '—' }}</dd>
          </div>
          <div>
            <dt class="text-xs text-slate-400">来源 IP</dt>
            <dd class="mt-0.5 font-mono text-xs text-slate-700">{{ detail.ip || '—' }}</dd>
          </div>
          <div>
            <dt class="text-xs text-slate-400">过期时间</dt>
            <dd class="mt-0.5 text-sm text-slate-800">{{ formatDateTime(detail.expires_at) }}</dd>
          </div>
          <div class="sm:col-span-2">
            <dt class="text-xs text-slate-400">证书指纹</dt>
            <dd class="mt-0.5 flex items-start gap-1.5">
              <code class="break-all text-xs text-slate-700">{{ detail.fingerprint || '—' }}</code>
              <button
                v-if="detail.fingerprint"
                type="button"
                class="shrink-0 text-slate-300 hover:text-slate-500"
                title="复制"
                @click="copy(detail.fingerprint, '证书指纹')"
              >
                <Copy class="h-3 w-3" />
              </button>
            </dd>
          </div>
          <div v-if="detail.client_id">
            <dt class="text-xs text-slate-400">关联节点 ID</dt>
            <dd class="mt-0.5 font-mono text-xs text-slate-700">{{ detail.client_id }}</dd>
          </div>
          <div v-if="detail.approved_at">
            <dt class="text-xs text-slate-400">审批时间</dt>
            <dd class="mt-0.5 text-sm text-slate-800">{{ formatDateTime(detail.approved_at) }}</dd>
          </div>
        </dl>
        <div v-if="detail.csr_pem">
          <p class="mb-1.5 text-sm font-medium text-slate-700">CSR（证书签名请求）</p>
          <pre class="max-h-56 overflow-auto rounded-lg bg-slate-900 px-4 py-3 text-[11px] leading-5 text-slate-200"><code>{{ detail.csr_pem }}</code></pre>
        </div>
      </div>
      <template #footer>
        <BaseButton variant="secondary" size="sm" @click="detailOpen = false">关闭</BaseButton>
        <template v-if="detail?.status === 'pending' && auth.canWrite">
          <BaseButton variant="danger-outline" size="sm" :disabled="busyId === detail.id" @click="reject(detail)">
            拒绝
          </BaseButton>
          <BaseButton variant="success" size="sm" :loading="busyId === detail.id" @click="approve(detail)">
            批准接入
          </BaseButton>
        </template>
      </template>
    </Modal>
  </div>
</template>
