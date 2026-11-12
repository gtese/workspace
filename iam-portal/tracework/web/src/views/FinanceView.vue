<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">研发费用归集</div>
        <div class="page-desc">六类费用归集、公共费用分摊、工时转人工费用与委托研发管理。</div>
      </div>
      <div class="controls">
        <div class="field">
          <label>月份</label>
          <select v-model="period" @change="load">
            <option v-for="p in periods" :key="p" :value="p">{{ periodLabel(p) }}</option>
          </select>
        </div>
        <button class="btn ghost" @click="load">刷新</button>
      </div>
    </div>

    <div class="btn-row" style="margin-bottom:16px;">
      <button class="btn" :class="tab === 'overview' ? 'pri' : 'ghost'" @click="tab = 'overview'">费用归集总览</button>
      <button class="btn" :class="tab === 'labor' ? 'pri' : 'ghost'" @click="tab = 'labor'; loadLabor()">工时转人工费用</button>
      <button class="btn" :class="tab === 'shared' ? 'pri' : 'ghost'" @click="tab = 'shared'">公共费用分摊</button>
      <button class="btn" :class="tab === 'outsource' ? 'pri' : 'ghost'" @click="tab = 'outsource'">委托/合作研发</button>
      <button class="btn" :class="tab === 'entries' ? 'pri' : 'ghost'" @click="tab = 'entries'; loadEntries()">费用明细账</button>
    </div>

    <!-- ============ 费用归集总览 ============ -->
    <LoadState v-if="tab === 'overview'" :loading="loading" :error="error" @retry="load">
      <template v-if="sum">
        <div class="kpis">
          <div class="kpi pri">
            <div class="kpi-label">研发费用合计</div>
            <div class="kpi-value">{{ fmtW(sum.total) }}</div>
            <div class="kpi-note">万元 · {{ sum.projectCount }} 个研发项目</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">人员人工费用</div>
            <div class="kpi-value">{{ fmtW(sum.byCat.labor) }}</div>
            <div class="kpi-note">占 {{ pct(sum.byCat.labor, sum.total) }}</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">直接投入费用</div>
            <div class="kpi-value">{{ fmtW(sum.byCat.direct) }}</div>
            <div class="kpi-note">占 {{ pct(sum.byCat.direct, sum.total) }}</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">其他相关费用</div>
            <div class="kpi-value">{{ fmtW(sum.byCat.other) }}</div>
            <div class="kpi-note">限额 {{ fmtW(sum.otherCap) }}</div>
          </div>
        </div>

        <div class="hint">
          费用按「项目 × 六类」归集。人员人工费用可由工时系统<b>自动归集</b>；
          公共费用按研发工时占比分摊。金额单位统一为<b>万元</b>，与各类申报表口径一致。
        </div>

        <div class="card">
          <div class="card-h">
            <div class="card-t">{{ periodLabel(period) }} 研发费用归集表</div>
            <div class="card-s">单位：万元</div>
          </div>
          <div class="card-b flush">
            <div class="tbl-wrap">
              <table style="min-width:900px;">
                <thead>
                  <tr>
                    <th style="width:12%;">项目编号</th>
                    <th style="width:22%;">项目名称</th>
                    <th class="money" v-for="c in CATS" :key="c.k" style="width:10%;">
                      {{ c.name.replace(/^[一二三四五六]、/, '') }}
                    </th>
                    <th class="money" style="width:11%;">合计</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="p in sum.projects" :key="p.code">
                    <td class="num">{{ p.code }}</td>
                    <td>{{ p.name }}</td>
                    <td class="money num" v-for="c in CATS" :key="c.k">{{ fmtW(p.cost[c.k]) }}</td>
                    <td class="money num" style="font-weight:600;">{{ fmtW(p.total) }}</td>
                  </tr>
                  <tr class="total">
                    <td colspan="2">合计</td>
                    <td class="money num" v-for="c in CATS" :key="c.k">{{ fmtW(sum.byCat[c.k]) }}</td>
                    <td class="money num">{{ fmtW(sum.total) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><div class="card-t">限额检查</div></div>
          <div class="card-b">
            <div class="tieout" style="flex-direction:column;align-items:stretch;gap:10px;">
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span>前五项费用合计</span>
                <b class="num">{{ fmtW(sum.base5) }} 万元</b>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span>其他相关费用实际发生</span>
                <b class="num">{{ fmtW(sum.byCat.other) }} 万元</b>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span>加计扣除限额（前五项×10%÷(1-10%)）</span>
                <b class="num">{{ fmtW(sum.otherCap) }} 万元</b>
              </div>
              <div style="display:flex;justify-content:space-between;align-items:center;">
                <span>可计入加计扣除的其他费用</span>
                <b class="num" :style="sum.otherExcess > 0 ? 'color:var(--warn)' : 'color:var(--ok)'">
                  {{ fmtW(sum.otherAllowed) }} 万元
                </b>
              </div>
              <span v-if="sum.otherExcess > 0.01" class="chip warn" style="align-self:flex-start;">
                <span class="dot"></span>超限 {{ fmtW(sum.otherExcess) }} 万元不得加计
              </span>
              <span v-else class="chip ok" style="align-self:flex-start;">
                <span class="dot"></span>其他费用在限额内
              </span>
            </div>
          </div>
        </div>
      </template>
    </LoadState>

    <!-- ============ 工时转人工费用 ============ -->
    <LoadState v-if="tab === 'labor'" :loading="laborLoading" :error="laborError" @retry="loadLabor">
      <template v-if="labor">
        <div class="hint">
          按「员工薪酬 × 该项目研发工时 ÷ 该员工当月总工时」把工时系统的数据折算为
          <b>人员人工费用</b>，写入研发费用辅助账。重复执行不会重复计账（按人×项目×月份幂等）。
        </div>

        <div v-if="labor.warnings?.length" class="hint warn">
          <div v-for="(w, i) in labor.warnings" :key="i">{{ w }}</div>
        </div>

        <div class="kpis">
          <div class="kpi pri">
            <div class="kpi-label">可归集人工费用</div>
            <div class="kpi-value">{{ fmtW(labor.totalWan) }}</div>
            <div class="kpi-note">万元</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">涉及人员</div>
            <div class="kpi-value">{{ labor.employees.length }}</div>
            <div class="kpi-note">含未设薪酬 {{ labor.skippedCount }} 人</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">涉及项目</div>
            <div class="kpi-value">{{ labor.projectRows.length }}</div>
            <div class="kpi-note">研发项目</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">规则</div>
            <div class="kpi-value" style="font-size:15px;">按人加权</div>
            <div class="kpi-note">薪酬 × 项目工时 ÷ 总工时</div>
          </div>
        </div>

        <div class="card">
          <div class="card-h">
            <div class="card-t">按项目汇总</div>
            <div class="card-s">单位：万元</div>
          </div>
          <div class="card-b flush">
            <div class="tbl-wrap">
              <table>
                <thead><tr>
                  <th style="width:16%;">项目编号</th><th style="width:30%;">项目名称</th>
                  <th class="center" style="width:14%;">参与人数</th>
                  <th class="center" style="width:20%;">研发工时(h)</th>
                  <th class="money" style="width:20%;">人工费用(万元)</th>
                </tr></thead>
                <tbody>
                  <tr v-for="r in labor.projectRows" :key="r.code">
                    <td class="num">{{ r.code }}</td><td>{{ r.name }}</td>
                    <td class="center num">{{ r.headCount }}</td>
                    <td class="center num">{{ fmtH(r.hours) }}</td>
                    <td class="money num">{{ fmtW(r.amountWan) }}</td>
                  </tr>
                  <tr class="total">
                    <td colspan="3">合计</td>
                    <td class="center num">{{ fmtH(labor.projectRows.reduce((a,r)=>a+r.hours,0)) }}</td>
                    <td class="money num">{{ fmtW(labor.totalWan) }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-h"><div class="card-t">人员明细</div></div>
          <div class="card-b flush">
            <div class="tbl-wrap">
              <table style="min-width:900px;">
                <thead><tr>
                  <th style="width:9%;">工号</th><th style="width:11%;">姓名</th>
                  <th class="money" style="width:13%;">薪酬(元)</th>
                  <th class="center" style="width:11%;">研发工时</th>
                  <th class="center" style="width:11%;">非研发</th>
                  <th class="center" style="width:11%;">总工时</th>
                  <th class="center" style="width:12%;">研发占比</th>
                  <th class="money" style="width:13%;">人工费用(万元)</th>
                </tr></thead>
                <tbody>
                  <tr v-for="e in labor.employees" :key="e.userId">
                    <td class="num">{{ e.employeeNo || '—' }}</td>
                    <td>{{ e.name }}</td>
                    <td class="money num">{{ fmtMoney(e.salary) }}</td>
                    <td class="center num">{{ fmtH(e.rndHours) }}</td>
                    <td class="center num">{{ fmtH(e.nonRndHours) }}</td>
                    <td class="center num">{{ fmtH(e.totalHours) }}</td>
                    <td class="center num">{{ (e.rate * 100).toFixed(1) }}%</td>
                    <td class="money num">
                      <span v-if="e.skipped" style="color:var(--warn);">未设薪酬</span>
                      <span v-else>{{ fmtW(e.laborWan) }}</span>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
          <div class="card-b" style="border-top:1px solid var(--line);">
            <div class="btn-row">
              <button class="btn pri" :disabled="busy || !labor.projectRows.length" @click="applyLabor">
                {{ busy ? '归集中…' : '执行归集，写入辅助账' }}
              </button>
              <button class="btn ghost" @click="loadLabor">重新计算</button>
            </div>
            <div style="font-size:12px;color:var(--faint);margin-top:10px;">
              归集结果将作为「人员人工费用」进入研发费用辅助账；如需修正请先调整工时或人员薪酬后重新归集。
            </div>
          </div>
        </div>
      </template>
    </LoadState>

    <!-- ============ 公共费用 ============ -->
    <LoadState v-if="tab === 'shared'" :loading="sharedLoading" :error="sharedError" @retry="loadShared">
      <div class="hint">
        折旧、水电、房租等公共费用按「研发使用量 ÷ 全部使用量」计算分摊比例，
        再按各项目研发工时占比分摊到项目。分摊依据须留存备查。
      </div>
      <div class="card">
        <div class="card-h">
          <div class="card-t">{{ periodLabel(period) }} 公共费用与分摊</div>
          <div class="card-s">{{ sharedRows.length }} 项 · 单位：万元</div>
        </div>
        <div class="card-b flush">
          <div v-if="!sharedRows.length" class="empty">本月尚未登记公共费用</div>
          <div v-else class="tbl-wrap">
            <table style="min-width:1000px;">
              <thead><tr>
                <th style="width:20%;">费用项目</th>
                <th class="center" style="width:10%;">类别</th>
                <th class="money" style="width:11%;">费用总额</th>
                <th class="money" style="width:12%;">分摊基数</th>
                <th class="money" style="width:12%;">研发使用量</th>
                <th class="center" style="width:10%;">分摊比例</th>
                <th class="money" style="width:12%;">应分摊金额</th>
                <th class="center" style="width:13%;">操作</th>
              </tr></thead>
              <tbody>
                <tr v-for="r in sharedRows" :key="r.id">
                  <td>{{ r.item }}<div v-if="r.basis_note" style="font-size:11px;color:var(--sub);">{{ r.basis_note }}</div></td>
                  <td class="center"><span class="chip gray">{{ catLabel(r.category) }}</span></td>
                  <td class="money num">{{ fmtW(r.total_amount) }}</td>
                  <td class="money num">{{ fmtH(r.basis_total) }}</td>
                  <td class="money num">{{ fmtH(r.basis_rd) }}</td>
                  <td class="center num">{{ (r.rate * 100).toFixed(2) }}%</td>
                  <td class="money num" style="font-weight:600;">{{ fmtW(r.alloc) }}</td>
                  <td class="center">
                    <button class="btn ghost sm" @click="editShared(r)">编辑</button>
                    <button class="btn bad sm" style="margin-left:4px;" @click="delShared(r)">删除</button>
                  </td>
                </tr>
                <tr class="total">
                  <td colspan="2">合计</td>
                  <td class="money num">{{ fmtW(sumField(sharedRows, 'total_amount')) }}</td>
                  <td colspan="3"></td>
                  <td class="money num">{{ fmtW(sumField(sharedRows, 'alloc')) }}</td>
                  <td></td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="card-b" style="border-top:1px solid var(--line);">
          <button class="btn pri" @click="openShared()">＋ 新增公共费用</button>
        </div>
      </div>
    </LoadState>

    <!-- ============ 委外/合作 ============ -->
    <LoadState v-if="tab === 'outsource'" :loading="osLoading" :error="osError" @retry="loadOutsource">
      <div class="hint">
        委托研发按实际发生额的 <b>80%</b> 计入加计扣除；委托境外研发还不得超过境内符合条件研发费用的 <b>2/3</b>。
        委托与合作研发合同须经科技行政主管部门登记。
      </div>
      <div class="card">
        <div class="card-h">
          <div class="card-t">委外研发与合作研发</div>
          <div class="card-s">{{ osRows.length }} 项 · 单位：万元</div>
        </div>
        <div class="card-b flush">
          <div v-if="!osRows.length" class="empty">尚未登记委外研发</div>
          <div v-else class="tbl-wrap">
            <table style="min-width:1100px;">
              <thead><tr>
                <th style="width:10%;">类型</th><th style="width:18%;">受托/合作单位</th>
                <th style="width:12%;">对应项目</th>
                <th class="money" style="width:10%;">合同金额</th>
                <th class="money" style="width:10%;">实际发生</th>
                <th class="center" style="width:8%;">境内/外</th>
                <th class="center" style="width:8%;">关联方</th>
                <th style="width:14%;">科技部门登记号</th>
                <th class="center" style="width:11%;">操作</th>
              </tr></thead>
              <tbody>
                <tr v-for="r in osRows" :key="r.id">
                  <td><span class="chip" :class="r.kind === '委托研发' ? 'pri' : 'info'">{{ r.kind }}</span></td>
                  <td>{{ r.party }}</td>
                  <td class="num">{{ r.project_code || '—' }}</td>
                  <td class="money num">{{ fmtW(r.amount) }}</td>
                  <td class="money num">{{ fmtW(r.actual_amount) }}</td>
                  <td class="center">{{ r.is_domestic ? '境内' : '境外' }}</td>
                  <td class="center">{{ r.is_related ? '是' : '否' }}</td>
                  <td style="font-size:12px;">
                    <span v-if="r.tech_reg_no">{{ r.tech_reg_no }}</span>
                    <span v-else class="chip warn"><span class="dot"></span>未登记</span>
                  </td>
                  <td class="center">
                    <button class="btn ghost sm" @click="editOutsource(r)">编辑</button>
                    <button class="btn bad sm" style="margin-left:4px;" @click="delOutsource(r)">删除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="card-b" style="border-top:1px solid var(--line);">
          <button class="btn pri" @click="openOutsource()">＋ 新增委外研发</button>
        </div>
      </div>
    </LoadState>

    <!-- ============ 费用明细账 ============ -->
    <LoadState v-if="tab === 'entries'" :loading="entryLoading" :error="entryError" @retry="loadEntries">
      <div class="card">
        <div class="card-h">
          <div class="card-t">研发费用明细账</div>
          <div class="card-s">{{ entryRows.length }} 条 · 单位：万元</div>
        </div>
        <BulkBar :count="esel.count" :total="deletableIds.length" :all-selected="esel.allSelected"
                 @select-all="esel.selectAll()" @clear="esel.clear()">
          <button class="btn bad sm" :disabled="!esel.count || busy" @click="bulkDeleteEntries">
            批量删除（{{ esel.count }}）
          </button>
          <span style="font-size:12px;color:var(--sub);">工时自动归集的记录不可删除</span>
        </BulkBar>
        <div class="card-b flush">
          <div v-if="!entryRows.length" class="empty">本月尚无费用明细</div>
          <div v-else class="tbl-wrap">
            <table style="min-width:1000px;">
              <thead><tr>
                <th class="center" style="width:40px;">
                  <SelectAllBox :all-ids="deletableIds" :selected="esel.list"
                                @toggle-all="esel.toggleAll()" />
                </th>
                <th style="width:8%;">月份</th><th style="width:10%;">项目</th>
                <th style="width:10%;">类别</th><th style="width:20%;">明细科目</th>
                <th class="money" style="width:10%;">金额</th>
                <th style="width:10%;">凭证号</th>
                <th class="center" style="width:9%;">来源</th>
                <th style="width:15%;">摘要</th>
                <th class="center" style="width:8%;">操作</th>
              </tr></thead>
              <tbody>
                <tr v-for="r in entryRows" :key="r.id"
                    :class="{ 'row-sel': esel.isSelected(r.id) }">
                  <td class="center">
                    <input v-if="r.source !== 'time_labor'" type="checkbox"
                           :checked="esel.isSelected(r.id)"
                           @change="esel.setChecked(r.id, $event.target.checked)" />
                    <span v-else style="color:var(--faint);" title="工时自动归集，不可删除">—</span>
                  </td>
                  <td class="num">{{ r.period }}</td>
                  <td class="num">{{ r.project_code || '—' }}</td>
                  <td><span class="chip gray">{{ catLabel(r.category) }}</span></td>
                  <td>{{ r.sub_item || '—' }}</td>
                  <td class="money num" :style="r.direction === 'in' ? 'color:var(--bad)' : ''">
                    {{ r.direction === 'in' ? '-' : '' }}{{ fmtW(r.amount) }}
                  </td>
                  <td class="num" style="font-size:12px;">{{ r.voucher_no || '—' }}</td>
                  <td class="center">
                    <span class="chip" :class="r.source === 'time_labor' ? 'info' : 'gray'">
                      {{ r.source === 'time_labor' ? '工时归集' : '手工' }}
                    </span>
                  </td>
                  <td style="font-size:12px;color:var(--sub);">{{ (r.summary || '').slice(0, 30) }}</td>
                  <td class="center">
                    <button v-if="r.source !== 'time_labor'" class="btn bad sm" @click="delEntry(r)">删除</button>
                    <span v-else style="font-size:11px;color:var(--faint);">自动</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="card-b" style="border-top:1px solid var(--line);">
          <button class="btn pri" @click="openEntry()">＋ 新增费用</button>
        </div>
      </div>
    </LoadState>

    <!-- ============ 弹窗：公共费用 ============ -->
    <Modal v-if="sharedForm" :title="sharedForm.id ? '编辑公共费用' : '新增公共费用'" @close="sharedForm = null">
      <div class="form-row">
        <label>费用项目名称 *</label>
        <input v-model.trim="sharedForm.item" class="input" placeholder="如：厂房折旧、水电费、房租">
      </div>
      <div class="form-row">
        <label>费用类别</label>
        <select v-model="sharedForm.category" class="input">
          <option v-for="c in CATS" :key="c.k" :value="c.k">{{ c.name }}</option>
        </select>
      </div>
      <div class="form-row">
        <label>费用总额（万元）</label>
        <input v-model.number="sharedForm.total_amount" class="input" type="number" step="0.01">
      </div>
      <div class="form-row">
        <label>分摊基数合计（如总面积/总工时）</label>
        <input v-model.number="sharedForm.basis_total" class="input" type="number" step="0.01">
      </div>
      <div class="form-row">
        <label>其中研发使用量</label>
        <input v-model.number="sharedForm.basis_rd" class="input" type="number" step="0.01">
      </div>
      <div class="form-row">
        <label>分摊依据说明</label>
        <input v-model.trim="sharedForm.basis_note" class="input" placeholder="如：按研发场地面积占比分摊">
      </div>
      <template #footer>
        <button class="btn ghost" @click="sharedForm = null">取消</button>
        <button class="btn pri" :disabled="busy || !sharedForm.item" @click="saveShared">保存</button>
      </template>
    </Modal>

    <!-- ============ 弹窗：委外 ============ -->
    <Modal v-if="osForm" :title="osForm.id ? '编辑委外研发' : '新增委外研发'" width="620px" @close="osForm = null">
      <div class="form-row">
        <label>类型</label>
        <select v-model="osForm.kind" class="input">
          <option>委托研发</option><option>合作研发</option>
        </select>
      </div>
      <div class="form-row">
        <label>受托 / 合作单位 *</label>
        <input v-model.trim="osForm.party" class="input">
      </div>
      <div class="form-row">
        <label>对应项目</label>
        <select v-model="osForm.project_id" class="input">
          <option :value="null">未指定</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.code }} · {{ p.name }}</option>
        </select>
      </div>
      <div class="form-row">
        <label>委外研发内容</label>
        <input v-model.trim="osForm.content" class="input">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-row"><label>合同金额（万元）</label>
          <input v-model.number="osForm.amount" class="input" type="number" step="0.01"></div>
        <div class="form-row"><label>实际发生额（万元）</label>
          <input v-model.number="osForm.actual_amount" class="input" type="number" step="0.01"></div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-row"><label>境内 / 境外</label>
          <select v-model="osForm.is_domestic" class="input">
            <option :value="true">境内</option><option :value="false">境外</option>
          </select></div>
        <div class="form-row"><label>是否关联方</label>
          <select v-model="osForm.is_related" class="input">
            <option :value="false">否</option><option :value="true">是</option>
          </select></div>
      </div>
      <div class="form-row">
        <label>科技部门登记号</label>
        <input v-model.trim="osForm.tech_reg_no" class="input" placeholder="如：川技登2026-0XXX号">
      </div>
      <template #footer>
        <button class="btn ghost" @click="osForm = null">取消</button>
        <button class="btn pri" :disabled="busy || !osForm.party" @click="saveOutsource">保存</button>
      </template>
    </Modal>

    <!-- ============ 弹窗：费用明细 ============ -->
    <Modal v-if="entryForm" title="新增费用明细" @close="entryForm = null">
      <div class="form-row">
        <label>所属月份</label>
        <input v-model="entryForm.period" class="input" type="month">
      </div>
      <div class="form-row">
        <label>研发项目</label>
        <select v-model="entryForm.project_id" class="input">
          <option :value="null">未指定</option>
          <option v-for="p in projects" :key="p.id" :value="p.id">{{ p.code }} · {{ p.name }}</option>
        </select>
      </div>
      <div class="form-row">
        <label>费用类别</label>
        <select v-model="entryForm.category" class="input">
          <option v-for="c in CATS" :key="c.k" :value="c.k">{{ c.name }}</option>
        </select>
      </div>
      <div class="form-row">
        <label>明细科目</label>
        <input v-model.trim="entryForm.sub_item" class="input" placeholder="如：工业相机模组采购">
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">
        <div class="form-row"><label>金额（万元）</label>
          <input v-model.number="entryForm.amount" class="input" type="number" step="0.01"></div>
        <div class="form-row"><label>方向</label>
          <select v-model="entryForm.direction" class="input">
            <option value="out">费用发生</option><option value="in">冲减</option>
          </select></div>
      </div>
      <div class="form-row">
        <label>凭证号</label>
        <input v-model.trim="entryForm.voucher_no" class="input">
      </div>
      <template #footer>
        <button class="btn ghost" @click="entryForm = null">取消</button>
        <button class="btn pri" :disabled="busy || !entryForm.amount" @click="saveEntry">保存</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { costingApi } from '../api.js';
import { api } from '../api.js';
import LoadState from '../components/LoadState.vue';
import Modal from '../components/Modal.vue';
import SelectAllBox from '../components/SelectAllBox.vue';
import BulkBar from '../components/BulkBar.vue';
import { useSelection } from '../composables/useSelection.js';
import { fmtMoney, fmtHours, periodLabel, currentPeriod, recentPeriods } from '../utils.js';

const CATS = [
  { k: 'labor', name: '一、人员人工费用' }, { k: 'direct', name: '二、直接投入费用' },
  { k: 'dep', name: '三、折旧费用' }, { k: 'amort', name: '四、无形资产摊销' },
  { k: 'design', name: '五、新产品设计费等' }, { k: 'other', name: '六、其他相关费用' },
];
const CAT_NAME = Object.fromEntries(CATS.map((c) => [c.k, c.name]));

const periods = recentPeriods();
const period = ref(currentPeriod());
const tab = ref('overview');
const busy = ref(false);

const sum = ref(null);
const loading = ref(false), error = ref('');

const labor = ref(null);
const laborLoading = ref(false), laborError = ref('');

const sharedRows = ref([]);
const sharedLoading = ref(false), sharedError = ref('');
const sharedForm = ref(null);

const osRows = ref([]);
const osLoading = ref(false), osError = ref('');
const osForm = ref(null);

const entryRows = ref([]);
const entryLoading = ref(false), entryError = ref('');
const entryForm = ref(null);
// 只有手工录入的费用可批量删除
const deletableIds = computed(() => entryRows.value.filter((r) => r.source !== 'time_labor').map((r) => r.id));
const esel = useSelection(() => deletableIds.value);

async function bulkDeleteEntries() {
  const ids = esel.list.value;
  if (!ids.length) return;
  if (!confirm(`确认删除选中的 ${ids.length} 条费用记录？`)) return;
  busy.value = true;
  try {
    const r = await costingApi.bulkDeleteEntries(ids);
    window.__toast?.(r.message ? `已删除 ${r.deleted} 条；${r.message}` : `已删除 ${r.deleted} 条`, 'ok');
    esel.clear();
    await loadEntries(); await load();
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { busy.value = false; }
}




const fmtW = (v) => Number(v ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtH = fmtHours;
const catLabel = (k) => (CAT_NAME[k] ?? k).replace(/^[一二三四五六]、/, '');
const pct = (a, b) => (Number(b) ? ((Number(a) / Number(b)) * 100).toFixed(1) + '%' : '—');
const sumField = (rows, f) => rows.reduce((a, r) => a + Number(r[f] ?? 0), 0);

async function load() {
  loading.value = true; error.value = '';
  try {
    const r = await costingApi.entries({ period: period.value });
    const byProj = new Map();
    const byCat = { labor: 0, direct: 0, dep: 0, amort: 0, design: 0, other: 0 };
    for (const e of r.rows) {
      const amt = (e.direction === 'in' ? -1 : 1) * Number(e.amount);
      byCat[e.category] = (byCat[e.category] ?? 0) + amt;
      const key = e.project_code ?? '—';
      if (!byProj.has(key)) {
        byProj.set(key, { code: e.project_code ?? '—', name: e.project_name ?? '(未指定项目)', cost: { labor: 0, direct: 0, dep: 0, amort: 0, design: 0, other: 0 } });
      }
      const p = byProj.get(key);
      p.cost[e.category] = (p.cost[e.category] ?? 0) + amt;
    }
    const projs = [...byProj.values()].map((p) => ({
      ...p, total: Object.values(p.cost).reduce((a, b) => a + b, 0),
    })).filter((p) => p.total !== 0 || p.code !== '—');
    const total = Object.values(byCat).reduce((a, b) => a + b, 0);
    const base5 = total - byCat.other;
    const otherCap = base5 * 10 / 90;
    sum.value = {
      projects: projs, byCat, total, base5, otherCap,
      otherAllowed: Math.min(byCat.other, otherCap),
      otherExcess: Math.max(0, byCat.other - otherCap),
      projectCount: projs.length,
    };
  } catch (e) { error.value = e.message; }
  finally { loading.value = false; }
}

async function loadLabor() {
  laborLoading.value = true; laborError.value = '';
  try { labor.value = await costingApi.laborPreview(period.value); }
  catch (e) { laborError.value = e.message; }
  finally { laborLoading.value = false; }
}

async function applyLabor() {
  busy.value = true;
  try {
    const r = await costingApi.laborApply(period.value);
    window.__toast?.(`归集完成：新增 ${r.stats.inserted} 条，更新 ${r.stats.updated} 条，合计 ${r.totalWan} 万元`, 'ok');
    await loadLabor(); await load();
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { busy.value = false; }
}

async function loadShared() {
  sharedLoading.value = true; sharedError.value = '';
  try { sharedRows.value = (await costingApi.shared({ period: period.value })).rows; }
  catch (e) { sharedError.value = e.message; }
  finally { sharedLoading.value = false; }
}
function openShared() {
  sharedForm.value = { item: '', category: 'dep', total_amount: 0, basis_total: 0, basis_rd: 0, basis_note: '', period: period.value };
}
function editShared(r) { sharedForm.value = { ...r }; }
async function saveShared() {
  busy.value = true;
  try {
    const f = sharedForm.value;
    const payload = { ...f, period: period.value };
    if (f.id) await costingApi.updateShared(f.id, payload);
    else await costingApi.createShared(payload);
    window.__toast?.('已保存', 'ok'); sharedForm.value = null; await loadShared(); await load();
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { busy.value = false; }
}
async function delShared(r) {
  if (!confirm(`确认删除「${r.item}」？`)) return;
  try { await costingApi.deleteShared(r.id); window.__toast?.('已删除', 'ok'); await loadShared(); await load(); }
  catch (e) { window.__toast?.(e.message, 'err'); }
}

async function loadOutsource() {
  osLoading.value = true; osError.value = '';
  try { osRows.value = (await costingApi.outsource()).rows; }
  catch (e) { osError.value = e.message; }
  finally { osLoading.value = false; }
}
function openOutsource() {
  osForm.value = { kind: '委托研发', party: '', project_id: null, content: '', amount: 0,
    actual_amount: 0, is_domestic: true, is_related: false, tech_reg_no: '' };
}
function editOutsource(r) { osForm.value = { ...r }; }
async function saveOutsource() {
  busy.value = true;
  try {
    const f = osForm.value;
    if (f.id) await costingApi.updateOutsource(f.id, f);
    else await costingApi.createOutsource(f);
    window.__toast?.('已保存', 'ok'); osForm.value = null; await loadOutsource();
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { busy.value = false; }
}
async function delOutsource(r) {
  if (!confirm(`确认删除「${r.party}」的委外记录？`)) return;
  try { await costingApi.deleteOutsource(r.id); window.__toast?.('已删除', 'ok'); await loadOutsource(); }
  catch (e) { window.__toast?.(e.message, 'err'); }
}

async function loadEntries() {
  entryLoading.value = true; entryError.value = '';
  try { entryRows.value = (await costingApi.entries({ period: period.value })).rows; }
  catch (e) { entryError.value = e.message; }
  finally { entryLoading.value = false; }
}
function openEntry() {
  entryForm.value = { period: period.value, project_id: null, category: 'direct', sub_item: '', amount: 0, direction: 'out', voucher_no: '' };
}
async function saveEntry() {
  busy.value = true;
  try {
    await costingApi.createEntry(entryForm.value);
    window.__toast?.('已保存', 'ok'); entryForm.value = null; await loadEntries(); await load();
  } catch (e) { window.__toast?.(e.message, 'err'); }
  finally { busy.value = false; }
}
async function delEntry(r) {
  if (!confirm('确认删除该费用记录？')) return;
  try { await costingApi.deleteEntry(r.id); window.__toast?.('已删除', 'ok'); await loadEntries(); await load(); }
  catch (e) { window.__toast?.(e.message, 'err'); }
}

onMounted(async () => {
  await load();
  loadShared(); loadOutsource(); loadEntries();
});
</script>

<style scoped>
tr.row-sel { background: var(--primary-soft) !important; }

/* 项目成员/审批人选择器 */
.member-picker { border: 1px solid var(--line2); border-radius: 8px; overflow: hidden; }
.member-toolbar {
  display: flex; gap: 8px; align-items: center; padding: 8px;
  background: var(--surface-2); border-bottom: 1px solid var(--line);
}
.member-search {
  flex: 1; height: 30px; padding: 0 10px; border: 1px solid var(--line2);
  border-radius: 7px; font-size: 13px; font-family: inherit;
}
.member-search:focus { outline: none; border-color: var(--primary2); box-shadow: 0 0 0 3px rgba(4,159,215,.12); }
.member-list { max-height: 240px; overflow: auto; }
.member-item {
  display: flex; align-items: center; gap: 8px; padding: 6px 10px;
  font-size: 13px; color: var(--ink); cursor: pointer; border-bottom: 1px solid #F4F6F9;
}
.member-item:hover { background: var(--surface-2); }
.member-item.on { background: var(--primary-soft); }
.member-name { font-weight: 500; }
.member-meta { color: var(--sub); font-size: 12px; }
.member-empty { padding: 20px; text-align: center; color: var(--faint); font-size: 13px; }
</style>
