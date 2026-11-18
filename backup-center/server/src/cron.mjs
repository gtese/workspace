// 5 段 cron：分 时 日 月 周（周 0-6，0=周日）
function parseField(text, min, max, names = null) {
  const values = new Set();
  for (const part of String(text).split(',')) {
    const p = part.trim();
    if (!p) continue;
    let step = 1;
    let range = p;
    const slash = p.split('/');
    if (slash.length === 2) { range = slash[0]; step = Number(slash[1]); }
    if (!Number.isFinite(step) || step <= 0) throw new Error(`cron 步长无效：${p}`);
    let start;
    let end;
    if (range === '*') { start = min; end = max; }
    else if (range.includes('-')) {
      const [a, b] = range.split('-');
      start = parseValue(a, min, max, names); end = parseValue(b, min, max, names);
    } else {
      start = parseValue(range, min, max, names); end = start;
    }
    if (start < min || end > max || start > end) throw new Error(`cron 范围无效：${p}`);
    for (let v = start; v <= end; v += step) values.add(v);
  }
  return values;
}

function parseValue(v, min, max, names) {
  const raw = String(v).trim();
  if (names && names[raw.toLowerCase()] !== undefined) return names[raw.toLowerCase()];
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`cron 值无效：${v}`);
  return n;
}

const DOW = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const MON = null;

export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('cron 需要 5 段：分 时 日 月 周');
  return {
    minute: parseField(parts[0], 0, 59),
    hour: parseField(parts[1], 0, 23),
    dom: parseField(parts[2], 1, 31),
    month: parseField(parts[3], 1, 12, MON),
    dow: parseField(parts[4], 0, 6, DOW),
    domAll: parts[2].trim() === '*',
    dowAll: parts[4].trim() === '*',
  };
}

function matches(c, d) {
  if (!c.minute.has(d.getMinutes())) return false;
  if (!c.hour.has(d.getHours())) return false;
  if (!c.month.has(d.getMonth() + 1)) return false;
  const domOk = c.dom.has(d.getDate());
  const dowOk = c.dow.has(d.getDay());
  if (c.domAll && c.dowAll) return true;
  if (c.domAll) return dowOk;
  if (c.dowAll) return domOk;
  return domOk || dowOk;
}

export function nextOccurrence(expr, after = new Date()) {
  const c = parseCron(expr);
  const d = new Date(after.getTime());
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const limit = after.getTime() + 366 * 24 * 3600 * 1000;
  while (d.getTime() <= limit) {
    if (matches(c, d)) return new Date(d.getTime());
    d.setMinutes(d.getMinutes() + 1);
  }
  return null;
}

export function inWindow(now, window) {
  if (!window || !window.start || !window.end) return true;
  const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
  const start = toMin(window.start);
  const end = toMin(window.end);
  const cur = now.getHours() * 60 + now.getMinutes();
  if (start === end) return true;
  if (start < end) return cur >= start && cur < end;
  return cur >= start || cur < end;
}

export function validateCron(expr) {
  parseCron(expr);
  return true;
}
