// ============================================================================
// OOD 自定义应用：节点隔离（Node Isolation）
// 部署：/var/www/ood/apps/sys/node-isolation/
// 运行：Passenger(Node.js) 在 /pun/sys/node-isolation/ 下，进程身份 = 当前 OOD 用户
// 特权：只通过 sudo -n /usr/local/sbin/node-isolationctl 执行，参数在本地再校验一次
// ============================================================================
'use strict';

const http = require('http');
const fs = require('fs');
const crypto = require('crypto');
const cp = require('child_process');
const querystring = require('querystring');

const HELPER = '/usr/local/sbin/node-isolationctl';
const CONFIG = '/etc/node-isolation/config.json';
const BASE_RE = /^(\/pun\/sys\/node-isolation)/;
const NODE_RE = /^[0-9a-zA-Z][0-9a-zA-Z.\-]*$/;
const GROUP_RE = /^[A-Za-z0-9_][A-Za-z0-9_.\-]*$/;

// ---------------------------------------------------------------- 基础工具
function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
}

function usernameOf(uid) {
  try {
    const passwd = fs.readFileSync('/etc/passwd', 'utf8').split('\n');
    for (const line of passwd) {
      const f = line.split(':');
      if (f.length > 2 && Number(f[2]) === uid) return f[0];
    }
  } catch (e) { /* ignore */ }
  try { return cp.execFileSync('id', ['-nu', String(uid)], { encoding: 'utf8' }).trim(); } catch (e) { return 'uid' + uid; }
}

function groupsOf(user) {
  try {
    return cp.execFileSync('id', ['-nG', user], { encoding: 'utf8' }).trim().split(/\s+/);
  } catch (e) { return []; }
}

function isAdmin(user, cfg) {
  const mine = new Set(groupsOf(user));
  return (cfg.admin_groups || []).some((g) => mine.has(g));
}

function execFileSafe(file, args, opts) {
  try {
    return { ok: true, out: cp.execFileSync(file, args, Object.assign({ encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }, opts || {})) };
  } catch (e) {
    return { ok: false, out: (e.stdout || '') + (e.stderr || ''), code: e.status };
  }
}

function helper(args, useSudo) {
  const cmd = useSudo ? 'sudo' : HELPER;
  const argv = useSudo ? ['-n', HELPER].concat(args) : args;
  return execFileSafe(cmd, argv);
}

function status() {
  const r = helper(['status'], false);
  if (!r.ok) return { ok: false, error: r.out || 'node-isolationctl status 执行失败' };
  try { return JSON.parse(r.out); } catch (e) { return { ok: false, error: '状态输出解析失败: ' + e.message }; }
}

function auditEntries(limit) {
  const r = helper(['audit', String(limit)], true);
  if (!r.ok) return [];
  try { return JSON.parse(r.out).entries || []; } catch (e) { return []; }
}

