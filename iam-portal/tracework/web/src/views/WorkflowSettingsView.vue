<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">流程设置</div>
        <div class="page-desc">
          配置工时审批流程包含哪些节点。关闭的节点会被<strong>自动跳过</strong>，申请将直接流转到下一个启用的节点。
        </div>
      </div>
      <div class="controls">
        <button class="btn pri" :disabled="saving || !dirty" @click="save">
          {{ saving ? '保存中…' : '保存设置' }}
        </button>
      </div>
    </div>

    <LoadState :loading="loading" :error="error" @retry="load">
      <!-- 当前流程链 -->
      <div class="card">
        <div class="card-h">
          <div class="card-t">当前生效流程</div>
          <div class="card-s" v-if="meta.updatedAt">
            最后修改：{{ meta.updatedAt }}<template v-if="meta.updatedBy"> · {{ meta.updatedBy }}</template>
          </div>
        </div>
        <div class="card-b">
          <div class="flow-chain">
            <div v-for="(node, i) in chainNodes" :key="node.key" class="fc-node">
              <div class="fc-box" :class="{ skip: !node.enabled, final: node.final }">
                <div class="fc-name">{{ node.label }}</div>
                <div class="fc-role">{{ node.roleLabel }}</div>
                <div v-if="!node.enabled" class="fc-off">已跳过</div>
              </div>
              <div v-if="i < chainNodes.length - 1" class="fc-arrow">→</div>
            </div>
          </div>
          <div class="hint" style="margin-top:14px;margin-bottom:0;">
            <b>填报提交</b> 后进入上方第一个未关闭的节点；若全部关闭，提交后立即归档。
          </div>
        </div>
      </div>

      <!-- 节点开关 -->
      <div class="card">
        <div class="card-h">
          <div class="card-t">节点开关</div>
          <div class="card-s">至少保留一个节点，或全部关闭直接归档</div>
        </div>
        <div class="card-b">
          <div v-for="n in toggles" :key="n.key" class="toggle-row">
            <div class="tg-switch" :class="{ on: form[n.key] }" @click="toggle(n.key)">
              <div class="tg-knob"></div>
            </div>
            <div class="tg-info">
              <div class="tg-title">
                {{ n.label }}
                <span class="chip" :class="form[n.key] ? 'ok' : 'gray'" style="margin-left:8px;">
                  <span class="dot"></span>{{ form[n.key] ? '启用' : '跳过' }}
                </span>
              </div>
              <div class="tg-desc">{{ n.desc }}</div>
            </div>
          </div>

          <div v-if="!anyEnabled" class="alert warn" style="margin-top:14px;">
            所有节点均已关闭 —— 工时提交后将<strong>直接归档</strong>，无需任何人审批。
            请确认这是预期行为。
          </div>
        </div>
      </div>

      <!-- 说明 -->
      <div class="card">
        <div class="card-h"><div class="card-t">说明</div></div>
        <div class="card-b" style="font-size:13px;color:var(--sub);line-height:1.8;">
          <p style="margin:0 0 8px;">
            <b>项目审批</b>：由项目配置的审批人（可多位，或签）审批各自的工时。
            项目未配置审批人时，由人力资源部/管理员兜底。
          </p>
          <p style="margin:0 0 8px;">
            <b>人事确认</b>：人力资源部确认工时并维护月薪，写入薪酬快照。
          </p>
          <p style="margin:0 0 8px;">
            <b>财务确认</b>：财务部确认人工费用与分摊比例，确认后工时归档，进入归档工时列表。
          </p>
          <p style="margin:0;">
            修改设置只影响<strong>之后新提交</strong>的工时单；已在流程中的单据按原流程走完。
          </p>
        </div>
      </div>
    </LoadState>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import { useAppStore } from '../store.js';
import LoadState from '../components/LoadState.vue';

const store = useAppStore();
const loading = ref(false);
const error = ref('');
const saving = ref(false);
const meta = ref({ updatedAt: null, updatedBy: null });

const form = ref({ enableProject: true, enableHr: true, enableFinance: true });
const saved = ref({ enableProject: true, enableHr: true, enableFinance: true });

const dirty = computed(() =>
  JSON.stringify(form.value) !== JSON.stringify(saved.value));

