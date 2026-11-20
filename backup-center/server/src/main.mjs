import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';
import { loadConfig, ensureDirs } from './config.mjs';
import { openDb } from './db.mjs';
import { loadOrCreateMasterKey } from './crypt.mjs';
import { ensureCa, signClientCsr } from './ca.mjs';
import { createAuth } from './auth.mjs';
import { createMountd } from './mountd.mjs';
import { createStorage } from './storage.mjs';
import { createClients } from './clients.mjs';
import { createJobs } from './jobs.mjs';
import { createSnapshots } from './snapshots.mjs';
import { createAlerts } from './alerts.mjs';
import { createScheduler } from './scheduler.mjs';
import { createMetrics } from './metrics.mjs';
import { createWebApi } from './webapi.mjs';
import { createAgentApi } from './agentapi.mjs';
import { createRepoApi } from './restapi.mjs';
import { createAudit } from './audit.mjs';
import { sendError, serveStatic, securityHeaders } from './http.mjs';
import { ApiError, nowIso, parseJson } from './util.mjs';

function argValue(name) {
  const idx = process.argv.indexOf(name);
  return idx >= 0 ? process.argv[idx + 1] : null;
}

const configPath = argValue('--config') || process.env.BC_CONFIG;
if (!configPath) {
  console.error('用法: node server/src/main.mjs --config <config.json>');
  process.exit(2);
}

const cfg = loadConfig(configPath);
ensureDirs(cfg);
const resticExists = fs.existsSync(cfg.restic.binary);
if (!resticExists) console.warn(`[warn] restic 不存在：${cfg.restic.binary}`);

const store = openDb(cfg.db.path);
// 迁移：旧版每个节点仅一个仓库密钥 -> 支持"节点可加入多个备份池"的 (client, repository) 维度
try {
  store.run(`INSERT OR IGNORE INTO client_repo_keys(client_id,repository_id,repo_password_enc,created_at)
             SELECT client_id,repository_id,repo_password_enc,created_at FROM client_repos`);
} catch (e) { console.error('[migrate] client_repo_keys', e.message); }
// 迁移：计划增加 RPO 字段（小时）
try {
  const cols = store.all('PRAGMA table_info(plans)').map((c) => c.name);
  if (!cols.includes('rpo_hours')) store.run('ALTER TABLE plans ADD COLUMN rpo_hours INTEGER NOT NULL DEFAULT 26');
} catch (e) { console.error('[migrate] rpo_hours', e.message); }
// 安全迁移：只允许 admin 角色登录后，清理历史 viewer/operator 会话并停用 OIDC 非管理员账号
try {
  store.run("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE role <> 'admin')");
  store.run("UPDATE users SET enabled=0 WHERE source='oidc' AND role <> 'admin'");
} catch (e) { console.error('[migrate] admin-only sessions', e.message); }
const masterKey = loadOrCreateMasterKey(path.join(cfg.paths.data, 'master.key'));
const caFiles = ensureCa(cfg.paths.data);
const ca = { ...caFiles, signClientCsr: (_self, opts) => signClientCsr(caFiles, opts) };
const audit = createAudit({ store, cfg });
const auth = createAuth({ cfg, store });
const mountd = createMountd(cfg);
const storage = createStorage({ cfg, store, masterKey, mountd });
const clients = createClients({ cfg, store, ca, storage, audit });
const jobs = createJobs({ cfg, store, storage, audit });
const snapshots = createSnapshots({ cfg, store, storage, jobs });
const alerts = createAlerts({ cfg, store, masterKey });
const metrics = createMetrics({ store, cfg });
const scheduler = createScheduler({ cfg, store, storage, jobs, snapshots, alerts });
jobs.setOnRunSuccess((run) => scheduler.maybeRetention(run));

const bootstrap = auth.ensureAdmin();
if (bootstrap) {
  console.log(`[init] 已创建初始管理员 ${bootstrap.username}${bootstrap.file ? `，密码写入 ${bootstrap.file}` : ''}`);
}