function esc(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseBody(req, cb) {
  let body = '';
  let tooBig = false;
  req.on('data', (c) => {
    body += c;
    if (body.length > 4096) { tooBig = true; req.destroy(); }
  });
  req.on('end', () => {
    if (tooBig) return cb(new Error('Request body too large'));
    try { cb(null, querystring.parse(body)); } catch (e) { cb(e); }
  });
}

function csrfCookie(base) {
  const token = crypto.randomBytes(18).toString('hex');
  return { token, header: 'nio_csrf=' + token + '; Path=' + base + '; HttpOnly; SameSite=Lax' };
}

// ---------------------------------------------------------------- 页面渲染
function badge(text, cls) { return '<span class="badge ' + cls + '">' + esc(text) + '</span>'; }

function stateBadge(state) {
  const s = String(state || '').toLowerCase();
  const cls = s.indexOf('mix') >= 0 ? 'b-warn' : (s.indexOf('idle') >= 0 ? 'b-ok' : (s.indexOf('down') >= 0 || s.indexOf('drain') >= 0 ? 'b-bad' : 'b-mute'));
  return badge(state || 'unknown', cls);
}


// 读取 OOD dashboard 的编译后 CSS 资源路径，保持与 OOD 页面一致的样式
function oodAsset(prefix, suffix) {
  try {
    const dir = '/var/www/ood/apps/sys/dashboard/public/assets';
    const f = fs.readdirSync(dir).find((x) => x.startsWith(prefix) && x.endsWith(suffix));
    return f ? '/pun/sys/dashboard/assets/' + f : '';
  } catch (e) { return ''; }
}

function oodCssLink() {
  const href = oodAsset('application-', '.css');
  return href ? '<link rel="stylesheet" href="' + href + '">' : '';
}

function renderPage(base, st, me, admin, flash, audit) {
  const rows = (st.nodes || []).map((n) => {
    const iso = n.isolation;
    const partsText = (n.partitions || []).join(', ') || '-';
    let action;
    if (iso && admin) {
      action = '<form method="post" action="' + base + '/release" class="inline">' +
        '<input type="hidden" name="csrf" value="' + esc(flash.csrf) + '">' +
        '<input type="hidden" name="node" value="' + esc(n.addr) + '">' +
        '<button class="btn danger" type="submit">Release</button></form>';
    } else if (iso) {
      action = '<span class="muted">Admin required</span>';
    } else if (admin) {
      const opts = (st.groups || []).map((g) => '<option value="' + esc(g) + '">' + esc(g) + '</option>').join('');
      action = '<form method="post" action="' + base + '/isolate" class="inline">' +
        '<input type="hidden" name="csrf" value="' + esc(flash.csrf) + '">' +
        '<input type="hidden" name="node" value="' + esc(n.addr) + '">' +
        '<select name="group" required>' + opts + '</select>' +
        '<button class="btn" type="submit">Isolate to group</button></form>';
    } else {
      action = '<span class="muted">—</span>';
    }
    const isoCell = iso
      ? badge('Only ' + iso.group, 'b-lock') + '<div class="sub">Partition ' + esc(iso.partition) + '</div>'
      : '<span class="muted">Shared</span>';
    return '<tr>' +
      '<td><code>' + esc(n.addr) + '</code><div class="sub">' + esc(n.host) + '</div></td>' +
      '<td>' + stateBadge(n.state) + '</td>' +
      '<td><code>' + esc(partsText) + '</code></td>' +
      '<td>' + isoCell + '</td>' +
      '<td class="num">' + esc(n.jobs) + '</td>' +
      '<td>' + action + '</td>' +
      '</tr>';
  }).join('');

  const partRows = (st.partitions || []).map((p) => '<tr><td><code>' + esc(p.name) + '</code></td>' +
    '<td><code>' + esc((p.nodes || []).join(',')) + '</code></td>' +
    '<td>' + (p.allow_groups && p.allow_groups !== 'ALL' ? badge(p.allow_groups, 'b-lock') : '<span class="muted">ALL</span>') + '</td>' +
    '<td>' + (String(p.default).toUpperCase() === 'YES' ? badge('Default', 'b-ok') : '<span class="muted">-</span>') + '</td></tr>').join('');

  const auditRows = (audit || []).map((a) => '<tr>' +
    '<td class="mono">' + esc(a.ts) + '</td>' +
    '<td>' + esc(a.actor) + '</td>' +
    '<td>' + esc(a.action) + '</td>' +
    '<td><code>' + esc(a.node) + '</code></td>' +
    '<td>' + (a.group ? badge(a.group, 'b-lock') : '<span class="muted">-</span>') + '</td>' +
    '<td>' + esc(a.result) + '</td></tr>').join('');

  return '<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Node Isolation · Tri EDA Cluster</title>' +
    oodCssLink() +
    '<link rel="stylesheet" href="/public/custom.css">' +
    '<style>' +
    ':root{--bg:#f6f7f9;--card:#fff;--line:#e3e6eb;--txt:#1f2933;--muted:#6b7280;--pri:#2563eb;--ok:#0f766e;--warn:#b45309;--bad:#b91c1c}' +
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:14px/1.55 var(--tri-font,-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif)}' +
    'header{background:#4b5563;color:#fff}' +
    'header .navbar{padding:.35rem 1rem}' +
    'main{max-width:1180px;margin:0 auto;padding:20px}' +
    '.card{background:var(--card);border:1px solid var(--line);border-radius:10px;margin-bottom:18px;overflow:hidden}' +
    '.card h2{font-size:14px;margin:0;padding:12px 16px;border-bottom:1px solid var(--line);background:#fbfcfd;font-weight:600}' +
    '.card .body{padding:14px 16px}.muted{color:var(--muted)}.sub{color:var(--muted);font-size:12px;margin-top:2px}.num{text-align:right}' +
    'table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:9px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:middle}' +
    'th{color:var(--muted);font-weight:500;background:#fbfcfd;font-size:12px}tr:last-child td{border-bottom:0}' +
    'code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}code{background:#f3f4f6;padding:1px 5px;border-radius:4px}' +
    '.mono{font-family:ui-monospace,Menlo,monospace;font-size:11px;color:var(--muted)}' +
    '.badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid transparent}' +
    '.b-ok{background:#ecfdf5;color:var(--ok);border-color:#a7f3d0}.b-warn{background:#fffbeb;color:var(--warn);border-color:#fde68a}' +
    '.b-bad{background:#fef2f2;color:var(--bad);border-color:#fecaca}.b-mute{background:#f3f4f6;color:var(--muted);border-color:#e5e7eb}' +
    '.b-lock{background:#eef2ff;color:#3730a3;border-color:#c7d2fe}' +
    'form.inline{display:flex;gap:6px;align-items:center;margin:0;flex-wrap:wrap}' +
    'select{padding:5px 6px;border:1px solid var(--line);border-radius:6px;background:#fff;font-size:12px}' +
    '.btn{border:1px solid var(--pri);background:var(--pri);color:#fff;padding:5px 10px;border-radius:6px;font-size:12px;cursor:pointer}' +
    '.btn:hover{opacity:.9}.btn.danger{background:#fff;color:var(--bad);border-color:#fecaca}' +
    '.flash{padding:10px 14px;border-radius:8px;margin-bottom:16px;font-size:13px;white-space:pre-wrap;font-family:ui-monospace,Menlo,monospace}' +
    '.flash.ok{background:#ecfdf5;border:1px solid #a7f3d0;color:#065f46}.flash.err{background:#fef2f2;border:1px solid #fecaca;color:#991b1b}' +
    '.hint{font-size:12px;color:var(--muted);margin-top:8px}' +
    '</style></head><body>' +
    '<header><nav class="navbar navbar-expand-md shadow-sm navbar-color navbar-dark">' +
    '<ul class="navbar-nav w-100 align-items-center" role="menubar">' +
    '<li role="none"><a class="navbar-brand" role="menuitem" href="/pun/sys/dashboard">Tri EDA Cluster</a></li>' +
    '<li class="nav-item" role="none"><a class="nav-link" role="menuitem" href="/pun/sys/dashboard">Dashboard</a></li>' +
    '<li class="nav-item" role="none"><a class="nav-link" role="menuitem" href="/pun/sys/files">Files</a></li>' +
    '<li class="nav-item" role="none"><a class="nav-link" role="menuitem" href="/pun/sys/activejobs">Active Jobs</a></li>' +
    '<li class="nav-item" role="none"><a class="nav-link" role="menuitem" href="/pun/sys/myjobs">Job Composer</a></li>' +
    '<li class="nav-item" role="none"><a class="nav-link" role="menuitem" href="/pun/sys/bc_desktop">Interactive Apps</a></li>' +
    '<li class="nav-item" role="none"><a class="nav-link" role="menuitem" href="/pun/sys/dashboard/apps/index">Apps</a></li>' +
    '<li class="nav-item" role="none"><a class="nav-link active" aria-current="page" role="menuitem" href="/pun/sys/node-isolation">Node Isolation</a></li>' +
    '<li class="ml-auto nav-item" role="none"><span class="nav-link disabled" title="Signed in user">' + esc(me.user) + (admin ? ' (Admin)' : ' (Read-only)') + '</span></li>' +
    '<li class="nav-item" role="none"><a class="nav-link" role="menuitem" href="/logout">Log Out</a></li>' +
    '</ul></nav></header>' +
    '<main>' + (flash.html || '') +
    '<h1 class="h4 mb-3">Node Isolation</h1>' +
    '<div class="card"><h2>Nodes</h2><div class="body" style="padding:0">' +
    '<table><thead><tr><th>Node</th><th>State</th><th>Partitions</th><th>Isolation</th><th class="num">Running Jobs</th><th>Action</th></tr></thead>' +
    '<tbody>' + rows + '</tbody></table></div>' +
    '<div class="body hint">Isolation moves a node out of its shared partition and creates a dedicated partition with <code>AllowGroups=&lt;group&gt;</code>. ' +
    'It does not drain the node or kill jobs; running jobs continue. Group membership changes require <code>scontrol reconfigure</code> to take effect.</div></div>' +
    '<div class="card"><h2>Partitions</h2><div class="body" style="padding:0">' +
    '<table><thead><tr><th>Partition</th><th>Nodes</th><th>AllowGroups</th><th>Default</th></tr></thead><tbody>' + partRows + '</tbody></table></div></div>' +
    (admin ? '<div class="card"><h2>Recent Actions</h2><div class="body" style="padding:0">' +
      '<table><thead><tr><th>Time</th><th>Actor</th><th>Action</th><th>Node</th><th>Group</th><th>Result</th></tr></thead><tbody>' +
      (auditRows || '<tr><td colspan="6" class="muted">No records</td></tr>') + '</tbody></table></div></div>' : '') +
    '</main></body></html>';
}

