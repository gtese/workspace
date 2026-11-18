<script setup>
import { computed } from 'vue'
import { statusMeta } from '../../lib/format.js'

const props = defineProps({
  status: { type: String, default: '' },
  kind: { type: String, default: 'generic' },
  label: { type: String, default: '' },
  dot: { type: Boolean, default: false },
})

const meta = computed(() => statusMeta(props.status, props.kind))
</script>

<template>
  <span
    class="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset"
    :class="meta.class"
  >
    <span v-if="dot" class="h-1.5 w-1.5 rounded-full bg-current" />
    {{ label || meta.label }}
  </span>
</template>
