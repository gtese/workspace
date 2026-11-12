<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">科技人员管理</div>
        <div class="page-desc">
          维护研发人员名册、科技人员认定与薪酬，供高企认定与研发费用分摊使用。
        </div>
      </div>
      <div class="controls">
        <button class="btn ghost" @click="exportRoster">导出名册 CSV</button>
      </div>
    </div>

    <LoadState :loading="loading" :error="error" @retry="load">
      <template v-if="users.length">
        <div class="kpis">
          <div class="kpi pri">
            <div class="kpi-label">在职人员</div>
            <div class="kpi-value">{{ users.length }}</div>
            <div class="kpi-note">人</div>
          </div>
          <div class="kpi ok">
            <div class="kpi-label">科技人员</div>
            <div class="kpi-value">{{ techCount }}</div>
            <div class="kpi-note">占比 {{ techRatio }}%（需 ≥ 10%）</div>
          </div>
          <div class="kpi" :class="techRatio >= 10 ? 'ok' : 'bad'">
            <div class="kpi-label">高企人员指标</div>
            <div class="kpi-value">{{ techRatio >= 10 ? '达标' : '未达标' }}</div>
            <div class="kpi-note">科技人员占比 ≥ 10%</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">已设薪酬</div>
            <div class="kpi-value">{{ withSalary }}</div>
            <div class="kpi-note">人（用于人工费用归集）</div>
          </div>
        </div>

        <div class="hint">
          科技人员指<b>直接从事研发和相关技术创新活动</b>，以及专门从事上述活动的管理和
          直接提供技术服务的、累计实际工作时间在 183 天以上的人员。
          非全时研发人员当期研发工时占比不得低于 <b>50%</b>；劳务派遣人员原则上不得认定。
        </div>

        <div class="card">
          <div class="card-h">
            <div class="card-t">研发人员名册</div>
            <div class="card-s">{{ users.length }} 人 · 点击「编辑」维护认定信息</div>
          </div>
          <BulkBar :count="sel.count" :total="users.length" :all-selected="sel.allSelected"
                   @select-all="sel.selectAll()" @clear="sel.clear()">
            <button class="btn ok sm" :disabled="!sel.count || busy" @click="bulkPatch({ is_tech_staff: true })">
              批量认定为科技人员
            </button>
            <button class="btn ghost sm" :disabled="!sel.count || busy" @click="bulkPatch({ is_tech_staff: false })">
              取消认定
            </button>
            <select class="bulk-select" :value="''" :disabled="!sel.count || busy"
                    @change="onBulkEmployeeType($event)">
              <option value="" disabled>批量设置研发类型…</option>
              <option value="fulltime_rnd">专职研发</option>
              <option value="parttime_rnd">兼职研发</option>
              <option value="support">研发支持</option>
              <option value="intern">实习生</option>
              <option value="external">外部人员</option>
            </select>
          </BulkBar>
          <div class="card-b flush">
            <div class="tbl-wrap">
              <table style="min-width:1200px;">
                <thead>
                  <tr>
                    <th class="center" style="width:44px;">
                      <SelectAllBox :all-ids="allUserIds" :selected="sel.list"
                                    @toggle-all="sel.toggleAll()" />
                    </th>
                    <th style="width:8%;">工号</th>
                    <th style="width:9%;">姓名</th>
                    <th style="width:10%;">部门</th>
                    <th style="width:11%;">岗位</th>
                    <th class="center" style="width:7%;">学历</th>
                    <th style="width:10%;">专业</th>
                    <th class="center" style="width:8%;">聘用形式</th>
                    <th class="center" style="width:9%;">科技人员</th>
                    <th class="money" style="width:10%;">月薪(元)</th>
                    <th class="center" style="width:8%;">认定</th>
                    <th class="center" style="width:10%;">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="u in users" :key="u.id" :class="{ 'row-sel': sel.isSelected(u.id) }">
                    <td class="center">
                      <input type="checkbox" :checked="sel.isSelected(u.id)"
                             @change="sel.setChecked(u.id, $event.target.checked)" />
                    </td>
                    <td class="num">{{ u.employeeNo || '—' }}</td>
                    <td>{{ u.displayName }}</td>
                    <td style="font-size:12px;">{{ u.department || '—' }}</td>
                    <td style="font-size:12px;">{{ u.post || u.title || '—' }}</td>
                    <td class="center">{{ u.education || '—' }}</td>
                    <td style="font-size:12px;">{{ u.major || '—' }}</td>
                    <td class="center">
                      <span class="chip" :class="u.employeeType === 'parttime_rnd' ? 'warn' : 'gray'">
                        {{ typeLabel(u.employeeType) }}
                      </span>
                    </td>
                    <td class="center">
                      <span class="chip" :class="u.isTechStaff ? 'ok' : 'gray'">
                        <span class="dot"></span>{{ u.isTechStaff ? '是' : '否' }}
                      </span>
                    </td>
                    <td class="money num">{{ fmtMoney(u.monthlySalary) }}</td>
                    <td class="center">
                      <span class="chip" :class="u.isTechStaff ? 'ok' : 'bad'">
                        {{ u.isTechStaff ? '可认定' : '未认定' }}
                      </span>
                    </td>
                    <td class="center">
                      <button class="btn ghost sm" @click="edit(u)">编辑</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </template>
    </LoadState>

    <Modal v-if="editing" :title="`编辑 · ${editing.displayName}`" width="600px" @close="editing = null">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-row">
          <label>工号</label>
          <input v-model.trim="form.employee_no" class="input" placeholder="如 E1001">
        </div>
        <div class="form-row">
          <label>岗位</label>
          <input v-model.trim="form.post" class="input" placeholder="如 算法工程师">
        </div>
      </div>
      <div class="form-row">
        <label>主要研发职责</label>
        <input v-model.trim="form.rd_duty" class="input" placeholder="如 视觉算法设计与训练">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-row">
          <label>学历</label>
          <select v-model="form.education" class="input">
            <option value="">—</option>
            <option>博士</option><option>硕士</option><option>本科</option><option>专科</option><option>其他</option>
          </select>
        </div>
        <div class="form-row">
          <label>专业</label>
          <input v-model.trim="form.major" class="input" placeholder="如 计算机科学与技术">
        </div>
      </div>
      <div class="form-row">
        <label>研发类型</label>
        <select v-model="form.employee_type" class="input">
          <option value="fulltime_rnd">专职研发</option>
          <option value="parttime_rnd">兼职研发（承担部分管理职能）</option>
          <option value="support">研发支持</option>
          <option value="intern">实习生</option>
          <option value="external">外部人员</option>
        </select>
      </div>
      <div class="form-row">
        <label>月薪 / 职工薪酬总额（元）—— 用于人工费用归集</label>
        <input v-model.number="form.monthly_salary" class="input" type="number" step="100">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-row">
          <label>入职 / 合作起始</label>
          <input v-model="form.join_date" class="input" type="date">
        </div>
        <div class="form-row">
          <label>佐证材料</label>
          <input v-model.trim="form.certify_note" class="input" placeholder="如 劳动合同、社保、职称证书">
        </div>
      </div>
      <div class="form-row" style="display:flex;gap:20px;align-items:center;">
        <label style="margin:0;display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink);">
          <input v-model="form.is_tech_staff" type="checkbox"> 认定为科技人员
        </label>
        <label style="margin:0;display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink);">
          <input v-model="form.is_rd_staff" type="checkbox"> 计入研发人员名册
        </label>
      </div>
      <template #footer>
        <button class="btn ghost" @click="editing = null">取消</button>
        <button class="btn pri" :disabled="busy" @click="save">保存</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import LoadState from '../components/LoadState.vue';