const anyEnabled = computed(() =>
  form.value.enableProject || form.value.enableHr || form.value.enableFinance);

const TOGGLES = [
  {
    key: 'enableProject', stage: 'stage1_project', label: '项目审批',
    desc: '项目审批人（或签）确认工时。关闭后提交即跳过项目审批。',
  },
  {
    key: 'enableHr', stage: 'stage2_hr', label: '人事确认',
    desc: '人力资源部确认工时并维护月薪。关闭后不经过人事环节。',
  },
  {
    key: 'enableFinance', stage: 'stage3_finance', label: '财务确认',
    desc: '财务部确认人工费用与分摊比例。关闭后不经财务确认，直接归档。',
  },
];

const toggles = computed(() =>
  TOGGLES.map((t) => ({ ...t, enabled: form.value[t.key] })));

const ROLE_LABEL = {
  stage1_project: '项目审批人',
  stage2_hr: '人力资源部',
  stage3_finance: '财务部',
  archived: '系统归档',
};

const chainNodes = computed(() => {
  const nodes = [
    { key: 'stage1_project', label: '项目审批', enabled: form.value.enableProject },
    { key: 'stage2_hr', label: '人事确认', enabled: form.value.enableHr },
    { key: 'stage3_finance', label: '财务确认', enabled: form.value.enableFinance },
    { key: 'archived', label: '已归档', enabled: true, final: true },
  ];
  return nodes.map((n) => ({ ...n, roleLabel: ROLE_LABEL[n.key] ?? '' }));
});

function toggle(key) {
  if (store.user?.role !== 'admin') {
    window.__toast?.('仅系统管理员可修改流程设置', 'err');
    return;
  }
  form.value[key] = !form.value[key];
}

async function load() {
  loading.value = true;
  error.value = '';
  try {
    const r = await api.workflowSettings();
    form.value = {
      enableProject: r.enableProject,
      enableHr: r.enableHr,
      enableFinance: r.enableFinance,
    };
    saved.value = { ...form.value };
    meta.value = { updatedAt: r.updatedAt, updatedBy: r.updatedBy };
  } catch (e) {
    error.value = e.message;
  } finally {
    loading.value = false;
  }
}

async function save() {
  saving.value = true;
  try {
    await api.updateWorkflowSettings(form.value);
    saved.value = { ...form.value };
    window.__toast?.('流程设置已保存', 'ok');
    await load();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  } finally {
    saving.value = false;
  }
}

onMounted(load);
</script>

<style scoped>
.flow-chain { display: flex; align-items: center; flex-wrap: wrap; gap: 6px; }
.fc-node { display: flex; align-items: center; gap: 6px; }
.fc-box {
  min-width: 118px; padding: 12px 16px; border-radius: 10px; text-align: center;
  background: var(--primary-soft); border: 1.5px solid var(--primary2);
}
.fc-box.skip { background: var(--surface-2); border-color: var(--line2); opacity: 0.65; }
.fc-box.final { background: #E8F5E9; border-color: #A5D6A7; }
.fc-name { font-size: 13.5px; font-weight: 700; color: var(--ink); }
.fc-role { font-size: 11.5px; color: var(--sub); margin-top: 2px; }
.fc-off { font-size: 11px; color: var(--faint); margin-top: 4px; }
.fc-arrow { color: var(--faint); font-size: 16px; }

.toggle-row {
  display: flex; align-items: flex-start; gap: 14px;
  padding: 14px 0; border-bottom: 1px solid var(--line);
}
.toggle-row:last-of-type { border-bottom: 0; }
.tg-switch {
  width: 44px; height: 24px; border-radius: 12px; background: var(--line2);
  position: relative; cursor: pointer; transition: background .18s; flex-shrink: 0; margin-top: 2px;
}
.tg-switch.on { background: var(--ok); }
.tg-knob {
  position: absolute; top: 2px; left: 2px; width: 20px; height: 20px;
  border-radius: 50%; background: #fff; transition: left .18s;
  box-shadow: 0 1px 3px rgba(0,0,0,.2);
}
.tg-switch.on .tg-knob { left: 22px; }
.tg-title { font-size: 14px; font-weight: 700; color: var(--ink); }
.tg-desc { font-size: 12.5px; color: var(--sub); margin-top: 4px; line-height: 1.6; }
</style>