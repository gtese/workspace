<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">工时填报</div>
        <div class="page-desc">按工作日、按项目如实填报当日投入工时（最小单位 0.5 小时）。</div>
      </div>
      <div class="controls">
        <div class="field">
          <label>月份</label>
          <select v-model="period" @change="load">
            <option v-for="p in periods" :key="p" :value="p">{{ periodLabel(p) }}</option>
          </select>
        </div>
        <div v-if="store.permissions.canHr" class="field">
          <label>代填对象</label>
          <select v-model="proxyUserId" @change="load">
            <option :value="null">我自己</option>
            <option v-for="u in userList" :key="u.id" :value="u.id">
              {{ u.displayName }}{{ u.employeeNo ? ' · ' + u.employeeNo : '' }}
            </option>
          </select>
        </div>
      </div>
    </div>

    <LoadState :loading="loading" :error="error" @retry="load">
      <template v-if="ctx">
        <div v-if="ctx.attendanceMissing" class="hint warn">
          {{ periodLabel(period) }} 的考勤工时尚未维护，当前按标准工作日（{{ ctx.workdayCount }} 天 × 8 小时）折算。
        </div>

        <!-- 状态 / 汇总条 -->
        <div class="card">
          <div class="card-h">
            <div class="card-t">
              {{ periodLabel(period) }} 填报汇总
              <span v-if="proxyUserId" style="font-weight:400;color:var(--sub);font-size:13px;">（代填）</span>
            </div>
            <span class="chip" :class="statusChipClass(ctx.status)">
              <span class="dot"></span>{{ STATUS_LABEL[ctx.status] || ctx.status }}
            </span>
          </div>

          <!-- 四阶段流程进度 -->
          <div v-if="progress" class="stage-bar">
            <div v-for="(st, i) in progress.stages" :key="st.key" class="stage-item"
                 :class="{ done: st.done, current: st.current }">
              <div class="stage-dot">{{ st.done ? '✓' : i + 1 }}</div>
              <div class="stage-label">{{ st.label }}</div>
              <div v-if="i < progress.stages.length - 1" class="stage-line"
                   :class="{ on: st.done }"></div>
            </div>
          </div>
          <div class="card-b">
            <div class="kpis" style="margin-bottom:0;">
              <div class="kpi pri">
                <div class="kpi-label">研发工时合计</div>
                <div class="kpi-value">{{ fmtHours(ctx.totals.rndHours) }} h</div>
                <div class="kpi-note">计入研发费用归集</div>
              </div>
              <div class="kpi">
                <div class="kpi-label">非研发工时</div>
                <div class="kpi-value">{{ fmtHours(ctx.totals.nonRndHours) }} h</div>
                <div class="kpi-note">如培训，不计入研发</div>
              </div>
              <div class="kpi">
                <div class="kpi-label">考勤工时</div>
                <div class="kpi-value">{{ fmtHours(ctx.totals.attendanceHours) }} h</div>
                <div class="kpi-note">{{ ctx.workdayCount }} 个工作日</div>
              </div>
              <div class="kpi" :class="Math.abs(ctx.totals.diff) < 0.01 ? 'ok' : 'bad'">
                <div class="kpi-label">差异</div>
                <div class="kpi-value">{{ diffText }}</div>
                <div class="kpi-note">{{ Math.abs(ctx.totals.diff) < 0.01 ? '与考勤一致' : '请核对' }}</div>
              </div>
            </div>
            <!-- 名下资产（只读） -->
            <div v-if="ctx.assets && ctx.assets.count > 0" class="asset-box">
              <div class="ab-head">
                <span class="ab-title">名下资产</span>
                <span class="ab-count">{{ ctx.assets.count }} 件</span>
                <span class="ab-sep">|</span>
                <span class="ab-kv">总价值 <b>{{ fmtMoney(ctx.assets.valueTotal) }}</b> 元</span>
                <span class="ab-sep">|</span>
                <span class="ab-kv">月折旧 <b>{{ fmtMoney(ctx.assets.depMonthly) }}</b> 元</span>
                <span class="ab-tip">财务审批时按研发工时占比摊入研发费用</span>
              </div>
              <div class="ab-list">
                <span v-for="a in ctx.assets.list" :key="a.assetNo" class="ab-item">
                  {{ a.deviceType }} {{ a.brand }} {{ a.model }}
                  <i>{{ fmtMoney(a.amount) }}元 · {{ a.depreciationMonths }}月</i>
                </span>
              </div>
            </div>

            <div v-if="!ctx.editable" class="alert ok" style="margin-top:14px;margin-bottom:0;">
              本月报工状态为「{{ STATUS_LABEL[ctx.status] }}」，不可修改。
              <span v-if="ctx.status === 'submitted'">如需修改请先撤回。</span>
            </div>
            <div v-else-if="ctx.rejectReason" class="alert bad" style="margin-top:14px;margin-bottom:0;">
              上月/本月报工被驳回：{{ ctx.rejectReason }}
            </div>
          </div>
        </div>

        <!-- 逐日填报 -->
        <div class="card">
          <div class="card-h">
            <div class="card-t">逐日填报明细</div>
            <div class="card-s">
              工时以 0.5 小时为单位；每日各项目合计不得超过当日可用工时
            </div>
          </div>
          <div class="card-b flush">
            <div class="tbl-wrap">
              <table class="day-editor" style="min-width:960px;">
                <thead>
                  <tr>
                    <th style="width:110px;">工作日期</th>
                    <th class="center" style="width:62px;">星期</th>
                    <th class="center" style="width:80px;">当日额度</th>
                    <th style="min-width:300px;">项目 / 工时</th>
                    <th class="center" style="width:86px;">当日合计</th>
                    <th class="center" style="width:96px;">校验</th>
                    <th class="center" style="width:150px;">操作</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="day in ctx.days" :key="day.date"
                      :class="{ nonwork: !day.isWorkday, dirty: dirty.has(day.date) }">
                    <td class="num">
                      {{ day.date }}
                      <div v-if="day.note" style="font-size:11px;color:var(--warn);">{{ day.note }}</div>
                    </td>
                    <td class="center num" :style="!day.isWorkday ? 'color:var(--faint)' : ''">
                      {{ weekdayLabel(day.date) }}
                    </td>
                    <td class="center num">{{ fmtHours(dayLimit) }}h</td>
                    <td>
                      <div v-for="(row, idx) in draft[day.date] || []" :key="idx"
                           style="display:flex;gap:6px;margin-bottom:6px;align-items:center;">
                        <select v-model.number="row.project_id" :disabled="!ctx.editable"
                                style="flex:1;min-width:150px;" @change="markDirty(day.date)">
                          <option v-for="p in ctx.projects" :key="p.id" :value="p.id">
                            {{ p.code }} · {{ p.name }}{{ p.is_rnd ? '' : '（非研发）' }}
                          </option>
                        </select>
                        <input v-model.number="row.hours" type="number" min="0" max="24" step="0.5"
                               :disabled="!ctx.editable" style="width:74px;" @input="markDirty(day.date)">
                        <button class="x-btn" :disabled="!ctx.editable" title="删除该行"
                                @click="removeRow(day.date, idx)">×</button>
                      </div>
                      <div v-if="!(draft[day.date] || []).length" style="color:var(--faint);font-size:12px;padding:4px 0;">
                        未填报
                      </div>
                      <button v-if="ctx.editable" class="btn ghost sm" style="margin-top:2px;"
                              @click="addRow(day.date)">＋ 添加项目</button>
                    </td>
                    <td class="center num" style="font-weight:700;">{{ fmtHours(dayTotal(day.date)) }}</td>
                    <td class="center">
                      <span v-if="!dayTotal(day.date)" style="color:var(--faint);font-size:12px;">—</span>
                      <span v-else-if="dayTotal(day.date) > dayLimit + 1e-9" class="bad-badge">超额度</span>
                      <span v-else-if="isHalfStep(dayTotal(day.date))" class="ok-badge">合规</span>
                      <span v-else class="bad-badge">非0.5倍数</span>
                    </td>
                    <td class="center">
                      <button class="btn ghost sm" :disabled="!ctx.editable || saving === day.date"
                              @click="saveDayRow(day.date)">
                        {{ saving === day.date ? '保存中…' : '保存' }}
                      </button>
                      <button class="btn ghost sm" style="margin-left:6px;"
                              :disabled="!ctx.editable" title="将该日填入标准 8 小时"
                              @click="fillStandard(day.date)">填满</button>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="card-b" style="border-top:1px solid var(--line);">
            <div class="btn-row" style="flex-wrap:wrap;">
              <button class="btn wave" :disabled="!ctx.editable" @click="openFillAll">
                ⚡ 一键全月填满
              </button>
              <button class="btn pri" :disabled="!ctx.editable || savingAll" @click="saveAll">
                {{ savingAll ? '保存中…' : '保存（不提交）' }}
              </button>
              <button class="btn ok" :disabled="!ctx.editable || ctx.totals.totalHours <= 0 || submitting"
                      @click="submit">
                {{ submitting ? '提交中…' : '提交送审' }}
              </button>
              <button class="btn bad" :disabled="!ctx.editable || ctx.totals.totalHours <= 0 || resetting"
                      @click="resetAll">
                {{ resetting ? '清空中…' : '重置（清空已填）' }}
              </button>
              <button class="btn ghost" :disabled="!ctx.editable" @click="load">放弃修回</button>
            </div>
            <div style="font-size:12px;color:var(--faint);margin-top:10px;">
              填报截止：每月最后一个工作日；项目负责人审批时限：收到后 {{ store.meta.approvalSlaWorkdays }} 个工作日内。
            </div>
          </div>
        </div>
      </template>
    </LoadState>

    <!-- 一键全月填满 -->
    <Modal v-if="fillAllOpen" title="一键全月填满" width="520px" @close="fillAllOpen = false">
      <p style="font-size:13px;color:var(--sub);margin:0 0 14px;">
        把 {{ periodLabel(period) }} 的<strong>所有工作日</strong>填满同一个项目。
        已有填报的日期将<strong>自动跳过</strong>，不会覆盖。
      </p>
      <div class="form-row">
        <label>项目</label>
        <select v-model.number="fillForm.projectId" class="input">
          <option :value="null" disabled>请选择项目</option>
          <option v-for="pj in ctx?.projects ?? []" :key="pj.id" :value="pj.id">
            {{ pj.code }} · {{ pj.name }}
          </option>
        </select>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-row">
          <label>每天工时</label>
          <input v-model.number="fillForm.hoursPerDay" class="input" type="number"
                 min="0.5" max="24" step="0.5">
        </div>
        <div class="form-row">
          <label>预计</label>
          <div class="input" style="background:var(--surface-2);color:var(--sub);">
            {{ ctx?.workdayCount ?? 0 }} 个工作日 × {{ fillForm.hoursPerDay }}h
            = <b>{{ ((ctx?.workdayCount ?? 0) * fillForm.hoursPerDay).toFixed(1) }}h</b>
          </div>
        </div>
      </div>
      <label style="display:flex;gap:8px;align-items:center;font-size:13px;color:var(--ink);">
        <input v-model="fillForm.overwrite" type="checkbox">
        覆盖已有填报（谨慎使用）
      </label>
      <template #footer>
        <button class="btn ghost" @click="fillAllOpen = false">取消</button>
        <button class="btn pri" :disabled="!fillForm.projectId || fillingAll" @click="doFillAll">
          {{ fillingAll ? '填充中…' : '确认填充' }}
        </button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted } from 'vue';
