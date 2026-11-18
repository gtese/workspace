<script setup>
import { AlertTriangle, RotateCw } from 'lucide-vue-next'
import BaseButton from './BaseButton.vue'

defineProps({
  message: { type: String, default: '加载失败' },
  description: { type: String, default: '请检查网络或服务端状态后重试。' },
  retryText: { type: String, default: '重试' },
  compact: { type: Boolean, default: false },
})

defineEmits(['retry'])
</script>

<template>
  <div class="flex flex-col items-center justify-center px-6 text-center" :class="compact ? 'py-8' : 'py-14'">
    <span class="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-red-50 text-red-500">
      <AlertTriangle class="h-6 w-6" />
    </span>
    <p class="text-sm font-medium text-slate-800">{{ message }}</p>
    <p v-if="description" class="mt-1 max-w-md text-sm text-slate-500">{{ description }}</p>
    <BaseButton variant="secondary" size="sm" class="mt-4" @click="$emit('retry')">
      <RotateCw class="h-3.5 w-3.5" />
      {{ retryText }}
    </BaseButton>
    <slot />
  </div>
</template>
