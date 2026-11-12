#!/usr/bin/env bash
# ============================================================
# 前端页面可用性验收（真实浏览器渲染）
# ============================================================
# 用 headless Chrome 逐个打开所有页面，检查：
#   · 页面标题正确渲染（不是白屏）
#   · 无 JS 异常 / 无 4xx 网络错误
#   · 关键元素存在
#
# 依赖：Google Chrome（macOS）或 chromium（Linux）
# 用法：TEST_USER=xxx TEST_PASS=xxx bash verify-ui.sh
# ============================================================
set -uo pipefail

BASE="${BASE:-https://work.tri.local}"
TEST_USER="${TEST_USER:-linyiyao}"
TEST_PASS="${TEST_PASS:?请设置 TEST_PASS 环境变量}"
CDP_PORT="${CDP_PORT:-9333}"

# 定位 node（macOS 上可能不在 PATH）
if ! command -v node >/dev/null 2>&1; then
  for c in "$HOME/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node" \
           /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    [ -x "$c" ] && { export PATH="$(dirname "$c"):$PATH"; break; }
  done
fi
command -v node >/dev/null 2>&1 || { echo "未找到 node，跳过 UI 验收"; exit 0; }

if [ -x "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" ]; then
  CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
elif command -v chromium >/dev/null 2>&1; then
  CHROME="$(command -v chromium)"
elif command -v google-chrome >/dev/null 2>&1; then
  CHROME="$(command -v google-chrome)"
else
  echo "未找到 Chrome/Chromium，跳过 UI 验收"; exit 0
fi

SCRIPT_DIR="${SCRIPT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
# shellcheck source=lib/auth.sh
source "$SCRIPT_DIR/lib/auth.sh"

PASS=0; FAIL=0
ok(){ PASS=$((PASS+1)); printf '  \033[32m✓\033[0m %s\n' "$*"; }
bad(){ FAIL=$((FAIL+1)); printf '  \033[31m✗\033[0m %s\n' "$*"; }
step(){ printf '\n\033[1;36m== %s ==\033[0m\n' "$*"; }

# ------------------------------------------------------------
# 静态检查：模板引用的 utils 函数是否已导入
# 这类遗漏不会导致构建失败，但运行时会抛 TypeError 使页面白屏
# ------------------------------------------------------------
step "0a. 静态检查：utils 导入完整性"
SRC_DIR="${SRC_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../web/src" 2>/dev/null && pwd || echo "")}"
if [ -n "$SRC_DIR" ] && [ -f "$SRC_DIR/utils.js" ]; then
  if (cd "$SRC_DIR" && node "$(dirname "${BASH_SOURCE[0]}")/check-imports.mjs" 2>/dev/null | grep -q "✗"); then
    (cd "$SRC_DIR" && node "$(dirname "${BASH_SOURCE[0]}")/check-imports.mjs" 2>/dev/null | sed 's/^/  /')
    bad "存在未导入的 utils 引用（会导致页面白屏）"
  else
    ok "所有视图的 utils 引用均正确"
  fi
else
  ok "跳过（无源码目录）"
fi

# 1. 取会话 Cookie
step "0. 获取登录会话"
# 自动适配 ldap / oidc 两种认证模式
JAR=/tmp/_ui_jar.txt
rm -f "$JAR"
if auth_login "$BASE" "$JAR" "$TEST_USER" "$TEST_PASS" 2>/dev/null; then
  SID=$(sed -n 's/.*rnd_sid[[:space:]]\+\([^[:space:]]*\).*/\1/p' "$JAR" | tail -1)
  ok "取得会话 Cookie"
else
  bad "登录失败"; exit 1
fi
ROLE=$(curl -sS -H "Cookie: rnd_sid=$SID" "${BASE}/api/auth/me" 2>/dev/null \
  | sed -n 's/.*"role":"\([^"]*\)".*/\1/p' | head -1)
echo "  当前账号角色: ${ROLE:-unknown}"

# 2. 启动 Chrome
PROFILE=$(mktemp -d)
"$CHROME" --headless=new --disable-gpu --no-sandbox \
  --remote-debugging-port="$CDP_PORT" --user-data-dir="$PROFILE" \
  --ignore-certificate-errors about:blank > /dev/null 2>&1 &
CHROME_PID=$!
trap 'kill $CHROME_PID 2>/dev/null; sleep 1; rm -rf "$PROFILE" 2>/dev/null' EXIT
sleep 4

# 3. 用 Node 通过 CDP 逐页检查
export SID BASE CDP_PORT ROLE
node --input-type=module <<'NODE' 2>&1
const { SID, BASE, CDP_PORT } = process.env;

const PAGES = [
  ['/',             '我的工作台'],
  ['/fill',         '工时填报'],
  ['/approve',      '审批中心'],
  ['/archive',      '归档工时'],
  ['/summary',      '月度汇总'],
  ['/finance',      '费用归集'],
  ['/deduction',    '多口径测算'],
  ['/ledgers',     '备查台账'],
  ['/docs',         '备查资料'],

  ['/hr',           '员工管理'],
  ['/it-assets',    'IT 资产'],
  ['/rules',        '规则说明'],
  ['/projects',     '研发项目'],
  ['/admin',        '用户管理'],
  ['/workflow-settings', '流程设置'],
];

