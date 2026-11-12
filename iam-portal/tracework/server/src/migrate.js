/**
 * 迁移执行器：按文件名顺序执行 migrations/*.sql，已执行的记录在 schema_migrations。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, withTransaction } from './db.js';
import { config } from './config.js';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, '..', 'migrations');

export async function runMigrations({ silent = false } = {}) {
  const log = silent ? () => {} : (...a) => console.log(...a);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);

  const { rows } = await pool.query('SELECT name FROM schema_migrations');
  const applied = new Set(rows.map((r) => r.name));

  const files = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  let count = 0;
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(migrationsDir, f), 'utf8');
    log(`[migrate] 应用 ${f} ...`);
    await withTransaction(async (client) => {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
    count++;
    log(`[migrate] ${f} 完成`);
  }
  if (count === 0) log('[migrate] 数据库结构已是最新');
  return count;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    await runMigrations();
    console.log(`[migrate] 完成，数据库 ${config.db.host}:${config.db.port}/${config.db.database}`);
    await pool.end();
  } catch (err) {
    console.error('[migrate] 失败:', err.message);
    process.exit(1);
  }
}