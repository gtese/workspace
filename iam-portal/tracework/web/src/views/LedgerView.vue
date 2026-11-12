<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">备查台账</div>
        <div class="page-desc">
          15 类研发备查台账，覆盖人员、物料、资产、委外、资本化等稽查关注点，含自动校验。
        </div>
      </div>
      <div class="controls">
        <div class="field">
          <label>归属月份</label>
          <select v-model="period" @change="onPeriodChange">
            <option value="">不限定</option>
            <option v-for="p in periods" :key="p" :value="p">{{ periodLabel(p) }}</option>
          </select>
        </div>
      </div>
    </div>

    <LoadState :loading="loading" :error="error" @retry="load">
      <template v-if="catalog.length">
        <!-- 台账切换 -->
        <div class="card">
          <div class="card-h">
            <div class="card-t">台账类型</div>
            <div class="card-s">{{ catalog.length }} 类</div>
          </div>
          <div class="card-b">
            <div style="display:flex;flex-wrap:wrap;gap:8px;">
              <button v-for="l in catalog" :key="l.key"
                      class="btn sm" :class="active === l.key ? 'pri' : 'ghost'"
                      style="position:relative;" @click="selectLedger(l.key)">
                {{ l.name }}
                <span v-if="l.count" style="margin-left:4px;background:rgba(255,255,255,.28);border-radius:20px;padding:0 6px;font-size:11px;">
                  {{ l.count }}
                </span>
              </button>
            </div>
          </div>
        </div>

        <!-- 当前台账 -->
        <LoadState :loading="detailLoading" :error="detailError" @retry="selectLedger(active)">
          <template v-if="detail">
            <div class="hint">{{ detail.desc }}</div>
            <div class="hint warn" style="margin-top:-6px;">
              <b>核查要点：</b>{{ detail.note }}
            </div>

            <div class="card">
              <div class="card-h">
                <div class="card-t">{{ detail.name }}</div>
                <div class="card-s">{{ detail.rows.length }} 条记录</div>
              </div>
              <BulkBar v-if="editable" :count="lsel.count" :total="rowIds.length"
                       :all-selected="lsel.allSelected"
                       @select-all="lsel.selectAll()" @clear="lsel.clear()">
                <button class="btn bad sm" :disabled="!lsel.count || busy" @click="bulkDelete">
                  批量删除（{{ lsel.count }}）
                </button>
              </BulkBar>
              <div class="card-b flush">
                <div class="tbl-wrap">
                  <table style="min-width:1200px;">
                    <thead>
                      <tr>
                        <th class="center" style="width:40px;">
                          <SelectAllBox :all-ids="rowIds" :selected="lsel.list"
                                        @toggle-all="lsel.toggleAll()" />
                        </th>
                        <th style="width:44px;">#</th>
                        <th v-for="c in detail.cols" :key="c.k" :style="{ minWidth: (c.w || 120) + 'px' }">
                          {{ c.t }}<span v-if="c.required" style="color:var(--bad);">*</span>
                        </th>
                        <th v-for="(dc, i) in detail.deriveCols" :key="'d' + i"
                            :style="{ minWidth: (dc.w || 110) + 'px', background: '#F0F6FF' }">
                          {{ dc.t }}
                        </th>
                        <th style="width:80px;">操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-if="!detail.rows.length">
                        <td :colspan="detail.cols.length + detail.deriveCols.length + 3"
                            style="text-align:center;color:var(--faint);padding:28px;">
                          还没有记录，点下方「新增一行」开始登记
                        </td>
                      </tr>
                      <tr v-for="(r, i) in detail.rows" :key="r.id"
                          :class="{ 'row-sel': lsel.isSelected(r.id) }">
                        <td class="center">
                          <input type="checkbox" :checked="lsel.isSelected(r.id)"
                                 @change="lsel.setChecked(r.id, $event.target.checked)" />
                        </td>
                        <td class="num">{{ i + 1 }}</td>
                        <td v-for="c in detail.cols" :key="c.k">
                          <select v-if="c.type === 'select'" v-model="r.fields[c.k]"
                                  :disabled="!editable" @change="markDirty(r.id)">
                            <option value="">—</option>
                            <option v-for="o in c.opts" :key="o" :value="o">{{ o }}</option>
                          </select>
                          <input v-else-if="c.type === 'date'" v-model="r.fields[c.k]" type="date"
                                 :disabled="!editable" @change="markDirty(r.id)">
                          <input v-else-if="c.type === 'num'" v-model="r.fields[c.k]" type="number" step="0.01"
                                 :disabled="!editable" @change="markDirty(r.id)">
                          <input v-else v-model="r.fields[c.k]" :disabled="!editable" @change="markDirty(r.id)">
                        </td>
                        <td v-for="(dc, j) in detail.deriveCols" :key="'d' + j"
                            style="background:#FAFCFF;">
                          <span :class="deriveClass(r.derived[j])">{{ r.derived[j] }}</span>
                        </td>
                        <td class="center">
                          <button class="btn ghost sm" :disabled="!editable || saving === r.id"
                                  @click="saveRow(r)">{{ saving === r.id ? '…' : '保存' }}</button>
                          <button class="btn bad sm" style="margin-left:4px;" :disabled="!editable"
                                  @click="delRow(r)">删</button>
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div class="card-b" style="border-top:1px solid var(--line);">
                <div class="btn-row">
                  <button class="btn pri" :disabled="!editable || busy" @click="addRow">＋ 新增一行</button>
                  <button class="btn ghost" :disabled="!dirtyCount || !editable || busy"
                          @click="saveAll">
                    保存全部修改{{ dirtyCount ? `（${dirtyCount}）` : '' }}
                  </button>
                  <button class="btn ghost" @click="selectLedger(active)">放弃修改</button>
                </div>
                <div v-if="!editable" style="font-size:12px;color:var(--warn);margin-top:8px;">
                  您当前没有维护台账的权限（仅财务/HR/管理员可维护），以下为只读视图。
                </div>
              </div>
            </div>

            <!-- 校验提示 -->
            <div v-if="allIssues.length" class="card">
              <div class="card-h">
                <div class="card-t">校验提示</div>
                <div class="card-s">{{ allIssues.length }} 项</div>
              </div>
              <div class="card-b flush">
                <div class="tbl-wrap">
                  <table>
                    <thead><tr><th style="width:10%;">行</th><th style="width:14%;">级别</th><th>说明</th></tr></thead>
                    <tbody>
                      <tr v-for="(it, i) in allIssues" :key="i">
                        <td class="num">第 {{ it.row }} 行</td>
                        <td>
                          <span class="chip" :class="it.level === 'error' ? 'bad' : (it.level === 'warn' ? 'warn' : 'info')">
                            <span class="dot"></span>{{ { error: '错误', warn: '警告', info: '提示' }[it.level] }}
                          </span>
                        </td>
                        <td style="font-size:12.5px;">{{ it.msg }}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          </template>
        </LoadState>
      </template>
    </LoadState>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { costingApi } from '../api.js';
