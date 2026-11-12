/**
 * PostgreSQL 连接池与轻量查询助手。
 */
import pg from 'pg';
import { lookup } from 'node:dns';
import { config } from './config.js';

// NUMERIC 默认被解析为字符串以避免精度丢失；本系统金额与工时都按需转 number，
// 这里统一转换为字符串保留精度，业务层显式 Number() 处理。
pg.types.setTypeParser(pg.types.builtins.INT8, (v) => (v === null ? null : Number(v)));

/**
 * DATE 列保持原始字符串，不要交给驱动转成 Date。
 *
 * 原因：pg 会把 DATE 解析为「本地时区午夜」的 Date 对象。当进程时区与
 * 数据录入时区不一致时（例如容器跑在 UTC，而日期按 Asia/Shanghai 业务日理解），
 * 对其取 toISOString()/getUTCDate() 会得到**前一天**，导致节假日日历、
 * 工作日计算、审批时限整体错位一天 —— 这类缺陷非常隐蔽。
 * 直接返回 'YYYY-MM-DD' 字符串可从根本消除时区歧义。
 */
pg.types.setTypeParser(pg.types.builtins.DATE, (v) => v);

/**
 * 解析数据库主机名。
 *
 * 背景：podman 内置的 DNS 解析器（10.89.1.1）在并发/快速连续查询时会
 * 间歇性返回 EAI_AGAIN，导致连接池随机失败（表现为 504 与
 * "getaddrinfo EAI_AGAIN db"）。这里在启动时主动解析一次，
 * 优先使用 dns.lookup 的 all:true（该形式实测稳定），
 * 失败则回退到解析 /etc/hosts。
 */
async function resolveDbHost(host) {
  if (!host || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;

  const tryLookup = (opts) => new Promise((resolve, reject) => {
    lookup(host, opts, (err, addr, family) => {
      if (err) return reject(err);
      resolve(addr);
    });
  });

  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      // all:true 返回数组，实测比单条查询稳定
      const addrs = await tryLookup({ all: true });
      const ipv4 = addrs.find((a) => a.family === 4) ?? addrs[0];
      if (ipv4?.address) return ipv4.address;
    } catch { /* 继续重试 */ }
    try {
      const a = await tryLookup({ family: 4 });
      if (a) return a;
    } catch { /* 继续重试 */ }
    await new Promise((r) => setTimeout(r, 150 * attempt));
  }

  // 最后兜底：读 /etc/hosts
  try {
    const fs = await import('node:fs');
    const hosts = fs.readFileSync('/etc/hosts', 'utf8');
    const re = new RegExp(`^\\s*([\\d.]+)\\s+.*\\b${host.replace(/\./g, '\\.')}\\b`, 'm');
    const m = re.exec(hosts);
    if (m) return m[1];
  } catch { /* 忽略 */ }

  console.warn(`[db] 无法解析主机名 ${host}，将交由连接池自行解析`);
  return host;
}

const resolvedHost = await resolveDbHost(config.db.host);
if (resolvedHost !== config.db.host) {
  console.log(`[db] 主机名 ${config.db.host} 解析为 ${resolvedHost}`);
}

export const pool = new pg.Pool({
  ...config.db,
  host: resolvedHost,
  application_name: 'rnd-timesheet',
  // 兜底保护：即使出现意料之外的锁等待，也会在 15 秒内失败并回滚，
  // 而不是让 HTTP 请求一直挂起到网关超时。
  statement_timeout: 15000,
  lock_timeout: 10000,
  idle_in_transaction_session_timeout: 20000,
});

pool.on('error', (err) => {
  console.error('[pg] 空闲连接异常:', err.message);
});

export function query(text, params) {
  return pool.query(text, params);
}

/** 在单个事务中执行 fn(client)。 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* 忽略回滚失败 */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function healthcheck() {
  const { rows } = await pool.query('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}

export async function closePool() {
  await pool.end();
}