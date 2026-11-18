<script setup>
import ToastHost from './components/ui/ToastHost.vue'
import ConfirmDialog from './components/ui/ConfirmDialog.vue'
</script>

<template>
  <router-view />
  <ToastHost />
  <ConfirmDialog />
</template>
