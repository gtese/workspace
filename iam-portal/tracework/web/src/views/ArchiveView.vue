<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">归档工时</div>
        <div class="page-desc">
          已完成四阶段审批并归档的工时明细，可按人员、项目、日期筛选并导出。
        </div>
      </div>
      <div class="controls">
        <button class="btn pri" :disabled="!rows.length" @click="exportCsv">导出 CSV</button>
      </div>
    </div>

    <LoadState :loading="loading" :error="error" @retry="load">
      <!-- 概览 -->
      <div v-if="summary" class="kpis">
        <div class="kpi pri">
          <div class="kpi-label">归档工时合计</div>
          <div class="kpi-value">{{ fmtHours(summary.totalHours) }} h</div>
          <div class="kpi-note">{{ summary.count }} 条明细</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">涉及人员</div>
          <div class="kpi-value">{{ summary.byUser.length }}</div>
          <div class="kpi-note">人</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">涉及项目</div>
          <div class="kpi-value">{{ summary.byProject.length }}</div>
          <div class="kpi-note">个</div>
        </div>
        <div class="kpi">
          <div class="kpi-label">涉及月份</div>
          <div class="kpi-value">{{ summary.byMonth.length }}</div>
          <div class="kpi-note">个</div>
        </div>
      </div>

      <!-- 分布 -->
      <div v-if="summary && rows.length" class="card">
        <div class="card-h"><div class="card-t">工时分布</div></div>
        <div class="card-b">
          <div class="dist-grid">
            <div>
              <div class="dist-title">按项目</div>
              <div v-for="p in summary.byProject.slice(0, 6)" :key="p.name" class="dist-row">
                <span class="dist-name">{{ p.name }}</span>
                <div class="dist-bar"><i :style="{ width: pct(p.hours, summary.byProject[0].hours) }"></i></div>
                <span class="dist-val">{{ fmtHours(p.hours) }}h</span>
              </div>
            </div>
            <div>
              <div class="dist-title">按人员（前 6）</div>
              <div v-for="u in summary.byUser.slice(0, 6)" :key="u.name" class="dist-row">
                <span class="dist-name">{{ u.name }}</span>
                <div class="dist-bar"><i :style="{ width: pct(u.hours, summary.byUser[0].hours) }"></i></div>
                <span class="dist-val">{{ fmtHours(u.hours) }}h</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 筛选 -->
      <div class="card">
        <div class="card-h">
          <div class="card-t">工时明细</div>
          <div class="card-s">{{ rows.length }} 条</div>
        </div>
        <div class="card-b" style="border-bottom:1px solid var(--line);display:flex;gap:10px;flex-wrap:wrap;">
          <div class="field">
            <label>月份</label>
            <select v-model="filter.period" @change="load">
              <option value="">全部</option>
              <option v-for="p in periodsWithData" :key="p" :value="p">{{ periodLabel(p) }}</option>
            </select>
          </div>
          <div v-if="canSeeAll" class="field">
            <label>人员</label>
            <select v-model="filter.userId" @change="load">
              <option value="">全部</option>
              <option v-for="u in summary?.byUser ?? []" :key="u.name" :value="nameToId(u.name)">
                {{ u.name }}
              </option>
            </select>
          </div>
          <div v-if="canSeeAll" class="field">
            <label>项目</label>
            <select v-model="filter.projectId" @change="load">
              <option value="">全部</option>
              <option v-for="p in projectOptions" :key="p.id" :value="p.id">
                {{ p.code }} · {{ p.name }}
              </option>
            </select>
          </div>
          <div class="field" style="flex:1;min-width:200px;">
            <label>搜索</label>
            <input v-model.trim="filter.q" placeholder="姓名 / 项目号 / 项目名" @input="debouncedLoad">
          </div>
          <div class="field" style="align-self:center;">
            <button class="btn ghost sm" @click="clearFilters">清除筛选</button>
          </div>
        </div>

        <div class="card-b flush">
          <div v-if="!rows.length" class="empty">
            暂无归档工时。工时需走完「项目审批 → 人事确认 → 财务确认」后才会归档。
          </div>
          <div v-else class="tbl-wrap">
            <table style="min-width:1000px;">
              <thead>
                <tr>
                  <th style="width:10%;">月份</th>
                  <th style="width:13%;">工作日期</th>
                  <th style="width:17%;">人员</th>
                  <th style="width:19%;">项目</th>
                  <th class="center" style="width:9%;">工时</th>
                  <th style="width:14%;">归档时间</th>
                  <th style="width:10%;">归档人</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="r in rows" :key="r.id">
                  <td class="num">{{ r.period }}</td>
                  <td class="num">{{ r.work_date }}</td>
                  <td>
                    {{ r.display_name }}
                    <span style="color:var(--faint);font-size:11px;">{{ r.username }}</span>
                  </td>
                  <td>
                    <span class="num" style="font-size:12px;">{{ r.project_code }}</span>
                    <div style="font-size:12px;color:var(--sub);">{{ r.project_name }}</div>
                  </td>
                  <td class="center num"><b>{{ r.hours }}</b></td>
                  <td class="num" style="font-size:12px;">{{ r.archived_at_fmt }}</td>
                  <td style="font-size:12px;">{{ r.archived_by_name || '—' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div v-if="rows.length && rows.length >= 2000" class="card-b" style="border-top:1px solid var(--line);">
          <div class="alert warn" style="margin:0;">
            结果已达 2000 条上限，请缩小筛选范围（如按月份）以获得完整数据。
          </div>
        </div>
      </div>
    </LoadState>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';
import { useAppStore } from '../store.js';
import LoadState from '../components/LoadState.vue';
import { fmtHours, periodLabel, recentPeriods } from '../utils.js';

const store = useAppStore();
const rows = ref([]);
const summary = ref(null);
const loading = ref(false);
const error = ref('');
const periods = recentPeriods();
const filter = ref({ period: '', userId: '', projectId: '', q: '' });

const canSeeAll = computed(() =>
  ['admin', 'hr', 'finance', 'pm'].includes(store.user?.role));

const periodsWithData = computed(() =>
  periods.filter((p) => !summary.value || summary.value.byMonth.some((m) => m.name === p)));

const projectOptions = computed(() => store.meta?.projects ?? []);

function nameToId(name) {
  const m = /\((.+)\)$/.exec(name);
  return m ? m[1] : name;
}

function pct(v, max) {
  return max > 0 ? `${Math.round((v / max) * 100)}%` : '0%';
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await api.archivedEntries(filter.value);
    rows.value = r.rows;
    summary.value = r.summary;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

let t;
function debouncedLoad() {
  clearTimeout(t);
  t = setTimeout(load, 350);
}
onUnmounted(() => clearTimeout(t));

function clearFilters() {
  filter.value = { period: '', userId: '', projectId: '', q: '' };
  load();
}

function exportCsv() {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(filter.value)) if (v) q.set(k, v);
  const a = document.createElement('a');
  a.href = `/api/archived-entries/export${q.toString() ? '?' + q.toString() : ''}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.__toast?.('已开始导出', 'ok');
}

onMounted(load);
</script>

<style scoped>
.dist-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 28px; }
.dist-title { font-size: 12px; font-weight: 700; color: var(--sub); margin-bottom: 10px; }
.dist-row { display: flex; align-items: center; gap: 10px; margin-bottom: 7px; font-size: 12.5px; }
.dist-name { width: 40%; color: var(--ink); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dist-bar { flex: 1; height: 8px; background: var(--surface-2); border-radius: 4px; overflow: hidden; }
.dist-bar i { display: block; height: 100%; background: var(--primary); border-radius: 4px; }
.dist-val { width: 60px; text-align: right; color: var(--sub); font-variant-numeric: tabular-nums; }
</style>