import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ApiError, id, nowIso, randomToken, maskSecret } from './util.mjs';
import { encryptText, decryptText } from './crypt.mjs';
import { resticInit, resticStats } from './restic.mjs';

const TYPES = new Set(['local', 'nfs', 'cifs', 'ftp']);

export function createStorage({ cfg, store, masterKey, mountd }) {
  const usageCache = new Map();

  function maskConfig(type, config) {
    const c = { ...config };
    if (c.password) c.password = maskSecret(c.password);
    return c;
  }

  function validate(type, config) {
    if (!TYPES.has(type)) throw new ApiError(400, 'validation', `不支持的存储类型：${type}`);
    if (!config || typeof config !== 'object') throw new ApiError(400, 'validation', '缺少存储配置');
    if (type === 'local') {
      if (!config.path || !path.isAbsolute(config.path)) throw new ApiError(400, 'validation', '本地目录必须是绝对路径');
    } else if (type === 'nfs') {
      if (!config.server || !config.export) throw new ApiError(400, 'validation', 'NFS 需要 server 与 export');
    } else if (type === 'cifs') {
      if (!config.server || !config.share) throw new ApiError(400, 'validation', 'CIFS 需要 server 与 share');
    } else if (type === 'ftp') {
      if (!config.host) throw new ApiError(400, 'validation', 'FTP 需要 host');
    }
  }

  function mountpointFor(type, config, repoId) {
    if (type === 'local') return config.path;
    return path.join(cfg.paths.storage, repoId);
  }

  async function ensureMounted(row) {
    const config = row.config || (row.config_enc ? JSON.parse(decryptText(masterKey, row.config_enc)) : {});
    if (row.type === 'local') {
      // 优先让 root 挂载助手创建目录并 chown 到 backup，兼容"管理员已手工 mkdir 但属主为 root"的场景
      if (cfg.mountd.enabled) {
        try {
          await mountd.ensure({ repo_id: row.id, type: 'local', config, mountpoint: row.mountpoint });
          return;
        } catch (e) {
          // 挂载助手不可用时退回本进程 mkdir（目录已存在且可写时仍可成功）
        }
      }
      fs.mkdirSync(row.mountpoint, { recursive: true, mode: 0o700 });
      return;
    }
    await mountd.ensure({ repo_id: row.id, type: row.type, config, mountpoint: row.mountpoint });
  }

  function unwritableMessage(dir) {
    return `目录不可写：${dir}。服务以 backup 用户运行，请先执行 ` +
      `chown -R backup:backup ${dir}（或 chmod 0770 并确保 backup 组可写），` +
      `再重试；也可由管理员用 root 创建目录后交给 backup。`;
  }

  function writable(dir) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.accessSync(dir, fs.constants.W_OK);
      return true;
    } catch { return false; }
  }

  async function create({ name, type, config }) {
    validate(type, config);
    if (!name || !String(name).trim()) throw new ApiError(400, 'validation', '存储库名称不能为空');
    if (store.get('SELECT id FROM repositories WHERE name=?', String(name).trim())) {
      throw new ApiError(409, 'conflict', '存储库名称已存在');
    }
    // 本地路径不允许被多个存储库复用（防止同一目录被两个仓库并发写入）
    if (type === 'local') {
      const dup = store.all("SELECT id,name,mountpoint FROM repositories WHERE type='local'");
      let target;
      try { target = path.resolve(config.path); } catch { target = config.path; }
      for (const d of dup) {
        if (path.resolve(d.mountpoint) === target) {
          throw new ApiError(409, 'conflict', `该本地路径已被存储库「${d.name}」使用`);
        }
      }
    }
    const repoId = id('r', 6);
    const mountpoint = mountpointFor(type, config, repoId);
    const enc = encryptText(masterKey, JSON.stringify(config));
    const row = { id: repoId, name: String(name).trim(), type, config_enc: enc, mountpoint, status: 'active' };
    store.run('INSERT INTO repositories(id,name,type,config_enc,mountpoint,status,created_at) VALUES(?,?,?,?,?,?,?)',
      repoId, row.name, type, enc, mountpoint, 'active', nowIso());
    try {
      await ensureMounted(row);
      if (!writable(mountpoint)) throw new ApiError(500, 'storage_unwritable', unwritableMessage(mountpoint));
    } catch (e) {
      store.run("UPDATE repositories SET status='error', last_error=? WHERE id=?", String(e.message || e), repoId);
      throw e;
    }
    return get(repoId);
  }

  function get(repoId, { reveal = false } = {}) {
    const row = store.get('SELECT * FROM repositories WHERE id=?', repoId);
    if (!row) return null;
    const config = JSON.parse(decryptText(masterKey, row.config_enc));
    return { ...row, config_enc: undefined, config: reveal ? config : maskConfig(row.type, config) };
  }

  function list() {
    return store.all('SELECT * FROM repositories ORDER BY created_at').map((row) => ({
      ...row, config_enc: undefined, config: maskConfig(row.type, JSON.parse(decryptText(masterKey, row.config_enc))),
    }));
  }

  async function update(repoId, { name, config }) {
    const row = store.get('SELECT * FROM repositories WHERE id=?', repoId);
    if (!row) throw new ApiError(404, 'not_found', '存储库不存在');
    if (name && name !== row.name) {
      if (store.get('SELECT id FROM repositories WHERE name=?', name)) throw new ApiError(409, 'conflict', '名称已存在');
      store.run('UPDATE repositories SET name=? WHERE id=?', String(name).trim(), repoId);
    }
    if (config) {
      validate(row.type, config);
      if (config.type && config.type !== row.type) throw new ApiError(400, 'validation', '不支持修改存储库类型');
      const old = JSON.parse(decryptText(masterKey, row.config_enc));
      if ((config.password === undefined || config.password === '') && old.password) config.password = old.password;
      const enc = encryptText(masterKey, JSON.stringify(config));
      store.run('UPDATE repositories SET config_enc=? WHERE id=?', enc, repoId);
      const fresh = get(repoId, { reveal: true });
      try {
        await ensureMounted(fresh);
        if (!writable(fresh.mountpoint)) throw new ApiError(500, 'storage_unwritable', unwritableMessage(fresh.mountpoint));
        store.run("UPDATE repositories SET status='active', last_error=NULL WHERE id=?", repoId);
      } catch (e) {
        store.run("UPDATE repositories SET status='error', last_error=? WHERE id=?", String(e.message || e), repoId);
        throw e;
      }
    }
    return get(repoId);
  }

  function remove(repoId) {
    const used = store.get('SELECT COUNT(*) AS n FROM clients WHERE repository_id=?', repoId);
    if (used && used.n > 0) throw new ApiError(409, 'conflict', '仍有节点使用该存储库');
    const row = store.get('SELECT * FROM repositories WHERE id=?', repoId);
    if (!row) throw new ApiError(404, 'not_found', '存储库不存在');
    store.run('DELETE FROM repositories WHERE id=?', repoId);
    return { ok: true, mountpoint: row.mountpoint };
  }

  function clientRepoDir(repo, clientId) {
    return path.join(repo.mountpoint, clientId);
  }

  function ensureClientRepo(clientId, repoId) {
    const repo = get(repoId, { reveal: true });
    if (!repo) throw new ApiError(404, 'not_found', '存储库不存在');
    let row = store.get('SELECT * FROM client_repos WHERE client_id=?', clientId);
    let password;
    if (!row) {
      password = randomToken(32);
      store.run('INSERT INTO client_repos(client_id,repository_id,repo_password_enc,created_at) VALUES(?,?,?,?)',
        clientId, repoId, encryptText(masterKey, password), nowIso());
    } else {
      password = decryptText(masterKey, row.repo_password_enc);
    }
    const dir = clientRepoDir(repo, clientId);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const t of ['data', 'index', 'keys', 'locks', 'snapshots']) fs.mkdirSync(path.join(dir, t), { recursive: true, mode: 0o700 });
    if (!fs.existsSync(path.join(dir, 'config'))) {
      const r = resticInitSync(repo, dir, password);
      if (r.code !== 0) throw new ApiError(500, 'repo_init_failed', `初始化仓库失败：${(r.stderr || '').slice(-400)}`);
    }
    return { dir, password };
  }

  function resticInitSync(repo, dir, password) {
    try {
      const out = execFileSync(cfg.restic.binary, ['-r', dir, 'init', '--repository-version', '2'], {
        env: { ...process.env, RESTIC_PASSWORD: password, RESTIC_CACHE_DIR: cfg.restic.cache_dir },
        encoding: 'utf8', timeout: 120000,
      });
      return { code: 0, stdout: out, stderr: '' };
    } catch (e) {
      return { code: e.status || 1, stdout: e.stdout || '', stderr: e.stderr || e.message };
    }
  }

  function clientRepoPassword(clientId) {
    const row = store.get('SELECT * FROM client_repos WHERE client_id=?', clientId);
    if (!row) return null;
    return { password: decryptText(masterKey, row.repo_password_enc), repositoryId: row.repository_id };
  }

  function clientRepository(clientId) {
    const client = store.get('SELECT * FROM clients WHERE id=?', clientId);
    if (!client) return null;
    return get(client.repository_id, { reveal: true });
  }

  function repoPasswordForClient(clientId) {
    return clientRepoPassword(clientId);
  }

  async function usage(repoId) {
    const repo = get(repoId, { reveal: true });
    if (!repo) throw new ApiError(404, 'not_found', '存储库不存在');
    const cached = usageCache.get(repoId);
    if (cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.value;
    let total = 0; let free = 0;
    try {
      const st = fs.statfsSync(repo.mountpoint);
      total = Number(st.bsize) * Number(st.blocks);
      free = Number(st.bsize) * Number(st.bavail);
    } catch { /* ignore */ }
    const clients = [];
    let entries = [];
    try { entries = fs.readdirSync(repo.mountpoint, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { entries = []; }
    for (const d of entries) {
      const clientRow = store.get('SELECT id,hostname FROM clients WHERE id=?', d.name);
      let bytes = 0;
      try {
        const out = execFileSync('du', ['-sk', path.join(repo.mountpoint, d.name)], { encoding: 'utf8', timeout: 20000 });
        bytes = Number((out.split(/\s+/)[0] || 0)) * 1024;
      } catch { /* ignore */ }
      const snaps = store.get('SELECT COUNT(*) AS n FROM runs WHERE client_id=? AND status=\'success\'', d.name);
      clients.push({ client_id: d.name, hostname: clientRow ? clientRow.hostname : d.name, bytes, snapshots: snaps ? snaps.n : 0 });
    }
    const value = { total_bytes: total, free_bytes: free, clients };
    store.run('UPDATE repositories SET total_bytes=?,free_bytes=?,last_checked_at=? WHERE id=?', total, free, nowIso(), repoId);
    usageCache.set(repoId, { at: Date.now(), value });
    return value;
  }

  async function validateRepo(repoId) {
    const repo = get(repoId, { reveal: true });
    if (!repo) throw new ApiError(404, 'not_found', '存储库不存在');
    await ensureMounted(repo);
    if (!writable(repo.mountpoint)) throw new ApiError(500, 'storage_unwritable', unwritableMessage(repo.mountpoint));
    const probe = path.join(repo.mountpoint, `.probe-${Date.now()}`);
    fs.writeFileSync(probe, 'ok', { mode: 0o600 });
    fs.rmSync(probe, { force: true });
    store.run("UPDATE repositories SET status='active', last_error=NULL, last_checked_at=? WHERE id=?", nowIso(), repoId);
    return { ok: true, mountpoint: repo.mountpoint };
  }

  return {
    list, get, create, update, remove, clientRepoDir, ensureClientRepo, clientRepoPassword,
    clientRepository, repoPasswordForClient, usage, validateRepo, ensureMounted,
  };
}
