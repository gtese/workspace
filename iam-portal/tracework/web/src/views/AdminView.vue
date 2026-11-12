<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">用户管理</div>
        <div class="page-desc">管理系统用户角色、AD 同步、节假日日历与开放 API 密钥。员工名册与考勤请到「员工管理」。</div>
      </div>
      <div class="controls">
        <button class="btn ghost" :disabled="syncing" @click="syncAd(false)">
          {{ syncing ? '同步中…' : '立即同步 AD 用户' }}
        </button>
      </div>
    </div>

    <!-- 用户管理 -->
    <LoadState :loading="loading" :error="error" @retry="load">
      <div class="card">
        <div class="card-h">
          <div class="card-t">用户与权限</div>
          <div class="controls">
            <div class="field">
              <label>搜索</label>
              <input v-model.trim="search" placeholder="姓名/账号/工号" @input="debouncedLoad">
            </div>
            <div class="field">
              <label>显示</label>
              <select v-model="showAll" @change="load">
                <option :value="false">仅在职</option>
                <option :value="true">全部（含禁用/已删除）</option>
              </select>
            </div>
          </div>
        </div>
        <div class="card-b flush">
          <div v-if="!rows.length" class="empty">没有匹配的用户</div>
          <div v-else class="tbl-wrap">
            <table style="min-width:1100px;">
              <thead>
                <tr>
                  <th style="width:11%;">域账号</th>
                  <th style="width:11%;">姓名</th>
                  <th style="width:10%;">工号</th>
                  <th style="width:12%;">角色</th>
                  <th style="width:13%;">研发类型</th>
                  <th class="money" style="width:12%;">月薪(元)</th>
                  <th class="center" style="width:10%;">标准考勤(h)</th>
                  <th class="center" style="width:11%;">AD 状态</th>
                  <th class="center" style="width:12%;">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="u in rows" :key="u.id">
                  <td class="num" style="font-size:12px;">{{ u.username }}</td>
                  <td>{{ u.displayName }}</td>
                  <td class="num">{{ u.employeeNo || '—' }}</td>
                  <td>
                    <span class="chip" :class="roleChip(u.role)">{{ ROLE_LABEL[u.role] || u.role }}</span>
                  </td>
                  <td style="font-size:12px;color:var(--sub);">{{ typeLabel(u.employeeType) }}</td>
                  <td class="money num">{{ fmtMoney(u.monthlySalary) }}</td>
                  <td class="center num">{{ u.attendanceHours ?? '—' }}</td>
                  <td class="center">
                    <span class="chip" :class="adChipClass(u)">
                      <span class="dot"></span>{{ adLabel(u) }}
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
        <div class="card-b" style="border-top:1px solid var(--line);">
          <div style="font-size:12px;color:var(--faint);line-height:1.8;">
            用户身份信息（姓名、邮箱、部门、所属 AD 组）由 AD 同步而来，系统按小时自动刷新；
            此处维护的是<b>业务属性</b>（角色、工号、薪酬、考勤），不会被 AD 覆盖。
            初始角色由 AD 组 <code>Group_Roots</code> 推导为系统管理员，其余为普通研发人员。
          </div>
        </div>
      </div>
    </LoadState>

    <!-- 节假日 -->
    <div class="card">
      <div class="card-h">
        <div class="card-t">法定节假日日历</div>
        <div class="controls">
          <div class="field">
            <label>年份</label>
            <select v-model.number="calYear">
              <option v-for="y in calYears" :key="y" :value="y">{{ y }} 年</option>
            </select>
          </div>
        </div>
      </div>
      <div class="card-b">
        <div class="btn-row" style="margin-bottom:14px;">
          <div class="field">
            <label>日期</label>
            <input v-model="calForm.day" type="date">
          </div>
          <div class="field">
            <label>性质</label>
            <select v-model="calForm.isWorkday">
              <option :value="false">休息 / 节假日</option>
              <option :value="true">调休上班</option>
            </select>
          </div>
          <div class="field">
            <label>说明</label>
            <input v-model.trim="calForm.note" placeholder="如：国庆节">
          </div>
          <button class="btn pri" :disabled="!calForm.day" @click="saveCalendar">保存</button>
        </div>
        <div class="tbl-wrap" style="max-height:320px;overflow:auto;">
          <table>
            <thead><tr><th style="width:22%;">日期</th><th style="width:22%;">性质</th><th>说明</th><th style="width:10%;">操作</th></tr></thead>
            <tbody>
              <tr v-for="h in filteredHolidays" :key="h.day">
                <td class="num">{{ h.day }}</td>
                <td>
                  <span class="chip" :class="h.isWorkday ? 'info' : 'warn'">
                    {{ h.isWorkday ? '调休上班' : '休息/节假日' }}
                  </span>
                </td>
                <td style="color:var(--sub);font-size:12px;">{{ h.note || '—' }}</td>
                <td class="center">
                  <button class="btn bad sm" @click="delCalendar(h.day)">删除</button>
                </td>
              </tr>
              <tr v-if="!filteredHolidays.length"><td colspan="4" class="empty">{{ calYear }} 年暂无自定义日历，系统按周一至周五为工作日处理</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- API 密钥 -->
    <div class="card">
      <div class="card-h">
        <div class="card-t">开放 API 密钥</div>
        <div class="card-s">
          供外部系统调用，详见 <a href="/api/v1/openapi.json" target="_blank"
            style="color:var(--primary);">API 规范</a>
        </div>
      </div>
      <div class="card-b" style="border-bottom:1px solid var(--line);">
        <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
          <div class="field" style="flex:1;min-width:180px;">
            <label>用途名称</label>
            <input v-model.trim="keyForm.name" placeholder="如 BI 报表系统" style="width:100%;">
          </div>
          <div class="field" style="flex:1;min-width:200px;">
            <label>权限范围（留空 = 全部）</label>
            <select v-model="keyForm.preset" style="width:100%;">
              <option value="">全部权限</option>
              <option value="readonly">只读（全部领域）</option>
              <option value="timesheet">仅工时与审批</option>
              <option value="costing">仅费用与测算</option>
              <option value="asset">仅 IT 资产</option>
            </select>
          </div>
          <div class="field">
            <label>有效期</label>
            <select v-model.number="keyForm.days">
              <option :value="0">永久</option>
              <option :value="30">30 天</option>
              <option :value="90">90 天</option>
              <option :value="365">1 年</option>
            </select>
          </div>
          <button class="btn pri" :disabled="keyBusy || !keyForm.name" @click="createKey">
            {{ keyBusy ? '创建中…' : '＋ 创建密钥' }}
          </button>
        </div>
      </div>
      <div class="card-b flush">
        <div v-if="!apiKeys.length" class="empty">尚未创建 API 密钥</div>
        <div v-else class="tbl-wrap">
          <table style="min-width:980px;">
            <thead>
              <tr>
                <th style="width:20%;">用途</th>
                <th style="width:12%;">密钥前缀</th>
                <th style="width:25%;">权限范围</th>
                <th style="width:11%;">归属用户</th>
                <th class="center" style="width:9%;">调用次数</th>
                <th style="width:11%;">最后使用</th>
                <th class="center" style="width:8%;">状态</th>
                <th class="center" style="width:8%;">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="k in apiKeys" :key="k.id">
                <td>{{ k.name }}</td>
                <td class="num" style="font-size:12px;">{{ k.key_prefix }}…</td>
                <td style="font-size:12px;">
                  <span v-if="!k.scopes?.length" style="color:var(--faint);">无</span>
                  <span v-else>{{ k.scopes.join('、') }}</span>
                </td>
                <td style="font-size:12px;">{{ k.owner_name }}</td>
                <td class="center num">{{ k.call_count }}</td>
                <td class="num" style="font-size:12px;">{{ k.last_used_at_fmt || '—' }}</td>
                <td class="center">
                  <span class="chip" :class="k.is_active ? 'ok' : 'gray'">
                    <span class="dot"></span>{{ k.is_active ? '有效' : '已吊销' }}
                  </span>
                </td>
                <td class="center">
                  <button v-if="k.is_active" class="btn bad sm" @click="revokeKey(k)">吊销</button>
                  <span v-else style="color:var(--faint);font-size:12px;">—</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- 密钥明文弹窗 -->
    <Modal v-if="newKey" title="密钥已创建" width="560px" @close="newKey = null">
      <p style="font-size:13px;color:var(--sub);margin:0 0 12px;">
        请立即复制保存，关闭后将无法再次查看明文。
      </p>
      <div class="key-box">{{ newKey }}</div>
      <template #footer>
        <button class="btn ghost" @click="copyKey">复制</button>
        <button class="btn pri" @click="newKey = null">我已保存</button>
      </template>
    </Modal>

    <!-- 编辑用户 -->
    <Modal v-if="editing" :title="`编辑用户 · ${editing.displayName}`" @close="editing = null">
      <div class="form-row">
        <label>角色</label>
        <select v-model="form.role" class="input">
          <option value="employee">研发人员（仅填报与查看自己的数据）</option>
          <option value="pm">项目负责人（可审批自己负责的项目）</option>
          <option value="finance">财务部（研发费用归集、多口径测算、备查台账与资料）</option>
          <option value="hr">人力资源部（可汇总、维护考勤、审批全部）</option>
          <option value="admin">系统管理员（全部权限）</option>
        </select>
      </div>
      <div class="form-row">
        <label>员工编号</label>
        <input v-model.trim="form.employee_no" class="input" placeholder="如 E1001">
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
        <label>月薪 / 职工薪酬总额（元）—— 用于薪酬分摊</label>
        <input v-model.number="form.monthly_salary" class="input" type="number" min="0" step="100">
      </div>
      <div class="form-row">
        <label>标准考勤工时（小时/月，留空表示按工作日自动折算）</label>
        <input v-model.number="form.attendance_hours" class="input" type="number" min="0" step="0.5">
      </div>
      <div class="form-row" style="display:flex;gap:8px;align-items:center;">
        <input id="active" v-model="form.is_active" type="checkbox">
        <label for="active" style="margin:0;font-size:13px;color:var(--ink);">在职（取消勾选表示离职，将无法登录）</label>
      </div>
      <template #footer>
        <button class="btn ghost" @click="editing = null">取消</button>
        <button class="btn pri" :disabled="busy" @click="save">保存</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { api } from '../api.js';
