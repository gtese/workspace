<script setup>
import { computed, reactive, ref } from 'vue'
import { ChevronRight, FolderTree, Info, ShieldAlert, Timer } from 'lucide-vue-next'
import Modal from './ui/Modal.vue'
import BaseButton from './ui/BaseButton.vue'
import DirPicker from './DirPicker.vue'
import RepositoryPicker from './RepositoryPicker.vue'
import { useAuthStore } from '../stores/auth.js'
import { api } from '../api/index.js'
import { toast } from '../lib/toast.js'
import { CRON_PRESETS, splitLines, formatDateTime } from '../lib/format.js'

const props = defineProps({
  plan: { type: Object, default: null },
  clients: { type: Array, default: () => [] },
  repositories: { type: Array, default: () => [] },
})

const emit = defineEmits(['close', 'saved'])

const auth = useAuthStore()
const saving = ref(false)
const pickerOpen = ref(false)
const pickerInitial = ref('/')
const repoPickerOpen = ref(false)
const errors = reactive({})

function parseJson(value, fallback) {
  if (value === undefined || value === null) return fallback
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return fallback
  }
}

function initialForm() {
  const plan = props.plan || {}
  const windowValue = parseJson(plan.window ?? plan.window_json, {})
  const retention = parseJson(plan.retention ?? plan.retention_json, {})
  const hooks = parseJson(plan.hooks ?? plan.hooks_json, {})
  const paths = Array.isArray(plan.paths) ? plan.paths : parseJson(plan.paths_json, [])
  const excludes = Array.isArray(plan.excludes) ? plan.excludes : parseJson(plan.excludes_json, [])
  return {
    name: plan.name || '',
    client_id: plan.client_id || '',
    repository_id: plan.repository_id || '',
    pathsText: (Array.isArray(paths) ? paths : []).join('\n'),
    excludesText: (Array.isArray(excludes) ? excludes : []).join('\n'),
    cron: plan.cron || '0 2 * * *',
    windowStart: windowValue.start || '22:00',
    windowEnd: windowValue.end || '06:00',
    skipOutside: windowValue.skip_outside !== false,
    compression: plan.compression || 'auto',
    limit_upload_kib: Number(plan.limit_upload_kib) || 0,
    rpo_hours: Number(plan.rpo_hours ?? 26) || 26,
    keepLast: Number(retention.keep_last ?? 5),
    keepDaily: Number(retention.keep_daily ?? 7),
    keepWeekly: Number(retention.keep_weekly ?? 4),
    keepMonthly: Number(retention.keep_monthly ?? 6),
    keepYearly: Number(retention.keep_yearly ?? 1),
    prune: retention.prune_after_backup !== false,
    preHook: hooks.pre || '',
    postHook: hooks.post || '',
    enabled: plan.enabled !== false && plan.enabled !== 0,
  }
}

const form = reactive(initialForm())

const isEditing = computed(() => !!props.plan?.id)
const paths = computed(() => splitLines(form.pathsText))
const selectedRepo = computed(() => props.repositories.find((r) => r.id === form.repository_id) || null)

const REPO_TYPES = { local: '本地目录', nfs: 'NFS', cifs: 'SMB/CIFS', ftp: 'FTP(S)' }
function repoPath(repo) {
  if (!repo) return ''
  return repo.mountpoint || repo.config?.path || repo.config?.export || repo.config?.share || repo.config?.dir || ''
}
function onRepoPicked(id) {
  form.repository_id = id
  repoPickerOpen.value = false
}
const excludes = computed(() => splitLines(form.excludesText))

function clearErrors() {
  for (const key of Object.keys(errors)) delete errors[key]
}

function validate() {
  clearErrors()
  if (!form.name.trim()) errors.name = '请填写计划名称'
  if (!form.client_id) errors.client_id = '请选择备份节点'
  if (!form.repository_id) errors.repository_id = '请选择存储库'
  if (!paths.value.length) errors.paths = '请至少添加一个备份路径'
  const cronParts = form.cron.trim().split(/\s+/)
  if (cronParts.length !== 5 || !cronParts.every((part) => /^[0-9*/,\-]+$/.test(part))) {
    errors.cron = 'cron 需为 5 段：分 时 日 月 周（如 0 2 * * *）'
  }
  if (!/^\d{2}:\d{2}$/.test(form.windowStart) || !/^\d{2}:\d{2}$/.test(form.windowEnd)) {
    errors.window = '备份窗口时间格式需为 HH:MM'
  }
  if (!(Number(form.rpo_hours) >= 1)) errors.rpo = 'RPO 必须为正整数小时'
  for (const key of ['keepLast', 'keepDaily', 'keepWeekly', 'keepMonthly', 'keepYearly', 'limit_upload_kib']) {
    if (Number(form[key]) < 0 || Number.isNaN(Number(form[key]))) {
      errors.retention = '保留数量与限速必须为非负整数'
      break
    }
  }
  return Object.keys(errors).length === 0
}

