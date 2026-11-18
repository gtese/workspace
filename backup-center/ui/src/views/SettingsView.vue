<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import {
  Activity,
  CheckCircle2,
  ExternalLink,
  Info,
  Mail,
  RefreshCw,
  Save,
  Send,
  Settings2,
  Webhook,
} from 'lucide-vue-next'
import PageHeader from '../components/ui/PageHeader.vue'
import BaseButton from '../components/ui/BaseButton.vue'
import Modal from '../components/ui/Modal.vue'
import LoadingSkeleton from '../components/ui/LoadingSkeleton.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import { useAuthStore } from '../stores/auth.js'
import { api } from '../api/index.js'
import { toast } from '../lib/toast.js'

const auth = useAuthStore()

const activeTab = ref('alerts')

const alertsLoading = ref(true)
const alertsError = ref('')
const savingAlerts = ref(false)
const originalAlerts = ref({})

const smtp = reactive({
  enabled: false,
  host: '',
  port: 587,
  tls: true,
  username: '',
  password: '',
  from: '',
  to: '',
})
const webhook = reactive({
  enabled: false,
  url: '',
  secret: '',
})

const generalLoading = ref(true)
const generalError = ref('')
const general = ref(null)
const health = ref(null)
const healthError = ref(false)

const testOpen = ref(false)
const testing = ref(false)
const testChannel = ref('')
const testResult = ref(null)

const isAdmin = computed(() => auth.isAdmin)

function toStringValue(value) {
  if (value === undefined || value === null) return ''
  if (Array.isArray(value)) return value.join(', ')
  return String(value)
}

function applyAlerts(data) {
  originalAlerts.value = data && typeof data === 'object' ? data : {}
  const smtpData = data?.smtp && typeof data.smtp === 'object' ? data.smtp : {}
  const webhookData = data?.webhook && typeof data.webhook === 'object' ? data.webhook : {}
  smtp.enabled = !!smtpData.enabled
  smtp.host = toStringValue(smtpData.host)
  smtp.port = Number(smtpData.port) || 587
  smtp.tls = smtpData.tls !== false
  smtp.username = toStringValue(smtpData.username)
  smtp.password = ''
  smtp.from = toStringValue(smtpData.from)
  smtp.to = toStringValue(smtpData.to)
  webhook.enabled = !!webhookData.enabled
  webhook.url = toStringValue(webhookData.url)
  webhook.secret = ''
}

async function loadAlerts() {
  alertsLoading.value = true
  alertsError.value = ''
  try {
    const data = await api.settings.getAlerts()
    applyAlerts(data)
  } catch (err) {
    alertsError.value = err?.message || '加载告警配置失败'
  } finally {
    alertsLoading.value = false
  }
}

async function loadGeneral() {
  generalLoading.value = true
  generalError.value = ''
  try {
    general.value = await api.settings.getGeneral()
  } catch (err) {
    generalError.value = err?.message || '加载系统设置失败'
  } finally {
    generalLoading.value = false
  }
}

onMounted(() => {
  loadAlerts()
  loadGeneral()
  api.health
    .get()
    .then((data) => {
      if (data && typeof data === 'object' && data.ok) health.value = data
      else healthError.value = true
    })
    .catch(() => {
      healthError.value = true
    })
})

function toList(value) {
  return String(value || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim())
    .filter(Boolean)
}

async function saveAlerts() {
  if (smtp.enabled && !smtp.host.trim()) {
    toast.error('启用 SMTP 时请填写服务器地址')
    return
  }
  if (webhook.enabled && !webhook.url.trim()) {
    toast.error('启用 Webhook 时请填写回调地址')
    return
  }
  savingAlerts.value = true
  try {
    const payload = {
      ...originalAlerts.value,
      smtp: {
        ...(originalAlerts.value?.smtp || {}),
        enabled: !!smtp.enabled,
        host: smtp.host.trim(),
        port: Number(smtp.port) || 587,
        tls: !!smtp.tls,
        username: smtp.username.trim(),
        from: smtp.from.trim(),
        to: toList(smtp.to),
      },
      webhook: {
        ...(originalAlerts.value?.webhook || {}),
        enabled: !!webhook.enabled,
        url: webhook.url.trim(),
      },
    }
    if (smtp.password) payload.smtp.password = smtp.password
    if (webhook.secret) payload.webhook.secret = webhook.secret
    await api.settings.putAlerts(payload)
    toast.success('告警配置已保存')
    smtp.password = ''
    webhook.secret = ''
    await loadAlerts()
  } finally {
    savingAlerts.value = false
  }
}

