import { nowIso } from './util.mjs';

export function createMetrics({ store }) {
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
    return lines.join('\n') + '\n';
  }
  return { render };
}
