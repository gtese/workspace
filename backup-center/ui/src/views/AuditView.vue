<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { ChevronDown, ChevronRight, RefreshCw, ScrollText, Search, X } from 'lucide-vue-next'
import PageHeader from '../components/ui/PageHeader.vue'
import BaseButton from '../components/ui/BaseButton.vue'
import StatusBadge from '../components/ui/StatusBadge.vue'
import Pagination from '../components/ui/Pagination.vue'
import LoadingSkeleton from '../components/ui/LoadingSkeleton.vue'
import ErrorState from '../components/ui/ErrorState.vue'
import EmptyState from '../components/ui/EmptyState.vue'
import { api } from '../api/index.js'
import { listOf, totalOf } from '../lib/normalize.js'
import { formatDateTime, shortId } from '../lib/format.js'

const entries = ref([])
const loading = ref(true)
const error = ref('')
const page = ref(1)
const pageSize = ref(20)
const hasNext = ref(false)
const total = ref(null)

const actorInput = ref('')
const actionInput = ref('')
const actorFilter = ref('')
const actionFilter = ref('')
const expandedId = ref('')

const ACTION_LABELS = {
  'auth.login': '登录',
  'auth.logout': '退出登录',
  'auth.oidc.login': 'OIDC 登录',
  'client.approve': '批准节点',
  'client.reject': '拒绝节点',
  'client.create': '创建节点',
  'client.update': '修改节点',
  'client.enable': '启用节点',
  'client.disable': '停用节点',
  'client.delete': '删除节点',
  'client.fs_list': '浏览节点目录',
  'enroll.request': '生成接入请求',
  'repository.create': '创建存储库',
  'repository.update': '修改存储库',
  'repository.delete': '删除存储库',
  'repository.validate': '校验存储库',
  'plan.create': '创建计划',
  'plan.update': '修改计划',
  'plan.delete': '删除计划',
  'plan.run': '手动运行计划',
  'plan.enable': '启用计划',
  'plan.disable': '停用计划',
  'run.cancel': '取消运行',
  'snapshot.restore': '发起恢复',
  'snapshot.pin': '钉住快照',
  'snapshot.unpin': '取消钉住',
  'snapshot.delete': '删除快照',
  'snapshot.download': '下载快照文件',
  'restore.cancel': '取消恢复',
  'user.create': '创建用户',
  'user.update': '修改用户',
  'user.delete': '删除用户',
  'settings.update': '修改设置',
  'settings.test': '测试告警',
}

const hasFilters = computed(() => !!(actorFilter.value || actionFilter.value))

async function load() {
  loading.value = true
  error.value = ''
  try {
    const data = await api.audit.list({
      limit: pageSize.value,
      offset: (page.value - 1) * pageSize.value,
      actor: actorFilter.value || undefined,
      action: actionFilter.value || undefined,
    })
    entries.value = listOf(data, 'logs', 'items', 'audit')
    total.value = totalOf(data)
    hasNext.value = total.value === null ? entries.value.length === pageSize.value : page.value * pageSize.value < total.value
  } catch (err) {
    error.value = err?.message || '加载审计日志失败'
  } finally {
    loading.value = false
  }
}

onMounted(load)

watch([page, pageSize], () => {
  load()
})

function applyFilters() {
  actorFilter.value = actorInput.value.trim()
  actionFilter.value = actionInput.value.trim()
  page.value = 1
  load()
}

function resetFilters() {
  actorInput.value = ''
  actionInput.value = ''
  actorFilter.value = ''
  actionFilter.value = ''
  page.value = 1
  load()
}

function refresh() {
  load()
}

function actionLabel(action) {
  if (!action) return '—'
  return ACTION_LABELS[action] || action
}

function resultMeta(result) {
  const value = String(result || '').toLowerCase()
  if (['success', 'ok', 'allowed', '200'].includes(value)) {
    return { status: 'success', kind: 'generic', label: result || '成功' }
  }
  if (['failed', 'failure', 'denied', 'forbidden', 'error', '401', '403', '500'].includes(value)) {
    return { status: 'failed', kind: 'generic', label: result || '失败' }
  }
  return { status: result || 'unknown', kind: 'generic', label: result || '—' }
}

function toggleExpand(rowKey) {
  expandedId.value = expandedId.value === rowKey ? '' : rowKey
}

function detailText(entry) {
  const raw = entry.detail ?? entry.detail_json
  if (!raw) return '—'
  if (typeof raw === 'string') {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2)
    } catch {
      return raw
    }
  }
  return JSON.stringify(raw, null, 2)
}

function rowKey(entry, index) {
  return entry.id ?? `${entry.at || ''}-${index}`
}
</script>