import LoadState from '../components/LoadState.vue';
import Modal from '../components/Modal.vue';
import { fmtMoney, debounce, ROLE_LABEL, EMPLOYEE_TYPE_LABEL } from '../utils.js';

const rows = ref([]);
const loading = ref(true);
const error = ref('');
const search = ref('');
const showAll = ref(false);
const syncing = ref(false);
const busy = ref(false);

// ---- 开放 API 密钥 ----
const apiKeys = ref([]);
const keyBusy = ref(false);
const newKey = ref('');
const keyForm = ref({ name: '', preset: '', days: 0 });

const SCOPE_PRESETS = {
  readonly: ['timesheet:read', 'approval:read', 'project:read', 'costing:read',
    'summary:read', 'doc:read', 'asset:read', 'user:read'],
  timesheet: ['timesheet:*', 'approval:*', 'project:read'],
  costing: ['costing:*', 'summary:*', 'doc:*'],
  asset: ['asset:read', 'asset:write'],
};

async function loadKeys() {
  try {
    const r = await api.apiRequest('GET', '/api/v1/api-keys');
    apiKeys.value = r.data ?? [];
  } catch { apiKeys.value = []; }
}

async function createKey() {
  keyBusy.value = true;
  try {
    const scopes = keyForm.value.preset
      ? SCOPE_PRESETS[keyForm.value.preset]
      : ['*'];
    const body = { name: keyForm.value.name, scopes };
    if (keyForm.value.days > 0) {
      const d = new Date();
      d.setDate(d.getDate() + keyForm.value.days);
      body.expiresAt = d.toISOString();
    }
    const r = await api.apiRequest('POST', '/api/v1/api-keys', body);
    newKey.value = r.data.key;
    keyForm.value = { name: '', preset: '', days: 0 };
    await loadKeys();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  } finally { keyBusy.value = false; }
}

