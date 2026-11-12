<template>
  <div>
    <div class="page-head">
      <div>
        <div class="page-title">研发项目</div>
        <div class="page-desc">维护研发项目立项信息、项目成员与审批人配置。项目是工时填报与费用归集的基础。</div>
      </div>
      <div class="controls">
        <button class="btn pri" @click="openNewProject">＋ 新建项目</button>
      </div>
    </div>

    <LoadState :loading="projLoading" :error="projError" @retry="loadProjects">
      <div class="card">
        <div class="card-h">
          <div class="card-t">研发项目管理</div>
          <div class="card-s">{{ projects.length }} 个项目</div>
        </div>
        <div class="card-b flush">
          <div v-if="!projects.length" class="empty">暂无项目，点右上角「新建项目」开始</div>
          <div v-else class="tbl-wrap">
            <table style="min-width:980px;">
              <thead>
                <tr>
                  <th style="width:12%;">项目号</th>
                  <th style="width:22%;">项目名称</th>
                  <th style="width:18%;">审批人（或签）</th>
                  <th class="center" style="width:9%;">类型</th>
                  <th class="center" style="width:10%;">成员数</th>
                  <th class="center" style="width:9%;">状态</th>
                  <th style="width:15%;">说明</th>
                  <th class="center" style="width:13%;">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in projects" :key="p.id">
                  <td class="num">{{ p.code }}</td>
                  <td>{{ p.name }}</td>
                  <td style="font-size:12px;">
                    <template v-if="p.approvers?.length">
                      <span v-for="(a, i) in p.approvers" :key="a.id">
                        {{ a.name }}<span v-if="i < p.approvers.length - 1">、</span>
                      </span>
                    </template>
                    <span v-else class="chip warn" title="未配置审批人，报工将只能由 HR/管理员审批">
                      <span class="dot"></span>未配置
                    </span>
                  </td>
                  <td class="center">
                    <span class="chip" :class="p.isRnd ? 'pri' : 'gray'">{{ p.isRnd ? '研发' : '非研发' }}</span>
                  </td>
                  <td class="center num">{{ p.memberCount }}</td>
                  <td class="center">
                    <span class="chip" :class="p.isActive ? 'ok' : 'gray'">
                      <span class="dot"></span>{{ p.isActive ? '启用' : '停用' }}
                    </span>
                  </td>
                  <td style="font-size:12px;color:var(--sub);">{{ p.description || '—' }}</td>
                  <td class="center">
                    <button class="btn ghost sm" @click="openEditProject(p)">编辑</button>
                    <button class="btn bad sm" style="margin-left:4px;" @click="delProject(p)">删除</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </LoadState>