(async () => {
  if (cfg.bootstrap_default_repository && store.get('SELECT COUNT(*) AS n FROM repositories').n === 0) {
    try {
      const r = await storage.create({
        name: cfg.bootstrap_default_repository.name || '默认存储库',
        type: 'local',
        config: { path: cfg.bootstrap_default_repository.path || cfg.paths.repos },
      });
      console.log(`[init] 已创建默认存储库 ${r.name} (${r.mountpoint})`);
    } catch (e) {
      console.error('[init] 默认存储库创建失败', e.message);
    }
  }

  const repoApi = createRepoApi({
    getRepo: (repoId) => {
      const row = store.get('SELECT * FROM repositories WHERE id=?', repoId);
      if (!row) return null;
      return { id: row.id, mountpoint: row.mountpoint, type: row.type };
    },
  });

  function tlsOptions(requestCert = false) {
    if (!cfg.tls.enabled) return null;
    const key = fs.readFileSync(cfg.tls.key);
    const cert = fs.readFileSync(cfg.tls.cert);
    const opts = { key, cert, minVersion: 'TLSv1.2' };
    if (requestCert) {
      opts.requestCert = true;
      opts.rejectUnauthorized = false; // 由应用层根据平台 CA + 序列号白名单判定
      opts.ca = [fs.readFileSync(ca.crtPath)];
    }
    return opts;
  }

  function authenticateAgent(req) {
    if (!cfg.tls.enabled) {
      const headerId = req.headers['x-client-id'];
      if (headerId) return store.get("SELECT * FROM clients WHERE id=? AND status='active'", String(headerId)) || null;
      if (cfg.dev_client_id) return store.get("SELECT * FROM clients WHERE id=? AND status='active'", String(cfg.dev_client_id)) || null;
      return store.get("SELECT * FROM clients WHERE status='active' ORDER BY created_at DESC LIMIT 1") || null;
    }
    const socket = req.socket;
    let cert = null;
    try { cert = typeof socket.getPeerX509Certificate === 'function' ? socket.getPeerX509Certificate() : null; } catch { cert = null; }
    if (!cert) return null;
    const serial = cert.serialNumber;
    const client = clients.bySerial(serial);
    if (!client) return null;
    try {
      const caCert = new crypto.X509Certificate(ca.caPem);
      if (!cert.checkIssued(caCert) || !cert.verify(caCert.publicKey)) return null;
      if (new Date(cert.validTo).getTime() < Date.now()) return null;
    } catch { return null; }
    return client;
  }

  const repoHandler = async (req, res, url) => {
    const m = /^\/repo\/([^/]+)\/([^/]+)(\/.*)?$/.exec(url.pathname);
    if (!m) return false;
    const [, repoId, clientId, restPath] = m;
    const client = authenticateAgent(req);
    if (!client || client.id !== clientId) { sendError(res, new ApiError(403, 'forbidden', '仓库访问被拒绝')); return true; }
    const allowed = store.get('SELECT 1 AS x FROM client_repo_keys WHERE client_id=? AND repository_id=?', client.id, repoId);
    if (!allowed) { sendError(res, new ApiError(403, 'forbidden', '存储库未授权该节点')); return true; }
    try {
      await repoApi(req, res, { repoId, clientId, restPath: restPath || '/', query: url.searchParams });
    } catch (e) { sendError(res, e); }
    return true;
  };

  const webApi = createWebApi({ cfg, store, masterKey, auth, storage, clients, jobs, snapshots, alerts, scheduler, metrics, audit });
  const agentApi = createAgentApi({ cfg, store, clients, jobs, audit, authenticate: authenticateAgent });

  function serveDist(req, res, pathname) {
    if (pathname === '/agent/ca.crt') {
      const file = path.join(cfg.agent_dist_dir, 'ca.crt');
      if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('企业根 CA 未部署'); return true; }
      const st = fs.statSync(file);
      res.writeHead(200, { 'Content-Type': 'application/x-x509-ca-cert', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=86400' });
      fs.createReadStream(file).pipe(res);
      return true;
    }
    if (pathname === '/agent/install.sh') {
      const file = path.join(cfg.agent_dist_dir, 'install.sh');
      if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('install.sh 未部署'); return true; }
      res.writeHead(200, { 'Content-Type': 'text/x-shellscript; charset=utf-8' });
      fs.createReadStream(file).pipe(res);
      return true;
    }
    if (pathname.startsWith('/agent/dist/')) {
      const rel = pathname.slice('/agent/dist/'.length);
      if (rel.includes('..')) return false;
      const file = path.join(cfg.agent_dist_dir, rel);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return true; }
      const st = fs.statSync(file);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=3600' });
      fs.createReadStream(file).pipe(res);
      return true;
    }
    return false;
  }

  const webHandler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname === '/healthz' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/')) {
        await webApi.handle(req, res, url);
        return;
      }
      if (serveDist(req, res, url.pathname)) return;
      serveStatic(path.join(process.cwd(), 'server/public'), req, res, url.pathname);
    } catch (e) { sendError(res, e); }
  };

  const agentHandler = async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (url.pathname.startsWith('/repo/')) {
        await repoHandler(req, res, url);
        return;
      }
      if (url.pathname.startsWith('/api/')) {
        await agentApi.handle(req, res, url);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    } catch (e) { sendError(res, e); }
  };

  function makeServer(handler, tlsOpts, port, host) {
    const server = tlsOpts ? https.createServer(tlsOpts, handler) : http.createServer(handler);
    server.requestTimeout = 0;
    server.headersTimeout = 65000;
    server.keepAliveTimeout = 65000;
    server.listen(port, host, () => console.log(`[listen] ${tlsOpts ? 'https' : 'http'}://${host}:${port}`));
    return server;
  }

  const webServer = makeServer(webHandler, tlsOptions(false), cfg.web.port, cfg.web.host);
  const agentServer = makeServer(agentHandler, tlsOptions(true), cfg.agent.port, cfg.agent.host);

  scheduler.start();

  // 每日 03:00 备份数据库与配置
  let lastDbBackup = '';
  setInterval(() => {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    if (now.getHours() === 3 && lastDbBackup !== day) {
      lastDbBackup = day;
      try {
        const dir = path.join(cfg.paths.data, 'db-backups');
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        fs.copyFileSync(cfg.db.path, path.join(dir, `backup-${day}.db`));
        const files = fs.readdirSync(dir).filter((f) => f.startsWith('backup-')).sort();
        while (files.length > 14) fs.rmSync(path.join(dir, files.shift()), { force: true });
      } catch (e) { console.error('[db-backup]', e.message); }
    }
  }, 60 * 1000).unref();

  function shutdown(sig) {
    console.log(`[shutdown] ${sig}`);
    scheduler.stop();
    webServer.close();
    agentServer.close();
    setTimeout(() => process.exit(0), 300);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
})().catch((e) => {
  console.error('启动失败', e);
  process.exit(1);
});
