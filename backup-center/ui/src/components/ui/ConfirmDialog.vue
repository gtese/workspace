<script setup>
import { AlertTriangle } from 'lucide-vue-next'
import Modal from './Modal.vue'
import BaseButton from './BaseButton.vue'
import { confirmState, resolveConfirm } from '../../lib/confirm.js'
</script>

<template>
  <Modal
    :open="confirmState.open"
    :title="confirmState.title"
    size="sm"
    :close-on-overlay="true"
    :z-index="65"
    @close="resolveConfirm(false)"
  >
    <div class="flex items-start gap-3">
      <span
        class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full"
        :class="confirmState.danger ? 'bg-red-50 text-red-600' : 'bg-amber-50 text-amber-600'"
      >
        <AlertTriangle class="h-5 w-5" />
      </span>
      <div class="min-w-0 flex-1">
        <p class="whitespace-pre-wrap text-sm leading-6 text-slate-700">{{ confirmState.message }}</p>
        <p v-if="confirmState.detail" class="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 px-3 py-2 text-xs leading-5 text-slate-500">
          {{ confirmState.detail }}
        </p>
      </div>
    </div>

    <template #footer>
      <BaseButton variant="secondary" size="sm" @click="resolveConfirm(false)">{{ confirmState.cancelText }}</BaseButton>
      <BaseButton :variant="confirmState.danger ? 'danger' : 'primary'" size="sm" @click="resolveConfirm(true)">
        {{ confirmState.confirmText }}
      </BaseButton>
    </template>
  </Modal>
</template>
