<template>
  <!--
    表头全选框。
    indeterminate 状态表示「部分选中」，这对用户判断当前选择范围很关键 ——
    只有全选/未选两态时，用户很容易误以为已经全选。
  -->
  <input
    ref="box"
    type="checkbox"
    :checked="allSelected"
    :indeterminate.prop="someSelected && !allSelected"
    :disabled="disabled || !total"
    :title="allSelected ? `取消全选（共 ${total} 行）` : `全选（共 ${total} 行）`"
    @change="$emit('toggle-all')"
  />
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';

const props = defineProps({
  /** 全部可见行的 id 数组 */
  allIds: { type: Array, default: () => [] },
  /** 当前已选中的 id 数组 */
  selected: { type: Array, default: () => [] },
  disabled: { type: Boolean, default: false },
});
defineEmits(['toggle-all']);

const box = ref(null);
const total = computed(() => props.allIds.length);
const selectedSet = computed(() => new Set(props.selected));
const allSelected = computed(() =>
  total.value > 0 && props.allIds.every((id) => selectedSet.value.has(id)));
const someSelected = computed(() =>
  total.value > 0 && props.allIds.some((id) => selectedSet.value.has(id)));

function sync() {
  if (box.value) box.value.indeterminate = someSelected.value && !allSelected.value;
}
watch([allSelected, someSelected], sync, { flush: 'post' });
onMounted(sync);
</script>