import { api } from '../api.js';
import { useAppStore } from '../store.js';
import LoadState from '../components/LoadState.vue';
import Modal from '../components/Modal.vue';
import { fmtHours, fmtMoney, weekdayLabel, periodLabel, currentPeriod, recentPeriods, STATUS_LABEL, statusChipClass } from '../utils.js';

const store = useAppStore();
const periods = recentPeriods();
const period = ref(store.meta.currentPeriod || currentPeriod());
const proxyUserId = ref(null);
const userList = ref([]);

const ctx = ref(null);
const loading = ref(true);
const error = ref('');
const saving = ref('');
const savingAll = ref(false);
const submitting = ref(false);

/** 本地编辑草稿：date -> [{project_id, hours}] */
const draft = ref({});
const dirty = ref(new Set());

const dayLimit = computed(() => {
  const c = ctx.value;
  if (!c) return 8;
  if (c.attendance?.workdays > 0) {
    return Math.round((c.attendance.hours / c.attendance.workdays) * 100) / 100;
  }
  return 8;
});

const diffText = computed(() => {
  const d = ctx.value?.totals.diff ?? 0;
  if (Math.abs(d) < 0.01) return '0 h';
  return (d > 0 ? '+' : '') + fmtHours(d) + ' h';
});

function buildDraft(c) {
  const d = {};
  for (const day of c.days) {
    d[day.date] = day.entries.map((e) => ({ project_id: e.projectId, hours: Number(e.hours) }));
  }
  draft.value = d;
  dirty.value = new Set();
}