const ROLE = process.env.ROLE || 'employee';
const isAdminLike = ['admin', 'hr'].includes(ROLE);
const canFinance = ['admin', 'hr', 'finance'].includes(ROLE);
const canApprove = ['admin', 'hr', 'finance', 'pm'].includes(ROLE);

// 按角色过滤页面：无权限的页面会被路由守卫弹回工作台，
// 这不是缺陷，测试时应跳过而不是判失败。
const PAGES_ALL = PAGES.filter(([path]) => {
  if (path === '/admin' || path === '/hr' || path === '/workflow-settings') return isAdminLike;
  if (['/finance', '/deduction', '/ledgers', '/docs'].includes(path)) return canFinance;
  if (['/projects', '/summary'].includes(path)) return canApprove;
  return true;
});
PAGES.length = 0;
PAGES.push(...PAGES_ALL);

const host = new URL(BASE).hostname;
const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
let logs = [];
let netErr = [];

function send(method, params = {}) {
  return new Promise((res) => {
    const i = ++id;
    pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
}

ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    logs.push('ERROR: ' + m.params.entry.text);
  }
  if (m.method === 'Network.responseReceived' && m.params.response.status >= 400) {
    const u = m.params.response.url;
    if (!u.includes('favicon')) netErr.push(`${m.params.response.status} ${u.replace(BASE, '')}`);
  }
};

await new Promise((r) => { ws.onopen = r; });
await send('Runtime.enable');
await send('Log.enable');
await send('Network.enable');
await send('Page.enable');
await send('Network.setCookie', {
  name: 'rnd_sid', value: SID, domain: host, path: '/', secure: true, httpOnly: true,
});

let pass = 0;
let fail = 0;
console.log('\n\x1b[1;36m== 1. 逐页渲染检查 ==\x1b[0m');

for (const [path, expect] of PAGES) {
  logs = [];
  netErr = [];
  await send('Page.navigate', { url: BASE + path });
  await new Promise((r) => setTimeout(r, 3000));

  const r = await send('Runtime.evaluate', {
    expression: "document.querySelector('.page-title')?.innerText ?? ''",
    returnByValue: true,
  });
  const title = String(r.result?.value ?? '').trim();
  const bodyLen = await send('Runtime.evaluate', {
    expression: 'document.body.innerText.length', returnByValue: true,
  });
  const len = Number(bodyLen.result?.value ?? 0);

  const problems = [];
  if (!title) problems.push('标题为空（可能白屏）');
  if (len < 100) problems.push(`内容过少(${len}字节)`);
  if (expect && !title.includes(expect) && !title.includes('工作台')) {
    problems.push(`标题"${title}"与预期"${expect}"不符`);
  }
  if (logs.length) problems.push(logs[0]);
  if (netErr.length) problems.push(netErr[0]);

  if (problems.length === 0) {
    console.log(`  \x1b[32m✓\x1b[0m ${path.padEnd(13)} ${title}`);
    pass++;
  } else {
    console.log(`  \x1b[31m✗\x1b[0m ${path.padEnd(13)} ${problems.join('; ')}`);
    fail++;
  }
}

// 4. 系统管理页专项检查
if (isAdminLike) { console.log('\n\x1b[1;36m== 2. 用户管理页专项 ==\x1b[0m');
logs = []; netErr = [];
await send('Page.navigate', { url: BASE + '/admin' });
await new Promise((r) => setTimeout(r, 4000));
const detail = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    cards: Array.from(document.querySelectorAll('.card .card-t')).map(e => e.innerText),
    apiKeySection: document.body.innerText.includes('开放 API 密钥'),
    keyCreateBtn: Array.from(document.querySelectorAll('button')).some(b => b.innerText.includes('创建密钥')),
    calendarSelect: !!document.querySelector('select'),
    users: document.querySelector('.card tbody')?.querySelectorAll('tr').length ?? 0,
  })`,
  returnByValue: true,
});
try {
  const d = JSON.parse(detail.result.value);
  const checks = [
    ['三张卡片齐全', d.cards.length === 3],
    ['含「开放 API 密钥」', d.apiKeySection],
    ['含「创建密钥」按钮', d.keyCreateBtn],
    ['用户表格有数据', d.users > 0],
  ];
  for (const [name, okFlag] of checks) {
    if (okFlag) { console.log(`  \x1b[32m✓\x1b[0m ${name}`); pass++; }
    else { console.log(`  \x1b[31m✗\x1b[0m ${name}`); fail++; }
  }
} catch {
  console.log('  \x1b[31m✗\x1b[0m 无法解析页面结构');
  fail++;
}

if (logs.length) { console.log('  \x1b[31m✗\x1b[0m JS 错误: ' + logs[0]); fail++; }
else { console.log('  \x1b[32m✓\x1b[0m 无 JS 异常'); pass++; }

} else {
  console.log('\n\x1b[1;36m== 2. 用户管理页专项（非管理员，跳过）==\x1b[0m');
}

ws.close();
console.log(`\n\x1b[1m════ UI 验收: ${pass} 通过, ${fail} 失败 ════\x1b[0m`);
process.exit(fail === 0 ? 0 : 1);
NODE
RC=$?

[ "$RC" -eq 0 ] && exit 0 || exit 1