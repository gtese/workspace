<script setup>
import { computed, onMounted, reactive, ref } from 'vue'
import { AlertTriangle, RotateCcw } from 'lucide-vue-next'
import Modal from './ui/Modal.vue'
import BaseButton from './ui/BaseButton.vue'
import { api } from '../api/index.js'
import { toast } from '../lib/toast.js'
import { splitLines } from '../lib/format.js'
import { useAuthStore } from '../stores/auth.js'

const props = defineProps({
  clientId: { type: String, required: true },
  repositoryId: { type: String, default: '' },
  snapshotId: { type: String, required: true },
  includes: { type: Array, default: () => [] },
  snapshotLabel: { type: String, default: '' },
})

const emit = defineEmits(['close', 'submitted'])
const auth = useAuthStore()
const isAdmin = computed(() => auth.user?.role === 'admin')

const includesText = ref(props.includes.join('\n'))
const inPlace = ref(true)
const target = ref('/tmp/restore')
const overwrite = ref('if-changed')
const dryRun = ref(false)
const submitting = ref(false)
const errors = reactive({})

const includes = computed(() => splitLines(includesText.value))

onMounted(() => {
  if (!isAdmin.value) {
    inPlace.value = false
    if (target.value === '/') target.value = '/tmp/restore'
  }
})

function validate() {
  for (const key of Object.keys(errors)) delete errors[key]
  if (!includes.value.length) errors.includes = '请至少填写一个恢复路径'
  if (!includes.value.every((path) => path.startsWith('/'))) {
    errors.includes = '恢复路径必须是绝对路径（以 / 开头）'
  }
  if (!inPlace.value || !isAdmin.value) {
    const value = target.value.trim()
    if (!value.startsWith('/')) errors.target = '目标路径必须是绝对路径'
    if (value.includes('..')) errors.target = '目标路径不允许包含 ..'
    const normalized = value.replace(/\/\.(?=\/|$)/g, '').replace(/\/+$/, '') || '/'
    if (!isAdmin.value && normalized === '/') {
      errors.target = '原地恢复到原始路径仅管理员可操作，请使用其他目标路径'
    }
  }
  return Object.keys(errors).length === 0
}

async function submit() {
  if (!validate()) {
    toast.error('请检查恢复表单')
    return
  }
  submitting.value = true
  try {
    const result = await api.snapshots.restore(props.clientId, props.snapshotId, {
      repository_id: props.repositoryId || undefined,
      includes: includes.value,
      target: (inPlace.value && isAdmin.value) ? '/' : target.value.trim(),
      overwrite: overwrite.value,
      dry_run: !!dryRun.value,
    })
    toast.success(dryRun.value ? '干跑恢复任务已提交' : '恢复任务已提交')
    emit('submitted', result?.restore || result)
  } finally {
    submitting.value = false
  }
}
</script>

<template>
  <Modal :open="true" title="恢复快照文件" :subtitle="snapshotLabel" size="lg" :z-index="60" @close="emit('close')">
    <div class="space-y-5">
      <div class="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2.5 text-xs leading-5 text-amber-800">
        <AlertTriangle class="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          恢复操作会通过代理在目标节点执行。选择「总是覆盖」可能覆盖目标路径下的现有文件，建议先使用干跑确认恢复内容。
        </span>
      </div>

      <div>
        <label class="bc-label">恢复路径（每行一个，来自快照的绝对路径）</label>
        <textarea v-model="includesText" rows="4" class="bc-input font-mono text-xs leading-6" placeholder="/home/docs/a.txt" />
        <p class="mt-1 text-xs text-slate-400">可填写快照内任意文件或目录路径；恢复时会按目标路径还原原目录结构。</p>
        <p v-if="errors.includes" class="mt-1 text-xs text-red-600">{{ errors.includes }}</p>
      </div>

      <div class="space-y-3 rounded-xl border border-slate-200 px-4 py-3">
        <label class="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input v-model="inPlace" type="checkbox" :disabled="!isAdmin" class="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500 disabled:cursor-not-allowed disabled:opacity-50" />
          原地恢复（还原到快照中的原始路径，仅管理员）
        </label>
        <p v-if="!isAdmin" class="text-xs text-amber-600">操作员只能恢复到其他目标路径（如 /tmp/restore），不能原地覆盖原始路径。</p>
        <div v-if="!inPlace">
          <label class="bc-label">目标路径</label>
          <input v-model="target" class="bc-input font-mono" placeholder="/" />
          <p class="mt-1 text-xs text-slate-400">文件会恢复到「目标路径 + 原始路径」下，例如 /tmp/restore/home/docs。</p>
          <p v-if="errors.target" class="mt-1 text-xs text-red-600">{{ errors.target }}</p>
        </div>
        <div>
          <label class="bc-label">覆盖策略</label>
          <select v-model="overwrite" class="bc-input">
            <option value="if-changed">仅内容变化时覆盖（推荐）</option>
            <option value="always">总是覆盖</option>
            <option value="never">从不覆盖（保留现有文件）</option>
          </select>
        </div>
        <label class="inline-flex cursor-pointer items-center gap-2 text-sm text-slate-700">
          <input v-model="dryRun" type="checkbox" class="h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500" />
          干跑（--dry-run，仅演练不写入）
        </label>
      </div>

      <div class="rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
        恢复任务提交后可在「恢复任务」页面查看实时进度与日志。恢复过程会校验文件完整性（--verify）。
      </div>
    </div>

    <template #footer>
      <BaseButton variant="secondary" size="sm" @click="emit('close')">取消</BaseButton>
      <BaseButton size="sm" :loading="submitting" @click="submit">
        <RotateCcw class="h-3.5 w-3.5" />
        {{ dryRun ? '提交干跑恢复' : '提交恢复任务' }}
      </BaseButton>
    </template>
  </Modal>
</template>
