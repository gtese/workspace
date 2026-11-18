<script setup>
import { computed } from 'vue'
import { Loader2 } from 'lucide-vue-next'

const props = defineProps({
  variant: { type: String, default: 'primary' },
  size: { type: String, default: 'md' },
  type: { type: String, default: 'button' },
  loading: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  block: { type: Boolean, default: false },
})

const VARIANTS = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 focus:ring-brand-500/40',
  secondary: 'border border-slate-300 bg-white text-slate-700 hover:bg-slate-50 focus:ring-slate-400/30',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500/40',
  'danger-outline': 'border border-red-200 bg-white text-red-600 hover:bg-red-50 focus:ring-red-400/30',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700 focus:ring-emerald-500/40',
  ghost: 'text-slate-600 hover:bg-slate-100 focus:ring-slate-400/30',
  link: 'text-brand-600 hover:text-brand-700 hover:underline underline-offset-2 !px-0',
}

const SIZES = {
  xs: 'px-2 py-1 text-xs',
  sm: 'px-2.5 py-1.5 text-xs',
  md: 'px-3.5 py-2 text-sm',
  lg: 'px-4 py-2.5 text-sm',
}

const classes = computed(() => [
  'inline-flex items-center gap-1.5 rounded-lg font-medium transition focus:outline-none focus:ring-2 disabled:cursor-not-allowed disabled:opacity-60',
  VARIANTS[props.variant] || VARIANTS.primary,
  SIZES[props.size] || SIZES.md,
  props.block ? 'w-full justify-center' : '',
])
</script>

<template>
  <button :type="type" :disabled="disabled || loading" :class="classes">
    <Loader2 v-if="loading" class="h-4 w-4 shrink-0 animate-spin" />
    <slot />
  </button>
</template>
