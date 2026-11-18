import fs from 'node:fs';
import path from 'node:path';

const DEFAULTS = {
  tls: { enabled: true, cert: '', key: '', ca: '' },
  web: { host: '0.0.0.0', port: 443 },
  agent: { host: '0.0.0.0', port: 8443 },
  paths: {
    data: '/var/lib/backup-center',
    repos: '/data2/backup/restic',
    log: '/var/log/backup-center',
    storage: '/mnt/backup-center',
    dist: '/opt/backup-center/dist',
  },
  db: { path: '' },
  restic: { binary: '/opt/backup-center/bin/restic', version: '0.18.0', cache_dir: '' },
  server: { hostname: 'backup.tri.local', public_url: 'https://backup.tri.local', agent_url: '' },
  scheduler: {
    tick_ms: 10000,
    max_concurrent_backups: 3,
    max_concurrent_per_repo: 2,
    offline_alert_minutes: 180,
    capacity_alert_percent: 85,
    check_interval_days: 7,
    read_data_check_interval_days: 30,
    retention_hour: 2,
  },
  oidc: {
    enabled: false,
    issuer: 'https://sso.tri.local/realms/tri',
    client_id: 'backup-center',
    client_secret: '',
    redirect_uri: '',
    post_logout_uri: '',
    ca_file: '/etc/pki/ca-trust/source/anchors/tri-local-enterprise-root-ca.crt',
    scope: 'openid profile email',
    admin_group: 'Group_Roots',
    admin_role: 'backup:admin',
    operator_group: '',
  },
  smtp: { enabled: false, host: '', port: 465, secure: true, user: '', password: '', from: '', to: [] },
  webhook: { enabled: false, url: '', headers: {} },
  mountd: { enabled: true, socket: '/run/backup-center/mountd.sock' },
  logging: { level: 'info' },
  bootstrap_admin: { username: 'admin', password: '' },
  defaults: {
    retention: { keep_last: 5, keep_daily: 7, keep_weekly: 4, keep_monthly: 6, keep_yearly: 1, prune_after_backup: true },
    window: { start: '22:00', end: '06:00', skip_outside: false },
    compression: 'auto',
  },
};

function merge(base, over) {
  if (over === undefined || over === null) return base;
  if (Array.isArray(over)) return over;
  if (typeof base !== 'object' || base === null || typeof over !== 'object') return over;
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) out[k] = merge(base[k], v);
  return out;
}

export function loadConfig(configPath) {
  if (!configPath) throw new Error('缺少 --config <config.json>');
  const abs = path.resolve(configPath);
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const cfg = merge(DEFAULTS, raw);
  const baseDir = path.dirname(abs);
  const resolve = (p) => (p ? path.resolve(baseDir, p) : p);
  for (const k of Object.keys(cfg.paths)) cfg.paths[k] = resolve(cfg.paths[k]);
  cfg.db.path = resolve(cfg.db.path || path.join(cfg.paths.data, 'backup.db'));
  cfg.restic.binary = resolve(cfg.restic.binary);
  cfg.restic.cache_dir = resolve(cfg.restic.cache_dir || path.join(cfg.paths.data, 'restic-cache'));
  if (cfg.tls.cert) cfg.tls.cert = resolve(cfg.tls.cert);
  if (cfg.tls.key) cfg.tls.key = resolve(cfg.tls.key);
  if (cfg.tls.ca) cfg.tls.ca = resolve(cfg.tls.ca);
  if (cfg.oidc.ca_file) cfg.oidc.ca_file = resolve(cfg.oidc.ca_file);
  if (!cfg.server.agent_url) {
    const u = new URL(cfg.server.public_url);
    u.port = String(cfg.agent.port);
    cfg.server.agent_url = u.toString().replace(/\/$/, '');
  }
  if (!cfg.oidc.redirect_uri) cfg.oidc.redirect_uri = `${cfg.server.public_url}/auth/oidc/callback`;
  if (!cfg.oidc.post_logout_uri) cfg.oidc.post_logout_uri = `${cfg.server.public_url}/`;
  cfg.agent_dist_dir = resolve(cfg.agent_dist_dir || cfg.paths.dist);
  cfg._config_path = abs;
  cfg._config_dir = baseDir;
  return cfg;
}

export function ensureDirs(cfg) {
  for (const d of [cfg.paths.data, cfg.paths.repos, cfg.paths.log, cfg.paths.storage, cfg.agent_dist_dir,
    cfg.restic.cache_dir, path.dirname(cfg.db.path), path.join(cfg.paths.data, 'ca'),
    path.join(cfg.paths.data, 'tasks'), path.join(cfg.paths.data, 'tmp')]) {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  }
}
