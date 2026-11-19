#!/usr/bin/env node
/**
 * 抓取 AstraFlow（UCloud ModelVerse）模型价格页数据，输出 JSON。
 *
 * 依赖：一个已登录 astraflow.ucloud.cn 且开启远程调试的 Chrome 窗口。
 *   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 *     --no-sandbox --disable-gpu --remote-debugging-port=9333 \
 *     --user-data-dir=/tmp/mvlogin https://astraflow.ucloud.cn/modelverse/prices
 *
 * 用法：
 *   node fetch_prices.mjs --port 9333 --project org-xxxx --out prices.json
 *
 * 说明：GetUFSquareModelPrices 需要登录态 + CSRF 头（取自 console 下发的
 * U_CSRF_TOKEN cookie），因此必须在已登录页面的上下文里发起 fetch。
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const getArg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const PORT = Number(getArg('port', '9333'));
const PROJECT = getArg('project', '');
const OUT = getArg('out', 'prices.json');
const PAGE_LIMIT = Number(getArg('limit', '100'));

const list = await fetch(`http://127.0.0.1:${PORT}/json/list`).then(r => r.json());
const page = list.find(t => t.type === 'page' && t.url.includes('astraflow.ucloud.cn'));
if (!page) throw new Error('未找到 astraflow.ucloud.cn 页面，请先打开并在该窗口登录');

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let id = 0;
const pending = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { res, rej } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
  }
};
const send = (method, params = {}) => new Promise((res, rej) => {
  const i = ++id;
  pending.set(i, { res, rej });
  ws.send(JSON.stringify({ id: i, method, params }));
});
await send('Runtime.enable');

const expr = `(async () => {
  const ck = n => { const m = document.cookie.match(new RegExp('(?:^|;\\\\s*)' + n + '=([^;]*)')); return m ? decodeURIComponent(m[1]) : null; };
  const headers = { 'Content-Type': 'application/json', 'x-api-lang': 'zh_CN' };
  const csrf = ck('CSRF_TOKEN'); if (csrf) headers['CSRF-Token'] = csrf;
  const ucsrf = ck('U_CSRF_TOKEN'); if (ucsrf) headers['U-CSRF-Token'] = ucsrf;
  const LIMIT = ${PAGE_LIMIT}, PROJECT = ${JSON.stringify(PROJECT)};
  const call = async (offset) => {
    for (let i = 0; i < 4; i++) {
      try {
        const r = await fetch('https://api.ucloud.cn/?Action=GetUFSquareModelPrices', {
          method: 'POST', credentials: 'include', headers,
          body: JSON.stringify({ ProjectId: PROJECT, Limit: LIMIT, Offset: offset, Action: 'GetUFSquareModelPrices', _timestamp: Date.now() })
        });
        const j = await r.json();
        if (j.RetCode === 0) return j;
        if (j.RetCode !== 222201 && !String(j.Message || '').includes('deadline')) return { error: j };
      } catch (e) {}
      await new Promise(r => setTimeout(r, 1500));
    }
    return { error: { Message: 'retries exhausted at offset ' + offset } };
  };
  const first = await call(0);
  if (first.error) return JSON.stringify({ error: first.error });
  const total = first.TotalCount;
  const models = [...first.Models];
  for (let off = LIMIT; off < total; off += LIMIT) {
    const j = await call(off);
    if (j.error) return JSON.stringify({ error: j.error, got: models.length, total });
    models.push(...j.Models);
  }
  return JSON.stringify({ TotalCount: total, Models: models, fetchedAt: new Date().toISOString() });
})()`;

const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails).slice(0, 500));
const data = JSON.parse(r.result.value);
if (data.error) throw new Error(JSON.stringify(data.error).slice(0, 300));
fs.writeFileSync(OUT, JSON.stringify(data, null, 1));
console.log(`saved ${OUT}: ${data.Models.length}/${data.TotalCount} models`);
process.exit(0);