function markDirty(date) {
  dirty.value = new Set([...dirty.value, date]);
}

function dayTotal(date) {
  return (draft.value[date] ?? []).reduce((s, r) => s + (Number(r.hours) || 0), 0);
}
function isHalfStep(n) {
  return Math.abs(n * 2 - Math.round(n * 2)) < 1e-9;
}
function addRow(date) {
  if (!draft.value[date]) draft.value[date] = [];
  const firstProject = ctx.value?.projects?.[0];
  if (!firstProject) return;
  draft.value[date].push({ project_id: firstProject.id, hours: 0 });
  markDirty(date);
}
function removeRow(date, idx) {
  draft.value[date].splice(idx, 1);
  markDirty(date);
}
/** 把该日填满到额度（优先使用已有的第一个项目）。 */
function fillStandard(date) {
  const rows = draft.value[date] ?? [];
  const remain = Math.round((dayLimit.value - dayTotal(date)) * 2) / 2;
  if (rows.length === 0) {
    const firstProject = ctx.value?.projects?.[0];
    if (!firstProject) return;
    draft.value[date] = [{ project_id: firstProject.id, hours: Math.max(0, remain) }];
  } else if (remain > 0) {
    // 把差额加到第一行
    rows[0].hours = Math.round((Number(rows[0].hours || 0) + remain) * 2) / 2;
  }
  markDirty(date);
}

