<template>
  <div class="modal-mask" @click.self="$emit('close')">
    <div class="modal" :style="{ maxWidth: width }">
      <div class="modal-h">
        <div class="modal-t">{{ title }}</div>
        <button class="x-btn" @click="$emit('close')">×</button>
      </div>
      <div class="modal-b"><slot /></div>
      <div v-if="$slots.footer" class="modal-f"><slot name="footer" /></div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  title: { type: String, default: '' },
  width: { type: String, default: '560px' },
});
defineEmits(['close']);
</script>