async function revokeKey(k) {
  if (!confirm(`确认吊销密钥「${k.name}」？吊销后使用该密钥的系统将立即无法访问。`)) return;
  try {
    await api.apiRequest('DELETE', `/api/v1/api-keys/${k.id}`);
    window.__toast?.('已吊销', 'ok');
    await loadKeys();
  } catch (e) { window.__toast?.(e.message, 'err'); }
}

function copyKey() {
  navigator.clipboard?.writeText(newKey.value).then(
    () => window.__toast?.('已复制到剪贴板', 'ok'),
    () => window.__toast?.('复制失败，请手动选择', 'err'));
}

const editing = ref(null);
const form = ref({});

const holidays = ref([]);
const calYears = ref([]);
const calYear = ref(new Date().getFullYear());
const filteredHolidays = computed(() =>
  holidays.value.filter((h) => String(h.day).startsWith(String(calYear.value))));
const calForm = ref({ day: '', isWorkday: false, note: '' });

const typeLabel = (t) => EMPLOYEE_TYPE_LABEL[t] ?? t;
/**
 * AD 状态标签。区分「AD 禁用」与「AD 已删除」——
 * 两者都不允许登录，但运维排查时含义完全不同。
 */
function adLabel(u) {
  const st = u.adStatus ?? 'unknown';
  if (st === 'deleted') return 'AD 已删除';
  if (st === 'disabled') return 'AD 已禁用';
  if (st === 'active') return u.isActive ? '在职' : '已停用';
  return '未知';
}
function adChipClass(u) {
  const st = u.adStatus ?? 'unknown';
  if (st === 'deleted') return 'bad';
  if (st === 'disabled') return 'warn';
  if (st === 'active') return u.isActive ? 'ok' : 'gray';
  return 'gray';
}

