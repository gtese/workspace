<script setup>
defineProps({
  rows: { type: Number, default: 5 },
  variant: { type: String, default: 'table' },
  cards: { type: Number, default: 4 },
})
</script>

<template>
  <div v-if="variant === 'cards'" class="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
    <div v-for="i in cards" :key="i" class="bc-card animate-pulse p-5">
      <div class="h-3 w-24 rounded bg-slate-200" />
      <div class="mt-4 h-7 w-32 rounded bg-slate-200" />
      <div class="mt-3 h-3 w-40 rounded bg-slate-100" />
    </div>
  </div>

  <div v-else-if="variant === 'block'" class="animate-pulse space-y-3">
    <div class="h-5 w-48 rounded bg-slate-200" />
    <div class="h-40 w-full rounded-xl bg-slate-200/70" />
    <div class="h-4 w-64 rounded bg-slate-100" />
  </div>

  <div v-else class="animate-pulse overflow-hidden rounded-xl border border-slate-200 bg-white">
    <div class="flex items-center gap-6 border-b border-slate-100 bg-slate-50 px-4 py-3">
      <div v-for="i in 5" :key="i" class="h-3 w-20 rounded bg-slate-200" />
    </div>
    <div v-for="i in rows" :key="i" class="flex items-center gap-6 border-b border-slate-100 px-4 py-4 last:border-0">
      <div class="h-3.5 w-32 rounded bg-slate-100" />
      <div class="h-3.5 w-24 rounded bg-slate-100" />
      <div class="h-3.5 w-28 rounded bg-slate-100" />
      <div class="h-3.5 w-20 rounded bg-slate-100" />
      <div class="ml-auto h-6 w-16 rounded-full bg-slate-100" />
    </div>
  </div>
</template>