import Modal from '../components/Modal.vue';
import SelectAllBox from '../components/SelectAllBox.vue';
import BulkBar from '../components/BulkBar.vue';
import { useSelection } from '../composables/useSelection.js';
import { fmtMoney, downloadCsv, EMPLOYEE_TYPE_LABEL } from '../utils.js';

const users = ref([]);
const loading = ref(false);
const error = ref('');
const busy = ref(false);
const editing = ref(null);
const form = ref({});

const typeLabel = (t) => EMPLOYEE_TYPE_LABEL[t] ?? t;
const allUserIds = computed(() => users.value.map((u) => u.id));
const sel = useSelection(() => allUserIds.value);

/** 批量更新选中人员的指定字段。 */
async function bulkPatch(patch) {
  const ids = sel.list.value;
  if (!ids.length) return;
  const label = Object.keys(patch).includes('is_tech_staff')
    ? (patch.is_tech_staff ? '认定为科技人员' : '取消科技人员认定')
    : '批量设置';
  if (!confirm(`确认将 ${ids.length} 位人员${label}？`)) return;
  busy.value = true;
  try {
    const r = await api.bulkUpdateUsers(ids, patch);
    window.__toast?.(`已更新 ${r.updated} 人${r.failed?.length ? `，失败 ${r.failed.length} 人` : ''}`, 'ok');
    sel.clear();
    await load();
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { busy.value = false; }
}

function onBulkEmployeeType(ev) {
  const v = ev.target.value;
  ev.target.value = '';
  if (v) bulkPatch({ employee_type: v });
}
const techCount = computed(() => users.value.filter((u) => u.isTechStaff).length);
const withSalary = computed(() => users.value.filter((u) => Number(u.monthlySalary) > 0).length);
const techRatio = computed(() =>
  users.value.length ? ((techCount.value / users.value.length) * 100).toFixed(2) : '0.00');

async function load() {
  loading.value = true; error.value = '';
  try {
    const r = await api.users({});
    users.value = r.rows;
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}

function edit(u) {
  editing.value = u;
  form.value = {
    employee_no: u.employeeNo ?? '', post: u.post ?? '', rd_duty: u.rdDuty ?? '',
    education: u.education ?? '', major: u.major ?? '', employee_type: u.employeeType ?? 'fulltime_rnd',
    monthly_salary: u.monthlySalary ?? 0, join_date: u.joinDate ?? '',
    certify_note: u.certifyNote ?? '',
    is_tech_staff: Boolean(u.isTechStaff), is_rd_staff: u.isRdStaff !== false,
  };
}

async function save() {
  busy.value = true;
  try {
    const p = { ...form.value };
    if (p.employee_no === '') p.employee_no = null;
    if (p.join_date === '') p.join_date = null;
    await api.updateUser(editing.value.id, p);
    window.__toast?.('已保存', 'ok');
    editing.value = null;
    await load();
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { busy.value = false; }
}

function exportRoster() {
  const rows = [
    ['研发人员名册'],
    [],
    ['工号', '姓名', '部门', '岗位', '主要研发职责', '学历', '专业', '聘用形式', '科技人员', '月薪(元)'],
    ...users.value.map((u) => [
      u.employeeNo || '', u.displayName, u.department || '', u.post || u.title || '',
      u.rdDuty || '', u.education || '', u.major || '', typeLabel(u.employeeType),
      u.isTechStaff ? '是' : '否', u.monthlySalary ?? 0,
    ]),
  ];
  downloadCsv(`研发人员名册.csv`, rows);
  window.__toast?.('已导出', 'ok');
}

onMounted(load);
</script>

<style scoped>
tr.row-sel { background: var(--primary-soft) !important; }
.bulk-select {
  height: 30px; padding: 0 8px; border: 1px solid var(--line2); border-radius: 7px;
  font-size: 13px; background: #fff; color: var(--ink); font-family: inherit;
}
</style>