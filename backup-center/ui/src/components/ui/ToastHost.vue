<script setup>
import { CheckCircle2, AlertCircle, Info, AlertTriangle, X } from 'lucide-vue-next'
import { toastState, removeToast } from '../../lib/toast.js'

const ICONS = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
}

const STYLES = {
  success: 'border-emerald-200 bg-white text-emerald-700',
  error: 'border-red-200 bg-white text-red-700',
  info: 'border-slate-200 bg-white text-slate-700',
  warning: 'border-amber-200 bg-white text-amber-700',
}

const ICON_STYLES = {
  success: 'bg-emerald-50 text-emerald-600',
  error: 'bg-red-50 text-red-600',
  info: 'bg-slate-100 text-slate-600',
  warning: 'bg-amber-50 text-amber-600',
}
</script>

<template>
  <div class="pointer-events-none fixed right-4 top-4 z-[70] flex w-[min(24rem,calc(100vw-2rem))] flex-col gap-2">
    <TransitionGroup
      enter-active-class="transition duration-200 ease-out"
      enter-from-class="translate-y-2 opacity-0"
      enter-to-class="translate-y-0 opacity-100"
      leave-active-class="transition duration-150 ease-in"
      leave-from-class="opacity-100"
      leave-to-class="translate-x-2 opacity-0"
    >
      <div
        v-for="item in toastState.items"
        :key="item.id"
        class="pointer-events-auto flex items-start gap-3 rounded-xl border px-4 py-3 shadow-lg"
        :class="STYLES[item.type] || STYLES.info"
      >
        <span class="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full" :class="ICON_STYLES[item.type] || ICON_STYLES.info">
          <component :is="ICONS[item.type] || Info" class="h-4 w-4" />
        </span>
        <p class="flex-1 whitespace-pre-wrap break-words text-sm leading-5 text-slate-700">{{ item.message }}</p>
        <button type="button" class="shrink-0 rounded p-0.5 text-slate-400 hover:text-slate-600" aria-label="关闭" @click="removeToast(item.id)">
          <X class="h-4 w-4" />
        </button>
      </div>
    </TransitionGroup>
  </div>
</template>
