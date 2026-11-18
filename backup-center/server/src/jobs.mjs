import { EventEmitter } from 'node:events';
import { ApiError, id, nowIso, parseJson, sleep } from './util.mjs';

export function createJobs({ cfg, store, storage, audit }) {
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const waiters = new Map(); // clientId -> Set<resolve>

  const key = (kind, entityId) => `${kind}:${entityId}`;
  function emit(kind, entityId, event, data) {
    bus.emit(key(kind, entityId), { event, data });
  }
  function subscribe(kind, entityId, res) {
    const k = key(kind, entityId);
    const onEvent = ({ event, data }) => {
      try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch { /* ignore */ }
    };
    bus.on(k, onEvent);
    const timer = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 20000);
    return () => { clearInterval(timer); bus.off(k, onEvent); try { res.end(); } catch { /* ignore */ } };
  }

  function notifyClient(clientId) {
    const set = waiters.get(clientId);
    if (!set) return;
    waiters.delete(clientId);
    for (const resolve of set) resolve();
  }

  function enqueueTask({ type, clientId, payload, dedupeKey = null }) {
    const taskId = id('t', 8);
    store.run('INSERT INTO tasks(id,type,client_id,payload_json,status,created_at,dedupe_key) VALUES(?,?,?,?,?,?,?)',
      taskId, type, clientId, JSON.stringify({ ...payload, id: taskId, type }), 'queued', nowIso(), dedupeKey);
    notifyClient(clientId);
    return taskId;
  }

  function nextQueuedTask(clientId) {
    const row = store.get("SELECT * FROM tasks WHERE client_id=? AND status='queued' ORDER BY created_at LIMIT 1", clientId);
    if (!row) return null;
    store.run("UPDATE tasks SET status='dispatched', dispatched_at=? WHERE id=?", nowIso(), row.id);
    return { id: row.id, payload: parseJson(row.payload_json, {}) };
  }

  function waitTask(clientId, waitMs = 20000) {
    const immediate = nextQueuedTask(clientId);
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve) => {
      let finished = false;
      let poll = null;
      let timer = null;
      const wake = () => {
        const t = nextQueuedTask(clientId);
        if (t) done(t);
      };
      const cleanup = () => {
        if (poll) clearInterval(poll);
        if (timer) clearTimeout(timer);
        const set = waiters.get(clientId);
        if (set) {
          set.delete(wake);
          if (!set.size) waiters.delete(clientId);
        }
      };
      const done = (t) => {
        if (finished) return;
        finished = true;
        cleanup();
        resolve(t);
      };
      if (!waiters.has(clientId)) waiters.set(clientId, new Set());
      waiters.get(clientId).add(wake);
      timer = setTimeout(() => done(null), waitMs);
      // 兜底轮询，防止事件丢失；一旦结束必须清理，否则会"偷走"任务
      poll = setInterval(wake, 2000);
      wake();
    });
  }

  function taskRow(taskId) {
    return store.get('SELECT * FROM tasks WHERE id=?', taskId);
  }

  function reportProgress(taskId, data) {
    const task = taskRow(taskId);
    if (!task) throw new ApiError(404, 'not_found', '任务不存在');
    if (task.status === 'queued') store.run("UPDATE tasks SET status='running' WHERE id=?", taskId);
    const progress = {
      percent: Number(data.percent || 0),
      bytes_done: Number(data.bytes_done || 0),
      bytes_total: Number(data.bytes_total || 0),
      files_done: Number(data.files_done || 0),
      files_total: Number(data.files_total || 0),
      current_path: data.current_path || '',
      message: data.message || '',
      at: nowIso(),
    };
    if (task.type === 'backup') {
      const run = store.get('SELECT * FROM runs WHERE task_id=?', taskId);
      if (run) {
        store.run("UPDATE runs SET status='running', started_at=COALESCE(started_at,?), progress_json=? WHERE id=?",
          nowIso(), JSON.stringify(progress), run.id);
        emit('run', run.id, 'progress', progress);
      }
    } else if (task.type === 'restore') {
      const restore = store.get('SELECT * FROM restores WHERE task_id=?', taskId);
      if (restore) {
        store.run("UPDATE restores SET status='running', started_at=COALESCE(started_at,?), progress_json=? WHERE id=?",
          nowIso(), JSON.stringify(progress), restore.id);
        emit('restore', restore.id, 'progress', progress);
      }
    }
    return { ok: true, cancel: !!task.cancel_requested };
  }

  function reportResult(taskId, result) {
    const task = taskRow(taskId);
    if (!task) throw new ApiError(404, 'not_found', '任务不存在');
    const status = result && result.ok ? 'done' : 'failed';
    store.run("UPDATE tasks SET status=?, finished_at=?, result_json=? WHERE id=?", status, nowIso(), JSON.stringify(result || {}), taskId);
    const logTail = String((result && result.log_tail) || '').slice(-65536);
    if (task.type === 'backup') {
      const run = store.get('SELECT * FROM runs WHERE task_id=?', taskId);
      if (run) {
        const summary = (result && result.summary) || {};
        const ok = !!(result && result.ok);
        store.run(`UPDATE runs SET status=?, finished_at=?, snapshot_id=?, files_new=?, files_changed=?,
          files_unmodified=?, bytes_added=?, bytes_processed=?, error=?, log_tail=? WHERE id=?`,
          ok ? 'success' : 'failed', nowIso(), summary.snapshot_id || (result && result.snapshot_id) || null,
          Number(summary.files_new || 0), Number(summary.files_changed || 0), Number(summary.files_unmodified || 0),
          Number(summary.data_added_packed || summary.data_added || 0), Number(summary.total_bytes_processed || 0),
          ok ? null : String((result && result.error) || '备份失败').slice(0, 4000), logTail, run.id);
        emit('run', run.id, 'done', { ok, status: ok ? 'success' : 'failed', snapshot_id: summary.snapshot_id || null });
        if (ok && typeof onRunSuccess === 'function') { try { onRunSuccess(run); } catch (e) { console.error('onRunSuccess', e); } }
      }
    } else if (task.type === 'restore') {
      const restore = store.get('SELECT * FROM restores WHERE task_id=?', taskId);
      if (restore) {
        const ok = !!(result && result.ok);
        store.run("UPDATE restores SET status=?, finished_at=?, error=?, log_tail=? WHERE id=?",
          ok ? 'success' : 'failed', nowIso(), ok ? null : String((result && result.error) || '恢复失败').slice(0, 4000), logTail, restore.id);
        emit('restore', restore.id, 'done', { ok, status: ok ? 'success' : 'failed' });
      }
    }
    return { ok: true };
  }

  let onRunSuccess = null;
  function setOnRunSuccess(fn) { onRunSuccess = fn; }

  function cancelRun(runId) {
    const run = store.get('SELECT * FROM runs WHERE id=?', runId);
    if (!run) throw new ApiError(404, 'not_found', '运行不存在');
    if (run.status === 'queued' || run.status === 'running') {
      store.run("UPDATE runs SET status='canceled', finished_at=? WHERE id=?", nowIso(), runId);
      if (run.task_id) store.run('UPDATE tasks SET cancel_requested=1 WHERE id=?', run.task_id);
      emit('run', runId, 'done', { ok: false, status: 'canceled' });
    }
    return getRun(runId);
  }

  function cancelRestore(restoreId) {
    const row = store.get('SELECT * FROM restores WHERE id=?', restoreId);
    if (!row) throw new ApiError(404, 'not_found', '恢复任务不存在');
    if (row.status === 'queued' || row.status === 'running') {
      store.run("UPDATE restores SET status='canceled', finished_at=? WHERE id=?", nowIso(), restoreId);
      if (row.task_id) store.run('UPDATE tasks SET cancel_requested=1 WHERE id=?', row.task_id);
      emit('restore', restoreId, 'done', { ok: false, status: 'canceled' });
    }
    return getRestore(restoreId);
  }

  function repoPayload(clientId) {
    const repoInfo = storage.clientRepoPassword(clientId);
    if (!repoInfo) throw new ApiError(409, 'config', '节点尚未分配存储库');
    const client = store.get('SELECT repository_id FROM clients WHERE id=?', clientId);
    const repoId = client.repository_id;
    return { url: `${cfg.server.agent_url}/repo/${repoId}/${clientId}/`, password: repoInfo.password };
  }

  function createRun(plan, { trigger = 'manual', paths = null, excludes = null, userId = null } = {}) {
    const client = store.get('SELECT * FROM clients WHERE id=?', plan.client_id);
    if (!client) throw new ApiError(404, 'not_found', '节点不存在');
    if (client.status !== 'active') throw new ApiError(409, 'conflict', '节点已停用');
    const repoId = plan.repository_id || client.repository_id;
    const repoInfo = storage.clientRepoPassword(client.id);
    if (!repoInfo) throw new ApiError(409, 'config', '节点尚未初始化仓库');
    const runId = id('run', 8);
    const usePaths = Array.isArray(paths) && paths.length ? paths : parseJson(plan.paths_json, []);
    const useExcludes = Array.isArray(excludes) ? excludes : parseJson(plan.excludes_json, []);
    store.run('INSERT INTO runs(id,plan_id,client_id,repository_id,trigger,status,created_at,paths_json,excludes_json) VALUES(?,?,?,?,?,?,?,?,?)',
      runId, plan.id || null, client.id, repoId, trigger, 'queued', nowIso(), JSON.stringify(usePaths), JSON.stringify(useExcludes));
    const repo = { url: `${cfg.server.agent_url}/repo/${repoId}/${client.id}/`, password: repoInfo.password };
    const payload = {
      plan_id: plan.id || null,
      run_id: runId,
      repo,
      host: client.id,
      paths: usePaths,
      excludes: useExcludes,
      tags: [`plan:${plan.id || 'manual'}`],
      compression: plan.compression || 'auto',
      limit_upload_kib: Number(plan.limit_upload_kib || 0),
      hooks: parseJson(plan.hooks_json, {}),
      timeout_seconds: Number(plan.timeout_seconds || 24 * 3600),
    };
    const taskId = enqueueTask({ type: 'backup', clientId: client.id, payload });
    store.run('UPDATE runs SET task_id=? WHERE id=?', taskId, runId);
    if (plan.id) store.run('UPDATE plans SET last_run_at=?, last_status=? WHERE id=?', nowIso(), 'queued', plan.id);
    return getRun(runId);
  }

  function createRestore({ clientId, snapshotId, includes, target, overwrite = 'always', dryRun = false, userId = null }) {
    const client = store.get('SELECT * FROM clients WHERE id=?', clientId);
    if (!client) throw new ApiError(404, 'not_found', '节点不存在');
    if (client.status !== 'active') throw new ApiError(409, 'conflict', '节点已停用');
    const repoInfo = storage.clientRepoPassword(client.id);
    if (!repoInfo) throw new ApiError(409, 'config', '节点尚未初始化仓库');
    const restoreId = id('rst', 8);
    store.run('INSERT INTO restores(id,client_id,repository_id,snapshot_id,includes_json,target,overwrite,dry_run,status,created_by,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      restoreId, client.id, client.repository_id, snapshotId, JSON.stringify(includes || []), target || '/', overwrite,
      dryRun ? 1 : 0, 'queued', userId || '', nowIso());
    const payload = {
      restore_id: restoreId,
      repo: { url: `${cfg.server.agent_url}/repo/${client.repository_id}/${client.id}/`, password: repoInfo.password },
      snapshot: snapshotId,
      includes: includes || [],
      target: target || '/',
      overwrite,
      dry_run: !!dryRun,
    };
    const taskId = enqueueTask({ type: 'restore', clientId: client.id, payload });
    store.run('UPDATE restores SET task_id=? WHERE id=?', taskId, restoreId);
    return getRestore(restoreId);
  }

  async function waitTaskResult(taskId, timeoutMs = 15000) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      const t = store.get('SELECT * FROM tasks WHERE id=?', taskId);
      if (!t) return null;
      if (t.status === 'done' || t.status === 'failed' || t.status === 'canceled') {
        return { ok: t.status === 'done', status: t.status, result: parseJson(t.result_json, {}) };
      }
      await sleep(100);
    }
    return null;
  }

  function getRun(runId) {
    const row = store.get('SELECT * FROM runs WHERE id=?', runId);
    if (!row) return null;
    return { ...row, progress: parseJson(row.progress_json, null), paths: parseJson(row.paths_json, []), excludes: parseJson(row.excludes_json, []) };
  }

  function listRuns({ clientId, status, limit = 50, offset = 0 } = {}) {
    const where = [];
    const args = [];
    if (clientId) { where.push('client_id=?'); args.push(clientId); }
    if (status) { where.push('status=?'); args.push(status); }
    const sql = `SELECT * FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    return store.all(sql, ...args, Number(limit), Number(offset)).map((r) => ({ ...r, progress: parseJson(r.progress_json, null) }));
  }

  function getRestore(restoreId) {
    const row = store.get('SELECT * FROM restores WHERE id=?', restoreId);
    if (!row) return null;
    return { ...row, progress: parseJson(row.progress_json, null), includes: parseJson(row.includes_json, []) };
  }

  function listRestores({ status, limit = 50, offset = 0 } = {}) {
    const args = [];
    let where = '';
    if (status) { where = 'WHERE status=?'; args.push(status); }
    return store.all(`SELECT * FROM restores ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`, ...args, Number(limit), Number(offset))
      .map((r) => ({ ...r, progress: parseJson(r.progress_json, null), includes: parseJson(r.includes_json, []) }));
  }

  function watchdog() {
    const now = Date.now();
    // 已下发但代理迟迟未开始的任务：重新入队（最多 3 次），避免连接中断导致任务丢失
    const dispatched = store.all("SELECT * FROM tasks WHERE status='dispatched'");
    for (const row of dispatched) {
      const at = row.dispatched_at ? new Date(row.dispatched_at).getTime() : now;
      if (now - at > 120 * 1000) {
        if (Number(row.attempts || 0) < 3) {
          store.run("UPDATE tasks SET status='queued', dispatched_at=NULL, attempts=attempts+1 WHERE id=?", row.id);
        } else {
          store.run("UPDATE tasks SET status='failed', finished_at=? WHERE id=?", nowIso(), row.id);
          reportResult(row.id, { ok: false, error: '任务多次下发未执行（代理无响应）', log_tail: '' });
        }
      }
    }
    const running = store.all("SELECT * FROM tasks WHERE status='running'");
    for (const row of running) {
      const started = new Date(row.dispatched_at || row.created_at).getTime();
      if (now - started > 25 * 3600 * 1000) {
        store.run("UPDATE tasks SET status='failed', finished_at=? WHERE id=?", nowIso(), row.id);
        reportResult(row.id, { ok: false, error: '任务超时（服务端判定）', log_tail: '' });
      }
    }
  }

  return {
    enqueueTask, waitTask, reportProgress, reportResult, cancelRun, cancelRestore,
    createRun, createRestore, getRun, listRuns, getRestore, listRestores, subscribe, watchdog, setOnRunSuccess,
    waitTaskResult, repoPayload,
  };
}
