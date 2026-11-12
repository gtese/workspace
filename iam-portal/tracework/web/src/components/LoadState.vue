<template>
  <div v-if="loading" class="loading"><span class="spinner"></span>加载中…</div>
  <div v-else-if="error" class="card"><div class="empty">
    <div style="color:var(--bad);margin-bottom:8px;">⚠ {{ error }}</div>
    <button class="btn ghost sm" @click="$emit('retry')">重新加载</button>
  </div></div>
  <slot v-else />
</template>

<script setup>
defineProps({
  loading: { type: Boolean, default: false },
  error: { type: String, default: '' },
});
defineEmits(['retry']);
</script>