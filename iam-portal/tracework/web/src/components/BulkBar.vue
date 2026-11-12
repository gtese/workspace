<template>
  <!--
    批量操作条：选中若干行后出现在表格上方。
    设计要点：
      · 始终显示「已选 N 项」，让用户随时知道选中范围
      · 提供「全选本页 / 取消选择」，减少来回滚动点选
      · 危险操作（批量删除/批量驳回）用红色按钮并二次确认
  -->
  <div v-if="count > 0" class="bulkbar">
    <span class="bulkbar-info">
      已选 <b>{{ count }}</b> 项
      <span v-if="total && count < total" class="bulkbar-hint">（共 {{ total }} 项）</span>
    </span>

    <span class="bulkbar-sep"></span>

    <button v-if="!allSelected && total" class="btn ghost sm" @click="$emit('select-all')">
      全选本页（{{ total }}）
    </button>
    <button class="btn ghost sm" @click="$emit('clear')">取消选择</button>

    <span class="bulkbar-sep"></span>

    <slot />

    <span style="flex:1"></span>
  </div>
</template>

<script setup>
const props = defineProps({
  count: { type: Number, default: 0 },
  total: { type: Number, default: 0 },
  allSelected: { type: Boolean, default: false },
});
defineEmits(['select-all', 'clear']);
</script>

<style scoped>
.bulkbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 10px 14px;
  background: var(--primary-soft);
  border-bottom: 1px solid var(--line);
  position: sticky;
  top: 0;
  z-index: 2;
}
.bulkbar-info { font-size: 13px; color: var(--primary); }
.bulkbar-info b { font-size: 15px; }
.bulkbar-hint { color: var(--sub); font-weight: 400; }
.bulkbar-sep { width: 1px; height: 18px; background: var(--line2); }
</style>