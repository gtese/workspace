import { ApiError, parseJson } from './util.mjs';
import { listSnapshots, listSnapshotFiles, resticTag, resticForget, spawnRestic } from './restic.mjs';

export function createSnapshots({ cfg, store, storage, jobs }) {
  function ctx(clientId, repositoryId = null) {
    const client = store.get('SELECT * FROM clients WHERE id=?', clientId);
    if (!client) throw new ApiError(404, 'not_found', '节点不存在');
    const repoId = repositoryId || client.repository_id;
    if (!repoId) throw new ApiError(409, 'config', '节点尚未分配存储库');
    const repo = storage.clientRepository(clientId, repoId);
    if (!repo) throw new ApiError(404, 'not_found', '存储库不存在');
    const cred = storage.clientRepoPassword(clientId, repoId);
    return { client, repo, repositoryId: repoId, dir: storage.clientRepoDir(repo, clientId), password: cred.password };
  }

  async function list(clientId, repositoryId = null) {
    const { client, dir, password, repositoryId: rid } = ctx(clientId, repositoryId);
    const snaps = await listSnapshots(cfg, dir, password, { host: client.id });
    return snaps.map((s) => {
      const tags = s.tags || [];
      const sum = s.summary || {};
      return {
        id: s.id, short_id: s.short_id, time: s.time, hostname: s.hostname,
        repository_id: rid, paths: s.paths || [], tags, pinned: tags.includes('pinned'),
        files: sum.total_files_processed || 0,
        bytes: sum.total_bytes_processed || 0,
        data_added: sum.data_added_packed || sum.data_added || 0,
        duration_seconds: sum.total_duration || 0,
      };
    }).sort((a, b) => (a.time < b.time ? 1 : -1));
  }

  async function ls(clientId, snapshotId, dirPath, repositoryId = null) {
    const { dir, password } = ctx(clientId, repositoryId);
    const target = normalizePath(dirPath || '/');
    const nodes = await listSnapshotFiles(cfg, dir, password, snapshotId, target);
    const seen = new Set();
    const entries = [];
    for (const n of nodes) {
      if (!n.path || n.path === target) continue;
      if (seen.has(n.path)) continue;
      seen.add(n.path);
      entries.push({
        name: n.name || n.path.split('/').pop(),
        path: n.path,
        type: n.type === 'symlink' ? 'link' : (n.type || 'other'),
        size: n.type === 'dir' ? 0 : Number(n.size || 0),
        mode: modeToString(n.mode),
        mtime: n.mtime || '',
        link_target: n.linktarget || '',
        uid: n.uid, gid: n.gid,
      });
    }
    entries.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : b.type === 'dir' ? 1 : 0));
    const roots = await snapshotRoots(clientId, snapshotId, repositoryId);
    return { path: target, entries, roots };
  }

  async function snapshotRoots(clientId, snapshotId, repositoryId = null) {
    const { dir, password } = ctx(clientId, repositoryId);
    const snaps = await listSnapshots(cfg, dir, password);
    const snap = snaps.find((s) => s.id === snapshotId || s.short_id === snapshotId);
    return snap ? (snap.paths || []) : [];
  }

  async function search(clientId, snapshotId, q, repositoryId = null) {
    const { dir, password } = ctx(clientId, repositoryId);
    const pattern = String(q || '').trim();
    if (!pattern) return [];
    const r = await import('./restic.mjs').then((m) => m.runRestic(cfg, { repo: dir, password, args: ['find', '--json', `*${pattern}*`], timeoutMs: 60000 }));
    if (r.code !== 0) return [];
    let data = [];
    try { data = JSON.parse(r.stdout.trim() || '[]'); } catch { data = []; }
    const out = [];
    for (const grp of data) {
      const snap = String(grp.snapshot || '');
      if (snap !== snapshotId && !snap.startsWith(snapshotId)) continue;
      for (const m of grp.matches || []) {
        out.push({ path: m.path, type: m.type === 'symlink' ? 'link' : m.type, size: Number(m.size || 0), mode: modeToString(m.mode), mtime: m.mtime });
        if (out.length >= 500) break;
      }
    }
    return out;
  }

  async function download(clientId, snapshotId, filePath, repositoryId = null) {
    const { dir, password } = ctx(clientId, repositoryId);
    const target = normalizePath(filePath);
    if (target === '/' || target === '') throw new ApiError(400, 'validation', '请选择要下载的文件或目录');
    const nodes = await listSnapshotFiles(cfg, dir, password, snapshotId, target);
    const self = nodes.find((n) => n.path === target);
    if (!self) throw new ApiError(404, 'not_found', '快照中不存在该路径');
    const isDir = self.type === 'dir';
    const args = ['dump', snapshotId, target];
    if (isDir) args.push('-a', 'zip');
    const child = spawnRestic(cfg, { repo: dir, password, args });
    return {
      child, isDir,
      name: self.name || target.split('/').pop() || 'download',
      size: isDir ? null : Number(self.size || 0),
    };
  }

  async function pin(clientId, snapshotId, pinned, repositoryId = null) {
    const { dir, password } = ctx(clientId, repositoryId);
    if (pinned) await resticTag(cfg, dir, password, snapshotId, { add: ['pinned'] });
    else await resticTag(cfg, dir, password, snapshotId, { remove: ['pinned'] });
    return { ok: true, pinned: !!pinned };
  }

  async function remove(clientId, snapshotId, repositoryId = null) {
    const { dir, password } = ctx(clientId, repositoryId);
    await resticForget(cfg, dir, password, [snapshotId], { prune: false });
    return { ok: true };
  }

  function modeToString(mode) {
    if (mode === undefined || mode === null) return '';
    const n = Number(mode);
    if (!Number.isFinite(n)) return String(mode);
    return (n & 0o7777).toString(8).padStart(4, '0');
  }

  function normalizePath(p) {
    let s = String(p || '/').trim();
    if (!s.startsWith('/')) s = '/' + s;
    s = s.replace(/\/+/g, '/');
    if (s.length > 1) s = s.replace(/\/$/, '');
    if (s.includes('..')) throw new ApiError(400, 'validation', '路径不能包含 ..');
    return s;
  }

  return { list, ls, search, download, pin, remove, ctx, normalizePath };
}