async function testAlert(channel) {
  testChannel.value = channel
  testOpen.value = true
  testResult.value = null
  testing.value = true
  try {
    const result = await api.settings.testAlerts({ channel })
    testResult.value = { ok: true, result }
    toast.success('测试告警已发送')
  } catch (err) {
    testResult.value = { ok: false, error: err?.message || '发送失败' }
  } finally {
    testing.value = false
  }
}

const generalEntries = computed(() => {
  const data = general.value
  if (!data || typeof data !== 'object') return []
  return Object.entries(data).map(([key, value]) => ({
    key,
    label: GENERAL_LABELS[key] || key,
    value,
  }))
})

const GENERAL_LABELS = {
  site_name: '站点名称',
  default_repository_id: '默认存储库',
  retention_default: '默认保留策略',
  window_default: '默认备份窗口',
  oidc: 'OIDC / Keycloak 配置',
  version: '版本',
  timezone: '时区',
  base_url: '站点地址',
}

function renderValue(value) {
  if (value === null || value === undefined) return '—'
  if (typeof value === 'object') return JSON.stringify(value, null, 2)
  return String(value)
}

function prettyJson(value) {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
</script>

<template>
  <div>
    <PageHeader title="设置" description="配置告警通知与查看系统级设置">
      <template #actions>
        <BaseButton
          variant="secondary"
          size="sm"
          :loading="activeTab === 'alerts' ? alertsLoading : generalLoading"
          @click="activeTab === 'alerts' ? loadAlerts() : loadGeneral()"
        >
          <RefreshCw class="h-3.5 w-3.5" />
          刷新
        </BaseButton>
      </template>
    </PageHeader>

    <div class="mb-4 flex gap-1.5">
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition"
        :class="activeTab === 'alerts' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50'"
        @click="activeTab = 'alerts'"
      >
        <Mail class="h-4 w-4" />
        告警通知
      </button>
      <button
        type="button"
        class="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-medium transition"
        :class="activeTab === 'general' ? 'bg-slate-900 text-white' : 'bg-white text-slate-600 ring-1 ring-inset ring-slate-200 hover:bg-slate-50'"
        @click="activeTab = 'general'"
      >
        <Settings2 class="h-4 w-4" />
        系统设置
      </button>
    </div>

    <!-- 告警 -->
    <template v-if="activeTab === 'alerts'">
      <LoadingSkeleton v-if="alertsLoading && !alertsError" variant="block" />
      <div v-else-if="alertsError" class="bc-card">
        <ErrorState :message="alertsError" @retry="loadAlerts" />
      </div>

      <div v-else class="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <div class="bc-card">
          <div class="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
            <div class="flex items-center gap-2">
              <Mail class="h-4 w-4 text-slate-400" />
              <h2 class="text-sm font-semibold text-slate-800">SMTP 邮件告警</h2>
            </div>
            <label class="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600">
              <input v-model="smtp.enabled" type="checkbox" class="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
              启用
            </label>
          </div>
          <div class="space-y-4 px-5 py-4">
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
              <div class="sm:col-span-2">
                <label class="bc-label">SMTP 服务器</label>
                <input v-model="smtp.host" class="bc-input font-mono" placeholder="smtp.example.com" :disabled="!smtp.enabled" />
              </div>
              <div>
                <label class="bc-label">端口</label>
                <input v-model.number="smtp.port" type="number" class="bc-input" :disabled="!smtp.enabled" />
              </div>
            </div>
            <label class="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600">
              <input v-model="smtp.tls" type="checkbox" class="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500" :disabled="!smtp.enabled" />
              使用 TLS / STARTTLS
            </label>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div>
                <label class="bc-label">用户名</label>
                <input v-model="smtp.username" class="bc-input" autocomplete="off" :disabled="!smtp.enabled" />
              </div>
              <div>
                <label class="bc-label">密码</label>
                <input
                  v-model="smtp.password"
                  type="password"
                  class="bc-input"
                  placeholder="留空表示不修改"
                  autocomplete="new-password"
                  :disabled="!smtp.enabled"
                />
              </div>
            </div>
            <div>
              <label class="bc-label">发件人</label>
              <input v-model="smtp.from" class="bc-input" placeholder="backup-center@example.com" :disabled="!smtp.enabled" />
            </div>
            <div>
              <label class="bc-label">收件人（逗号分隔）</label>
              <input v-model="smtp.to" class="bc-input" placeholder="ops@example.com, dba@example.com" :disabled="!smtp.enabled" />
            </div>
          </div>
        </div>

        <div class="bc-card">
          <div class="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
            <div class="flex items-center gap-2">
              <Webhook class="h-4 w-4 text-slate-400" />
              <h2 class="text-sm font-semibold text-slate-800">Webhook 告警</h2>
            </div>
            <label class="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600">
              <input v-model="webhook.enabled" type="checkbox" class="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
              启用
            </label>
          </div>
          <div class="space-y-4 px-5 py-4">
            <div>
              <label class="bc-label">回调地址</label>
              <input
                v-model="webhook.url"
                class="bc-input font-mono text-xs"
                placeholder="https://hooks.example.com/backup"
                :disabled="!webhook.enabled"
              />
            </div>
            <div>
              <label class="bc-label">签名密钥</label>
              <input
                v-model="webhook.secret"
                type="password"
                class="bc-input"
                placeholder="留空表示不修改"
                autocomplete="new-password"
                :disabled="!webhook.enabled"
              />
              <p class="mt-1 text-xs text-slate-400">服务端使用该密钥对请求体签名，接收方应校验签名。</p>
            </div>
            <div class="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
              <Info class="mt-0.5 h-3.5 w-3.5 shrink-0" />
              告警配置中的密码与密钥只写不读，保存后再次读取会显示为 ***。
            </div>
          </div>
        </div>
      </div>

      <div v-if="!alertsLoading && !alertsError" class="mt-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3">
        <div class="flex flex-wrap items-center gap-2">
          <BaseButton size="sm" :loading="savingAlerts" :disabled="!isAdmin" @click="saveAlerts">
            <Save class="h-3.5 w-3.5" />
            保存告警配置
          </BaseButton>
          <BaseButton variant="secondary" size="sm" :loading="testing && testChannel === 'smtp'" :disabled="!isAdmin" @click="testAlert('smtp')">
            <Send class="h-3.5 w-3.5" />
            测试 SMTP
          </BaseButton>
          <BaseButton variant="secondary" size="sm" :loading="testing && testChannel === 'webhook'" :disabled="!isAdmin" @click="testAlert('webhook')">
            <Send class="h-3.5 w-3.5" />
            测试 Webhook
          </BaseButton>
        </div>
        <p class="text-xs text-slate-400">
          <template v-if="isAdmin">测试发送使用已保存的配置，请先保存。</template>
          <template v-else>仅管理员可修改告警配置。</template>
        </p>
      </div>
    </template>

    <!-- 系统设置 -->
    <template v-else>
      <LoadingSkeleton v-if="generalLoading" variant="block" />
      <div v-else-if="generalError" class="bc-card">
        <ErrorState :message="generalError" @retry="loadGeneral" />
      </div>
      <div v-else class="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div class="bc-card xl:col-span-2">
          <div class="border-b border-slate-100 px-5 py-3.5">
            <h2 class="text-sm font-semibold text-slate-800">通用设置</h2>
            <p class="text-xs text-slate-400">系统级设置由服务端配置与环境变量管理，页面只读展示</p>
          </div>
          <dl class="divide-y divide-slate-100">
            <div v-for="item in generalEntries" :key="item.key" class="grid grid-cols-1 gap-1 px-5 py-3 sm:grid-cols-3 sm:gap-4">
              <dt class="text-xs text-slate-400">{{ item.label }}</dt>
              <dd class="sm:col-span-2">
                <pre
                  v-if="typeof item.value === 'object' && item.value !== null"
                  class="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-slate-50 px-3 py-2 text-[11px] leading-5 text-slate-600"
                >{{ prettyJson(item.value) }}</pre>
                <span v-else class="break-all font-mono text-xs text-slate-700">{{ renderValue(item.value) }}</span>
              </dd>
            </div>
            <div v-if="!generalEntries.length" class="px-5 py-8 text-center text-sm text-slate-400">
              服务端未返回通用设置。
            </div>
          </dl>
        </div>

        <div class="space-y-4">
          <div class="bc-card">
            <div class="flex items-center gap-2 border-b border-slate-100 px-5 py-3.5">
              <Activity class="h-4 w-4 text-slate-400" />
              <h2 class="text-sm font-semibold text-slate-800">服务健康</h2>
            </div>
            <div class="space-y-3 px-5 py-4 text-sm">
              <div v-if="health" class="flex items-center gap-2 text-emerald-700">
                <CheckCircle2 class="h-4 w-4" />
                服务正常 · v{{ health.version || '1.0' }}
              </div>
              <div v-else-if="healthError" class="text-red-600">无法连接 /healthz 健康检查接口</div>
              <div v-else class="text-slate-400">正在检查…</div>
              <dl v-if="health" class="space-y-2 text-xs">
                <div class="flex justify-between gap-3">
                  <dt class="text-slate-400">数据库</dt>
                  <dd class="font-mono text-slate-700">{{ health.db ?? '—' }}</dd>
                </div>
                <div class="flex justify-between gap-3">
                  <dt class="text-slate-400">rest-server</dt>
                  <dd class="font-mono text-slate-700">{{ health.rest_servers ?? '—' }}</dd>
                </div>
              </dl>
              <a
                v-if="isAdmin"
                href="/api/metrics"
                target="_blank"
                rel="noopener"
                class="inline-flex items-center gap-1 text-xs text-brand-600 hover:underline"
              >
                <ExternalLink class="h-3 w-3" />
                查看 Prometheus 指标
              </a>
            </div>
          </div>

          <div class="bc-card">
            <div class="flex items-center gap-2 border-b border-slate-100 px-5 py-3.5">
              <Info class="h-4 w-4 text-slate-400" />
              <h2 class="text-sm font-semibold text-slate-800">统计与审计</h2>
            </div>
            <div class="space-y-2 px-5 py-4 text-xs leading-5 text-slate-500">
              <p>审计日志同时写入数据库与 <code class="rounded bg-slate-100 px-1">audit.jsonl</code>。</p>
              <p>所有写操作、恢复与下载都会记录操作人、来源 IP 与结果。</p>
              <p>保留策略的 <code class="rounded bg-slate-100 px-1">pinned</code> 快照不会被自动清理。</p>
            </div>
          </div>
        </div>
      </div>
    </template>

    <!-- 测试结果 -->
    <Modal v-model:open="testOpen" title="测试告警发送" :subtitle="testChannel === 'smtp' ? 'SMTP 邮件' : 'Webhook'" size="md">
      <div v-if="testing" class="flex items-center gap-2 py-6 text-sm text-slate-500">
        <Send class="h-4 w-4 animate-pulse text-brand-500" />
        正在发送测试告警…
      </div>
      <div v-else-if="testResult">
        <div
          class="mb-3 rounded-lg px-3 py-2 text-sm"
          :class="testResult.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'"
        >
          {{ testResult.ok ? '测试告警发送请求已完成' : testResult.error }}
        </div>
        <pre v-if="testResult.ok" class="max-h-64 overflow-auto rounded-lg bg-slate-900 px-3 py-2 text-[11px] leading-5 text-slate-200"><code>{{ prettyJson(testResult.result) }}</code></pre>
      </div>
      <template #footer>
        <BaseButton variant="secondary" size="sm" @click="testOpen = false">关闭</BaseButton>
      </template>
    </Modal>
  </div>
</template>
