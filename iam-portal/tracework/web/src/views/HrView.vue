<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">员工管理</div>
        <div class="page-desc">统一维护员工名册、科技人员认定、月度考勤与薪酬，供研发费用归集与高企认定使用。</div>
      </div>
      <div class="controls">
        <div class="field">
          <label>月份</label>
          <select v-model="period" @change="onPeriodChange">
            <option v-for="p in periods" :key="p" :value="p">{{ periodLabel(p) }}</option>
          </select>
        </div>
      </div>
    </div>

    <!-- 页签 -->
    <div class="btn-row" style="margin-bottom:16px;">
      <button class="btn" :class="tab === 'staff' ? 'pri' : 'ghost'" @click="tab = 'staff'; loadStaff()">人员名册</button>
      <button class="btn" :class="tab === 'attendance' ? 'pri' : 'ghost'" @click="tab = 'attendance'">月度考勤与薪酬</button>
      <button class="btn" :class="tab === 'audit' ? 'pri' : 'ghost'" @click="tab = 'audit'; loadAudit()">审计日志</button>
    </div>

    <!-- 人员名册 -->
    <LoadState v-if="tab === 'staff'" :loading="staffLoading" :error="staffError" @retry="loadStaff">

      <template v-if="staffUsers.length">
        <div class="kpis">
          <div class="kpi pri">
            <div class="kpi-label">在职人员</div>
            <div class="kpi-value">{{ staffUsers.length }}</div>
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
            <div class="card-s">{{ staffUsers.length }} 人 · 点击「编辑」维护认定信息</div>
          </div>
          <BulkBar :count="staffSel.count" :total="staffUsers.length" :all-selected="staffSel.allSelected"
                   @select-all="staffSel.selectAll()" @clear="staffSel.clear()">
            <button class="btn ok sm" :disabled="!staffSel.count || staffBusy" @click="bulkPatch({ is_tech_staff: true })">
              批量认定为科技人员
            </button>
            <button class="btn ghost sm" :disabled="!staffSel.count || staffBusy" @click="bulkPatch({ is_tech_staff: false })">
              取消认定
            </button>
            <select class="bulk-select" :value="''" :disabled="!staffSel.count || staffBusy"
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
                      <SelectAllBox :all-ids="allUserIds" :selected="staffSel.list"
                                    @toggle-all="staffSel.toggleAll()" />
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
                  <tr v-for="u in staffUsers" :key="u.id" :class="{ 'row-sel': staffSel.isSelected(u.id) }">
                    <td class="center">
                      <input type="checkbox" :checked="staffSel.isSelected(u.id)"
                             @change="staffSel.setChecked(u.id, $event.target.checked)" />
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
                      <button class="btn ghost sm" @click="editStaff(u)">编辑</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </template>
    
    </LoadState>

    <!-- 考勤 -->
    <LoadState v-if="tab === 'attendance'" :loading="loading" :error="error" @retry="load">
      <div class="card">
        <div class="card-h">
          <div class="card-t">{{ periodLabel(period) }} 考勤与薪酬</div>
          <div class="card-s">
            {{ attendanceRows.length }} 位人员 · 点击「编辑」录入当月考勤工时
          </div>
        </div>
        <BulkBar :count="hrSel.count" :total="attRows.length" :all-selected="hrSel.allSelected"
                 @select-all="hrSel.selectAll()" @clear="hrSel.clear()">
          <button class="btn pri sm" :disabled="!hrSel.count || busy" @click="openBulkAttendance">
            批量录入考勤（{{ hrSel.count }}）
          </button>
        </BulkBar>
        <div class="card-b flush">
          <div v-if="!attRows.length" class="empty">
            本月尚无考勤记录。点上方「批量录入全部人员考勤」可一次为所有人员设置。
          </div>
          <div v-else class="tbl-wrap">
            <table style="min-width:940px;">
              <thead>
                <tr>
                  <th class="center" style="width:44px;">
                    <SelectAllBox :all-ids="hrSelIds" :selected="hrSel.list"
                                  @toggle-all="hrSel.toggleAll()" />
                  </th>
                  <th style="width:12%;">员工编号</th>
                  <th style="width:12%;">姓名</th>
                  <th style="width:16%;">研发类型</th>
                  <th class="center" style="width:14%;">考勤工时(h)</th>
                  <th class="center" style="width:12%;">出勤天数</th>
                  <th class="center" style="width:12%;">来源</th>
                  <th class="money" style="width:12%;">月薪(元)</th>
                  <th class="center" style="width:10%;">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in attRows" :key="r.userId" :class="{ 'row-sel': hrSel.isSelected(r.userId) }">
                  <td class="center">
                    <input type="checkbox" :checked="hrSel.isSelected(r.userId)"
                           @change="hrSel.setChecked(r.userId, $event.target.checked)" />
                  </td>
                  <td class="num">{{ r.employeeNo || '—' }}</td>
                  <td>{{ r.name }}</td>
                  <td style="font-size:12px;color:var(--sub);">{{ typeLabel(r.employeeType) }}</td>
                  <td class="center num">{{ fmtHours(r.hours) }}</td>
                  <td class="center num">{{ fmtHours(r.workdays) }}</td>
                  <td class="center">
                    <span class="chip" :class="r.source === 'none' ? 'warn' : 'gray'">
                      {{ sourceLabel(r.source) }}
                    </span>
                  </td>
                  <td class="money num">{{ fmtMoney(r.salary) }}</td>
                  <td class="center">
                    <button class="btn ghost sm" @click="editAttendance(r)">编辑</button>
                    <button v-if="r.source !== 'none'" class="btn bad sm" style="margin-left:4px;"
                            @click="clearAttendance(r)">清除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="card-b" style="border-top:1px solid var(--line);">
          <div class="btn-row">
            <button class="btn pri" @click="openBatchAttendance">批量录入全部人员考勤</button>
            <button class="btn ghost" @click="load">刷新</button>
          </div>
          <div style="font-size:12px;color:var(--faint);margin-top:10px;">
            考勤工时用于校验报工合计，并作为分摊时的总工时口径。未录入时系统按标准工作日 × 8 小时折算。
          </div>
        </div>
      </div>
    </LoadState>

    <!-- 审计 -->
    <LoadState v-if="tab === 'audit'" :loading="auditLoading" :error="auditError" @retry="loadAudit">
      <div class="card">
        <div class="card-h">
          <div class="card-t">操作审计日志</div>
          <div class="card-s">最近 {{ auditRows.length }} 条</div>
        </div>
        <div class="card-b flush">
          <div v-if="!auditRows.length" class="empty">暂无审计记录</div>
          <div v-else class="tbl-wrap">
            <table style="min-width:820px;">
              <thead>
                <tr>
                  <th style="width:16%;">时间</th>
                  <th style="width:12%;">操作人</th>
                  <th style="width:20%;">动作</th>
                  <th style="width:14%;">对象</th>
                  <th style="width:10%;">月份</th>
                  <th>详情</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="a in auditRows" :key="a.id">
                  <td class="num" style="font-size:12px;">{{ fmtDateTime(a.at) }}</td>
                  <td>{{ a.actor_name }}</td>
                  <td><span class="chip gray">{{ a.action }}</span></td>
                  <td class="num" style="font-size:12px;">{{ a.target || '—' }}</td>
                  <td class="num" style="font-size:12px;">{{ a.period || '—' }}</td>
                  <td style="font-size:12px;color:var(--sub);max-width:340px;overflow:hidden;text-overflow:ellipsis;">
                    {{ JSON.stringify(a.detail) }}
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </LoadState>

    <!-- 考勤编辑 -->
    <Modal v-if="editingAttendance" :title="`录入考勤 · ${editingAttendance.name}`" @close="editingAttendance = null">
      <div class="form-row">
        <label>考勤工时（小时）</label>
        <input v-model.number="attForm.hours" class="input" type="number" min="0" max="400" step="0.5">
      </div>
      <div class="form-row">
        <label>出勤天数</label>
        <input v-model.number="attForm.workdays" class="input" type="number" min="0" max="31" step="0.5">
      </div>
      <template #footer>
        <button class="btn ghost" @click="editingAttendance = null">取消</button>
        <button class="btn pri" :disabled="busy" @click="saveAttendance">保存</button>
      </template>
    </Modal>

    <!-- 批量考勤 -->
    <Modal v-if="batchOpen" title="批量录入考勤" width="640px" @close="batchOpen = false">
      <div style="font-size:13px;color:var(--sub);margin-bottom:12px;">
        为 {{ periodLabel(period) }} 的
        <b style="color:var(--primary);">{{ hrSel.count ? hrSel.count + ' 位已勾选人员' : '全部 ' + attRows.length + ' 位人员' }}</b>
        设置相同考勤工时。
        <span v-if="!hrSel.count" style="color:var(--warn);">（未勾选时默认处理全部人员）</span>
      </div>
      <div class="form-row">
        <label>考勤工时（小时）</label>
        <input v-model.number="batchHours" class="input" type="number" min="0" max="400" step="0.5">
      </div>
      <div class="form-row">
        <label>出勤天数</label>
        <input v-model.number="batchWorkdays" class="input" type="number" min="0" max="31" step="0.5">
        <div style="font-size:11.5px;color:var(--faint);margin-top:4px;">
          当月实际 {{ monthWorkdays }} 个工作日
          <span v-if="batchWorkdays !== monthWorkdays" style="color:var(--warn);">
            ⚠ 已手动改为 {{ batchWorkdays }} 天
          </span>
        </div>
      </div>
      <div style="font-size:12px;color:var(--faint);">
        提示：法定节假日请按实际考勤填写；系统内置节假日日历，工作日数量可在填报页查看。
      </div>
      <template #footer>
        <button class="btn ghost" @click="batchOpen = false">取消</button>
        <button class="btn pri" :disabled="busy" @click="saveBatch">应用到全部人员</button>
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
import {
  fmtHours, fmtMoney, fmtDateTime, periodLabel, currentPeriod, recentPeriods,
  EMPLOYEE_TYPE_LABEL,
} from '../utils.js';