function validateDay(date) {
  const rows = draft.value[date] ?? [];
  for (const r of rows) {
    const h = Number(r.hours) || 0;
    if (h < 0 || h > 24) return '单条工时必须在 0 ~ 24 小时之间';
    if (!isHalfStep(h)) return '工时必须以 0.5 小时为单位';
  }
  if (dayTotal(date) > dayLimit.value + 1e-9) {
    return `当日合计 ${fmtHours(dayTotal(date))}h 超过当日额度 ${fmtHours(dayLimit.value)}h`;
  }
  return '';
}

// ---- 一键填满 / 重置 / 阶段进度 ----
const fillAllOpen = ref(false);
const fillingAll = ref(false);
const resetting = ref(false);
const progress = ref(null);
const fillForm = ref({ projectId: null, hoursPerDay: 8, overwrite: false });

function openFillAll() {
  fillForm.value = { projectId: (ctx.value?.projects?.[0]?.id) ?? null, hoursPerDay: 8, overwrite: false };
  fillAllOpen.value = true;
}

async function doFillAll() {
  fillingAll.value = true;
  try {
    const r = await api.fillWholeMonth(period.value, {
      projectId: fillForm.value.projectId,
      hoursPerDay: fillForm.value.hoursPerDay,
      overwrite: fillForm.value.overwrite,
      userId: proxyUserId.value || undefined,
    });
    fillAllOpen.value = false;
    window.__toast?.(
      `已填充 ${r.filled} 天，共 ${r.hours} 小时` + (r.skipped ? `；跳过 ${r.skipped} 天（已有填报）` : ''),
      'ok');
    await load();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  } finally { fillingAll.value = false; }
}

async function resetAll() {
  if (!confirm(`确认清空 ${periodLabel(period.value)} 的全部填报？\n\n此操作会删除当月所有工时明细，不可恢复。`)) return;
  resetting.value = true;
  try {
    const r = await api.resetMonth(period.value, proxyUserId.value || undefined);
    window.__toast?.(`已清空 ${r.cleared} 条填报`, 'ok');
    await load();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  } finally { resetting.value = false; }
}

async function loadProgress() {
  try {
    progress.value = await api.timesheetProgress(period.value, proxyUserId.value || undefined);
  } catch { progress.value = null; }
}