<template>
  <div>
    <PageHeader title="审计日志" description="查询所有写操作、恢复与下载的审计记录（不可修改）">
      <template #actions>
        <BaseButton variant="secondary" size="sm" :loading="loading" @click="refresh">
          <RefreshCw v-if="!loading" class="h-3.5 w-3.5" />
          刷新
        </BaseButton>
      </template>
    </PageHeader>

    <div class="mb-4 bc-card px-4 py-3">
      <div class="flex flex-wrap items-end gap-2">
        <div class="w-full sm:w-48">
          <label class="bc-label">操作人</label>
          <input v-model="actorInput" class="bc-input" placeholder="用户名" @keyup.enter="applyFilters" />
        </div>
        <div class="w-full sm:w-56">
          <label class="bc-label">动作</label>
          <input v-model="actionInput" class="bc-input font-mono text-xs" placeholder="如 snapshot.restore" @keyup.enter="applyFilters" />
        </div>
        <BaseButton size="sm" @click="applyFilters">
          <Search class="h-3.5 w-3.5" />
          筛选
        </BaseButton>
        <BaseButton v-if="hasFilters" variant="ghost" size="sm" @click="resetFilters">
          <X class="h-3.5 w-3.5" />
          清除
        </BaseButton>
        <span class="ml-auto text-xs text-slate-400">
          {{ total !== null ? `共 ${total} 条` : `第 ${page} 页` }}
        </span>
      </div>
      <div class="mt-2 flex flex-wrap gap-2 text-[11px] text-slate-400">
        <span>常用动作：</span>
        <button
          v-for="action in ['snapshot.restore', 'snapshot.download', 'plan.run', 'client.disable', 'auth.login']"
          :key="action"
          type="button"
          class="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-slate-500 transition hover:bg-slate-200"
          @click="actionInput = action; applyFilters()"
        >
          {{ action }}
        </button>
      </div>
    </div>

    <div class="bc-card overflow-hidden">
      <LoadingSkeleton v-if="loading && !entries.length" variant="table" :rows="8" />
      <ErrorState v-else-if="error && !entries.length" :message="error" @retry="load" />
      <EmptyState
        v-else-if="!entries.length"
        title="没有审计记录"
        :description="hasFilters ? '没有匹配筛选条件的审计记录。' : '目前还没有写操作、恢复或下载记录。'"
      />

      <template v-else>
        <div class="overflow-x-auto">
          <table class="bc-table">
            <thead>
              <tr>
                <th class="w-8"></th>
                <th>时间</th>
                <th>操作人</th>
                <th>动作</th>
                <th>对象</th>
                <th>结果</th>
                <th>IP</th>
                <th>详情</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="(entry, index) in entries" :key="rowKey(entry, index)">
                <tr class="cursor-pointer" @click="toggleExpand(rowKey(entry, index))">
                  <td>
                    <ChevronDown v-if="expandedId === rowKey(entry, index)" class="h-3.5 w-3.5 text-slate-400" />
                    <ChevronRight v-else class="h-3.5 w-3.5 text-slate-400" />
                  </td>
                  <td class="whitespace-nowrap text-xs text-slate-600">{{ formatDateTime(entry.at) }}</td>
                  <td>
                    <div class="text-sm text-slate-700">{{ entry.actor || '—' }}</div>
                    <div class="font-mono text-[11px] text-slate-400">{{ shortId(entry.user_id || entry.actor_id, 14) }}</div>
                  </td>
                  <td>
                    <div class="text-xs text-slate-700">{{ actionLabel(entry.action) }}</div>
                    <div class="font-mono text-[11px] text-slate-400">{{ entry.action || '—' }}</div>
                  </td>
                  <td class="max-w-[16rem]">
                    <span class="break-all font-mono text-[11px] text-slate-600">{{ entry.target || '—' }}</span>
                  </td>
                  <td>
                    <StatusBadge :status="resultMeta(entry.result).status" kind="generic" :label="resultMeta(entry.result).label" />
                  </td>
                  <td class="font-mono text-[11px] text-slate-500">{{ entry.ip || '—' }}</td>
                  <td class="text-xs text-slate-400">
                    <span class="inline-flex items-center gap-1">
                      <ScrollText class="h-3 w-3" />
                      {{ entry.detail || entry.detail_json ? '查看' : '—' }}
                    </span>
                  </td>
                </tr>
                <tr v-if="expandedId === rowKey(entry, index)" class="bg-slate-50/70">
                  <td colspan="8" class="px-4 py-3">
                    <pre class="max-h-64 overflow-auto rounded-lg bg-slate-900 px-3 py-2 text-[11px] leading-5 text-slate-200"><code>{{ detailText(entry) }}</code></pre>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>

        <Pagination
          :page="page"
          :page-size="pageSize"
          :total="total"
          :has-next="hasNext"
          @update:page="page = $event"
          @update:page-size="pageSize = $event"
        />
      </template>
    </div>

    <p class="mt-3 text-xs text-slate-400">
      审计记录同时写入数据库 audit_log 与服务器 audit.jsonl；仅管理员和审计员可查看。
    </p>
  </div>
</template>
