/** 统一 API 客户端：自动带 Cookie、统一错误处理、401 自动跳登录。 */

let onUnauthorized = null;
export function setUnauthorizedHandler(fn) { onUnauthorized = fn; }

async function request(method, url, body) {
  const opts = {
    method,
    credentials: 'same-origin',
    headers: { 'Accept': 'application/json' },
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(url, opts);
  } catch (e) {
    throw Object.assign(new Error('网络连接失败，请检查网络后重试'), { code: 'NETWORK' });
  }

  if (res.status === 401 && onUnauthorized) {
    onUnauthorized();
    throw Object.assign(new Error('会话已过期，请重新登录'), { code: 'UNAUTHENTICATED', status: 401 });
  }

  const ct = res.headers.get('content-type') ?? '';
  let data = null;
  if (ct.includes('application/json')) {
    data = await res.json().catch(() => null);
  }

  if (!res.ok) {
    const msg = data?.error ?? `请求失败（HTTP ${res.status}）`;
    throw Object.assign(new Error(msg), {
      code: data?.code ?? 'HTTP_' + res.status,
      status: res.status,
      details: data?.details,
    });
  }
  return data;
}

export const api = {
  get: (u) => request('GET', u),
  post: (u, b) => request('POST', u, b),
  put: (u, b) => request('PUT', u, b),
  patch: (u, b) => request('PATCH', u, b),

  // 认证
  login: (username, password) => request('POST', '/api/auth/login', { username, password }),
  logout: () => request('POST', '/api/auth/logout', {}),
  me: () => request('GET', '/api/auth/me'),

  // 元数据
  meta: () => request('GET', '/api/meta'),
  dashboard: (period) => request('GET', `/api/dashboard${period ? `?period=${period}` : ''}`),
  calendar: (period) => request('GET', `/api/calendar/${period}`),

  // 填报
  fillContext: (period, userId) =>
    request('GET', `/api/timesheet/${period}/context${userId ? `?user_id=${userId}` : ''}`),
  saveDay: (period, date, entries) => request('PUT', `/api/timesheet/${period}/day`, { period, date, entries }),
  submitMonth: (period) => request('POST', `/api/timesheet/${period}/submit`, {}),
  withdrawMonth: (period) => request('POST', `/api/timesheet/${period}/withdraw`, {}),

  // 审批
  approvals: (period, status) =>
    request('GET', `/api/approvals?period=${period}${status ? `&status=${status}` : ''}`),
  decide: (id, action, reason) => request('POST', `/api/approvals/${id}/decide`, { action, reason }),
  bulkDecide: (period, userId, action, reason) =>
    request('POST', '/api/approvals/bulk', { period, user_id: userId, action, reason }),

  // 汇总
  summary: (period, mode) => request('GET', `/api/summary/${period}${mode ? `?mode=${mode}` : ''}`),
  freezeSummary: (period) => request('POST', `/api/summary/${period}/freeze`, {}),

  // 管理
  users: (params = {}) => {
    const q = new URLSearchParams();
    if (params.all) q.set('all', '1');
    if (params.role) q.set('role', params.role);
    if (params.q) q.set('q', params.q);
    const s = q.toString();
    return request('GET', `/api/admin/users${s ? '?' + s : ''}`);
  },
  updateUser: (id, patch) => request('PATCH', `/api/admin/users/${id}`, patch),
  syncAd: (dryRun) => request('POST', `/api/admin/sync-ad${dryRun ? '?dry_run=1' : ''}`, {}),
  adminProjects: () => request('GET', '/api/admin/projects'),
  createProject: (data) => request('POST', '/api/admin/projects', data),
  updateProject: (id, patch) => request('PATCH', `/api/admin/projects/${id}`, patch),
  deleteProject: (id) => request('DELETE', `/api/admin/projects/${id}`),
  projectMembers: (id) => request('GET', `/api/admin/projects/${id}/members`),
  setProjectMembers: (id, userIds) => request('PUT', `/api/admin/projects/${id}/members`, { user_ids: userIds }),
  projectApprovers: (id) => request('GET', `/api/admin/projects/${id}/approvers`),
  setProjectApprovers: (id, userIds) =>
    request('PUT', `/api/admin/projects/${id}/approvers`, { user_ids: userIds }),
  attendance: (period) => request('GET', `/api/admin/attendance/${period}`),
  setAttendance: (period, userId, hours, workdays) =>
    request('PUT', `/api/admin/attendance/${period}/${userId}`, { hours, workdays }),
  deleteAttendance: (period, userId) =>
    request('DELETE', `/api/admin/attendance/${period}/${userId}`),
  audit: (period) => request('GET', `/api/admin/audit${period ? `?period=${period}` : ''}`),
  // 批量操作
  bulkUpdateUsers: (ids, patch) => request('POST', '/api/admin/users/bulk-update', { ids, patch }),
  bulkAttendance: (period, ids, hours, workdays) =>
    request('POST', `/api/admin/attendance/${period}/bulk`, { ids, hours, workdays }),
  calendarList: () => request('GET', '/api/admin/calendar'),
  calendarPeriod: (period) => request('GET', `/api/calendar/${period}`),
  saveCalendarDay: (day) => request('POST', '/api/admin/calendar', day),
  deleteCalendarDay: (day) => request('DELETE', `/api/admin/calendar/${day}`),

  // ---- 四阶段审批流程 ----
  fillWholeMonth: (period, body) => request('POST', `/api/timesheet/${period}/fill-all`, body),
  resetMonth: (period, userId) => request('POST', `/api/timesheet/${period}/reset`, { userId }),
  submitWorkflow: (period, userId) => request('POST', `/api/timesheet/${period}/submit-workflow`, { userId }),
  timesheetProgress: (period, userId) =>
    request('GET', `/api/timesheet/${period}/progress${userId ? '?userId=' + userId : ''}`),
  workflowInbox: (period) => request('GET', `/api/workflow/inbox${period ? '?period=' + period : ''}`),
  myTimesheets: (period) => request('GET', `/api/my-timesheets${period ? '?period=' + period : ''}`),
  workflowStages: () => request('GET', '/api/workflow/stages'),
  workflowSettings: () => request('GET', '/api/workflow/settings'),
  updateWorkflowSettings: (body) => request('PUT', '/api/workflow/settings', body),
  decideProjectApproval: (id, action, reason) =>
    request('POST', `/api/workflow/approvals/${id}/decide`, { action, reason }),
  hrConfirm: (tsId, body) => request('POST', `/api/workflow/${tsId}/hr-confirm`, body),
  financeConfirm: (tsId, body) => request('POST', `/api/workflow/${tsId}/finance-confirm`, body),
  assetAllocation: (tsId) => request('GET', `/api/workflow/${tsId}/asset-allocation`),
  archivedEntries: (params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    const qs = q.toString();
    return request('GET', `/api/archived-entries${qs ? '?' + qs : ''}`);
  },
};
// ================================================================
// 研发费用归集与备查体系（第二阶段）
// ================================================================
export const costingApi = {
  // 企业档案
  company: () => request('GET', '/api/costing/company'),
  saveCompany: (data) => request('PUT', '/api/costing/company', data),

  // 费用明细
  entries: (params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    const s = q.toString();
    return request('GET', `/api/costing/entries${s ? '?' + s : ''}`);
  },
  createEntry: (data) => request('POST', '/api/costing/entries', data),
  updateEntry: (id, data) => request('PATCH', `/api/costing/entries/${id}`, data),
  deleteEntry: (id) => request('DELETE', `/api/costing/entries/${id}`),
  bulkDeleteEntries: (ids) => request('POST', '/api/costing/entries/bulk-delete', { ids }),

  // 公共费用
  shared: (params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    const s = q.toString();
    return request('GET', `/api/costing/shared${s ? '?' + s : ''}`);
  },
  createShared: (data) => request('POST', '/api/costing/shared', data),
  updateShared: (id, data) => request('PATCH', `/api/costing/shared/${id}`, data),
  deleteShared: (id) => request('DELETE', `/api/costing/shared/${id}`),

  // 委外/合作
  outsource: (projectId) => request('GET', `/api/costing/outsource${projectId ? `?project_id=${projectId}` : ''}`),
  createOutsource: (data) => request('POST', '/api/costing/outsource', data),
  updateOutsource: (id, data) => request('PATCH', `/api/costing/outsource/${id}`, data),
  deleteOutsource: (id) => request('DELETE', `/api/costing/outsource/${id}`),

  // 工时 → 人工费用
  laborPreview: (period) => request('GET', `/api/costing/labor/preview?period=${period}`),
  laborApply: (period) => request('POST', '/api/costing/labor/apply', { period }),

  // 多口径测算
  deduction: (period, scope) => request('GET', `/api/costing/deduction?period=${period}&scope=${scope}`),
  freezeDeduction: (period, scope) => request('POST', '/api/costing/deduction/freeze', { period, scope }),
  compliance: (period, scope) => request('GET', `/api/costing/compliance?period=${period}&scope=${scope}`),

  // 备查台账
  ledgers: (period) => request('GET', `/api/costing/ledgers${period ? `?period=${period}` : ''}`),
  ledger: (key, period) => request('GET', `/api/costing/ledgers/${key}${period ? `?period=${period}` : ''}`),
  addLedgerRow: (key, fields, period) =>
    request('POST', `/api/costing/ledgers/${key}/rows`, { fields, period }),
  updateLedgerRow: (key, id, fields) =>
    request('PATCH', `/api/costing/ledgers/${key}/rows/${id}`, { fields }),
  deleteLedgerRow: (key, id) => request('DELETE', `/api/costing/ledgers/${key}/rows/${id}`),
  replaceLedger: (key, rows, period) =>
    request('PUT', `/api/costing/ledgers/${key}`, { rows, period }),
  bulkDeleteLedgerRows: (key, ids) =>
    request('POST', `/api/costing/ledgers/${key}/rows/bulk-delete`, { ids }),

  // 文档
  docs: (period) => request('GET', `/api/costing/docs?period=${period}`),
  docPreview: (key, period, scope) =>
    request('GET', `/api/costing/docs/${key}/preview?period=${period}&scope=${scope}`),
  docDownloadUrl: (key, period, scope) =>
    `/api/costing/docs/${key}/download?period=${period}&scope=${scope}`,
  docDownloadAllUrl: (period, scope) =>
    `/api/costing/docs/download-all?period=${period}&scope=${scope}`,
};

