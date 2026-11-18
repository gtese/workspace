<script setup>
import { computed } from 'vue'
import { ChevronLeft, ChevronRight } from 'lucide-vue-next'

const props = defineProps({
  page: { type: Number, default: 1 },
  pageSize: { type: Number, default: 20 },
  total: { type: Number, default: null },
  hasNext: { type: Boolean, default: false },
  pageSizes: { type: Array, default: () => [10, 20, 50, 100] },
  disabled: { type: Boolean, default: false },
})

const emit = defineEmits(['update:page', 'update:pageSize'])

const totalPages = computed(() => {
  if (props.total === null || props.total === undefined) return null
  return Math.max(1, Math.ceil(props.total / props.pageSize))
})

const canPrev = computed(() => props.page > 1 && !props.disabled)
const canNext = computed(() => {
  if (props.disabled) return false
  if (totalPages.value !== null) return props.page < totalPages.value
  return props.hasNext
})

const pageItems = computed(() => {
  if (totalPages.value === null || totalPages.value <= 1) return []
  const max = 5
  const total = totalPages.value
  let start = Math.max(1, props.page - Math.floor(max / 2))
  const end = Math.min(total, start + max - 1)
  start = Math.max(1, end - max + 1)
  const items = []
  for (let i = start; i <= end; i += 1) items.push(i)
  return items
})

function go(page) {
  if (props.disabled || page < 1) return
  if (totalPages.value !== null && page > totalPages.value) return
  if (page === props.page) return
  emit('update:page', page)
}

function changeSize(e) {
  emit('update:pageSize', Number(e.target.value))
  emit('update:page', 1)
}
</script>

<template>
  <div class="flex flex-col gap-3 border-t border-slate-100 px-4 py-3 text-sm text-slate-500 sm:flex-row sm:items-center sm:justify-between">
    <div class="flex items-center gap-3">
      <span v-if="total !== null && total !== undefined">共 {{ total.toLocaleString('zh-CN') }} 条</span>
      <span v-else>第 {{ page }} 页</span>
      <span class="hidden text-slate-300 sm:inline">·</span>
      <label class="flex items-center gap-1.5">
        <span class="hidden sm:inline">每页</span>
        <select
          :value="pageSize"
          class="rounded-md border border-slate-300 bg-white px-1.5 py-1 text-xs text-slate-600 outline-none focus:border-brand-500"
          :disabled="disabled"
          @change="changeSize"
        >
          <option v-for="size in pageSizes" :key="size" :value="size">{{ size }}</option>
        </select>
        <span class="hidden sm:inline">条</span>
      </label>
    </div>

    <div class="flex items-center gap-1">
      <button
        type="button"
        class="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="!canPrev"
        @click="go(page - 1)"
      >
        <ChevronLeft class="h-3.5 w-3.5" />
        上一页
      </button>

      <template v-if="totalPages !== null">
        <button
          v-for="item in pageItems"
          :key="item"
          type="button"
          class="h-8 min-w-8 rounded-md border px-2 text-xs transition"
          :class="item === page ? 'border-brand-600 bg-brand-600 text-white' : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'"
          :disabled="disabled"
          @click="go(item)"
        >
          {{ item }}
        </button>
      </template>

      <button
        type="button"
        class="inline-flex h-8 items-center gap-1 rounded-md border border-slate-300 bg-white px-2 text-xs text-slate-600 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
        :disabled="!canNext"
        @click="go(page + 1)"
      >
        下一页
        <ChevronRight class="h-3.5 w-3.5" />
      </button>
    </div>
  </div>
</template>
