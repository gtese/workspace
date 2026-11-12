<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">我的工作台</div>
        <div class="page-desc">您好，{{ store.user?.displayName || store.user?.username }}。查看本月填报进度与待办事项。</div>
      </div>
      <div class="controls">
        <div class="field">
          <label>月份</label>
          <select v-model="period" @change="load">
            <option v-for="p in periods" :key="p" :value="p">{{ periodLabel(p) }}</option>
          </select>
        </div>
      </div>
    </div>

    <LoadState :loading="loading" :error="error" @retry="load">
      <template v-if="data">
        <!-- 待办提示 -->
        <div v-if="data.fill.attendanceMissing" class="hint warn">
          本月考勤工时尚未由人力资源部维护，当前按标准工作日折算。如有出入请联系人力资源部。
        </div>

        <div class="kpis">
          <div class="kpi pri">
            <div class="kpi-label">本月研发工时</div>
            <div class="kpi-value">{{ fmtHours(data.fill.rndHours) }} <span style="font-size:14px;font-weight:600;">h</span></div>
            <div class="kpi-note">非研发 {{ fmtHours(data.fill.nonRndHours) }} h</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">本月总计填报</div>
            <div class="kpi-value">{{ fmtHours(data.fill.totalHours) }} <span style="font-size:14px;font-weight:600;">h</span></div>
            <div class="kpi-note">考勤 {{ fmtHours(data.fill.attendanceHours) }} h</div>
          </div>
          <div class="kpi" :class="diffClass">
            <div class="kpi-label">与考勤差异</div>
            <div class="kpi-value">{{ diffText }}</div>
            <div class="kpi-note">{{ Math.abs(data.fill.diff) < 0.01 ? '填报与考勤一致' : '请核对填报数据' }}</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">填报进度</div>
            <div class="kpi-value">{{ data.fill.daysFilled }}<span style="font-size:14px;font-weight:600;"> / {{ data.fill.workdayCount }} 天</span></div>
            <div class="kpi-note">已填报工作日</div>
          </div>
        </div>

        <!-- 状态卡片 -->
        <div class="card">
          <div class="card-h">
            <div class="card-t">{{ periodLabel(period) }} 报工状态</div>
            <span class="chip" :class="statusChipClass(data.fill.status)">
              <span class="dot"></span>{{ STATUS_LABEL[data.fill.status] || data.fill.status }}
            </span>
          </div>
          <div class="card-b">
            <div class="btn-row">
              <button class="btn pri" @click="$router.push({ name: 'fill' })">
                {{ data.fill.editable ? '去填报本月工时' : '查看本月工时' }}
              </button>
              <button v-if="data.fill.editable && data.fill.totalHours > 0"
                      class="btn ghost" @click="submitNow">提交报工审批</button>
              <button v-if="data.fill.status === 'submitted'"
                      class="btn ghost" @click="withdraw">撤回提交</button>
            </div>
            <div v-if="data.fill.status === 'rejected' && rejectReason" class="alert bad" style="margin-top:14px;">
              本月报工已被驳回：{{ rejectReason }}
            </div>
          </div>
        </div>

        <!-- 我的审批明细 -->
        <div class="card">
          <div class="card-h">
            <div class="card-t">本月报工明细（按项目）</div>
            <div class="card-s">共 {{ data.myApprovals.length }} 个项目</div>
          </div>
          <div class="card-b flush">
            <div v-if="!data.myApprovals.length" class="empty">本月尚未提交报工</div>
            <div v-else class="tbl-wrap">
              <table>
                <thead>
                  <tr>
                    <th>项目号</th><th>项目名称</th><th class="center">工时(h)</th>
                    <th class="center">状态</th><th class="center">提交时间</th><th>说明</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="(a, i) in data.myApprovals" :key="i">
                    <td class="num">{{ a.projectCode }}</td>
                    <td>{{ a.projectName }}</td>
                    <td class="center num">{{ fmtHours(a.hours) }}</td>
                    <td class="center">
                      <span class="chip" :class="statusChipClass(a.status)">
                        <span class="dot"></span>{{ STATUS_LABEL[a.status] || a.status }}
                      </span>
                    </td>
                    <td class="center num">{{ fmtDateTime(a.submitAt) }}</td>
                    <td style="color:var(--sub);font-size:12px;">{{ a.reason || '—' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 待我审批 -->
        <div v-if="store.permissions.canApprove" class="card">
          <div class="card-h">
            <div class="card-t">待我审批</div>
            <div class="card-s">
              <span v-if="data.pendingForMe > 0">{{ data.pendingForMe }} 单待处理</span>
              <span v-else>暂无待办</span>
            </div>
          </div>
          <div class="card-b">
            <button v-if="data.pendingForMe > 0" class="btn pri" @click="$router.push({ name: 'approve' })">
              前往审批中心（{{ data.pendingForMe }}）
            </button>
            <span v-else style="color:var(--sub);font-size:13px;">本月没有需要您处理的审批单。</span>
          </div>
        </div>
      </template>
    </LoadState>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { useAppStore } from '../store.js';
import LoadState from '../components/LoadState.vue';
import { fmtHours, fmtDateTime, periodLabel, currentPeriod, recentPeriods, STATUS_LABEL, statusChipClass } from '../utils.js';

const store = useAppStore();
const periods = recentPeriods();
const period = ref(store.meta.currentPeriod || currentPeriod());
const data = ref(null);
const loading = ref(true);
const error = ref('');

const rejectReason = computed(() =>
  (data.value?.myApprovals ?? []).find((a) => a.status === 'rejected')?.reason ?? '');

const diffText = computed(() => {
  const d = data.value?.fill.diff ?? 0;
  if (Math.abs(d) < 0.01) return '0 h';
  return (d > 0 ? '+' : '') + fmtHours(d) + ' h';
});
const diffClass = computed(() => {
  const d = data.value?.fill.diff ?? 0;
  return Math.abs(d) < 0.01 ? 'ok' : 'bad';
});

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.dashboard(period.value);
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function submitNow() {
  if (!confirm(`确认提交 ${periodLabel(period.value)} 的报工审批？提交后将无法直接修改。`)) return;
  try {
    await api.submitMonth(period.value);
    window.__toast?.('已提交审批，项目负责人将在 2 个工作日内完成审批', 'ok');
    await load();
    await store.refreshMe();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  }
}

async function withdraw() {
  if (!confirm('确认撤回本月报工？撤回后可以继续修改。')) return;
  try {
    await api.withdrawMonth(period.value);
    window.__toast?.('已撤回，可继续修改', 'ok');
    await load();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  }
}

onMounted(load);
</script>