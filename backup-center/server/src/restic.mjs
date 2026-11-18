import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function resticEnv(cfg, password, extraEnv = {}) {
  return {
    ...process.env,
    RESTIC_PASSWORD: password,
    RESTIC_CACHE_DIR: cfg.restic.cache_dir,
    RESTIC_PROGRESS_FPS: '2',
    RESTIC_REPOSITORY: '',
    TMPDIR: path.join(cfg.paths.data, 'tmp'),
    HOME: path.join(cfg.paths.data, 'home'),
    ...extraEnv,
  };
}

export function ensureDirsForRest(cfg) {
  for (const d of [cfg.restic.cache_dir, path.join(cfg.paths.data, 'tmp'), path.join(cfg.paths.data, 'home')]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}

function parseJsonLines(chunk, carry, onLine) {
  const text = carry + chunk.toString('utf8');
  const lines = text.split('\n');
  const rest = lines.pop();
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try { onLine(JSON.parse(t)); } catch { /* 非 JSON 行忽略 */ }
  }
  return rest;
}

/**
 * 运行 restic。
 * @param {object} cfg
 * @param {object} opts {repo, password, args, onJson, onStderr, timeoutMs, env, cwd}
 */
export function runRestic(cfg, opts) {
  const { repo, password, args = [], onJson, onStderr, timeoutMs = 0, env = {}, cwd } = opts;
  return new Promise((resolve, reject) => {
    const fullArgs = ['-r', repo, ...args];
    const child = spawn(cfg.restic.binary, fullArgs, {
      env: resticEnv(cfg, password, env), cwd: cwd || cfg.paths.data, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let carry = '';
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch { /* ignore */ } }, timeoutMs);
    }
    child.stdout.on('data', (buf) => {
      const s = buf.toString('utf8');
      stdout += s;
      if (stdout.length > 8 * 1024 * 1024) stdout = stdout.slice(-8 * 1024 * 1024);
      if (onJson) carry = parseJsonLines(buf, carry, onJson);
    });
    child.stderr.on('data', (buf) => {
      const s = buf.toString('utf8');
      stderr += s;
      if (stderr.length > 1024 * 1024) stderr = stderr.slice(-1024 * 1024);
      if (onStderr) onStderr(s);
    });
    child.on('error', (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

export function spawnRestic(cfg, { repo, password, args = [], env = {} }) {
  return spawn(cfg.restic.binary, ['-r', repo, ...args], {
    env: resticEnv(cfg, password, env),
    cwd: cfg.paths.data,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function resticInit(cfg, repoPath, password) {
  return runRestic(cfg, { repo: repoPath, password, args: ['init', '--repository-version', '2'] });
}

export async function listSnapshots(cfg, repoPath, password, { host } = {}) {
  const args = ['snapshots', '--json'];
  if (host) args.push('--host', host);
  const r = await runRestic(cfg, { repo: repoPath, password, args });
  if (r.code !== 0) throw resticError('snapshots', r);
  try { return JSON.parse(r.stdout.trim() || '[]'); } catch { return []; }
}

export async function listSnapshotFiles(cfg, repoPath, password, snapshotId, dirPath) {
  const args = ['ls', '--json', snapshotId, dirPath];
  const r = await runRestic(cfg, { repo: repoPath, password, args });
  if (r.code !== 0) throw resticError('ls', r);
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      const j = JSON.parse(t);
      if (j.struct_type === 'node') out.push(j);
    } catch { /* ignore */ }
  }
  return out;
}

export async function resticForget(cfg, repoPath, password, snapshotIds, { prune = false, keep = null, dryRun = false, onJson } = {}) {
  const args = ['forget', '--json'];
  if (dryRun) args.push('--dry-run');
  if (prune) args.push('--prune');
  if (keep) {
    for (const k of ['last', 'daily', 'weekly', 'monthly', 'yearly']) {
      if (Number.isFinite(Number(keep[`keep_${k}`]))) args.push(`--keep-${k}`, String(Number(keep[`keep_${k}`])));
    }
    args.push('--keep-tag', 'pinned');
  }
  for (const s of snapshotIds || []) args.push(s);
  const r = await runRestic(cfg, { repo: repoPath, password, args, onJson });
  if (r.code !== 0) throw resticError('forget', r);
  return r;
}

export async function resticCheck(cfg, repoPath, password, { readDataSubset } = {}) {
  const args = ['check', '--json'];
  if (readDataSubset) args.push(`--read-data-subset=${readDataSubset}`);
  return runRestic(cfg, { repo: repoPath, password, args, timeoutMs: 24 * 3600 * 1000 });
}

export async function resticStats(cfg, repoPath, password) {
  const r = await runRestic(cfg, { repo: repoPath, password, args: ['stats', '--json', '--mode', 'raw-data'] });
  if (r.code !== 0) return null;
  try { return JSON.parse(r.stdout.trim()); } catch { return null; }
}

export async function resticTag(cfg, repoPath, password, snapshotId, { add = [], remove = [] } = {}) {
  const args = ['tag', snapshotId];
  if (add.length) args.push('--add', add.join(','));
  if (remove.length) args.push('--remove', remove.join(','));
  const r = await runRestic(cfg, { repo: repoPath, password, args });
  if (r.code !== 0) throw resticError('tag', r);
  return r;
}

export function resticError(op, r) {
  const msg = (r.stderr || r.stdout || '').trim().split('\n').slice(-3).join(' | ');
  const e = new Error(`restic ${op} 失败（exit ${r.code}）：${msg}`);
  e.exitCode = r.code;
  e.stderr = r.stderr;
  return e;
}