// ================================================================
// 人员名册（原「科技人员管理」，已合并到员工管理）
// ================================================================
const staffLoading = ref(false);
const staffError = ref('');
const staffUsers = ref([]);
const staffBusy = ref(false);
const staffEditing = ref(null);
const staffForm = ref({});

const allUserIds = computed(() => staffUsers.value.map((u) => u.id));
const staffSel = useSelection(() => allUserIds.value);

/** 批量更新选中人员的指定字段。 */
async function bulkPatch(patch) {
  const ids = staffSel.list.value;
  if (!ids.length) return;
  const label = Object.keys(patch).includes('is_tech_staff')
    ? (patch.is_tech_staff ? '认定为科技人员' : '取消科技人员认定')
    : '批量设置';
  if (!confirm(`确认将 ${ids.length} 位人员${label}？`)) return;
  staffBusy.value = true;
  try {
    const r = await api.bulkUpdateUsers(ids, patch);
    window.__toast?.(`已更新 ${r.updated} 人${r.failed?.length ? `，失败 ${r.failed.length} 人` : ''}`, 'ok');
    sel.clear();
    await loadStaff();
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { staffBusy.value = false; }
}

function onBulkEmployeeType(ev) {
  const v = ev.target.value;
  ev.target.value = '';
  if (v) bulkPatch({ employee_type: v });
}
const techCount = computed(() => staffUsers.value.filter((u) => u.isTechStaff).length);
const withSalary = computed(() => staffUsers.value.filter((u) => Number(u.monthlySalary) > 0).length);
const techRatio = computed(() =>
  staffUsers.value.length ? ((techCount.value / staffUsers.value.length) * 100).toFixed(2) : '0.00');

async function loadStaff() {
  staffLoading.value = true; staffError.value = '';
  try {
    const r = await api.users({});
    staffUsers.value = r.rows;
  } catch (e) { staffError.value = e.message; }
  finally { staffLoading.value = false; }
}

function edit(u) {
  staffEditing.value = u;
  staffForm.value = {
    employee_no: u.employeeNo ?? '', post: u.post ?? '', rd_duty: u.rdDuty ?? '',
    education: u.education ?? '', major: u.major ?? '', employee_type: u.employeeType ?? 'fulltime_rnd',
    monthly_salary: u.monthlySalary ?? 0, join_date: u.joinDate ?? '',
    certify_note: u.certifyNote ?? '',
    is_tech_staff: Boolean(u.isTechStaff), is_rd_staff: u.isRdStaff !== false,
  };
}

async function save() {
  staffBusy.value = true;
  try {
    const p = { ...staffForm.value };
    if (p.employee_no === '') p.employee_no = null;
    if (p.join_date === '') p.join_date = null;
    await api.updateUser(staffEditing.value.id, p);
    window.__toast?.('已保存', 'ok');
    staffEditing.value = null;
    await loadStaff();
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { staffBusy.value = false; }
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

const periods = recentPeriods();
const period = ref(currentPeriod());
const tab = ref('staff');   // 默认进入人员名册
const busy = ref(false);

const attendanceRows = ref([]);
// 表格行 = 全部人员（含未录入考勤者）
const attRows = computed(() => attendanceRows.value);
const hrSelIds = computed(() => attRows.value.map((r) => r.userId));
const hrSel = useSelection(() => hrSelIds.value);
const loading = ref(false);
const error = ref('');
const editingAttendance = ref(null);
const attForm = ref({ hours: 176, workdays: 22 });
// 当月实际工作日与标准考勤工时（按日历动态计算，不硬编码）
const monthWorkdays = ref(22);
function onPeriodChange() {
  loadMonthWorkdays();   // 重新计算当月工作日
  load();
  if (tab.value === 'attendance') { /* 考勤页 */ }
}

async function loadMonthWorkdays() {
  try {
    const r = await api.calendarPeriod(period.value);
    monthWorkdays.value = r.count ?? 22;
  } catch { monthWorkdays.value = 22; }
}
/** 标准月工时 = 工作日 × 8 */
function stdHours() { return monthWorkdays.value * 8; }

const batchOpen = ref(false);
const batchHours = ref(176);
const batchWorkdays = ref(22);   // 打开弹窗时按当月工作日覆盖


const typeLabel = (t) => EMPLOYEE_TYPE_LABEL[t] ?? t;
const sourceLabel = (s) => ({ manual: '手工录入', import: '导入', default: '系统折算', none: '未录入' }[s] ?? s);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    // 关键 UX 改进：同时拉取「已有考勤记录」与「全部在职人员」，
    // 合并成完整名单 —— 否则未录入考勤的人根本不在列表里，无法勾选与批量录入。
    const [att, users] = await Promise.all([
      api.attendance(period.value),
      api.users({}).catch(() => ({ rows: [] })),
    ]);
    const byUser = new Map(att.rows.map((r) => [r.userId, r]));
    const merged = [];
    for (const u of users.rows) {
      const rec = byUser.get(u.id);
      merged.push(rec ?? {
        userId: u.id, username: u.username, name: u.displayName,
        employeeNo: u.employeeNo, employeeType: u.employeeType,
        workdays: 0, hours: 0, source: 'none', salary: u.monthlySalary ?? 0,
      });
    }
    // 补上不在在职名单中的历史记录（如已离职但有考勤）
    for (const r of att.rows) if (!merged.some((m) => m.userId === r.userId)) merged.push(r);
    attendanceRows.value = merged;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function loadUsers() {
  try {
    const r = await api.users({});
    users.value = r.rows;
  } catch { /* 忽略 */ }
}

function editAttendance(r) {
  editingAttendance.value = r;
  attForm.value = { hours: r.hours, workdays: r.workdays };
}

/** 清除某人某月考勤（纠正误录）。 */
async function clearAttendance(r) {
  if (!confirm(`确认清除 ${r.name} 在 ${periodLabel(period.value)} 的考勤记录？`)) return;
  try {
    await api.deleteAttendance(period.value, r.userId);
    window.__toast?.('已清除', 'ok');
    await load();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  }
}

async function saveAttendance() {
  busy.value = true;
  try {
    await api.setAttendance(period.value, editingAttendance.value.userId,
      attForm.value.hours, attForm.value.workdays);
    window.__toast?.('已保存', 'ok');
    editingAttendance.value = null;
    await load();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  } finally {
    busy.value = false;
  }
}

function openBatchAttendance() {
  // 按当月实际工作日动态设置默认值（如 2026-11 为 21 天 × 8h = 168h）
  batchWorkdays.value = monthWorkdays.value;
  batchHours.value = stdHours();
  batchOpen.value = true;
}

async function saveBatch() {
  // 有勾选则只处理勾选的人；没勾选则处理全部在职人员
  const ids = hrSel.count.value ? hrSel.list.value : attRows.value.map((r) => r.userId);
  if (!ids.length) { window.__toast?.('没有可设置考勤的人员', 'err'); return; }
  busy.value = true;
  try {
    const r = await api.bulkAttendance(period.value, ids, batchHours.value, batchWorkdays.value);
    if (r?.warnings?.length) {
      // 考勤与日历不一致时明确提示，避免后续工时对不上
      window.__toast?.(r.warnings.join('；'), '');
    }
    window.__toast?.(`已为 ${r.updated} 人录入考勤`, 'ok');
    batchOpen.value = false;
    hrSel.clear();
    await load();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  } finally {
    busy.value = false;
  }
}

async function loadAudit() {
  auditLoading.value = true;
  auditError.value = '';
  try {
    const r = await api.audit();
    auditRows.value = r.rows;
  } catch (e) {
    auditError.value = e.message;
  } finally {
    auditLoading.value = false;
  }
}

onMounted(() => {
  loadMonthWorkdays();
  loadStaff();
  load();
  loadUsers();
});
</script>

<style scoped>
tr.row-sel { background: var(--primary-soft) !important; }

</style>