<Modal v-if="editingProject" :title="editingProject.id ? '编辑项目' : '新建项目'" width="600px" @close="editingProject = null">
      <div class="form-row">
        <label>项目号（如 RD-2026-005）</label>
        <input v-model.trim="projForm.code" class="input" :disabled="!!editingProject.id">
      </div>
      <div class="form-row">
        <label>项目名称</label>
        <input v-model.trim="projForm.name" class="input">
      </div>
      <div class="form-row">
        <label>项目负责人</label>
        <select v-model="projForm.owner_id" class="input">
          <option :value="null">未指定</option>
          <option v-for="u in users" :key="u.id" :value="u.id">
            {{ u.displayName }}{{ u.employeeNo ? ' · ' + u.employeeNo : '' }}
          </option>
        </select>
      </div>
      <div class="form-row">
        <label>
          项目审批人（可多选，任一审批人批准即通过）
          <span style="color:var(--primary);font-weight:600;">已选 {{ approverIds.length }} 人</span>
        </label>
        <div class="member-picker">
          <div class="member-toolbar">
            <input v-model.trim="approverSearch" class="member-search"
                   placeholder="搜索姓名 / 工号 / 部门…" />
            <button type="button" class="btn ghost sm" :disabled="!approverFiltered.length"
                    @click="toggleApproverAll">
              {{ approverAllSelected ? '取消全选' : `全选（${approverFiltered.length}）` }}
            </button>
            <button type="button" class="btn ghost sm" :disabled="!approverIds.length"
                    @click="approverIds = []">清空</button>
          </div>
          <div class="member-list">
            <label v-for="u in approverFiltered" :key="'ap' + u.id" class="member-item"
                   :class="{ on: approverIds.includes(u.id) }">
              <input type="checkbox" :value="u.id" v-model="approverIds" />
              <span class="member-name">{{ u.displayName }}</span>
              <span class="member-meta">
                {{ u.employeeNo || '无工号' }}
                <template v-if="u.department"> · {{ u.department }}</template>
                <span v-if="u.role === 'pm'" class="chip pri" style="margin-left:4px;font-size:10px;">项目负责人</span>
              </span>
            </label>
            <div v-if="!approverFiltered.length" class="member-empty">没有匹配的人员</div>
          </div>
        </div>
        <div class="form-tip" style="font-size:11.5px;color:var(--faint);margin-top:4px;">
          不配置审批人时，该项目报工将只能由人力资源部/管理员审批。
        </div>
      </div>

      <div class="form-row">
        <label>说明</label>
        <input v-model.trim="projForm.description" class="input">
      </div>
      <div class="form-row" style="display:flex;gap:20px;align-items:center;">
        <label style="margin:0;display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink);">
          <input v-model="projForm.is_rnd" type="checkbox"> 研发项目（计入研发费用）
        </label>
        <label style="margin:0;display:flex;gap:6px;align-items:center;font-size:13px;color:var(--ink);">
          <input v-model="projForm.is_active" type="checkbox"> 启用
        </label>
      </div>
      <div class="form-row">
        <label>
          项目成员（不选表示全员可报工）
          <span style="color:var(--primary);font-weight:600;">已选 {{ memberIds.length }} 人</span>
        </label>

        <!-- 成员选择器：搜索 + 全选/反选 + 一键清空 -->
        <div class="member-picker">
          <div class="member-toolbar">
            <input v-model.trim="memberSearch" class="member-search"
                   placeholder="搜索姓名 / 工号 / 部门…" />
            <button type="button" class="btn ghost sm"
                    :disabled="!memberFiltered.length"
                    @click="toggleMemberAll">
              {{ memberAllSelected ? '取消全选' : `全选（${memberFiltered.length}）` }}
            </button>
            <button type="button" class="btn ghost sm" :disabled="!approverIds.length"
                    title="把已选的审批人也加为成员"
                    @click="memberIds = [...new Set([...memberIds, ...approverIds])]">
              同步审批人
            </button>
            <button type="button" class="btn ghost sm" :disabled="!memberIds.length"
                    @click="memberIds = []">清空</button>
          </div>
          <div class="member-list">
            <label v-for="u in memberFiltered" :key="u.id" class="member-item"
                   :class="{ on: memberIds.includes(u.id) }">
              <input type="checkbox" :value="u.id" v-model="memberIds" />
              <span class="member-name">{{ u.displayName }}</span>
              <span class="member-meta">
                {{ u.employeeNo || '无工号' }}
                <template v-if="u.department"> · {{ u.department }}</template>
              </span>
            </label>
            <div v-if="!memberFiltered.length" class="member-empty">
              没有匹配「{{ memberSearch }}」的人员
            </div>
          </div>
        </div>
      </div>
      <template #footer>
        <button class="btn ghost" @click="editingProject = null">取消</button>
        <button class="btn pri" :disabled="projBusy || !projForm.code || !projForm.name" @click="saveProject">保存</button>
      </template>
    </Modal>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { api } from '../api.js';
import LoadState from '../components/LoadState.vue';
import Modal from '../components/Modal.vue';

const users = ref([]);      // 审批人/成员候选                 // 人员候选（审批人 / 项目成员）
const projects = ref([]);
const projLoading = ref(false);
const projError = ref('');
const editingProject = ref(null);
const projForm = ref({ code: '', name: '', owner_id: null, description: '', is_rnd: true, is_active: true });
const memberIds = ref([]);
const memberSearch = ref('');
const approverIds = ref([]);
const approverSearch = ref('');

/** 审批人候选（pm 角色排前，便于快速找到） */
const approverFiltered = computed(() => {
  const q = approverSearch.value.toLowerCase();
  let list = users.value.filter((u) => u.isActive !== false);
  if (q) {
    list = list.filter((u) =>
      (u.displayName || '').toLowerCase().includes(q)
      || (u.employeeNo || '').toLowerCase().includes(q)
      || (u.department || '').toLowerCase().includes(q));
  }
  return [...list].sort((a, b) => (b.role === 'pm') - (a.role === 'pm'));
});