const roleChip = (r) => ({ admin: 'bad', hr: 'pri', finance: 'warn', pm: 'info', employee: 'gray' }[r] ?? 'gray');

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await api.users({ all: showAll.value, q: search.value || undefined });
    rows.value = r.rows;
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}
const debouncedLoad = debounce(load, 350);

function edit(u) {
  editing.value = u;
  form.value = {
    role: u.role,
    employee_no: u.employeeNo ?? '',
    employee_type: u.employeeType ?? 'fulltime_rnd',
    monthly_salary: u.monthlySalary ?? 0,
    attendance_hours: u.attendanceHours ?? null,
    is_active: u.isActive,
  };
}

async function save() {
  busy.value = true;
  try {
    const patch = { ...form.value };
    if (patch.employee_no === '') patch.employee_no = null;
    if (patch.attendance_hours === '' || patch.attendance_hours === null) patch.attendance_hours = null;
    await api.updateUser(editing.value.id, patch);
    window.__toast?.('已保存', 'ok');
    editing.value = null;
    await load();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  } finally {
    busy.value = false;
  }
}

async function syncAd() {
  syncing.value = true;
  try {
    const r = await api.syncAd(false);
    const st = r.stats ?? {};
    let msg = `AD 同步完成：新增 ${st.created ?? 0}，更新 ${st.updated ?? 0}`
      + `，禁用 ${st.disabled ?? 0}，删除 ${st.deleted ?? 0}，恢复 ${st.restored ?? 0}`;
    if (r.projectsWithoutApprover?.length) {
      msg += `；注意：${r.projectsWithoutApprover.map((p) => p.code).join('、')} 已无审批人`;
    }
    window.__toast?.(msg, r.projectsWithoutApprover?.length ? '' : 'ok');
    await load();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  } finally {
    syncing.value = false;
  }
}

async function loadHolidays() {
  try {
    const r = await api.calendarList();
    holidays.value = r.rows;
    calYears.value = r.years?.length
      ? r.years
      : [...new Set(r.rows.map((x) => Number(String(x.day).slice(0, 4))))].sort((a, b) => b - a);
    if (!calYears.value.includes(calYear.value)) {
      calYear.value = r.currentYear ?? calYears.value[0] ?? new Date().getFullYear();
    }
  } catch { /* 忽略 */ }
}

/** 删除错误的日历条目。 */
async function delCalendar(day) {
  if (!confirm(`确认删除 ${day} 的日历记录？`)) return;
  try {
    await api.deleteCalendarDay(day);
    window.__toast?.('已删除', 'ok');
    await loadHolidays();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  }
}

async function saveCalendar() {
  try {
    await api.saveCalendarDay(calForm.value);
    window.__toast?.('已保存', 'ok');
    calForm.value = { day: '', isWorkday: false, note: '' };
    await loadHolidays();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  }
}

onMounted(() => {
  load();
  loadHolidays();
  loadKeys();     // 首次进入即加载 API 密钥列表
});
onUnmounted(() => { /* debounce timer 由 GC 处理 */ });
</script>