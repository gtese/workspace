import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, display_name TEXT,
  email TEXT, role TEXT NOT NULL DEFAULT 'viewer',
  source TEXT NOT NULL DEFAULT 'local', password_hash TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS user_scopes (
  user_id TEXT NOT NULL, client_id TEXT NOT NULL, PRIMARY KEY (user_id, client_id)
);

CREATE TABLE IF NOT EXISTS sessions (
  sid_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL, csrf TEXT NOT NULL,
  ip TEXT, ua TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY, hostname TEXT NOT NULL, os TEXT, os_version TEXT, arch TEXT,
  agent_version TEXT, cert_serial TEXT UNIQUE, cert_fp TEXT,
  status TEXT NOT NULL DEFAULT 'active', repository_id TEXT,
  allowed_roots TEXT NOT NULL DEFAULT '/', tags TEXT NOT NULL DEFAULT '',
  ip TEXT, last_seen_at TEXT, last_heartbeat_json TEXT, created_at TEXT NOT NULL,
  disabled_reason TEXT
);

CREATE TABLE IF NOT EXISTS enroll_requests (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, enroll_secret_hash TEXT,
  hostname TEXT, os TEXT, os_version TEXT, arch TEXT, agent_version TEXT,
  csr_pem TEXT, fingerprint TEXT, ip TEXT,
  status TEXT NOT NULL DEFAULT 'pending', client_id TEXT, repository_id TEXT,
  created_by TEXT, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  approved_by TEXT, approved_at TEXT, reject_reason TEXT
);

CREATE TABLE IF NOT EXISTS repositories (
  id TEXT PRIMARY KEY, name TEXT UNIQUE NOT NULL, type TEXT NOT NULL,
  config_enc TEXT NOT NULL, mountpoint TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
  total_bytes INTEGER, free_bytes INTEGER, created_at TEXT NOT NULL,
  last_checked_at TEXT, last_error TEXT
);

CREATE TABLE IF NOT EXISTS client_certs (
  client_id TEXT NOT NULL, cert_pem TEXT NOT NULL, serial TEXT NOT NULL,
  fingerprint TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, PRIMARY KEY (client_id, serial)
);

CREATE TABLE IF NOT EXISTS client_repos (
  client_id TEXT PRIMARY KEY, repository_id TEXT NOT NULL,
  repo_password_enc TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, client_id TEXT NOT NULL, repository_id TEXT NOT NULL,
  paths_json TEXT NOT NULL, excludes_json TEXT NOT NULL DEFAULT '[]',
  cron TEXT NOT NULL, window_json TEXT NOT NULL DEFAULT '{}',
  compression TEXT NOT NULL DEFAULT 'auto', limit_upload_kib INTEGER NOT NULL DEFAULT 0,
  retention_json TEXT NOT NULL DEFAULT '{}', hooks_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1, created_by TEXT, created_at TEXT NOT NULL,
  next_run_at TEXT, last_run_at TEXT, last_status TEXT
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, plan_id TEXT, client_id TEXT NOT NULL, repository_id TEXT NOT NULL,
  trigger TEXT NOT NULL DEFAULT 'manual', status TEXT NOT NULL DEFAULT 'queued',
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT,
  snapshot_id TEXT, files_new INTEGER DEFAULT 0, files_changed INTEGER DEFAULT 0,
  files_unmodified INTEGER DEFAULT 0, bytes_added INTEGER DEFAULT 0,
  bytes_processed INTEGER DEFAULT 0, error TEXT, log_tail TEXT,
  task_id TEXT, progress_json TEXT, paths_json TEXT, excludes_json TEXT
);

CREATE TABLE IF NOT EXISTS restores (
  id TEXT PRIMARY KEY, client_id TEXT NOT NULL, repository_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL, includes_json TEXT NOT NULL, target TEXT NOT NULL,
  overwrite TEXT NOT NULL DEFAULT 'always', dry_run INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'queued', created_by TEXT, created_at TEXT NOT NULL,
  started_at TEXT, finished_at TEXT, error TEXT, log_tail TEXT, task_id TEXT,
  progress_json TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, client_id TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued',
  cancel_requested INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, dispatched_at TEXT, finished_at TEXT, result_json TEXT,
  dedupe_key TEXT
);

CREATE TABLE IF NOT EXISTS repo_checks (
  id TEXT PRIMARY KEY, repository_id TEXT NOT NULL, client_id TEXT,
  kind TEXT NOT NULL, status TEXT NOT NULL, detail TEXT,
  started_at TEXT NOT NULL, finished_at TEXT
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, severity TEXT NOT NULL DEFAULT 'warning',
  message TEXT NOT NULL, client_id TEXT, run_id TEXT,
  created_at TEXT NOT NULL, acked_at TEXT, dedupe_key TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT, action TEXT NOT NULL,
  target TEXT, result TEXT, ip TEXT, detail_json TEXT
);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);

CREATE TABLE IF NOT EXISTS oidc_states (
  state TEXT PRIMARY KEY, nonce TEXT NOT NULL, verifier TEXT NOT NULL,
  return_to TEXT, created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_runs_client ON runs(client_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_tasks_client ON tasks(client_id, status);
CREATE INDEX IF NOT EXISTS idx_audit_at ON audit_log(at DESC);
CREATE INDEX IF NOT EXISTS idx_alerts_created ON alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_checks_repo ON repo_checks(repository_id, started_at DESC);
`;

export function openDb(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;');
  db.exec(SCHEMA);
  const run = (sql, ...args) => db.prepare(sql).run(...args);
  const get = (sql, ...args) => db.prepare(sql).get(...args);
  const all = (sql, ...args) => db.prepare(sql).all(...args);
  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      db.exec('COMMIT');
      return out;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      throw e;
    }
  };
  return { db, run, get, all, tx, close: () => db.close() };
}

export function setMeta(store, key, value) {
  store.run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, JSON.stringify(value));
}

export function getMeta(store, key, fallback = null) {
  const row = store.get('SELECT value FROM settings WHERE key=?', key);
  if (!row) return fallback;
  try { return JSON.parse(row.value); } catch { return fallback; }
}
