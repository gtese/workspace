<script setup>
import { Inbox } from 'lucide-vue-next'

defineProps({
  title: { type: String, default: '暂无数据' },
  description: { type: String, default: '' },
  icon: { type: [Object, Function], default: null },
})
</script>

<template>
  <div class="flex flex-col items-center justify-center px-6 py-14 text-center">
    <span class="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-100 text-slate-400">
      <component :is="icon" v-if="icon" class="h-6 w-6" />
      <Inbox v-else class="h-6 w-6" />
    </span>
    <p class="text-sm font-medium text-slate-700">{{ title }}</p>
    <p v-if="description" class="mt-1 max-w-md text-sm text-slate-500">{{ description }}</p>
    <div v-if="$slots.default" class="mt-4">
      <slot />
    </div>
  </div>
</template>
