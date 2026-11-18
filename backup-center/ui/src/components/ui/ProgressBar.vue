<script setup>
import { computed } from 'vue'

const props = defineProps({
  value: { type: Number, default: 0 },
  status: { type: String, default: 'running' },
  showLabel: { type: Boolean, default: true },
  height: { type: String, default: 'h-2' },
})

const percent = computed(() => Math.min(100, Math.max(0, Number(props.value) || 0)))

const color = computed(() => {
  const s = String(props.status || '').toLowerCase()
  if (s === 'failed' || s === 'error') return 'bg-red-500'
  if (s === 'success') return 'bg-emerald-500'
  if (s === 'canceled' || s === 'cancelled' || s === 'skipped') return 'bg-amber-500'
  return 'bg-brand-500'
})
</script>

<template>
  <div class="flex items-center gap-3">
    <div class="relative flex-1 overflow-hidden rounded-full bg-slate-200" :class="height">
      <div class="h-full rounded-full transition-all duration-500" :class="color" :style="{ width: `${percent}%` }" />
    </div>
    <span v-if="showLabel" class="w-12 shrink-0 text-right text-xs font-medium tabular-nums text-slate-600">
      {{ percent.toFixed(0) }}%
    </span>
  </div>
</template>
