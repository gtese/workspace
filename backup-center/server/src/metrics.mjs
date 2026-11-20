import fs from 'node:fs';
import crypto from 'node:crypto';

export function createMetrics({ store, cfg }) {
  function render() {
    const lines = [];
    const add = (name, help, type, samples) => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
      for (const [labels, value] of samples) lines.push(`${name}${labels ? `{${labels}}` : ''} ${value}`);
    };
    const now = Date.now();
    const clients = store.all('SELECT status, last_seen_at FROM clients');
    const online = clients.filter((c) => c.last_seen_at && now - new Date(c.last_seen_at).getTime() < 10 * 60 * 1000).length;
    add('backup_clients_total', '节点总数', 'gauge', [['', clients.length], ['status="online"', online]]);
    const runs = store.all("SELECT status, COUNT(*) AS n FROM runs WHERE created_at>=? GROUP BY status", new Date(now - 24 * 3600 * 1000).toISOString());
    add('backup_runs_24h', '近 24 小时运行数', 'gauge', runs.map((r) => [`status="${r.status}"`, r.n]).concat([['', runs.reduce((a, b) => a + b.n, 0)]]));
    const repos = store.all('SELECT id,total_bytes,free_bytes FROM repositories');
    add('backup_repo_free_bytes', '存储库剩余字节', 'gauge', repos.map((r) => [`repo="${r.id}"`, r.free_bytes || 0]));
    const alerts = store.get('SELECT COUNT(*) AS n FROM alerts WHERE acked_at IS NULL');
    add('backup_alerts_unacked', '未确认告警数', 'gauge', [['', alerts ? alerts.n : 0]]);
    // BCP：计划 RPO/最近成功备份年龄
    const plans = store.all('SELECT id,name,rpo_hours,enabled,created_at FROM plans');
    const ageSamples = [];
    const rpoSamples = [];
    for (const p of plans) {
      const row = store.get("SELECT finished_at FROM runs WHERE plan_id=? AND status='success' ORDER BY finished_at DESC LIMIT 1", p.id);
      const baseline = row ? new Date(row.finished_at).getTime() : new Date(p.created_at).getTime();
      const age = Math.max(0, Math.floor((now - baseline) / 1000));
      const label = `plan="${String(p.name).replace(/"/g, '')}"`;
      ageSamples.push([label, age]);
      rpoSamples.push([label, Number(p.rpo_hours || 26) * 3600]);
    }
    if (ageSamples.length) add('backup_plan_last_success_age_seconds', '计划距最近成功备份的秒数', 'gauge', ageSamples);
    if (rpoSamples.length) add('backup_plan_rpo_seconds', '计划 RPO（秒）', 'gauge', rpoSamples);
    const activeTasks = store.get("SELECT COUNT(*) AS n FROM tasks WHERE status IN ('queued','dispatched','running')");
    add('backup_active_tasks', '排队/执行中的任务数', 'gauge', [['', activeTasks ? activeTasks.n : 0]]);
    const checks = store.all("SELECT kind, MAX(started_at) AS last FROM repo_checks WHERE status='ok' GROUP BY kind");
    add('backup_check_last_ok_timestamp', '最近一次成功校验（unix 秒）', 'gauge', checks.map((c) => [`kind="${c.kind}"`, Math.floor(new Date(c.last).getTime() / 1000)]));
    const reposRatio = store.all('SELECT id, total_bytes, free_bytes FROM repositories');
    add('backup_repo_used_ratio', '存储库已用比例', 'gauge', reposRatio.map((r) => [`repo="${r.id}"`, r.total_bytes ? 1 - (r.free_bytes || 0) / r.total_bytes : 0]));
    // 控制面：DB 大小、进程运行时长、TLS 证书剩余有效期
    try { add('backup_db_size_bytes', 'SQLite 数据库大小', 'gauge', [['', fs.statSync(cfg.db.path).size]]); } catch { /* ignore */ }
    add('backup_uptime_seconds', '服务运行时长', 'gauge', [['', Math.floor(process.uptime())]]);
    try {
      const cert = new crypto.X509Certificate(fs.readFileSync(cfg.tls.cert));
      add('backup_tls_cert_expires_seconds', 'Web TLS 证书剩余秒数', 'gauge', [['', Math.max(0, Math.floor((new Date(cert.validTo).getTime() - now) / 1000))]]);
    } catch { /* ignore */ }
    const drills = store.all("SELECT client_id, repository_id, MAX(started_at) AS last FROM repo_checks WHERE kind='restore-drill' AND status='ok' GROUP BY client_id, repository_id");
    add('backup_last_restore_drill_ok_timestamp', '最近一次恢复演练成功（unix 秒）', 'gauge',
      drills.map((d) => [`client="${d.client_id}",repo="${d.repository_id}"`, Math.floor(new Date(d.last).getTime() / 1000)]));
    return lines.join('\n') + '\n';
  }
  return { render };
}