import { useAppStore } from '../store.js';
import LoadState from '../components/LoadState.vue';
import SelectAllBox from '../components/SelectAllBox.vue';
import BulkBar from '../components/BulkBar.vue';
import { useSelection } from '../composables/useSelection.js';
import { periodLabel, recentPeriods } from '../utils.js';

const store = useAppStore();
const periods = recentPeriods();
const period = ref('');
const catalog = ref([]);
const active = ref('');
const detail = ref(null);
const loading = ref(false), error = ref('');
const detailLoading = ref(false), detailError = ref('');
const saving = ref(null);
const busy = ref(false);
const dirty = ref(new Set());

const editable = computed(() => store.permissions.canHr || store.permissions.canFinance);
const rowIds = computed(() => (detail.value?.rows ?? []).map((r) => r.id));
const lsel = useSelection(() => rowIds.value);

/** 批量删除台账行。 */
async function bulkDelete() {
  const ids = lsel.list.value;
  if (!ids.length) return;
  if (!confirm(`确认删除选中的 ${ids.length} 行记录？删除后不可恢复。`)) return;
  busy.value = true;
  try {
    const r = await costingApi.bulkDeleteLedgerRows(active.value, ids);
    window.__toast?.(`已删除 ${r.deleted} 行`, 'ok');
    lsel.clear();
    await selectLedger(active.value);
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { busy.value = false; }
}
const dirtyCount = computed(() => dirty.value.size);

const allIssues = computed(() => {
  const out = [];
  (detail.value?.rows ?? []).forEach((r, i) => {
    for (const it of (r.issues ?? [])) out.push({ ...it, row: i + 1 });
  });
  return out;
});

function deriveClass(v) {
  if (typeof v !== 'string') return '';
  if (v.startsWith('符合') || v.startsWith('是（') || v === '是') return 'ok-badge';
  if (v.includes('不得') || v.includes('不宜')) return 'bad-badge';
  if (v.includes('待')) return 'warn-badge';
  return '';
}

function markDirty(id) { dirty.value = new Set([...dirty.value, id]); }

async function load() {
  loading.value = true; error.value = '';
  try {
    const r = await costingApi.ledgers(period.value || undefined);
    catalog.value = r.catalog;
    if (!active.value && catalog.value.length) active.value = catalog.value[0].key;
    if (active.value) await selectLedger(active.value);
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}

async function selectLedger(key) {
  active.value = key;
  detailLoading.value = true; detailError.value = '';
  dirty.value = new Set();
  try {
    detail.value = await costingApi.ledger(key, period.value || undefined);
  } catch (e) { detailError.value = e.message; detail.value = null; }
  finally { detailLoading.value = false; }
}

function onPeriodChange() { if (active.value) selectLedger(active.value); }

async function addRow() {
  busy.value = true;
  try {
    const r = await costingApi.addLedgerRow(active.value, detail.value.blank, period.value || undefined);
    await selectLedger(active.value);
    window.__toast?.('已新增一行，请填写后保存', 'ok');
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { busy.value = false; }
}

async function saveRow(r) {
  saving.value = r.id;
  try {
    const res = await costingApi.updateLedgerRow(active.value, r.id, r.fields);
    r.derived = res.row.derived;
    r.issues = res.row.issues ?? [];
    dirty.value = new Set([...dirty.value].filter((x) => x !== r.id));
    const warns = (r.issues ?? []).filter((i) => i.level !== 'error');
    if (warns.length) window.__toast?.(warns.map((w) => w.msg).join('；'), '');
    else window.__toast?.('已保存', 'ok');
    const cat = catalog.value.find((c) => c.key === active.value);
    if (cat) cat.count = detail.value.rows.length;
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { saving.value = null; }
}

async function saveAll() {
  busy.value = true;
  try {
    const targets = detail.value.rows.filter((r) => dirty.value.has(r.id));
    for (const r of targets) {
      // eslint-disable-next-line no-await-in-loop
      const res = await costingApi.updateLedgerRow(active.value, r.id, r.fields);
      r.derived = res.row.derived;
      r.issues = res.row.issues ?? [];
    }
    dirty.value = new Set();
    window.__toast?.(`已保存 ${targets.length} 行`, 'ok');
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { busy.value = false; }
}

async function delRow(r) {
  if (!confirm('确认删除该行记录？')) return;
  try {
    await costingApi.deleteLedgerRow(active.value, r.id);
    window.__toast?.('已删除', 'ok');
    await selectLedger(active.value);
  } catch (e) { window.__toast?.(e.message, 'err'); }
}

onMounted(load);
</script>

<style scoped>
tr.row-sel { background: var(--primary-soft) !important; }
</style>