function openPicker() {
  if (!form.client_id) {
    toast.error('请先选择备份节点')
    return
  }
  pickerInitial.value = paths.value[0] || '/'
  pickerOpen.value = true
}

function onPick(selectedPaths) {
  const existing = splitLines(form.pathsText)
  for (const path of selectedPaths) {
    if (!existing.includes(path)) existing.push(path)
  }
  form.pathsText = existing.join('\n')
  toast.success(`已添加 ${selectedPaths.length} 个路径`)
}

function applyPreset(preset) {
  form.cron = preset
}

async function save() {
  if (!validate()) {
    toast.error('请检查表单中的必填项')
    return
  }
  saving.value = true
  try {
    const body = {
      name: form.name.trim(),
      client_id: form.client_id,
      repository_id: form.repository_id,
      paths: paths.value,
      excludes: excludes.value,
      cron: form.cron.trim(),
      window: {
        start: form.windowStart,
        end: form.windowEnd,
        skip_outside: !!form.skipOutside,
      },
      compression: form.compression,
      limit_upload_kib: Number(form.limit_upload_kib) || 0,
      rpo_hours: Number(form.rpo_hours) || 26,
      retention: {
        keep_last: Number(form.keepLast) || 0,
        keep_daily: Number(form.keepDaily) || 0,
        keep_weekly: Number(form.keepWeekly) || 0,
        keep_monthly: Number(form.keepMonthly) || 0,
        keep_yearly: Number(form.keepYearly) || 0,
        prune_after_backup: !!form.prune,
      },
      enabled: !!form.enabled,
    }
    if (auth.isAdmin) {
      body.hooks = {
        pre: form.preHook.trim() || null,
        post: form.postHook.trim() || null,
      }
    }

    if (isEditing.value) {
      await api.plans.update(props.plan.id, body)
      toast.success('备份计划已更新')
    } else {
      await api.plans.create(body)
      toast.success('备份计划已创建')
    }
    emit('saved')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <Modal
    :open="true"
    :title="isEditing ? '编辑备份计划' : '新建备份计划'"
    :subtitle="isEditing ? '修改计划配置后保存，下次调度按新配置执行' : '配置节点、备份范围、调度、保留与钩子'"
    size="xl"
    @close="emit('close')"
  >
    <div class="space-y-6">
      <!-- 基本信息 -->
      <section>
        <h3 class="mb-3 text-sm font-semibold text-slate-800">基本信息</h3>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label class="bc-label">计划名称 <span class="text-red-500">*</span></label>
            <input v-model="form.name" class="bc-input" placeholder="例如：每日全量备份" />
            <p v-if="errors.name" class="mt-1 text-xs text-red-600">{{ errors.name }}</p>
          </div>
          <div>
            <label class="bc-label">备份节点 <span class="text-red-500">*</span></label>
            <select v-model="form.client_id" class="bc-input">
              <option value="">请选择节点</option>
              <option v-for="client in clients" :key="client.id" :value="client.id">
                {{ client.hostname }}（{{ client.status === 'disabled' ? '停用' : '在线' }}）
              </option>
            </select>
            <p v-if="errors.client_id" class="mt-1 text-xs text-red-600">{{ errors.client_id }}</p>
          </div>
          <div>
            <label class="bc-label">存储库 / 备份池 <span class="text-red-500">*</span></label>
            <button
              type="button"
              class="flex w-full items-center justify-between gap-3 rounded-lg border border-slate-300 bg-white px-3 py-2 text-left text-sm transition hover:border-brand-400 hover:bg-brand-50/40"
              @click="repoPickerOpen = true"
            >
              <span v-if="selectedRepo" class="min-w-0">
                <span class="flex flex-wrap items-center gap-2">
                  <span class="font-medium text-slate-800">{{ selectedRepo.name }}</span>
                  <span class="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">{{ REPO_TYPES[selectedRepo.type] || selectedRepo.type }}</span>
                </span>
                <span class="mt-0.5 block truncate font-mono text-[11px] text-slate-400">{{ repoPath(selectedRepo) }}</span>
              </span>
              <span v-else class="text-slate-400">点击浏览并选择存储库对象</span>
              <ChevronRight class="h-4 w-4 shrink-0 text-slate-400" />
            </button>
            <p v-if="errors.repository_id" class="mt-1 text-xs text-red-600">{{ errors.repository_id }}</p>
            <p class="mt-1 text-[11px] text-slate-400">以文件浏览器方式列出可用备份池对象，例如 data2-projects。</p>
          </div>
        </div>
      </section>

      <!-- 备份范围 -->
      <section class="border-t border-slate-100 pt-5">
        <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-semibold text-slate-800">备份范围</h3>
          <BaseButton variant="secondary" size="xs" @click="openPicker">
            <FolderTree class="h-3.5 w-3.5" />
            浏览节点目录
          </BaseButton>
        </div>
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <label class="bc-label">备份路径（每行一个） <span class="text-red-500">*</span></label>
            <textarea
              v-model="form.pathsText"
              rows="5"
              class="bc-input font-mono text-xs leading-6"
              placeholder="/home/docs&#10;/data/project"
            />
            <p class="mt-1 text-xs text-slate-400">已配置 {{ paths.length }} 个路径；可用目录选择器多选目录或文件。</p>
            <p v-if="errors.paths" class="mt-1 text-xs text-red-600">{{ errors.paths }}</p>
          </div>
          <div>
            <label class="bc-label">排除规则（glob，每行一个）</label>
            <textarea
              v-model="form.excludesText"
              rows="5"
              class="bc-input font-mono text-xs leading-6"
              placeholder="*.tmp&#10;.cache&#10;node_modules"
            />
            <p class="mt-1 text-xs text-slate-400">已配置 {{ excludes.length }} 条排除规则，支持 restic glob 语法。</p>
          </div>
        </div>
      </section>

      <!-- 调度与窗口 -->
      <section class="border-t border-slate-100 pt-5">
        <h3 class="mb-3 text-sm font-semibold text-slate-800">调度与备份窗口</h3>
        <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label class="bc-label">cron 表达式（时区 Asia/Shanghai）</label>
            <input v-model="form.cron" class="bc-input font-mono" placeholder="0 2 * * *" />
            <div class="mt-1.5 flex flex-wrap gap-1">
              <button
                v-for="preset in CRON_PRESETS"
                :key="preset.value"
                type="button"
                class="rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[11px] text-slate-500 transition hover:border-brand-300 hover:text-brand-600"
                @click="applyPreset(preset.value)"
              >
                {{ preset.label }}
              </button>
            </div>
            <p v-if="errors.cron" class="mt-1 text-xs text-red-600">{{ errors.cron }}</p>
          </div>
          <div>
            <label class="bc-label">备份窗口</label>
            <div class="flex items-center gap-2">
              <input v-model="form.windowStart" type="time" class="bc-input" />
              <span class="text-slate-400">至</span>
              <input v-model="form.windowEnd" type="time" class="bc-input" />
            </div>
            <label class="mt-2 inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600">
              <input
                v-model="form.skipOutside"
                type="checkbox"
                class="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
              />
              窗口外跳过执行
            </label>
            <p v-if="errors.window" class="mt-1 text-xs text-red-600">{{ errors.window }}</p>
          </div>
          <div>
            <label class="bc-label">压缩模式</label>
            <select v-model="form.compression" class="bc-input">
              <option value="auto">自动（zstd，推荐）</option>
              <option value="off">不压缩</option>
              <option value="max">最大压缩</option>
            </select>
          </div>
          <div>
            <label class="bc-label">上传限速（KiB/s，0 为不限）</label>
            <input v-model.number="form.limit_upload_kib" type="number" min="0" class="bc-input" />
          </div>
          <div>
            <label class="bc-label">RPO（小时）</label>
            <input v-model.number="form.rpo_hours" type="number" min="1" max="8760" class="bc-input" />
            <p class="mt-1 text-[11px] text-slate-400">超过该时长没有成功备份会触发 SLA 告警，并在客户端在线时自动补备。</p>
          </div>
        </div>
      </section>

      <!-- 保留策略 -->
      <section class="border-t border-slate-100 pt-5">
        <h3 class="mb-3 text-sm font-semibold text-slate-800">保留策略</h3>
        <div class="grid grid-cols-2 gap-4 sm:grid-cols-5">
          <div>
            <label class="bc-label">保留最近</label>
            <input v-model.number="form.keepLast" type="number" min="0" class="bc-input" />
          </div>
          <div>
            <label class="bc-label">保留每日</label>
            <input v-model.number="form.keepDaily" type="number" min="0" class="bc-input" />
          </div>
          <div>
            <label class="bc-label">保留每周</label>
            <input v-model.number="form.keepWeekly" type="number" min="0" class="bc-input" />
          </div>
          <div>
            <label class="bc-label">保留每月</label>
            <input v-model.number="form.keepMonthly" type="number" min="0" class="bc-input" />
          </div>
          <div>
            <label class="bc-label">保留每年</label>
            <input v-model.number="form.keepYearly" type="number" min="0" class="bc-input" />
          </div>
        </div>
        <label class="mt-3 inline-flex cursor-pointer items-center gap-2 text-xs text-slate-600">
          <input
            v-model="form.prune"
            type="checkbox"
            class="h-3.5 w-3.5 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          备份完成后自动清理旧快照（同一池最多约 6 天执行一次 prune；钉住的快照不会被删除）
        </label>
        <p v-if="errors.retention" class="mt-1 text-xs text-red-600">{{ errors.retention }}</p>
      </section>

      <!-- 钩子 -->
      <section class="border-t border-slate-100 pt-5">
        <div class="mb-3 flex items-center gap-2">
          <h3 class="text-sm font-semibold text-slate-800">pre / post 钩子</h3>
          <span class="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">高风险</span>
        </div>
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div>
            <label class="bc-label">备份前执行（pre）</label>
            <textarea
              v-model="form.preHook"
              rows="3"
              class="bc-input font-mono text-xs"
              placeholder="例如：systemctl stop myapp"
              :disabled="!auth.isAdmin"
            />
          </div>
          <div>
            <label class="bc-label">备份后执行（post）</label>
            <textarea
              v-model="form.postHook"
              rows="3"
              class="bc-input font-mono text-xs"
              placeholder="例如：systemctl start myapp"
              :disabled="!auth.isAdmin"
            />
          </div>
        </div>
        <div class="mt-2 flex items-start gap-2 rounded-lg bg-amber-50 px-3 py-2 text-xs leading-5 text-amber-800">
          <ShieldAlert class="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            钩子会在客户端以 root 身份执行，仅管理员可配置。请确保命令幂等且不会阻塞备份。
            <template v-if="!auth.isAdmin">当前账号无权限修改钩子，保存时不会变更现有配置。</template>
          </span>
        </div>
      </section>

      <section class="flex items-center justify-between border-t border-slate-100 pt-5">
        <label class="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input
            v-model="form.enabled"
            type="checkbox"
            class="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
          />
          启用计划（按 cron 自动调度）
        </label>
        <div v-if="isEditing" class="flex items-center gap-1.5 text-xs text-slate-400">
          <Timer class="h-3.5 w-3.5" />
          <span>上次运行：{{ formatDateTime(props.plan?.last_run_at) }}</span>
        </div>
      </section>

      <div class="flex items-start gap-2 rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
        <Info class="mt-0.5 h-3.5 w-3.5 shrink-0" />
        创建后将按 cron 自动调度；「立即运行」可手动触发一次备份，并可在运行时临时覆盖路径。
      </div>
    </div>

    <template #footer>
      <BaseButton variant="secondary" size="sm" @click="emit('close')">取消</BaseButton>
      <BaseButton size="sm" :loading="saving" @click="save">
        {{ isEditing ? '保存修改' : '创建计划' }}
      </BaseButton>
    </template>

    <DirPicker
      v-model:open="pickerOpen"
      :client-id="form.client_id"
      :initial-path="pickerInitial"
      title="选择要备份的目录或文件"
      @confirm="onPick"
    />

    <RepositoryPicker
      :open="repoPickerOpen"
      :repositories="repositories"
      :selected-id="form.repository_id"
      @close="repoPickerOpen = false"
      @confirm="onRepoPicked"
    />
  </Modal>
</template>
