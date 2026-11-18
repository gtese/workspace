<script setup>
import { computed, onBeforeUnmount, onMounted, watch } from 'vue'
import { X } from 'lucide-vue-next'

const props = defineProps({
  open: { type: Boolean, default: false },
  title: { type: String, default: '' },
  subtitle: { type: String, default: '' },
  size: { type: String, default: 'md' },
  closable: { type: Boolean, default: true },
  closeOnOverlay: { type: Boolean, default: true },
  zIndex: { type: Number, default: 50 },
})

const emit = defineEmits(['update:open', 'close'])

const WIDTHS = {
  sm: 'max-w-md',
  md: 'max-w-xl',
  lg: 'max-w-3xl',
  xl: 'max-w-5xl',
  full: 'max-w-7xl',
}

const widthClass = computed(() => WIDTHS[props.size] || WIDTHS.md)

function close() {
  emit('update:open', false)
  emit('close')
}

function onOverlayClick() {
  if (props.closeOnOverlay) close()
}

function onKeydown(e) {
  if (e.key === 'Escape' && props.open) close()
}

let previousOverflow = ''

watch(
  () => props.open,
  (open) => {
    if (typeof document === 'undefined') return
    if (open) {
      previousOverflow = document.body.style.overflow
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = previousOverflow || ''
    }
  },
)

onMounted(() => document.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  document.body.style.overflow = ''
})
</script>

<template>
  <Teleport to="body">
    <Transition name="fade">
      <div v-if="open" class="fixed inset-0 overflow-y-auto" :style="{ zIndex }" role="dialog" aria-modal="true">
        <div class="fixed inset-0 bg-slate-900/50 backdrop-blur-[1px]" @click="onOverlayClick" />
        <div class="relative z-10 flex min-h-full items-start justify-center p-4 sm:p-6">
          <div
            class="my-4 w-full overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-slate-900/10 sm:my-8"
            :class="widthClass"
          >
            <div
              v-if="title || $slots.header || closable"
              class="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4"
            >
              <div class="min-w-0">
                <slot name="header">
                  <h3 class="truncate text-base font-semibold text-slate-900">{{ title }}</h3>
                  <p v-if="subtitle" class="mt-0.5 text-sm text-slate-500">{{ subtitle }}</p>
                </slot>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <slot name="header-actions" />
                <button
                  v-if="closable"
                  type="button"
                  class="rounded-lg p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  aria-label="关闭"
                  @click="close"
                >
                  <X class="h-5 w-5" />
                </button>
              </div>
            </div>

            <div class="max-h-[calc(100vh-14rem)] overflow-y-auto px-5 py-4">
              <slot />
            </div>

            <div v-if="$slots.footer" class="flex items-center justify-end gap-2 border-t border-slate-200 bg-slate-50 px-5 py-3">
              <slot name="footer" />
            </div>
          </div>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>
