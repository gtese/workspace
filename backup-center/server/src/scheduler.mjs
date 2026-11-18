import fs from 'node:fs';
import { id, nowIso, parseJson, sleep } from './util.mjs';
import { nextOccurrence, inWindow } from './cron.mjs';
import { resticForget, resticCheck } from './restic.mjs';

export function createScheduler({ cfg, store, storage, jobs, snapshots, alerts }) {
  let timer = null;
  let lastCapacityCheck = 0;
  let lastOfflineCheck = 0;
  let checkBusy = false;
  const pruneInFlight = new Set();

  function clientOnline(client, nowMs = Date.now()) {
    if (!client.last_seen_at) return false;
    return nowMs - new Date(client.last_seen_at).getTime() < 10 * 60 * 1000;
  }

  function activeBackups() {
    return store.all("SELECT * FROM runs WHERE status IN ('queued','running')");
  }

  function canStart(plan, active) {
    if (active.filter((r) => r.client_id === plan.client_id).length > 0) return false;
    if (active.length >= Number(cfg.scheduler.max_concurrent_backups)) return false;
    const perRepo = active.filter((r) => r.repository_id === plan.repository_id).length;
    if (perRepo >= Number(cfg.scheduler.max_concurrent_per_repo)) return false;
    return true;
  }

  function planNextRun(plan, from = new Date()) {
    try { return nextOccurrence(plan.cron, from); } catch { return null; }
  }

  function tick() {
    if (timer === null) return;
    try { tickInner(); } catch (e) { console.error('[scheduler]', e); }
  }

  function tickInner() {
    const now = new Date();
    const active = activeBackups();
    const plans = store.all("SELECT * FROM plans WHERE enabled=1");
    for (const plan of plans) {
      const due = !plan.next_run_at || new Date(plan.next_run_at).getTime() <= now.getTime();
      if (!due) continue;
      const window = parseJson(plan.window_json, {});
      if (window.start && window.end && !inWindow(now, window)) {
        const nxt = planNextRun(plan, new Date(now.getTime() - 60000));
        store.run('UPDATE plans SET next_run_at=? WHERE id=?', nxt ? nxt.toISOString() : null, plan.id);
        continue;
      }
      const client = store.get('SELECT * FROM clients WHERE id=?', plan.client_id);
      if (!client || client.status !== 'active') {
        const nxt = planNextRun(plan, now);
        store.run('UPDATE plans SET next_run_at=? WHERE id=?', nxt ? nxt.toISOString() : null, plan.id);
        continue;
      }
      if (!clientOnline(client)) {
        const retry = new Date(now.getTime() + 15 * 60 * 1000);
        const next = (window.start && window.end && !inWindow(retry, window)) ? planNextRun(plan, now) : retry;
        store.run('UPDATE plans SET next_run_at=? WHERE id=?', next ? next.toISOString() : null, plan.id);
        alerts.send({ type: 'client_offline', severity: 'warning', message: `节点 ${client.hostname} 离线，跳过计划「${plan.name}」`, clientId: client.id, dedupeMinutes: 360 }).catch(() => {});
        continue;
      }
      if (!canStart(plan, active)) continue;
      try {
        const run = jobs.createRun(plan, { trigger: 'schedule' });
        store.run('UPDATE plans SET next_run_at=?, last_status=? WHERE id=?', planNextRun(plan, now).toISOString(), 'queued', plan.id);
        active.push(run);
      } catch (e) {
        console.error('[scheduler] createRun', e.message);
        const nxt = planNextRun(plan, now);
        store.run('UPDATE plans SET next_run_at=? WHERE id=?', nxt ? nxt.toISOString() : null, plan.id);
      }
    }

    jobs.watchdog();

    const nowMs = Date.now();
    if (nowMs - lastOfflineCheck > 30 * 60 * 1000) {
      lastOfflineCheck = nowMs;
      offlineAlerts(nowMs);
    }
    if (nowMs - lastCapacityCheck > 30 * 60 * 1000) {
      lastCapacityCheck = nowMs;
      capacityAlerts();
    }
    scheduleChecks();
  }

  function offlineAlerts(nowMs) {
    const clients = store.all("SELECT * FROM clients WHERE status='active'");
    const threshold = Number(cfg.scheduler.offline_alert_minutes) * 60000;
    for (const c of clients) {
      const baseline = c.last_seen_at ? new Date(c.last_seen_at).getTime() : new Date(c.created_at).getTime();
      if (nowMs - baseline > threshold) {
        alerts.send({ type: 'client_offline', severity: 'warning', message: `节点 ${c.hostname} 已离线超过 ${Math.round(threshold / 60000)} 分钟`, clientId: c.id, dedupeMinutes: 720 }).catch(() => {});
      }
    }
  }

  function capacityAlerts() {
    const repos = store.all('SELECT * FROM repositories');
    for (const r of repos) {
      try {
        const st = fs.statfsSync(r.mountpoint);
        const total = Number(st.bsize) * Number(st.blocks);
        const free = Number(st.bsize) * Number(st.bavail);
        const usedPct = total ? (1 - free / total) * 100 : 0;
        store.run('UPDATE repositories SET total_bytes=?,free_bytes=?,last_checked_at=? WHERE id=?', total, free, nowIso(), r.id);
        if (usedPct >= Number(cfg.scheduler.capacity_alert_percent)) {
          alerts.send({ type: 'repo_capacity', severity: 'critical', message: `存储库 ${r.name} 使用率 ${usedPct.toFixed(1)}%，剩余 ${(free / 1024 ** 4).toFixed(1)} TiB`, dedupeMinutes: 720 }).catch(() => {});
        }
      } catch (e) { /* 挂载不可用时忽略 */ }
    }
  }

  function maybeRetention(run) {
    const plan = run.plan_id ? store.get('SELECT * FROM plans WHERE id=?', run.plan_id) : null;
    const retention = parseJson(plan && plan.retention_json, cfg.defaults.retention);
    if (retention && retention.prune_after_backup === false) return;
    const last = store.get("SELECT started_at FROM repo_checks WHERE client_id=? AND kind='prune' AND status='ok' ORDER BY started_at DESC LIMIT 1", run.client_id);
    if (last && Date.now() - new Date(last.started_at).getTime() < 6 * 24 * 3600 * 1000) return;
    const key = `prune:${run.client_id}`;
    if (pruneInFlight.has(key)) return;
    pruneInFlight.add(key);
    setTimeout(() => {
      pruneClient(run.client_id, retention)
        .catch((e) => console.error('[prune]', e.message))
        .finally(() => pruneInFlight.delete(key));
    }, 5000).unref();
  }

  async function pruneClient(clientId, retention = cfg.defaults.retention) {
    const { dir, password, client } = snapshots.ctx(clientId);
    const checkId = id('chk', 8);
    store.run('INSERT INTO repo_checks(id,repository_id,client_id,kind,status,started_at) VALUES(?,?,?,?,?,?)',
      checkId, client.repository_id, clientId, 'prune', 'running', nowIso());
    try {
      const r = await resticForget(cfg, dir, password, [], { keep: retention, prune: true });
      store.run("UPDATE repo_checks SET status='ok', finished_at=? WHERE id=?", nowIso(), checkId);
      return { ok: true, stdout: r.stdout.slice(-2000) };
    } catch (e) {
      store.run("UPDATE repo_checks SET status='failed', detail=?, finished_at=? WHERE id=?", String(e.message || e).slice(0, 2000), nowIso(), checkId);
      await alerts.send({ type: 'prune_failed', severity: 'warning', message: `节点 ${client.hostname} 清理旧快照失败：${e.message}`, clientId, dedupeMinutes: 360 });
      throw e;
    }
  }

  async function checkClient(clientId, { readData = false } = {}) {
    const { dir, password, client } = snapshots.ctx(clientId);
    const checkId = id('chk', 8);
    const kind = readData ? 'read-data' : 'check';
    store.run('INSERT INTO repo_checks(id,repository_id,client_id,kind,status,started_at) VALUES(?,?,?,?,?,?)',
      checkId, client.repository_id, clientId, kind, 'running', nowIso());
    try {
      const r = await resticCheck(cfg, dir, password, readData ? { readDataSubset: '1%' } : {});
      if (r.code !== 0) throw new Error((r.stderr || r.stdout || '').slice(-1000));
      store.run("UPDATE repo_checks SET status='ok', finished_at=? WHERE id=?", nowIso(), checkId);
      return { ok: true };
    } catch (e) {
      store.run("UPDATE repo_checks SET status='failed', detail=?, finished_at=? WHERE id=?", String(e.message || e).slice(0, 2000), nowIso(), checkId);
      await alerts.send({ type: 'check_failed', severity: 'critical', message: `节点 ${client.hostname} 仓库校验失败：${e.message}`, clientId, dedupeMinutes: 720 });
      throw e;
    }
  }

  function lastCheckAt(clientId, kinds) {
    const rows = store.all(`SELECT kind, started_at FROM repo_checks WHERE client_id=? AND status='ok' AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY started_at DESC LIMIT 1`, clientId, ...kinds);
    return rows.length ? new Date(rows[0].started_at).getTime() : 0;
  }

  async function scheduleChecks() {
    if (checkBusy) return;
    checkBusy = true;
    try {
      const clients = store.all("SELECT * FROM clients WHERE status='active'");
      const week = 7 * 24 * 3600 * 1000;
      const month = 30 * 24 * 3600 * 1000;
      for (const c of clients) {
        const lastCheck = lastCheckAt(c.id, ['check']);
        if (Date.now() - lastCheck > week) { await checkClient(c.id, { readData: false }).catch(() => {}); await sleep(1000); }
        const lastRead = lastCheckAt(c.id, ['read-data']);
        if (Date.now() - lastRead > month) { await checkClient(c.id, { readData: true }).catch(() => {}); await sleep(1000); }
      }
    } finally { checkBusy = false; }
  }

  function start() {
    if (timer) return;
    timer = setInterval(tick, Number(cfg.scheduler.tick_ms) || 10000);
    timer.unref();
    setTimeout(tick, 3000).unref();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { start, stop, tick, pruneClient, checkClient, maybeRetention, clientOnline };
}
