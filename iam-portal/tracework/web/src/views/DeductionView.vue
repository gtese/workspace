<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">多口径测算与申报</div>
        <div class="page-desc">加计扣除、高企认定、会计准则、R&amp;D 统计四套口径测算，及合规自检。</div>
      </div>
      <div class="controls">
        <div class="field">
          <label>口径</label>
          <select v-model="scope" @change="load">
            <option value="year">按年度</option>
            <option value="month">按月度</option>
          </select>
        </div>
        <div class="field">
          <label>{{ scope === 'year' ? '年度' : '月份' }}</label>
          <select v-model="period" @change="load">
            <option v-if="scope === 'year'" v-for="y in years" :key="y" :value="y">{{ y }} 年</option>
            <option v-else v-for="p in periods" :key="p" :value="p">{{ periodLabel(p) }}</option>
          </select>
        </div>
        <button class="btn ghost" :disabled="busy" @click="freeze">生成留档快照</button>
      </div>
    </div>

    <LoadState :loading="loading" :error="error" @retry="load">
      <template v-if="d">
        <!-- 核心指标 -->
        <div class="kpis">
          <div class="kpi pri">
            <div class="kpi-label">加计扣除基数</div>
            <div class="kpi-value">{{ fmtW(d.antiRDBase) }}</div>
            <div class="kpi-note">万元 · 比例 {{ fmtH(d.deductRate * 100) }}%</div>
          </div>
          <div class="kpi ok">
            <div class="kpi-label">加计扣除额</div>
            <div class="kpi-value">{{ fmtW(d.deduction) }}</div>
            <div class="kpi-note">万元</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">测算节税（25%）</div>
            <div class="kpi-value">{{ fmtW(d.taxSave25) }}</div>
            <div class="kpi-note">高企 15% 口径 {{ fmtW(d.taxSave15) }}</div>
          </div>
          <div class="kpi" :class="c.compliance.pass ? 'ok' : 'bad'">
            <div class="kpi-label">合规自检</div>
            <div class="kpi-value">{{ c.compliance.pass ? '通过' : '待整改' }}</div>
            <div class="kpi-note">
              错误 {{ c.compliance.counts.error }} · 警告 {{ c.compliance.counts.warn }}
            </div>
          </div>
        </div>

        <div v-if="d.negativeBlocked" class="hint bad">
          属于负面清单行业且该类收入占比超过 50%，<b>不得享受加计扣除</b>。
        </div>

        <!-- 四口径对照 -->
        <div class="card">
          <div class="card-h">
            <div class="card-t">四口径研发费用对照</div>
            <div class="card-s">单位：万元</div>
          </div>
          <div class="card-b">
            <div class="kpis" style="grid-template-columns:repeat(4,1fr);margin-bottom:0;">
              <div class="kpi pri">
                <div class="kpi-label">加计扣除口径</div>
                <div class="kpi-value" style="font-size:19px;">{{ fmtW(d.antiRD) }}</div>
                <div class="kpi-note">其他费用限 10%</div>
              </div>
              <div class="kpi info">
                <div class="kpi-label">高企认定口径</div>
                <div class="kpi-value" style="font-size:19px;">{{ fmtW(d.hiRD) }}</div>
                <div class="kpi-note">其他费用限 20%</div>
              </div>
              <div class="kpi">
                <div class="kpi-label">会计准则口径</div>
                <div class="kpi-value" style="font-size:19px;">{{ fmtW(d.accRD) }}</div>
                <div class="kpi-note">账面列支金额</div>
              </div>
              <div class="kpi">
                <div class="kpi-label">R&amp;D 统计口径</div>
                <div class="kpi-value" style="font-size:19px;">{{ fmtW(d.statRD) }}</div>
                <div class="kpi-note">近似会计口径</div>
              </div>
            </div>
          </div>
        </div>

        <!-- 加计扣除明细 -->
        <div class="card">
          <div class="card-h">
            <div class="card-t">加计扣除优惠明细（A107012 结构）</div>
            <div class="card-s">单位：万元</div>
          </div>
          <div class="card-b flush">
            <div class="tbl-wrap">
              <table>
                <thead><tr>
                  <th style="width:8%;">行次</th><th style="width:52%;">项目</th>
                  <th class="money" style="width:20%;">金额</th><th style="width:20%;">说明</th>
                </tr></thead>
                <tbody>
                  <tr v-for="(r, i) in rows" :key="i" :class="{ total: r.total }">
                    <td class="num">{{ r.no }}</td>
                    <td>{{ r.name }}</td>
                    <td class="money num">{{ r.val }}</td>
                    <td style="font-size:12px;color:var(--sub);">{{ r.note }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 高企指标 -->
        <div class="card">
          <div class="card-h">
            <div class="card-t">高新技术企业认定指标</div>
            <div class="card-s">{{ passCount }} / {{ d.indicators.length }} 项达标</div>
          </div>
          <div class="card-b flush">
            <div class="tbl-wrap">
              <table>
                <thead><tr>
                  <th style="width:42%;">指标</th><th class="center" style="width:14%;">本期值</th>
                  <th class="center" style="width:14%;">认定要求</th>
                  <th class="center" style="width:14%;">状态</th>
                  <th style="width:16%;">缺口</th>
                </tr></thead>
                <tbody>
                  <tr v-for="i in d.indicators" :key="i.key">
                    <td>{{ i.name }}</td>
                    <td class="center num" style="font-weight:600;">{{ fmtH(i.val) }}{{ i.unit }}</td>
                    <td class="center num">≥ {{ i.need }}{{ i.unit }}</td>
                    <td class="center">
                      <span class="chip" :class="i.ok ? 'ok' : 'bad'">
                        <span class="dot"></span>{{ i.ok ? '达标' : '未达标' }}
                      </span>
                    </td>
                    <td class="num" :style="i.ok ? 'color:var(--faint)' : 'color:var(--bad)'">
                      {{ i.ok ? '—' : fmtH(i.need - i.val) + i.unit }}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 其他费用限额 -->
        <div class="card">
          <div class="card-h"><div class="card-t">其他相关费用限额（加计扣除 10% 口径）</div></div>
          <div class="card-b">
            <div class="tieout" style="flex-direction:column;align-items:stretch;gap:10px;">
              <div style="display:flex;justify-content:space-between;">
                <span>第一至五项费用合计</span><b class="num">{{ fmtW(d.allBase5) }}</b></div>
              <div style="display:flex;justify-content:space-between;">
                <span>其他相关费用实际发生</span><b class="num">{{ fmtW(d.tCost.other) }}</b></div>
              <div style="display:flex;justify-content:space-between;">
                <span>限额（前五项 × 10% ÷ (1-10%)）</span><b class="num">{{ fmtW(d.allOtherCap) }}</b></div>
              <div style="display:flex;justify-content:space-between;">
                <span>可计入的其他费用</span>
                <b class="num" style="color:var(--ok);">{{ fmtW(d.allOtherAllowed) }}</b></div>
              <div v-if="d.tCost.other - d.allOtherAllowed > 0.01"
                   style="display:flex;justify-content:space-between;">
                <span>超限不得加计</span>
                <b class="num" style="color:var(--warn);">{{ fmtW(d.tCost.other - d.allOtherAllowed) }}</b></div>
            </div>
          </div>
        </div>

        <!-- 委托研发 -->
        <div v-if="d.entrustFull > 0" class="card">
          <div class="card-h"><div class="card-t">委托研发加计口径</div></div>
          <div class="card-b">
            <div class="tieout" style="flex-direction:column;align-items:stretch;gap:10px;">
              <div style="display:flex;justify-content:space-between;">
                <span>委托研发实际发生额</span><b class="num">{{ fmtW(d.entrustFull) }}</b></div>
              <div style="display:flex;justify-content:space-between;">
                <span>委托境内（按 80% 计入）</span><b class="num">{{ fmtW(d.entrustDom80) }}</b></div>
              <div style="display:flex;justify-content:space-between;">
                <span>委托境外（80% 口径）</span><b class="num">{{ fmtW(d.entrustFor80) }}</b></div>
              <div style="display:flex;justify-content:space-between;">
                <span>境外限额（境内符合条件 × 2/3）</span><b class="num">{{ fmtW(d.overseaCap) }}</b></div>
              <div v-if="d.overseaExcess > 0.01" class="chip warn" style="align-self:flex-start;">
                <span class="dot"></span>境外超限 {{ fmtW(d.overseaExcess) }} 万元不得加计
              </div>
            </div>
          </div>
        </div>

        <!-- 冲减项 -->
        <div v-if="d.deductAdjust > 0" class="card">
          <div class="card-h"><div class="card-t">加计扣除基数冲减项</div></div>
          <div class="card-b">
            <div class="tieout" style="flex-direction:column;align-items:stretch;gap:10px;">
              <div style="display:flex;justify-content:space-between;">
                <span>特殊收入（下脚料/残次品/中间试制品）</span><b class="num">{{ fmtW(d.specialIncome) }}</b></div>
              <div style="display:flex;justify-content:space-between;">
                <span>试制产品对外销售对应材料费</span><b class="num">{{ fmtW(d.productMaterial) }}</b></div>
              <div style="display:flex;justify-content:space-between;">
                <span>政府补助直接冲减</span><b class="num">{{ fmtW(d.grantOffset) }}</b></div>
              <div style="display:flex;justify-content:space-between;border-top:1px solid var(--line);padding-top:8px;">
                <span><b>冲减合计</b></span><b class="num" style="color:var(--bad);">{{ fmtW(d.deductAdjust) }}</b></div>
            </div>
          </div>
        </div>

        <!-- 资本化 -->
        <div v-if="d.capitalAmt > 0" class="card">
          <div class="card-h"><div class="card-t">研发资本化</div></div>
          <div class="card-b">
            <div class="tieout" style="flex-direction:column;align-items:stretch;gap:10px;">
              <div style="display:flex;justify-content:space-between;">
                <span>资本化金额</span><b class="num">{{ fmtW(d.capitalAmt) }} 万元</b></div>
              <div style="display:flex;justify-content:space-between;">
                <span>摊销年限</span><b class="num">{{ d.capLife }} 年</b></div>
              <div style="display:flex;justify-content:space-between;">
                <span>税收年摊销（成本 200%）</span><b class="num">{{ fmtW(d.capitalTaxAmort) }} 万元/年</b></div>
            </div>
          </div>
        </div>

        <!-- 合规自检 -->
        <div class="card">
          <div class="card-h">
            <div class="card-t">合规自检清单</div>
            <div class="card-s">
              错误 {{ c.compliance.counts.error }} · 警告 {{ c.compliance.counts.warn }} · 提示 {{ c.compliance.counts.info }}
            </div>
          </div>
          <div class="card-b flush">
            <div v-if="!c.compliance.issues.length" class="empty">
              <span style="color:var(--ok);font-size:15px;">✓ 未发现合规问题</span>
            </div>
            <div v-else class="tbl-wrap">
              <table>
                <thead><tr>
                  <th style="width:10%;">级别</th><th style="width:16%;">领域</th><th>问题说明</th>
                </tr></thead>
                <tbody>
                  <tr v-for="(i, k) in c.compliance.issues" :key="k">
                    <td>
                      <span class="chip" :class="i.level === 'error' ? 'bad' : (i.level === 'warn' ? 'warn' : 'info')">
                        <span class="dot"></span>{{ { error: '错误', warn: '警告', info: '提示' }[i.level] }}
                      </span>
                    </td>
                    <td>{{ i.area }}</td>
                    <td style="font-size:12.5px;">{{ i.msg }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- 数据来源 -->
        <div class="card">
          <div class="card-h"><div class="card-t">测算数据来源</div></div>
          <div class="card-b" style="font-size:13px;color:var(--sub);line-height:1.9;">
            统计区间 <b>{{ d.input?.from }}</b> ~ <b>{{ d.input?.to }}</b>；
            研发项目 <b>{{ d.input?.projectCount }}</b> 个；
            费用明细 <b>{{ d.input?.costEntryCount }}</b> 条；
            公共费用 <b>{{ d.input?.sharedCount }}</b> 项；
            委外合同 <b>{{ d.input?.outsourceCount }}</b> 项；
            研发工时 <b>{{ fmtH(d.input?.totalRdHours) }}</b> 小时。
            <div v-if="d.frozen" style="margin-top:8px;color:var(--primary);">
              当前展示的是 {{ fmtDateTime(d.snapshotAt) }} 生成的留档快照。
            </div>
          </div>
        </div>
      </template>
    </LoadState>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { costingApi } from '../api.js';
import LoadState from '../components/LoadState.vue';
import { fmtHours, fmtDateTime, periodLabel, currentPeriod, recentPeriods } from '../utils.js';

const periods = recentPeriods();
const thisYear = new Date().getFullYear();
const years = [thisYear, thisYear - 1, thisYear - 2, thisYear - 3].map(String);
const scope = ref('year');
const period = ref(String(thisYear));
const d = ref(null);
const loading = ref(false);
const error = ref('');
const busy = ref(false);

const fmtW = (v) => Number(v ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtH = fmtHours;
const c = computed(() => d.value ?? { compliance: { issues: [], counts: { error: 0, warn: 0, info: 0 }, pass: true } });
const passCount = computed(() => (d.value?.indicators ?? []).filter((i) => i.ok).length);

const rows = computed(() => {
  const x = d.value;
  if (!x) return [];
  const t = x.tCost;
  return [
    { no: '1', name: '人员人工费用', val: fmtW(t.labor), note: '工时系统归集' },
    { no: '2', name: '直接投入费用', val: fmtW(t.direct), note: '材料、燃料动力等' },
    { no: '3', name: '折旧费用', val: fmtW(t.dep), note: '仪器设备折旧' },
    { no: '4', name: '无形资产摊销', val: fmtW(t.amort), note: '软件、专利权等' },
    { no: '5', name: '新产品设计费等', val: fmtW(t.design), note: '设计费、规程制定费' },
    { no: '6', name: '第一至五项小计', val: fmtW(x.allBase5), note: '1+2+3+4+5', total: true },
    { no: '7', name: '其他相关费用实际发生额', val: fmtW(t.other), note: '差旅、咨询、知识产权等' },
    { no: '8', name: '其他相关费用限额', val: fmtW(x.allOtherCap), note: '前五项×10%÷(1-10%)' },
    { no: '9', name: '可计入的其他相关费用', val: fmtW(x.allOtherAllowed), note: '第7行与第8行孰小' },
    { no: '10', name: '委托研发费用实际发生额', val: fmtW(x.entrustFull), note: '合同实际发生额' },
    { no: '11', name: '委托研发计入金额', val: fmtW(x.antiEntrust), note: '按80%及境外限额' },
    { no: '12', name: '特殊收入冲减金额', val: fmtW(x.specialIncome), note: '下脚料、残次品等' },
    { no: '13', name: '试制产品材料费不得加计', val: fmtW(x.productMaterial), note: '对外销售对应材料费' },
    { no: '14', name: '政府补助冲减金额', val: fmtW(x.grantOffset), note: '直接冲减且未确认应税收入' },
    { no: '15', name: '允许加计扣除的研发费用合计', val: fmtW(x.antiRDBase), note: '6+9+11-12-13-14', total: true },
    { no: '16', name: '加计扣除比例', val: fmtH(x.deductRate * 100) + '%', note: '制造业等行业 100%' },
    { no: '17', name: '加计扣除金额', val: fmtW(x.deduction), note: '15×16', total: true },
  ];
});

async function load() {
  loading.value = true; error.value = '';
  try { d.value = await costingApi.deduction(period.value, scope.value); }
  catch (e) { error.value = e.message; d.value = null; }
  finally { loading.value = false; }
}

async function freeze() {
  if (!confirm(`确认生成 ${period.value}（${scope.value === 'year' ? '年度' : '月度'}）的测算留档快照？`)) return;
  busy.value = true;
  try {
    await costingApi.freezeDeduction(period.value, scope.value);
    window.__toast?.('快照已生成', 'ok');
    await load();
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { busy.value = false; }
}

onMounted(load);
</script>

<style scoped>
.kpi.info .kpi-value { color: var(--info); }
</style>