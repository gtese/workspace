<script setup>
defineProps({
  title: { type: String, required: true },
  description: { type: String, default: '' },
})
</script>

<template>
  <div class="mb-5 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
    <div class="min-w-0">
      <h1 class="text-xl font-semibold tracking-tight text-slate-900">{{ title }}</h1>
      <p v-if="description" class="mt-1 text-sm text-slate-500">{{ description }}</p>
    </div>
    <div class="flex shrink-0 flex-wrap items-center gap-2">
      <slot name="actions" />
    </div>
  </div>
</template>