// ================================================================
// IT 资产
// ================================================================
export const assetApi = {
  list: (params = {}) => {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
    const s = q.toString();
    return request('GET', `/api/assets${s ? '?' + s : ''}`);
  },
  stats: () => request('GET', '/api/assets/stats'),
  meta: () => request('GET', '/api/assets/meta'),
  get: (id) => request('GET', `/api/assets/${id}`),
  create: (data) => request('POST', '/api/assets', data),
  update: (id, data) => request('PATCH', `/api/assets/${id}`, data),
  remove: (id) => request('DELETE', `/api/assets/${id}`),
  returnAsset: (id, note) => request('POST', `/api/assets/${id}/return`, { note }),
  bulkStatus: (ids, status) => request('POST', '/api/assets/bulk-status', { ids, status }),
  bulkDelete: (ids) => request('POST', '/api/assets/bulk-delete', { ids }),
  searchUsers: (q) => request('GET', `/api/assets/users/search?q=${encodeURIComponent(q)}`),
  candidates: () => request('GET', '/api/assets/holders/candidates'),
};


// ================================================================
// 开放 API v1 —— 管理界面内部调用
// ================================================================
// 浏览器会话是 Cookie 认证，而 /api/v1/* 要求 Bearer。
// 这里用内部接口签发一个短期 token 并缓存，供 API 密钥管理页面使用。
let _apiToken = null;
let _apiTokenExp = 0;

async function getApiToken() {
  if (_apiToken && Date.now() < _apiTokenExp - 60_000) return _apiToken;
  // 借用浏览器会话身份换取 API token（服务端会校验会话 Cookie）
  const r = await request('POST', '/api/auth/api-token');
  _apiToken = r.accessToken;
  _apiTokenExp = Date.now() + (r.expiresIn ?? 600) * 1000;
  return _apiToken;
}

/** 调用 /api/v1/*，自动附加 Bearer token，拆解 { ok, data } 信封。 */
async function apiRequest(method, path, body) {
  const token = await getApiToken();
  const opts = {
    method,
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
    },
  };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(path, opts);
  let json = null;
  try { json = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok) {
    const msg = json?.error?.message ?? `请求失败（HTTP ${res.status}）`;
    throw Object.assign(new Error(msg), { code: json?.error?.code, status: res.status });
  }
  return json;
}

api.apiRequest = apiRequest;
