<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">IT 资产</div>
        <div class="page-desc">
          {{ canAdmin ? '登记与管理公司 IT 资产，使用人挂接 AD 账号，支持借用归还与导出。'
                      : '查看您名下的 IT 资产。' }}
        </div>
      </div>
      <div class="controls">
        <button class="btn ghost" @click="exportCsv">导出 CSV</button>
        <button v-if="canAdmin" class="btn pri" @click="openNew">＋ 新增资产</button>
      </div>
    </div>

    <LoadState :loading="loading" :error="error" @retry="load">
      <template v-if="stats">
        <!-- 概览 -->
        <div class="kpis">
          <div class="kpi pri">
            <div class="kpi-label">资产总数</div>
            <div class="kpi-value">{{ stats.total }}</div>
            <div class="kpi-note">{{ stats.type_count }} 种设备类型</div>
          </div>
          <div class="kpi ok">
            <div class="kpi-label">在用</div>
            <div class="kpi-value">{{ stats.in_use }}</div>
            <div class="kpi-note">已分配给人员</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">在库</div>
            <div class="kpi-value">{{ stats.in_stock }}</div>
            <div class="kpi-note">未分配</div>
          </div>
          <div class="kpi" :class="stats.lent > 0 ? 'warn' : ''">
            <div class="kpi-label">外借</div>
            <div class="kpi-value">{{ stats.lent }}</div>
            <div class="kpi-note">外部人员借用</div>
          </div>
        </div>

        <!-- 类型分布 -->
        <div class="card">
          <div class="card-h"><div class="card-t">设备类型分布</div></div>
          <div class="card-b">
            <div style="display:flex;flex-wrap:wrap;gap:10px;">
              <button v-for="t in stats.byType" :key="t.type"
                      class="btn sm" :class="filterType === t.type ? 'pri' : 'ghost'"
                      @click="toggleType(t.type)">
                {{ t.type }} <span style="opacity:.75;margin-left:4px;">{{ t.n }}</span>
              </button>
              <button v-if="filterType" class="btn sm ghost" @click="filterType = ''; load()">清除筛选</button>
            </div>
          </div>
        </div>

        <!-- 列表 -->
        <div class="card">
          <div class="card-h">
            <div class="card-t">资产清单</div>
            <div class="card-s">{{ rows.length }} 条</div>
          </div>

          <div class="card-b" style="border-bottom:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap;">
            <div class="field" style="flex:1;min-width:220px;">
              <label>搜索</label>
              <input v-model.trim="keyword" placeholder="资产编号 / SN / 型号 / 使用人"
                     style="width:100%;" @input="debouncedLoad" />
            </div>
            <div class="field">
              <label>状态</label>
              <select v-model="filterStatus" @change="load">
                <option value="">全部</option>
                <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
              </select>
            </div>
            <div v-if="canAdmin" class="field" style="align-self:center;">
              <label style="display:flex;gap:6px;align-items:center;cursor:pointer;">
                <input v-model="unassignedOnly" type="checkbox" @change="load" />
                仅看未分配
              </label>
            </div>
          </div>

          <BulkBar v-if="canAdmin" :count="sel.count" :total="rows.length" :all-selected="sel.allSelected"
                   @select-all="sel.selectAll()" @clear="sel.clear()">
            <select class="bulk-select" :value="''" :disabled="!sel.count"
                    @change="onBulkStatus($event)">
              <option value="" disabled>批量设置状态…</option>
              <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
            </select>
            <button class="btn bad sm" :disabled="!sel.count" @click="bulkDelete">批量删除（{{ sel.count }}）</button>
          </BulkBar>

          <div class="card-b flush">
            <div v-if="!rows.length" class="empty">
              {{ canAdmin ? '暂无资产，点右上角「新增资产」开始登记' : '您名下暂无 IT 资产' }}
            </div>
            <div v-else class="tbl-wrap">
              <table style="min-width:1340px;">
                <thead>
                  <tr>
                    <th v-if="canAdmin" class="center" style="width:40px;">
                      <SelectAllBox :all-ids="rowIds" :selected="sel.list"
                                    @toggle-all="sel.toggleAll()" />
                    </th>
                    <th style="width:13%;">资产编号</th>
                    <th style="width:8%;">类型</th>
                    <th style="width:15%;">品牌型号</th>
                    <th style="width:11%;">序列号</th>
                    <th style="width:15%;">使用人 / 借用方</th>
                    <th class="center" style="width:8%;">状态</th>
                    <th style="width:9%;">存放位置</th>
                    <th class="center" style="width:9%;">金额(元)</th>
                    <th class="center" style="width:9%;">月折旧(元)</th>
                    <th class="center" style="width:9%;">领用日期</th>
                    <th class="center" style="width:12%;">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="a in rows" :key="a.id" :class="{ 'row-sel': sel.isSelected(a.id) }">
                    <td v-if="canAdmin" class="center">
                      <input type="checkbox" :checked="sel.isSelected(a.id)"
                             @change="sel.setChecked(a.id, $event.target.checked)" />
                    </td>
                    <td class="num" style="font-size:12px;">
                      {{ a.asset_no }}
                      <div v-if="a.finance_no" style="color:var(--faint);font-size:11px;">{{ a.finance_no }}</div>
                    </td>
                    <td><span class="chip gray">{{ a.device_type }}</span></td>
                    <td>
                      <div>{{ a.brand }}</div>
                      <div style="color:var(--sub);font-size:12px;">{{ a.model }}</div>
                    </td>
                    <td class="num" style="font-size:12px;">{{ a.sn || '—' }}</td>
                    <td>
                      <template v-if="a.holder_name">
                        <div>{{ a.holder_name }}</div>
                        <div style="color:var(--primary);font-size:11px;">{{ a.holder_account }}</div>
                      </template>
                      <template v-else-if="a.borrower_external">
                        <div>{{ a.borrower_external }}</div>
                        <div style="color:var(--warn);font-size:11px;">外部借用</div>
                      </template>
                      <span v-else style="color:var(--faint);font-size:12px;">未分配</span>
                    </td>
                    <td class="center">
                      <span class="chip" :class="statusClass(a.status)">{{ a.status }}</span>
                    </td>
                    <td style="font-size:12px;">{{ a.location || '—' }}</td>
                    <td class="center num" style="font-size:12.5px;">
                      {{ a.amount != null ? Number(a.amount).toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—' }}
                    </td>
                    <td class="center num" style="font-size:12.5px;color:var(--sub);">
                      {{ depOf(a) }}
                    </td>
                    <td class="center num" style="font-size:12px;">{{ a.assign_date || '—' }}</td>
                    <td class="center">
                      <button v-if="canAdmin" class="btn ghost sm" @click="openEdit(a)">编辑</button>
                      <button v-if="canAdmin && (a.holder_id || a.borrower_external)"
                              class="btn ghost sm" style="margin-left:4px;" @click="doReturn(a)">归还</button>
                      <button v-if="!canAdmin" class="btn ghost sm" @click="openDetail(a)">查看</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </template>
    </LoadState>

    <!-- 编辑弹窗 -->
    <Modal v-if="form" :title="form.id ? `编辑资产 · ${form.asset_no}` : '新增资产'" width="680px" @close="form = null">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-row">
          <label>资产编号 *</label>
          <input v-model.trim="form.asset_no" class="input" placeholder="Tri-Asset-IT0xx">
        </div>
        <div class="form-row">
          <label>财务资产编号</label>
          <input v-model.trim="form.finance_no" class="input" placeholder="CS-02-00xx">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-row">
          <label>设备类型</label>
          <select v-model="form.device_type" class="input">
            <option v-for="t in deviceTypes" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>
        <div class="form-row">
          <label>状态</label>
          <select v-model="form.status" class="input">
            <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
          </select>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-row">
          <label>品牌</label>
          <input v-model.trim="form.brand" class="input" placeholder="如 苹果 / 联想">
        </div>
        <div class="form-row">
          <label>型号</label>
          <input v-model.trim="form.model" class="input" placeholder="如 MacbookAir 16G">
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-row">
          <label>序列号 (SN)</label>
          <input v-model.trim="form.sn" class="input">
        </div>
        <div class="form-row">
          <label>存放位置</label>
          <input v-model.trim="form.location" class="input" placeholder="办公室 / 数讯机房 / 第三方">
        </div>
      </div>

      <!-- 使用人：AD 账号挂接 -->
      <div class="form-row">
        <label>
          使用人（挂接 AD 账号）
          <span v-if="form.holder_account" class="chip pri" style="margin-left:6px;">
            {{ form.holder_name }} · {{ form.holder_account }}
          </span>
          <span v-else-if="form.borrower_external" class="chip warn" style="margin-left:6px;">
            外部借用：{{ form.borrower_external }}
          </span>
          <span v-else class="chip gray" style="margin-left:6px;">未分配</span>
        </label>

        <div style="display:flex;gap:8px;align-items:center;">
          <input v-model.trim="holderQuery" class="input" style="flex:1;"
                 placeholder="输入 AD 账号或姓名搜索，如 liusen / 刘森"
                 @input="debouncedSearchUsers" @focus="searchUsers" />
          <button type="button" class="btn ghost" :disabled="!form.holder_account"
                  @click="clearHolder">清除使用人</button>
        </div>

        <div v-if="holderCandidates.length" class="cand-list">
          <button v-for="u in holderCandidates" :key="u.id" type="button" class="cand"
                  @click="pickHolder(u)">
            <b>{{ u.displayName }}</b>
            <span>{{ u.username }}</span>
            <span v-if="u.department">{{ u.department }}</span>
          </button>
        </div>

        <div style="margin-top:8px;display:flex;gap:8px;align-items:center;">
          <span style="font-size:12px;color:var(--sub);">或登记外部借用：</span>
          <input v-model.trim="form.borrower_external" class="input" style="flex:1;"
                 placeholder="外部人员姓名（无 AD 账号）" @input="onExternalInput" />
        </div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;">
        <div class="form-row">
          <label>购买日期</label>
          <input v-model="form.purchase_date" class="input" type="date">
        </div>
        <div class="form-row">
          <label>领用日期</label>
          <input v-model="form.assign_date" class="input" type="date">
        </div>
        <div class="form-row">
          <label>资产金额（元）</label>
          <input v-model.number="form.amount" class="input" type="number" min="0" step="0.01"
                 placeholder="默认 10000">
        </div>
        <div class="form-row">
          <label>折旧年限（月）</label>
          <input v-model.number="form.depreciation_months" class="input" type="number" min="1" step="1"
                 placeholder="默认 36">
        </div>
      </div>
      <div v-if="form.amount > 0" class="hint" style="margin-top:-6px;">
        月折旧额 = {{ form.amount }} ÷ {{ form.depreciation_months || 36 }} =
        <b>{{ (form.amount / (form.depreciation_months || 36)).toFixed(2) }} 元/月</b>
        <span style="color:var(--faint);margin-left:8px;">
          （{{ ((form.amount / (form.depreciation_months || 36)) * 12).toFixed(2) }} 元/年）
        </span>
      </div>
      <div class="form-row">
        <label>供应商</label>
        <input v-model.trim="form.supplier" class="input" placeholder="如 上海伊维撒科技有限公司">
      </div>
      <div class="form-row">
        <label>备注</label>
        <input v-model.trim="form.note" class="input">
      </div>

      <template #footer>
        <button class="btn ghost" @click="form = null">取消</button>
        <button class="btn pri" :disabled="busy || !form.asset_no" @click="save">
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </template>
    </Modal>

    <!-- 详情（员工只读） -->
    <Modal v-if="detail" :title="`资产详情 · ${detail.asset.asset_no}`" width="680px" @close="detail = null">
      <div class="detail-grid">
        <div><span>设备类型</span><b>{{ detail.asset.device_type }}</b></div>
        <div><span>品牌型号</span><b>{{ detail.asset.brand }} {{ detail.asset.model }}</b></div>
        <div><span>序列号</span><b>{{ detail.asset.sn || '—' }}</b></div>
        <div><span>状态</span><b>{{ detail.asset.status }}</b></div>
        <div><span>存放位置</span><b>{{ detail.asset.location || '—' }}</b></div>
        <div><span>领用日期</span><b>{{ detail.asset.assign_date || '—' }}</b></div>
      </div>
      <div class="modal-sub">借用记录</div>
      <table class="mini-tbl">
        <thead><tr><th>借用人</th><th>借出时间</th><th>归还时间</th></tr></thead>
        <tbody>
          <tr v-for="x in detail.assignments" :key="x.id">
            <td>{{ x.holder_name || x.holder_external }}</td>
            <td class="num">{{ x.assigned_at_fmt }}</td>
            <td class="num">{{ x.returned_at_fmt || '未归还' }}</td>
          </tr>
        </tbody>
      </table>
      <template #footer>
        <button class="btn ghost" @click="detail = null">关闭</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { assetApi } from '../api.js';
import LoadState from '../components/LoadState.vue';
import Modal from '../components/Modal.vue';
import SelectAllBox from '../components/SelectAllBox.vue';
import BulkBar from '../components/BulkBar.vue';
import { useSelection } from '../composables/useSelection.js';

const rows = ref([]);
const stats = ref(null);
const loading = ref(false);
const error = ref('');
const busy = ref(false);
const canAdmin = ref(false);
const statuses = ref([]);
const deviceTypes = ref([]);

const keyword = ref('');
const filterStatus = ref('');
const filterType = ref('');
const unassignedOnly = ref(false);

const form = ref(null);
const detail = ref(null);
const holderQuery = ref('');
const holderCandidates = ref([]);

const rowIds = computed(() => rows.value.map((a) => a.id));
const sel = useSelection(() => rowIds.value);

function depOf(a) {
  const amt = Number(a.amount) || 0;
  const m = Number(a.depreciation_months) || 36;
  if (amt <= 0 || m <= 0) return '—';
  return (amt / m).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function statusClass(s) {
  return { 在用: 'ok', 在库: 'gray', 外借: 'warn', 维修: 'warn', 报废: 'bad', 调拨: 'info' }[s] ?? 'gray';
}

async function load() {
  loading.value = true; error.value = '';
  try {
    const [list, st, meta] = await Promise.all([
      assetApi.list({
        q: keyword.value || undefined,
        status: filterStatus.value || undefined,
        type: filterType.value || undefined,
        unassigned: unassignedOnly.value ? '1' : undefined,
      }),
      assetApi.stats(),
      assetApi.meta(),
    ]);
    rows.value = list.rows;
    canAdmin.value = list.canAdmin;
    stats.value = st;
    statuses.value = meta.statuses;
    deviceTypes.value = meta.deviceTypes;
    sel.clear();
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}

let debounceTimer;
function debouncedLoad() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(load, 350);
}
function debouncedSearchUsers() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(searchUsers, 300);
}
onUnmounted(() => clearTimeout(debounceTimer));

function toggleType(t) {
  filterType.value = filterType.value === t ? '' : t;
  load();
}

function openNew() {
  form.value = { asset_no: '', finance_no: '', device_type: '笔记本', brand: '', model: '',
    sn: '', location: '办公室', supplier: '', purchase_date: '', assign_date: '',
    note: '', amount: 10000, depreciation_months: 36, status: '在库', holder_account: '', holder_name: '', borrower_external: '' };
  holderQuery.value = '';
  holderCandidates.value = [];
}

function openEdit(a) {
  form.value = {
    id: a.id, asset_no: a.asset_no, finance_no: a.finance_no ?? '',
    device_type: a.device_type, brand: a.brand, model: a.model, sn: a.sn ?? '',
    location: a.location, supplier: a.supplier,
    purchase_date: a.purchase_date ?? '', assign_date: a.assign_date ?? '',
    note: a.note, amount: a.amount ?? 10000, depreciation_months: a.depreciation_months ?? 36, status: a.status,
    holder_account: a.holder_account ?? '', holder_name: a.holder_name ?? '',
    borrower_external: a.borrower_external ?? '',
  };
  holderQuery.value = a.holder_name ? `${a.holder_name} (${a.holder_account})` : '';
  holderCandidates.value = [];
}

async function searchUsers() {
  const q = holderQuery.value.trim();
  if (!q) { holderCandidates.value = []; return; }
  try {
    const r = await assetApi.searchUsers(q);
    holderCandidates.value = r.rows;
  } catch { holderCandidates.value = []; }
}

function pickHolder(u) {
  form.value.holder_account = u.username;
  form.value.holder_name = u.displayName;
  form.value.borrower_external = '';
  holderQuery.value = `${u.displayName} (${u.username})`;
  holderCandidates.value = [];
}

function clearHolder() {
  form.value.holder_account = '';
  form.value.holder_name = '';
  form.value.borrower_external = '';   // 同时清空外部借用方，避免两者冲突
  holderQuery.value = '';
  holderCandidates.value = [];
}

function onExternalInput() {
  if (form.value.borrower_external) {
    form.value.holder_account = '';
    form.value.holder_name = '';
    holderQuery.value = '';
  }
}

async function save() {
  busy.value = true;
  try {
    const f = { ...form.value };
    delete f.holder_name;
    const r = f.id ? await assetApi.update(f.id, f) : await assetApi.create(f);
    if (r?.warnings?.length) window.__toast?.(r.warnings.join('；'), '');
    else window.__toast?.('已保存', 'ok');
    form.value = null;
    await load();
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { busy.value = false; }
}

async function doReturn(a) {
  const who = a.holder_name || a.borrower_external;
  if (!confirm(`确认「${who}」归还 ${a.asset_no}？归还后状态将变为「在库」。`)) return;
  try {
    await assetApi.returnAsset(a.id, '');
    window.__toast?.('已归还', 'ok');
    await load();
  } catch (e) { window.__toast?.(e.message, 'err'); }
}

async function onBulkStatus(ev) {
  const status = ev.target.value;
  ev.target.value = '';
  if (!status || !sel.count.value) return;
  if (!confirm(`确认将选中的 ${sel.count.value} 件资产状态改为「${status}」？`)) return;
  try {
    const r = await assetApi.bulkStatus(sel.list.value, status);
    window.__toast?.(`已更新 ${r.updated} 件`, 'ok');
    await load();
  } catch (e) { window.__toast?.(e.message, 'err'); }
}

async function bulkDelete() {
  if (!sel.count.value) return;
  if (!confirm(`确认删除选中的 ${sel.count.value} 件资产？删除后借用记录一并清除，不可恢复。`)) return;
  try {
    const r = await assetApi.bulkDelete(sel.list.value);
    window.__toast?.(`已删除 ${r.deleted} 件`, 'ok');
    await load();
  } catch (e) { window.__toast?.(e.message, 'err'); }
}

async function openDetail(a) {
  try {
    const r = await assetApi.get(a.id);
    detail.value = r;
  } catch (e) { window.__toast?.(e.message, 'err'); }
}

function exportCsv() {
  const qs = new URLSearchParams();
  if (keyword.value) qs.set('q', keyword.value);
  if (filterStatus.value) qs.set('status', filterStatus.value);
  if (filterType.value) qs.set('type', filterType.value);
  if (unassignedOnly.value) qs.set('unassigned', '1');
  const s = qs.toString();
  const a = document.createElement('a');
  a.href = `/api/assets/export${s ? '?' + s : ''}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.__toast?.('已开始导出', 'ok');
}

onMounted(load);
</script>

<style scoped>
tr.row-sel { background: var(--primary-soft) !important; }
.bulk-select {
  height: 30px; padding: 0 8px; border: 1px solid var(--line2); border-radius: 7px;
  font-size: 13px; background: #fff; color: var(--ink); font-family: inherit;
}
.cand-list {
  border: 1px solid var(--line2); border-radius: 8px; margin-top: 8px;
  max-height: 180px; overflow: auto; background: #fff;
}
.cand {
  display: flex; gap: 10px; align-items: baseline; width: 100%; text-align: left;
  padding: 7px 12px; border: 0; border-bottom: 1px solid #F4F6F9;
  background: transparent; font-size: 13px; color: var(--ink); font-family: inherit; cursor: pointer;
}
.cand:hover { background: var(--primary-soft); }
.cand span { color: var(--sub); font-size: 12px; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px 20px; margin-bottom: 16px; }
.detail-grid > div { display: flex; justify-content: space-between; font-size: 13px; }
.detail-grid span { color: var(--sub); }
.modal-sub { font-size: 13px; font-weight: 700; margin-bottom: 8px; }
.mini-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.mini-tbl th, .mini-tbl td { border: 1px solid var(--line); padding: 6px 8px; text-align: left; }
.mini-tbl th { background: var(--surface-2); }
</style>