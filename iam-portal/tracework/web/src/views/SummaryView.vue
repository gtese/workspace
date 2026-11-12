<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">月度汇总与薪酬分摊</div>
        <div class="page-desc">职工薪酬按研发人员参与各项目的工时占比分摊，供财务核算与研发费用归集。</div>
      </div>
      <div class="controls">
        <div class="field">
          <label>月份</label>
          <select v-model="period" @change="load">
            <option v-for="p in periods" :key="p" :value="p">{{ periodLabel(p) }}</option>
          </select>
        </div>
        <button v-if="store.permissions.canHr" class="btn ghost" :disabled="busy" @click="freeze">
          生成留档快照
        </button>
        <button class="btn ghost" :disabled="!data" @click="exportCsv">导出 CSV</button>
      </div>
    </div>

    <LoadState :loading="loading" :error="error" @retry="load">
      <template v-if="data">
        <!-- 流程条 -->
        <div class="flow">
          <div class="flow-step">
            <div class="flow-idx done">1</div>
            <div><div class="flow-txt">逐日填报</div><div class="flow-sub">研发人员按项目填写</div></div>
          </div>
          <span class="flow-arrow">›</span>
          <div class="flow-step">
            <div class="flow-idx" :class="{ done: data.progress.pending + data.progress.approved + data.progress.rejected > 0 }">2</div>
            <div><div class="flow-txt">HR 汇总分类</div><div class="flow-sub">按项目归集</div></div>
          </div>
          <span class="flow-arrow">›</span>
          <div class="flow-step">
            <div class="flow-idx" :class="{ done: data.progress.pending === 0 && data.progress.approved > 0 }">3</div>
            <div><div class="flow-txt">项目负责人审批</div><div class="flow-sub">{{ data.progress.pending }} 单待审</div></div>
          </div>
          <span class="flow-arrow">›</span>
          <div class="flow-step">
            <div class="flow-idx" :class="{ done: data.allApproved }">4</div>
            <div><div class="flow-txt">HR 考勤核查</div><div class="flow-sub">报工与考勤比对</div></div>
          </div>
          <span class="flow-arrow">›</span>
          <div class="flow-step">
            <div class="flow-idx" :class="{ done: data.readyForFinance }">5</div>
            <div><div class="flow-txt">提交财务分摊</div><div class="flow-sub">{{ data.frozen ? '已留档' : (data.readyForFinance ? '可提交' : '待完成') }}</div></div>
          </div>
        </div>

        <div class="kpis">
          <div class="kpi pri">
            <div class="kpi-label">当月研发工时合计</div>
            <div class="kpi-value">{{ fmtHours(data.totalHours) }} h</div>
            <div class="kpi-note">{{ data.workdays }} 个工作日</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">职工薪酬总额</div>
            <div class="kpi-value">¥{{ fmtMoney(data.salaryTotal) }}</div>
            <div class="kpi-note">工资、五险一金等</div>
          </div>
          <div class="kpi pri">
            <div class="kpi-label">项目分摊薪酬</div>
            <div class="kpi-value">¥{{ fmtMoney(data.allocTotal) }}</div>
            <div class="kpi-note">按工时占比分摊</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">非研发薪酬</div>
            <div class="kpi-value">¥{{ fmtMoney(data.nonRndSalaryTotal) }}</div>
            <div class="kpi-note">不计入研发费用</div>
          </div>
        </div>

        <div v-if="data.frozen" class="hint">
          当前展示的是 {{ fmtDateTime(data.snapshotAt) }} 生成的留档快照，数据已冻结，不再随填报变动。
        </div>
        <div v-else-if="!data.allApproved" class="hint warn">
          本月报工尚未全部审批完成（待审 {{ data.progress.pending }} 单，驳回 {{ data.progress.rejected }} 单），当前为实时数据，仅供预览。
        </div>

        <!-- 项目汇总 -->
        <div class="card">
          <div class="card-h">
            <div class="card-t">项目研发费用汇总（提交财务部）</div>
            <div class="card-s">{{ data.projRows.length }} 个研发项目</div>
          </div>
          <div class="card-b flush">
            <div v-if="!data.projRows.length" class="empty">本月没有研发项目工时记录</div>
            <div v-else class="tbl-wrap">
              <table style="min-width:760px;">
                <thead>
                  <tr>
                    <th style="width:15%;">项目号</th>
                    <th style="width:26%;">项目名称</th>
                    <th class="center" style="width:13%;">参与人次</th>
                    <th class="center" style="width:15%;">项目工时合计(h)</th>
                    <th class="money" style="width:18%;">分摊职工薪酬(元)</th>
                    <th class="center" style="width:13%;">工时占比</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="r in data.projRows" :key="r.id">
                    <td class="num">{{ r.code }}</td>
                    <td>{{ r.name }}</td>
                    <td class="center num">{{ r.headCount }}</td>
                    <td class="center num">{{ fmtHours(r.hours) }}</td>
                    <td class="money num">{{ fmtMoney(r.alloc) }}</td>
                    <td class="center num">{{ fmtPct(r.ratio) }}</td>
                  </tr>
                  <tr class="total">
                    <td colspan="2">合计</td>
                    <td class="center num">{{ totalHead }}</td>
                    <td class="center num">{{ fmtHours(data.totalHours) }} h</td>
                    <td class="money num">{{ fmtMoney(data.allocTotal) }}</td>
                    <td class="center num">100.00%</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 图表 -->
        <div class="card">
          <div class="card-h"><div class="card-t">项目工时与分摊薪酬分布</div></div>
          <div class="card-b">
            <div ref="chartEl" class="chart-box"></div>
            <div v-if="chartFailed" class="bar-fallback">
              <div v-for="r in data.projRows" :key="r.id" class="bar-row">
                <div class="bar-label">{{ r.code }}</div>
                <div class="bar-track">
                  <div class="bar-fill" :style="{ width: barPct(r) + '%' }"></div>
                </div>
                <div class="bar-val">{{ fmtHours(r.hours) }} h · ¥{{ fmtMoney(r.alloc) }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 员工核对 -->
        <div class="card">
          <div class="card-h">
            <div class="card-t">员工考勤核对（人力资源部）</div>
            <div class="card-s">确认研发报工与考勤工时相比不存在明显异常</div>
          </div>
          <div class="card-b flush">
            <div v-if="!data.empRows.length" class="empty">本月没有工时记录</div>
            <div v-else class="tbl-wrap">
              <table style="min-width:1080px;">
                <thead>
                  <tr>
                    <th style="width:9%;">员工编号</th>
                    <th style="width:8%;">姓名</th>
                    <th style="width:12%;">研发类型</th>
                    <th class="center" style="width:10%;">研发工时(h)</th>
                    <th class="center" style="width:8%;">非研发(h)</th>
                    <th class="center" style="width:9%;">总工时(h)</th>
                    <th class="center" style="width:8%;">考勤(h)</th>
                    <th class="center" style="width:8%;">差异(h)</th>
                    <th class="center" style="width:8%;">标记</th>
                    <th class="money" style="width:10%;">薪酬总额(元)</th>
                    <th class="money" style="width:10%;">非研发薪酬(元)</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="e in data.empRows" :key="e.id">
                    <td class="num">{{ e.employeeNo || '—' }}</td>
                    <td>{{ e.name }}</td>
                    <td style="font-size:12px;color:var(--sub);">{{ typeLabel(e.employeeType) }}</td>
                    <td class="center num">{{ fmtHours(e.rndHours) }}</td>
                    <td class="center num">{{ fmtHours(e.nonRndHours) }}</td>
                    <td class="center num">{{ fmtHours(e.totalHours) }}</td>
                    <td class="center num">{{ fmtHours(e.attendanceHours) }}</td>
                    <td class="center num" :style="Math.abs(e.diff) > 0.01 ? 'color:var(--bad);font-weight:600;' : ''">
                      {{ e.diff > 0 ? '+' : '' }}{{ fmtHours(e.diff) }}
                    </td>
                    <td class="center">
                      <span class="chip" :class="e.abnormal ? 'bad' : 'ok'">
                        <span class="dot"></span>{{ e.abnormal ? '异常' : '正常' }}
                      </span>
                    </td>
                    <td class="money num">{{ fmtMoney(e.salary) }}</td>
                    <td class="money num">{{ fmtMoney(e.nonRndSalary) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 勾稽 -->
        <div class="card">
          <div class="card-h"><div class="card-t">勾稽校验</div></div>
          <div class="card-b">
            <div class="tieout">
              <span class="eq">项目分摊薪酬合计 <b>¥{{ fmtMoney(data.allocTotal) }}</b></span>
              <span style="color:var(--faint);">＋</span>
              <span class="eq">非研发薪酬合计 <b>¥{{ fmtMoney(data.nonRndSalaryTotal) }}</b></span>
              <span style="color:var(--faint);">－</span>
              <span class="eq">职工薪酬总额 <b>¥{{ fmtMoney(data.salaryTotal) }}</b></span>
              <span style="color:var(--faint);">＝</span>
              <span class="eq">差异 <b>¥{{ fmtMoney(Math.abs(data.tieDiff)) }}</b></span>
              <span class="chip" :class="data.tieOk ? 'ok' : 'bad'">
                <span class="dot"></span>
                {{ data.tieOk ? '勾稽平衡' : '存在差异，请核查' }}
              </span>
            </div>
            <div v-if="!data.tieOk" style="font-size:12px;color:var(--sub);margin-top:10px;line-height:1.8;">
              差异通常来自：① 未设置职工薪酬总额的员工存在工时；② 非研发工时未填报；
              ③ 四舍五入累计（0.05 元以内视为平衡）。请在「人力与考勤」中核对薪酬与工时数据。
            </div>
          </div>
        </div>
      </template>
    </LoadState>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch } from 'vue';
import * as echarts from 'echarts';
import { api } from '../api.js';
import { useAppStore } from '../store.js';
import LoadState from '../components/LoadState.vue';
import {
  fmtHours, fmtMoney, fmtPct, fmtDateTime, periodLabel, currentPeriod, recentPeriods,
  EMPLOYEE_TYPE_LABEL, downloadCsv,
} from '../utils.js';

const store = useAppStore();
const periods = recentPeriods();
const period = ref(store.meta.currentPeriod || currentPeriod());
const data = ref(null);
const loading = ref(true);
const error = ref('');
const busy = ref(false);
const chartEl = ref(null);
const chartFailed = ref(false);
let chart = null;

const typeLabel = (t) => EMPLOYEE_TYPE_LABEL[t] ?? t;
const totalHead = computed(() => (data.value?.projRows ?? []).reduce((s, r) => s + r.headCount, 0));
const barPct = (r) => Math.max(2, data.value?.totalHours ? (r.hours / data.value.totalHours) * 100 : 0);

async function load() {
  loading.value = true;
  error.value = '';
  try {
    data.value = await api.summary(period.value);
    await nextTick();
    renderChart();
  } catch (e) {
    error.value = e.message;
    data.value = null;
  } finally {
    loading.value = false;
  }
}

function renderChart() {
  if (!chartEl.value || !data.value) return;
  try {
    if (!chart) chart = echarts.init(chartEl.value);
    const rows = data.value.projRows;
    chart.setOption({
      grid: { left: 70, right: 70, top: 34, bottom: 30 },
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: ['项目工时(h)', '分摊薪酬(元)'], top: 0 },
      xAxis: {
        type: 'category',
        data: rows.map((r) => r.code),
        axisLine: { lineStyle: { color: '#D0D5DD' } },
        axisLabel: { color: '#667085' },
      },
      yAxis: [
        { type: 'value', name: '工时', axisLabel: { color: '#667085' }, splitLine: { lineStyle: { color: '#EEF1F4' } } },
        { type: 'value', name: '薪酬', axisLabel: { color: '#667085' }, splitLine: { show: false } },
      ],
      series: [
        {
          name: '项目工时(h)', type: 'bar', data: rows.map((r) => r.hours), barWidth: 24,
          itemStyle: { color: '#006185' }, yAxisIndex: 0,
          label: { show: true, position: 'top', color: '#1D2939', fontSize: 11, formatter: '{c}h' },
        },
        {
          name: '分摊薪酬(元)', type: 'bar', data: rows.map((r) => Number(r.alloc.toFixed(2))), barWidth: 24,
          itemStyle: { color: '#049FD7' }, yAxisIndex: 1,
          label: { show: true, position: 'top', color: '#1D2939', fontSize: 11 },
        },
      ],
    }, true);
    chart.resize();
    chartFailed.value = false;
  } catch {
    chartFailed.value = true;
  }
}

async function freeze() {
  if (!confirm(`确认生成 ${periodLabel(period.value)} 的留档快照？快照将冻结当前数据用于财务留档。`)) return;
  busy.value = true;
  try {
    await api.freezeSummary(period.value);
    window.__toast?.('快照已生成', 'ok');
    await load();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  } finally {
    busy.value = false;
  }
}

function exportCsv() {
  if (!data.value) return;
  const rows = [
    [`${periodLabel(period.value)} 研发工时与薪酬分摊表`],
    [],
    ['一、项目研发费用汇总'],
    ['项目号', '项目名称', '参与人次', '项目工时合计(h)', '分摊职工薪酬(元)', '工时占比'],
    ...data.value.projRows.map((r) => [r.code, r.name, r.headCount, r.hours, r.alloc.toFixed(2), (r.ratio * 100).toFixed(2) + '%']),
    ['合计', '', totalHead.value, data.value.totalHours, data.value.allocTotal.toFixed(2), '100.00%'],
    [],
    ['二、员工考勤核对'],
    ['员工编号', '姓名', '研发类型', '研发工时(h)', '非研发(h)', '总工时(h)', '考勤(h)', '差异(h)', '标记', '薪酬总额(元)', '非研发薪酬(元)'],
    ...data.value.empRows.map((e) => [
      e.employeeNo || '', e.name, typeLabel(e.employeeType), e.rndHours, e.nonRndHours,
      e.totalHours, e.attendanceHours, e.diff, e.abnormal ? '异常' : '正常',
      e.salary.toFixed(2), e.nonRndSalary.toFixed(2),
    ]),
    [],
    ['三、勾稽校验'],
    ['项目分摊薪酬合计', data.value.allocTotal.toFixed(2)],
    ['非研发薪酬合计', data.value.nonRndSalaryTotal.toFixed(2)],
    ['职工薪酬总额', data.value.salaryTotal.toFixed(2)],
    ['差异', data.value.tieDiff.toFixed(2)],
    ['勾稽结果', data.value.tieOk ? '平衡' : '存在差异'],
  ];
  downloadCsv(`研发工时与薪酬分摊_${period.value}.csv`, rows);
  window.__toast?.('已导出 CSV', 'ok');
}

let resizeTimer;
function onResize() {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { try { chart?.resize(); } catch { /* 忽略 */ } }, 150);
}

onMounted(() => {
  load();
  window.addEventListener('resize', onResize);
});
watch(period, load);
</script>