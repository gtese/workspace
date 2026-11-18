<script setup>
import { RouterLink } from 'vue-router'
import { Compass, Home } from 'lucide-vue-next'
</script>

<template>
  <div class="flex min-h-[60vh] flex-col items-center justify-center text-center">
    <span class="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-slate-200/70 text-slate-500">
      <Compass class="h-8 w-8" />
    </span>
    <p class="text-4xl font-semibold tracking-tight text-slate-800">404</p>
    <p class="mt-2 text-sm text-slate-500">页面不存在或已被移除。</p>
    <RouterLink
      :to="{ name: 'dashboard' }"
      class="mt-5 inline-flex items-center gap-1.5 rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-brand-700"
    >
      <Home class="h-4 w-4" />
      返回概览
    </RouterLink>
  </div>
</template>
