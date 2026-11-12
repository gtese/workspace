<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">审批中心</div>
        <div class="page-desc">
          工时审批四阶段：项目审批 → 人事确认 → 财务确认 → 归档。按您的角色显示对应待办。
        </div>
      </div>
      <div class="controls">
        <div class="field">
          <label>月份</label>
          <select v-model="period" @change="onPeriodChange">
            <option value="">全部</option>
            <option v-for="p in periods" :key="p" :value="p">{{ periodLabel(p) }}</option>
          </select>
        </div>
      </div>
    </div>

    <!-- 页签：待我审批 / 我提交的 -->
    <div class="btn-row" style="margin-bottom:16px;">
      <button v-if="canApprove" class="btn" :class="view === 'inbox' ? 'pri' : 'ghost'"
              @click="view = 'inbox'; load()">待我审批</button>
      <button class="btn" :class="view === 'mine' ? 'pri' : 'ghost'"
              @click="view = 'mine'; loadMine()">我提交的</button>
    </div>

    <!-- ============ 我提交的 ============ -->
    <LoadState v-if="view === 'mine'" :loading="mineLoading" :error="mineError" @retry="loadMine">
      <div class="kpis">
        <div class="kpi pri">
          <div class="kpi-label">提交中</div>
          <div class="kpi-value">{{ mineSummary.inProgress }}</div>
          <div class="kpi-note">正在审批流程中</div>
        </div>
        <div class="kpi ok">
          <div class="kpi-label">已归档</div>
          <div class="kpi-value">{{ mineSummary.archived }}</div>
          <div class="kpi-note">全流程完成</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">填报中</div>
          <div class="kpi-value">{{ mineSummary.draft }}</div>
          <div class="kpi-note">尚未提交</div>
        </div>
      </div>

      <div v-if="!mineRows.length" class="card">
        <div class="card-b">
          <div class="empty">您还没有提交过工时审批</div>
        </div>
      </div>

      <div v-for="r in mineRows" :key="r.id" class="card">
        <div class="card-h">
          <div class="card-t">{{ periodLabel(r.period) }} 工时单</div>
          <span class="chip" :class="stageChip(r.status)">{{ r.stageLabel }}</span>
        </div>
        <div class="card-b">
          <!-- 四阶段进度 -->
          <div class="mini-stages">
            <div v-for="(st, i) in stageList" :key="st.key" class="ms-item"
                 :class="{ done: r.stageOrder > st.order, current: r.stageOrder === st.order }">
              <div class="ms-dot">{{ r.stageOrder > st.order ? '✓' : i + 1 }}</div>
              <div class="ms-label">{{ st.label }}</div>
            </div>
          </div>

          <div class="mine-grid">
            <div><span>总工时</span><b>{{ r.total_hours }} h</b></div>
            <div><span>研发工时</span><b>{{ r.rnd_hours }} h</b></div>
            <div><span>提交时间</span><b>{{ r.submitted_at_fmt || '未提交' }}</b></div>
            <div><span>归档时间</span><b>{{ r.archived_at_fmt || '—' }}</b></div>
          </div>

          <div v-if="r.reject_reason" class="alert bad" style="margin-top:12px;">
            <b>被驳回：</b>{{ r.reject_reason }}
          </div>

          <!-- 项目审批明细 -->
          <div v-if="r.approvals.length" style="margin-top:14px;">
            <div class="sec-title">项目审批</div>
            <table class="mini-tbl">
              <thead><tr><th>项目</th><th>工时</th><th>审批人</th><th>状态</th><th>处理时间</th></tr></thead>
              <tbody>
                <tr v-for="a in r.approvals" :key="a.id">
                  <td>{{ a.project_code }} {{ a.project_name }}</td>
                  <td class="num">{{ a.hours }} h</td>
                  <td>{{ a.approver_name || '—' }}</td>
                  <td>
                    <span class="chip" :class="{ ok: a.status === 'approved', bad: a.status === 'rejected', warn: a.status === 'pending' }">
                      {{ { approved: '已通过', rejected: '已驳回', pending: '审批中' }[a.status] || a.status }}
                    </span>
                  </td>
                  <td class="num">{{ a.acted_at_fmt || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>

          <!-- 流转轨迹 -->
          <div v-if="r.logs.length" style="margin-top:14px;">
            <div class="sec-title">流转记录</div>
            <div class="timeline">
              <div v-for="(lg, i) in r.logs" :key="i" class="tl-item">
                <div class="tl-dot"></div>
                <div class="tl-body">
                  <span class="tl-time">{{ lg.at_fmt }}</span>
                  <span class="tl-text">
                    {{ lg.from_status }} → {{ lg.to_status }}
                    <b>{{ actionLabel(lg.action) }}</b>
                    <span v-if="lg.actor_name">（{{ lg.actor_name }}）</span>
                    <span v-if="lg.note" class="tl-note">{{ lg.note }}</span>
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </LoadState>

    <!-- ============ 待我审批 ============ -->
    <template v-if="view === 'inbox'">
    <!-- 阶段概览 -->
    <div class="stage-overview">
      <div v-for="s in stageDefs" :key="s.key" class="so-card" :class="{ active: counts[s.key] > 0 }">
        <div class="so-num">{{ counts[s.key] ?? 0 }}</div>
        <div class="so-label">{{ s.label }}</div>
        <div class="so-hint">{{ s.hint }}</div>
      </div>
      <div class="so-card done">
        <div class="so-num">{{ archivedCount }}</div>
        <div class="so-label">已归档</div>
        <div class="so-hint">本月完成数</div>
      </div>
    </div>

    <LoadState :loading="loading" :error="error" @retry="load">
      <!-- 阶段 1：项目审批 -->
      <div v-if="inbox.stage1?.length" class="card">
        <div class="card-h">
          <div class="card-t">① 项目审批</div>
          <div class="card-s">{{ inbox.stage1.length }} 项待审（或签：任一审批人通过即可）</div>
        </div>
        <div class="card-b flush">
          <div class="tbl-wrap">
            <table style="min-width:960px;">
              <thead>
                <tr>
                  <th style="width:9%;">月份</th>
                  <th style="width:15%;">人员</th>
                  <th style="width:22%;">项目</th>
                  <th class="center" style="width:10%;">本项目工时</th>
                  <th class="center" style="width:10%;">月总工时</th>
                  <th style="width:13%;">提交时间</th>
                  <th class="center" style="width:16%;">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in inbox.stage1" :key="r.id">
                  <td class="num">{{ r.period }}</td>
                  <td>{{ r.display_name }}<span style="color:var(--faint);font-size:11px;"> {{ r.username }}</span></td>
                  <td>
                    <span class="num" style="font-size:12px;">{{ r.project_code }}</span>
                    <div style="font-size:12px;color:var(--sub);">{{ r.project_name }}</div>
                  </td>
                  <td class="center num"><b>{{ r.hours }}</b> h</td>
                  <td class="center num">{{ r.total_hours }} h</td>
                  <td class="num" style="font-size:12px;">{{ r.submitted_at_fmt || '—' }}</td>
                  <td class="center">
                    <button class="btn ok sm" :disabled="busy" @click="decideProject(r, 'approve')">通过</button>
                    <button class="btn bad sm" style="margin-left:4px;" :disabled="busy"
                            @click="decideProject(r, 'reject')">驳回</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 阶段 2：人事确认 -->
      <div v-if="inbox.stage2?.length" class="card">
        <div class="card-h">
          <div class="card-t">② 人事确认</div>
          <div class="card-s">{{ inbox.stage2.length }} 项待确认（确认工时并维护月薪）</div>
        </div>
        <div class="card-b flush">
          <div class="tbl-wrap">
            <table style="min-width:960px;">
              <thead>
                <tr>
                  <th style="width:9%;">月份</th>
                  <th style="width:15%;">人员</th>
                  <th class="center" style="width:10%;">研发工时</th>
                  <th class="center" style="width:10%;">总工时</th>
                  <th class="center" style="width:13%;">月薪(元)</th>
                  <th style="width:13%;">到达时间</th>
                  <th class="center" style="width:16%;">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in inbox.stage2" :key="r.timesheet_id">
                  <td class="num">{{ r.period }}</td>
                  <td>{{ r.display_name }}<span style="color:var(--faint);font-size:11px;"> {{ r.username }}</span></td>
                  <td class="center num">{{ r.rnd_hours }} h</td>
                  <td class="center num">{{ r.total_hours }} h</td>
                  <td class="center num">
                    <input v-model.number="hrSalary[r.timesheet_id]" class="mini-input"
                           type="number" min="0" step="100"
                           :placeholder="r.monthly_salary > 0 ? String(r.monthly_salary) : '未维护'">
                  </td>
                  <td class="num" style="font-size:12px;">{{ r.entered_at_fmt || '—' }}</td>
                  <td class="center">
                    <button class="btn ok sm" :disabled="busy" @click="confirmHr(r)">确认</button>
                    <button class="btn bad sm" style="margin-left:4px;" :disabled="busy"
                            @click="rejectHr(r)">驳回</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 阶段 3：财务确认 -->
      <div v-if="inbox.stage3?.length" class="card">
        <div class="card-h">
          <div class="card-t">③ 财务确认</div>
          <div class="card-s">{{ inbox.stage3.length }} 项待确认（确认人工费用与分摊比例）</div>
        </div>
        <div class="card-b flush">
          <div class="tbl-wrap">
            <table style="min-width:1180px;">
              <thead>
                <tr>
                  <th style="width:8%;">月份</th>
                  <th style="width:14%;">人员</th>
                  <th class="center" style="width:9%;">研发工时</th>
                  <th class="center" style="width:9%;">考勤工时</th>
                  <th class="center" style="width:11%;">月薪(元)</th>
                  <th class="center" style="width:12%;">人工费用(万元)</th>
                  <th class="center" style="width:10%;">分摊比例</th>
                  <th class="center" style="width:12%;">资产折旧折算</th>
                  <th class="center" style="width:12%;">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in inbox.stage3" :key="r.timesheet_id">
                  <td class="num">{{ r.period }}</td>
                  <td>{{ r.display_name }}<span style="color:var(--faint);font-size:11px;"> {{ r.username }}</span></td>
                  <td class="center num">{{ r.rnd_hours }} h</td>
                  <td class="center num">{{ r.attendance_hours }} h</td>
                  <td class="center num">{{ fmtMoney(r.salary_snapshot) }}</td>
                  <td class="center">
                    <input v-model.number="finCost[r.timesheet_id]" class="mini-input" type="number"
                           min="0" step="0.0001" :placeholder="autoCost(r)">
                  </td>
                  <td class="center">
                    <input v-model.number="finRatio[r.timesheet_id]" class="mini-input" type="number"
                           min="0" max="1" step="0.0001" :placeholder="autoRatio(r)">
                  </td>
                  <td class="center">
                    <button class="btn ghost sm" :disabled="busy" @click="showAssetAlloc(r)">
                      查看折算
                    </button>
                  </td>
                  <td class="center">
                    <button class="btn ok sm" :disabled="busy" @click="confirmFin(r)">确认归档</button>
                    <button class="btn bad sm" style="margin-left:4px;" :disabled="busy"
                            @click="rejectFin(r)">驳回</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <!-- 空状态 -->
      <div v-if="isEmpty" class="card">
        <div class="card-b">
          <div class="empty">
            <div style="font-size:15px;margin-bottom:6px;">当前没有待您处理的审批</div>
            <div style="font-size:13px;color:var(--faint);">{{ roleHint }}</div>
          </div>
        </div>
      </div>
    </LoadState>
    </template>

    <!-- 资产折旧折算弹窗 -->
    <Modal v-if="assetAlloc" :title="`资产折旧折算 · ${assetAlloc.employee?.displayName || ''}`"
           width="720px" @close="assetAlloc = null">
      <div class="alloc-grid">
        <div><span>名下资产</span><b>{{ assetAlloc.count }} 件</b></div>
        <div><span>资产总价值</span><b>{{ fmtMoney(assetAlloc.valueTotal) }} 元</b></div>
        <div><span>月度折旧合计</span><b>{{ fmtMoney(assetAlloc.depMonthly) }} 元</b></div>
        <div><span>研发工时</span><b>{{ assetAlloc.rndHours }} h</b></div>
        <div><span>月度总工时</span><b>{{ assetAlloc.totalHours }} h</b></div>
        <div><span>研发工时占比</span><b>{{ (assetAlloc.ratio * 100).toFixed(2) }}%</b></div>
      </div>

      <div class="formula-box">
        项目设备每月折旧额 = 设备月度折旧金额 × 月度研发工时 ÷ 月度总工时<br>
        = {{ fmtMoney(assetAlloc.depMonthly) }} × {{ assetAlloc.rndHours }} ÷ {{ assetAlloc.totalHours }}
        = <b>{{ fmtMoney(assetAlloc.allocYuan) }} 元</b>
        （{{ assetAlloc.allocWan }} 万元）
      </div>

      <div class="sec-title" style="margin-top:16px;">逐件明细</div>
      <table class="mini-tbl">
        <thead>
          <tr><th>资产编号</th><th>设备</th><th class="num">金额(元)</th>
              <th class="center">年限(月)</th><th class="num">月折旧(元)</th><th class="num">摊入研发(元)</th></tr>
        </thead>
        <tbody>
          <tr v-for="d in assetAlloc.detail" :key="d.assetNo">
            <td class="num" style="font-size:12px;">{{ d.assetNo }}</td>
            <td style="font-size:12px;">{{ d.deviceType }} {{ d.brand }} {{ d.model }}</td>
            <td class="num">{{ fmtMoney(d.amount) }}</td>
            <td class="center">{{ d.depreciationMonths }}</td>
            <td class="num">{{ fmtMoney(d.monthlyDep) }}</td>
            <td class="num"><b>{{ fmtMoney(d.allocated) }}</b></td>
          </tr>
          <tr v-if="!assetAlloc.detail.length">
            <td colspan="6" class="empty" style="text-align:center;">该员工名下暂无资产</td>
          </tr>
        </tbody>
      </table>

      <template #footer>
        <button class="btn ghost" @click="assetAlloc = null">关闭</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { useAppStore } from '../store.js';
import LoadState from '../components/LoadState.vue';
import { fmtMoney, periodLabel, recentPeriods, currentPeriod } from '../utils.js';

const store = useAppStore();
const periods = recentPeriods();
const period = ref('');   // 默认全部月份：跨月待办不应被漏掉
const loading = ref(false);
const error = ref('');
const busy = ref(false);
const inbox = ref({ stage1: [], stage2: [], stage3: [], counts: {} });
const archivedCount = ref(0);
const hrSalary = ref({});
const finCost = ref({});
const finRatio = ref({});

// ---- 页签：待我审批 / 我提交的 ----
const canApprove = computed(() => store.permissions.canApprove);
const view = ref('mine');   // 默认看我提交的；审批人可切换
const mineRows = ref([]);
const mineLoading = ref(false);
const mineError = ref('');
const mineSummary = ref({ total: 0, inProgress: 0, archived: 0, draft: 0 });
const stageList = [
  { key: 'draft', label: '填报中', order: 0 },
  { key: 'stage1_project', label: '项目审批', order: 1 },
  { key: 'stage2_hr', label: '人事确认', order: 2 },
  { key: 'stage3_finance', label: '财务确认', order: 3 },
  { key: 'archived', label: '已归档', order: 4 },
];

function stageChip(s) {
  return {
    draft: 'gray', stage1_project: 'warn', stage2_hr: 'info',
    stage3_finance: 'info', archived: 'ok', rejected: 'bad',
  }[s] ?? 'gray';
}
function actionLabel(a) {
  return {
    submit: '提交', approve: '通过', reject: '驳回',
    archive: '归档', fill_month: '批量填充', withdraw: '撤回',
  }[a] ?? a;
}

async function loadMine() {
  mineLoading.value = true;
  mineError.value = '';
  try {
    const r = await api.myTimesheets(period.value || undefined);
    mineRows.value = r.rows;
    mineSummary.value = r.summary;
  } catch (e) {
    mineError.value = e.message;
  } finally {
    mineLoading.value = false;
  }
}

function onPeriodChange() {
  if (view.value === 'mine') loadMine();
  else load();
}

const assetAlloc = ref(null);

/** 查看资产折旧折算明细（财务确认前预览）。 */
async function showAssetAlloc(r) {
  try {
    assetAlloc.value = await api.assetAllocation(r.timesheet_id);
  } catch (e) {
    window.__toast?.(e.message, 'err');
  }
}

const STAGE_DEFS = [
  { key: 'stage1', label: '项目审批', hint: '项目负责人' },
  { key: 'stage2', label: '人事确认', hint: '人力资源部' },
  { key: 'stage3', label: '财务确认', hint: '财务部' },
];
const stageDefs = computed(() => STAGE_DEFS.filter((s) => inbox.value[s.key] !== undefined));
const counts = computed(() => inbox.value.counts ?? {});
const isEmpty = computed(() =>
  !inbox.value.stage1?.length && !inbox.value.stage2?.length && !inbox.value.stage3?.length);

const roleHint = computed(() => {
  const r = store.user?.role;
  if (r === 'pm') return '您负责的项目当前没有待审工时。';
  if (r === 'hr') return '所有工时均已完成人事确认。';
  if (r === 'finance') return '所有工时均已完成财务确认。';
  if (r === 'admin') return '全部阶段的待办均已清空。';
  return '请等待项目负责人提交审批。';
});

function autoCost(r) {
  const a = Number(r.attendance_hours) || 1;
  const v = (Number(r.salary_snapshot) * (Number(r.rnd_hours) / a)) / 10000;
  return (Math.round(v * 10000) / 10000).toString();
}
function autoRatio(r) {
  const a = Number(r.attendance_hours) || 1;
  return (Math.round((Number(r.total_hours) / a) * 10000) / 10000).toString();
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await api.workflowInbox(period.value || undefined);
    inbox.value = r;
    hrSalary.value = {};
    finCost.value = {};
    finRatio.value = {};
    try {
      const ar = await api.archivedEntries({ period: period.value || undefined });
      archivedCount.value = new Set(ar.rows.map((x) => x.username + '|' + x.period)).size;
    } catch { archivedCount.value = 0; }
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function run(fn) {
  busy.value = true;
  try {
    await fn();
    await load();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  } finally {
    busy.value = false;
  }
}

function decideProject(r, action) {
  let reason = '';
  if (action === 'reject') {
    reason = prompt(`驳回 ${r.display_name} 在「${r.project_name}」的 ${r.hours}h 工时，请填写原因：`);
    if (reason === null) return;
    if (!reason.trim()) { window.__toast?.('驳回必须填写原因', 'err'); return; }
  } else if (!confirm(`确认通过 ${r.display_name} 在「${r.project_name}」的 ${r.hours}h 工时？`)) {
    return;
  }
  run(() => api.decideProjectApproval(r.id, action, reason));
}

function confirmHr(r) {
  const s = hrSalary.value[r.timesheet_id];
  run(async () => {
    await api.hrConfirm(r.timesheet_id, { salary: s || undefined });
    window.__toast?.('人事确认完成，已流转至财务', 'ok');
  });
}

function rejectHr(r) {
  const reason = prompt(`驳回 ${r.display_name} 的 ${r.period} 工时（将退回项目审批阶段），请填写原因：`);
  if (reason === null) return;
  if (!reason.trim()) { window.__toast?.('驳回必须填写原因', 'err'); return; }
  run(() => api.hrConfirm(r.timesheet_id, { action: 'reject', reason }));
}

function confirmFin(r) {
  const cost = finCost.value[r.timesheet_id];
  const ratio = finRatio.value[r.timesheet_id];
  if (!confirm(`确认归档 ${r.display_name} 的 ${r.period} 工时？\n\n人工费用：${cost || autoCost(r)} 万元\n分摊比例：${ratio || autoRatio(r)}`)) return;
  run(async () => {
    await api.financeConfirm(r.timesheet_id, {
      laborCostWan: cost || undefined,
      allocRatio: ratio || undefined,
    });
    window.__toast?.('财务确认完成，工时已归档', 'ok');
  });
}

function rejectFin(r) {
  const reason = prompt(`驳回 ${r.display_name} 的 ${r.period} 工时（将退回人事确认阶段），请填写原因：`);
  if (reason === null) return;
  if (!reason.trim()) { window.__toast?.('驳回必须填写原因', 'err'); return; }
  run(() => api.financeConfirm(r.timesheet_id, { action: 'reject', reason }));
}

onMounted(() => {
  if (canApprove.value) {
    view.value = 'inbox';
    load();
  } else {
    view.value = 'mine';
    loadMine();
  }
});
</script>

<style scoped>
.stage-overview { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 16px; }
.so-card {
  background: #fff; border: 1px solid var(--line); border-radius: 10px;
  padding: 14px 16px; box-shadow: var(--shadow-sm);
}
.so-card.active { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(4,159,215,.1); }
.so-card.done { background: var(--surface-2); }
.so-num { font-size: 26px; font-weight: 800; color: var(--ink); line-height: 1.1; }
.so-card.active .so-num { color: var(--primary); }
.so-label { font-size: 13px; font-weight: 700; margin-top: 4px; }
.so-hint { font-size: 11.5px; color: var(--faint); margin-top: 2px; }
.mini-input {
  width: 100px; height: 28px; padding: 0 8px; border: 1px solid var(--line2);
  border-radius: 6px; font-size: 12.5px; text-align: right; font-family: inherit;
}
.mini-input:focus { outline: none; border-color: var(--primary2); }

/* 我提交的：迷你阶段条 */
.mini-stages { display: flex; gap: 0; margin-bottom: 16px; }
.ms-item { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 5px;
  position: relative; }
.ms-item:not(:last-child)::after {
  content: ''; position: absolute; top: 11px; left: 50%; width: 100%; height: 2px;
  background: var(--line2); z-index: 0;
}
.ms-item.done:not(:last-child)::after { background: var(--ok); }
.ms-dot {
  width: 22px; height: 22px; border-radius: 50%; display: flex; align-items: center;
  justify-content: center; font-size: 11px; font-weight: 700; background: #fff;
  border: 2px solid var(--line2); color: var(--faint); position: relative; z-index: 1;
}
.ms-item.done .ms-dot { background: var(--ok); border-color: var(--ok); color: #fff; }
.ms-item.current .ms-dot { border-color: var(--primary); color: var(--primary);
  box-shadow: 0 0 0 3px rgba(4,159,215,.14); }
.ms-label { font-size: 11.5px; color: var(--sub); white-space: nowrap; }
.ms-item.current .ms-label { color: var(--primary); font-weight: 700; }

.mine-grid {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px 20px;
  padding: 12px 14px; background: var(--surface-2); border-radius: 8px; font-size: 13px;
}
.mine-grid > div { display: flex; justify-content: space-between; }
.mine-grid span { color: var(--sub); }

.sec-title { font-size: 12.5px; font-weight: 700; color: var(--sub); margin-bottom: 8px; }
.mini-tbl { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.mini-tbl th, .mini-tbl td { border: 1px solid var(--line); padding: 6px 9px; text-align: left; }
.mini-tbl th { background: var(--surface-2); font-weight: 600; color: var(--sub); }

.timeline { border-left: 2px solid var(--line2); padding-left: 14px; }
.tl-item { position: relative; margin-bottom: 10px; }
.tl-dot { position: absolute; left: -20px; top: 4px; width: 8px; height: 8px;
  border-radius: 50%; background: var(--primary); }
.tl-body { font-size: 12.5px; }
.tl-time { color: var(--faint); margin-right: 8px; font-variant-numeric: tabular-nums; }
.tl-text { color: var(--ink); }
.tl-note { color: var(--sub); margin-left: 6px; }

.alloc-grid {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px 20px;
  padding: 12px 14px; background: var(--surface-2); border-radius: 8px; font-size: 13px;
}
.alloc-grid > div { display: flex; justify-content: space-between; }
.alloc-grid span { color: var(--sub); }
.formula-box {
  margin-top: 14px; padding: 12px 14px; background: var(--primary-soft);
  border-radius: 8px; font-size: 12.5px; line-height: 1.9; color: var(--ink);
}
</style>