const approverAllSelected = computed(() =>
  approverFiltered.value.length > 0
  && approverFiltered.value.every((u) => approverIds.value.includes(u.id)));

function toggleApproverAll() {
  const visible = approverFiltered.value.map((u) => u.id);
  if (approverAllSelected.value) {
    approverIds.value = approverIds.value.filter((id) => !visible.includes(id));
  } else {
    approverIds.value = [...new Set([...approverIds.value, ...visible])];
  }
}

/** 项目成员候选 */
const memberFiltered = computed(() => {
  const q = memberSearch.value.toLowerCase();
  if (!q) return users.value;
  return users.value.filter((u) =>
    (u.displayName || '').toLowerCase().includes(q)
    || (u.employeeNo || '').toLowerCase().includes(q)
    || (u.department || '').toLowerCase().includes(q));
});

const memberAllSelected = computed(() =>
  memberFiltered.value.length > 0 &&
  memberFiltered.value.every((u) => memberIds.value.includes(u.id)));

function toggleMemberAll() {
  const visible = memberFiltered.value.map((u) => u.id);
  if (memberAllSelected.value) {
    memberIds.value = memberIds.value.filter((id) => !visible.includes(id));
  } else {
    memberIds.value = [...new Set([...memberIds.value, ...visible])];
  }
}
const projBusy = ref(false);


async function loadProjects() {
  projLoading.value = true;
  projError.value = '';
  try {
    const r = await api.adminProjects();
    projects.value = r.rows;
  } catch (e) {
    projError.value = e.message;
  } finally {
    projLoading.value = false;
  }
}

function openNewProject() {
  editingProject.value = { id: null };
  approverIds.value = [];
  approverSearch.value = '';
  projForm.value = { code: 'RD-' + new Date().getFullYear() + '-', name: '', owner_id: null, description: '', is_rnd: true, is_active: true };
  memberIds.value = [];
}

async function openEditProject(p) {
  editingProject.value = p;
  projForm.value = {
    code: p.code, name: p.name, owner_id: p.ownerId ?? null,
    description: p.description ?? '', is_rnd: p.isRnd, is_active: p.isActive,
  };
  memberIds.value = [];
  approverIds.value = [];
  approverSearch.value = '';
  try {
    const [m, a] = await Promise.all([
      api.projectMembers(p.id),
      api.projectApprovers(p.id),
    ]);
    memberIds.value = m.rows.map((x) => x.user_id);
    approverIds.value = a.rows.map((x) => x.user_id);
  } catch { /* 忽略 */ }
}

/** 删除项目（仅当无任何业务数据时允许，否则提示停用）。 */
async function delProject(p) {
  if (!confirm(`确认删除项目「${p.code} ${p.name}」？\n\n仅当该项目没有任何工时、费用、审批、台账数据时才能删除；否则请使用「停用」。`)) return;
  try {
    await api.deleteProject(p.id);
    window.__toast?.('项目已删除', 'ok');
    await loadProjects();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  }
}

async function saveProject() {
  projBusy.value = true;
  try {
    let projectId = editingProject.value.id;
    if (projectId) {
      await api.updateProject(projectId, projForm.value);
      await api.setProjectMembers(projectId, memberIds.value);
    } else {
      const r = await api.createProject(projForm.value);
      projectId = r.project.id;
      if (memberIds.value.length) await api.setProjectMembers(projectId, memberIds.value);
    }
    // 审批人（可为空 = 由 HR/管理员兜底）
    await api.setProjectApprovers(projectId, approverIds.value);
    window.__toast?.('已保存', 'ok');
    editingProject.value = null;
    await loadProjects();
  } catch (e) {
    window.__toast?.(e.message, 'err');
  } finally {
    projBusy.value = false;
  }
}




onMounted(async () => {
  // 人员列表仅用于「审批人/成员」选择。
  // 无用户管理权限的角色（如普通员工）调用会 403，
  // 此时降级为空列表——项目列表照常展示，不影响查看。
  try {
    const r = await api.users({});
    users.value = r.rows;
  } catch { users.value = []; }
  await loadProjects();
});
</script>

<style scoped>
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