async function saveDayRow(date) {
  const err = validateDay(date);
  if (err) { window.__toast?.(err, 'err'); return false; }
  saving.value = date;
  try {
    const entries = (draft.value[date] ?? [])
      .filter((r) => Number(r.hours) > 0)
      .map((r) => ({ project_id: r.project_id, hours: Number(r.hours) }));
    const res = await api.saveDay(period.value, date, entries);
    dirty.value = new Set([...dirty.value].filter((d) => d !== date));
    if (res.warnings?.length) window.__toast?.(res.warnings.join('；'));
    else window.__toast?.(`${date} 已保存`, 'ok');
    return true;
  } catch (e) {
    window.__toast?.(e.message, 'err');
    return false;
  } finally {
    saving.value = '';
  }
}

async function saveAll() {
  const dates = [...dirty.value].sort();
  if (!dates.length) { window.__toast?.('没有需要保存的修改'); return; }
  for (const d of dates) {
    const err = validateDay(d);
    if (err) { window.__toast?.(`${d}：${err}`, 'err'); return; }
  }
  savingAll.value = true;
  let ok = 0;
  try {
    for (const d of dates) {
      if (await saveDayRow(d)) ok++;
    }
    window.__toast?.(`已保存 ${ok} 天`, 'ok');
    await load();
  } finally {
    savingAll.value = false;
  }
}

async function submit() {
  if (dirty.value.size) {
    window.__toast?.('存在未保存的修改，请先保存', 'err');
    return;
  }
  if (!confirm(`确认提交 ${periodLabel(period.value)} 的报工？提交后需由项目负责人审批。`)) return;
  submitting.value = true;
  try {
    await api.submitMonth(period.value);
    window.__toast?.('已提交审批', 'ok');
    await load();
    await store.refreshMe();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  } finally {
    submitting.value = false;
  }
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const c = await api.fillContext(period.value, proxyUserId.value);
    ctx.value = c;
    buildDraft(c);
    await loadProgress();     // 四阶段进度条
  } catch (e) {
    error.value = e.message;
    ctx.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadUsers() {
  if (!store.permissions.canHr) return;
  try {
    const r = await api.users({});
    userList.value = r.rows;
  } catch { /* 忽略 */ }
}

watch(() => period.value, load);
onMounted(async () => {
  await Promise.all([load(), loadUsers()]);
});
</script>

<style scoped>
/* 四阶段流程进度条 */
.stage-bar {
  display: flex;
  align-items: flex-start;
  padding: 18px 20px 22px;
  background: var(--surface-2);
  border-bottom: 1px solid var(--line);
}
.stage-item {
  position: relative;
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 7px;
}
.stage-dot {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  font-weight: 700;
  background: #fff;
  border: 2px solid var(--line2);
  color: var(--faint);
  position: relative;
  z-index: 2;
}
.stage-item.done .stage-dot {
  background: var(--ok);
  border-color: var(--ok);
  color: #fff;
}
.stage-item.current .stage-dot {
  border-color: var(--primary);
  color: var(--primary);
  background: #fff;
  box-shadow: 0 0 0 4px rgba(4, 159, 215, 0.14);
}
.stage-label {
  font-size: 12px;
  color: var(--sub);
  text-align: center;
  white-space: nowrap;
}
.stage-item.current .stage-label {
  color: var(--primary);
  font-weight: 700;
}
.stage-item.done .stage-label {
  color: var(--ink);
}
.stage-line {
  position: absolute;
  top: 14px;
  left: 50%;
  width: 100%;
  height: 2px;
  background: var(--line2);
  z-index: 1;
}
.stage-line.on {
  background: var(--ok);
}

/* 一键填满按钮 */
.btn.wave {
  background: linear-gradient(135deg, #f6a623, #f0a020);
  color: #fff;
  border: 0;
}
.btn.wave:hover:not(:disabled) {
  filter: brightness(1.06);
}

/* 名下资产 */
.asset-box {
  margin-top: 14px; padding: 12px 14px; background: var(--surface-2);
  border-radius: 8px; border-left: 3px solid var(--primary);
}
.ab-head { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; font-size: 13px; }
.ab-title { font-weight: 700; color: var(--ink); }
.ab-count { color: var(--sub); font-size: 12px; }
.ab-sep { color: var(--line2); }
.ab-kv { color: var(--sub); }
.ab-kv b { color: var(--ink); font-variant-numeric: tabular-nums; }
.ab-tip { margin-left: auto; font-size: 11.5px; color: var(--faint); }
.ab-list { display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 8px; }
.ab-item { font-size: 12px; color: var(--ink); }
.ab-item i { font-style: normal; color: var(--faint); margin-left: 4px; }
</style>
