/**
 * 表格多选逻辑的复用钩子。
 *
 * 统一处理：单选/多选切换、全选、反选、清空、以及「当前可见行」与
 * 「已选行」之间的同步（例如筛选后已选中的行不在列表里时仍保留选择）。
 */
import { ref, computed } from 'vue';

export function useSelection(getIds) {
  const selected = ref(new Set());

  const ids = computed(() => getIds() ?? []);
  const count = computed(() => selected.value.size);
  const allIds = computed(() => ids.value);
  const allSelected = computed(() =>
    allIds.value.length > 0 && allIds.value.every((id) => selected.value.has(id)));

  const list = computed(() => [...selected.value]);

  function isSelected(id) { return selected.value.has(id); }

  function toggle(id) {
    const next = new Set(selected.value);
    if (next.has(id)) next.delete(id); else next.add(id);
    selected.value = next;
  }

  function toggleAll() {
    const next = new Set(selected.value);
    const every = allIds.value.every((id) => next.has(id));
    if (every) for (const id of allIds.value) next.delete(id);
    else for (const id of allIds.value) next.add(id);
    selected.value = next;
  }

  function selectAll() {
    selected.value = new Set([...selected.value, ...allIds.value]);
  }

  function clear() { selected.value = new Set(); }

  /** 同步单个勾选框（配合 v-model 用）。 */
  function setChecked(id, checked) {
    const next = new Set(selected.value);
    if (checked) next.add(id); else next.delete(id);
    selected.value = next;
  }

  /** 移除已不存在的选中项（数据刷新后调用）。 */
  function prune(validIds) {
    const valid = new Set(validIds);
    const next = new Set([...selected.value].filter((id) => valid.has(id)));
    if (next.size !== selected.value.size) selected.value = next;
  }

  return {
    selected, list, count, allIds, allSelected,
    isSelected, toggle, toggleAll, selectAll, clear, setChecked, prune,
  };
}