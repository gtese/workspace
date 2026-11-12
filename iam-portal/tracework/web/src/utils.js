/** 通用格式化与工具函数。 */

export function fmtMoney(n) {
  return Number(n ?? 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
export function fmtHours(n) {
  return Number(Number(n ?? 0).toFixed(2)).toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}
export function fmtPct(n) {
  return (Number(n ?? 0) * 100).toFixed(2) + '%';
}
export function fmtDateTime(s) {
  if (!s) return '—';
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export function fmtDate(s) {
  if (!s) return '—';
  return String(s).slice(0, 10);
}
const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
export function weekdayLabel(dateStr) {
  const d = new Date(String(dateStr) + 'T00:00:00');
  return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getDay()];
}
export function isWeekend(dateStr) {
  const d = new Date(String(dateStr) + 'T00:00:00');
  const w = d.getDay();
  return w === 0 || w === 6;
}
export function currentPeriod() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
/** 生成最近 N 个月的 period 选项。 */
export function recentPeriods(n = 14) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}
export function periodLabel(p) {
  const [y, m] = String(p).split('-');
  return `${y}年${Number(m)}月`;
}

export const STATUS_LABEL = {
  draft: '草稿', submitted: '已提交', approved: '已通过', rejected: '已驳回',
  pending: '待审批',
};
export function statusChipClass(s) {
  return { draft: 'gray', submitted: 'warn', approved: 'ok', rejected: 'bad', pending: 'warn' }[s] ?? 'gray';
}

export const EMPLOYEE_TYPE_LABEL = {
  fulltime_rnd: '专职研发', parttime_rnd: '兼职研发', support: '研发支持',
  intern: '实习生', external: '外部人员',
};

export const ROLE_LABEL = {
  admin: '系统管理员', hr: '人力资源部', finance: '财务部',
  pm: '项目负责人', employee: '研发人员',
};

/** 简单防抖。 */
export function debounce(fn, ms = 300) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export function downloadCsv(filename, rows) {
  const bom = '\uFEFF';
  const csv = rows.map((r) => r.map((c) => {
    const s = c === null || c === undefined ? '' : String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
  const blob = new Blob([bom + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}