// ---------------------------------------------------------------- 路由
function page(base, flash, auditWanted) {
  const cfg = readConfig();
  const uid = process.getuid();
  const user = usernameOf(uid);
  const admin = isAdmin(user, cfg);
  const st = status();
  if (!st.ok) {
    return { status: 500, html: '<!DOCTYPE html><html><body><h1>Failed to read status</h1><pre>' + esc(st.error) + '</pre></body></html>' };
  }
  const audit = admin && auditWanted ? auditEntries(10) : [];
  return { status: 200, html: renderPage(base, st, { user }, admin, flash, audit) };
}

function send(res, code, html, extraHeaders) {
  const h = Object.assign({
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
  }, extraHeaders || {});
  res.writeHead(code, h);
  res.end(html);
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const m = BASE_RE.exec(u.pathname);
  const base = m ? m[1] : '/pun/sys/node-isolation';
  const path = m ? (u.pathname.slice(base.length) || '/') : '/';

  if (req.method === 'GET' && path === '/api/status') {
    const st = status();
    res.writeHead(st.ok ? 200 : 500, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(st, null, 2));
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    const csrf = csrfCookie(base);
    let flash = { csrf: csrf.token, html: '' };
    if (u.searchParams.get('ok')) {
      flash.html = '<div class="flash ok">' + esc(u.searchParams.get('msg') || '完成') + '</div>';
    } else if (u.searchParams.get('err')) {
      flash.html = '<div class="flash err">' + esc(u.searchParams.get('msg') || '失败') + '</div>';
    }
    const isAdminUser = isAdmin(usernameOf(process.getuid()), readConfig());
    const out = page(base, flash, isAdminUser);
    return send(res, out.status, out.html, { 'Set-Cookie': csrf.header });
  }

  if (req.method === 'POST') {
    const isAdminUser = isAdmin(usernameOf(process.getuid()), readConfig());
    return parseBody(req, (err, form) => {
      if (err) return send(res, 400, '<pre>bad request</pre>');
      const cookies = {};
      (req.headers.cookie || '').split(';').forEach((c) => {
        const i = c.indexOf('=');
        if (i > 0) cookies[c.slice(0, i).trim()] = c.slice(i + 1).trim();
      });
      const originOk = !req.headers.origin || (req.headers.origin.replace(/^https?:\/\//, '') === (req.headers.host || ''));
      if (!isAdminUser) return send(res, 403, '<pre>403 Admin privileges required（组: ' + esc(readConfig().admin_groups.join(', ')) + '）</pre>');
      if (!form.csrf || form.csrf !== cookies.nio_csrf || !originOk) {
        return send(res, 403, '<pre>403 CSRF validation failed; refresh and retry</pre>');
      }
      const node = String(form.node || '');
      if (!NODE_RE.test(node)) return send(res, 400, '<pre>Invalid node parameter</pre>');
      const redirect = (ok, msg) => {
        res.writeHead(303, { Location: base + '/?' + (ok ? 'ok=1' : 'err=1') + '&msg=' + encodeURIComponent(msg) });
        res.end();
      };
      if (path === '/isolate') {
        const group = String(form.group || '');
        if (!GROUP_RE.test(group)) return send(res, 400, '<pre>Invalid group parameter</pre>');
        const r = helper(['isolate', node, group], true);
        let msg = r.out;
        try { msg = JSON.parse(r.out).message || r.out; } catch (e) { /* keep raw */ }
        return redirect(r.ok, (r.ok ? '' : 'Operation failed: ') + msg);
      }
      if (path === '/release') {
        const r = helper(['release', node], true);
        let msg = r.out;
        try { msg = JSON.parse(r.out).message || r.out; } catch (e) { /* keep raw */ }
        return redirect(r.ok, (r.ok ? '' : 'Operation failed: ') + msg);
      }
      return send(res, 404, '<pre>404</pre>');
    });
  }

  send(res, 405, '<pre>405</pre>');
});

server.listen(0);
module.exports = server;
