import crypto from 'node:crypto';
import { ApiError, id, nowIso, randomToken, parseJson } from './util.mjs';
import { hashToken } from './crypt.mjs';

export function createClients({ cfg, store, ca, storage, audit }) {
  function list({ status, q, limit = 200, offset = 0, includeDeleted = false } = {}) {
    const where = [];
    const args = [];
    // 软删除的节点默认不再出现在列表/统计中（历史快照仍保留在存储库）
    if (!includeDeleted) where.push("(disabled_reason IS NULL OR disabled_reason <> 'deleted')");
    if (status) { where.push('status=?'); args.push(status); }
    if (q) { where.push('(hostname LIKE ? OR id LIKE ?)'); args.push(`%${q}%`, `%${q}%`); }
    const sql = `SELECT * FROM clients ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    const rows = store.all(sql, ...args, Number(limit), Number(offset));
    return rows.map((c) => {
      const repo = c.repository_id ? store.get('SELECT name FROM repositories WHERE id=?', c.repository_id) : null;
      const hb = parseJson(c.last_heartbeat_json, {});
      return { ...c, last_heartbeat: hb, repository_name: repo ? repo.name : null };
    });
  }

  function get(clientId) {
    const c = store.get('SELECT * FROM clients WHERE id=?', clientId);
    if (!c) return null;
    const repo = c.repository_id ? store.get('SELECT id,name,type,status FROM repositories WHERE id=?', c.repository_id) : null;
    return { ...c, last_heartbeat: parseJson(c.last_heartbeat_json, {}), repository: repo };
  }

  function update(clientId, patch) {
    const c = store.get('SELECT * FROM clients WHERE id=?', clientId);
    if (!c) throw new ApiError(404, 'not_found', '节点不存在');
    const fields = [];
    const args = [];
    for (const k of ['hostname', 'tags', 'allowed_roots', 'repository_id']) {
      if (patch[k] !== undefined) { fields.push(`${k}=?`); args.push(String(patch[k])); }
    }
    if (!fields.length) return get(clientId);
    store.run(`UPDATE clients SET ${fields.join(',')} WHERE id=?`, ...args, clientId);
    return get(clientId);
  }

  function setStatus(clientId, status, reason = null) {
    const c = store.get('SELECT * FROM clients WHERE id=?', clientId);
    if (!c) throw new ApiError(404, 'not_found', '节点不存在');
    store.run('UPDATE clients SET status=?, disabled_reason=? WHERE id=?', status, reason, clientId);
    return get(clientId);
  }

  function remove(clientId) {
    const c = store.get('SELECT * FROM clients WHERE id=?', clientId);
    if (!c) throw new ApiError(404, 'not_found', '节点不存在');
    store.run("UPDATE clients SET status='disabled', disabled_reason='deleted', cert_serial=NULL WHERE id=?", clientId);
    store.run('UPDATE plans SET enabled=0, next_run_at=NULL WHERE client_id=?', clientId);
    return { ok: true, note: '节点已从列表移除；历史快照仍保留在对应存储库' };
  }

  function createEnroll({ userId, hostnameHint = '', ttlMinutes = 120, repositoryId = null }) {
    const token = randomToken(32);
    const requestId = id('e', 8);
    const expiresAt = new Date(Date.now() + Math.max(5, Number(ttlMinutes) || 120) * 60 * 1000).toISOString();
    store.run('INSERT INTO enroll_requests(id,token_hash,hostname,status,repository_id,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?)',
      requestId, hashToken(token), String(hostnameHint || ''), 'pending', repositoryId, userId || '', nowIso(), expiresAt);
    const command = `curl -fsSL ${cfg.server.public_url}/agent/install.sh -o /tmp/backup-center-install.sh && sudo bash /tmp/backup-center-install.sh --server ${cfg.server.agent_url} --token ${token}`;
    return { id: requestId, token, expires_at: expiresAt, command, agent_version: '0.1.0' };
  }

  function listEnroll({ status = 'pending' } = {}) {
    const rows = store.all('SELECT * FROM enroll_requests WHERE status=? ORDER BY created_at DESC LIMIT 200', status);
    return rows.map((r) => ({ ...r, token_hash: undefined, enroll_secret_hash: undefined, csr_pem: undefined }));
  }

  function getEnroll(requestId) {
    const r = store.get('SELECT * FROM enroll_requests WHERE id=?', requestId);
    if (!r) return null;
    return { ...r, token_hash: undefined, enroll_secret_hash: undefined };
  }

  function agentEnroll({ token, hostname, os, os_version, arch, agent_version, csr_pem, ip }) {
    if (!token) throw new ApiError(400, 'validation', '缺少 token');
    const row = store.get('SELECT * FROM enroll_requests WHERE token_hash=?', hashToken(token));
    if (!row) throw new ApiError(403, 'forbidden', 'token 无效');
    if (row.status !== 'pending') throw new ApiError(409, 'conflict', 'token 已被使用');
    if (new Date(row.expires_at).getTime() < Date.now()) {
      store.run("UPDATE enroll_requests SET status='expired' WHERE id=?", row.id);
      throw new ApiError(410, 'expired', 'token 已过期');
    }
    if (!csr_pem || !/BEGIN CERTIFICATE REQUEST/.test(csr_pem)) throw new ApiError(400, 'validation', 'CSR 无效');
    const secret = randomToken(24);
    const fingerprint = String(csr_pem).length > 0 ? crypto.createHash('sha256').update(csr_pem).digest('hex').slice(0, 32) : '';
    store.run('UPDATE enroll_requests SET hostname=?,os=?,os_version=?,arch=?,agent_version=?,csr_pem=?,fingerprint=?,ip=?,enroll_secret_hash=? WHERE id=?',
      String(hostname || '').slice(0, 128), String(os || '').slice(0, 64), String(os_version || '').slice(0, 64),
      String(arch || '').slice(0, 32), String(agent_version || '').slice(0, 32), String(csr_pem), fingerprint,
      String(ip || ''), hashToken(secret), row.id);
    return { request_id: row.id, enroll_secret: secret, poll_after_seconds: 10 };
  }

  function agentEnrollStatus(requestId, secret) {
    const row = store.get('SELECT * FROM enroll_requests WHERE id=?', requestId);
    if (!row) throw new ApiError(404, 'not_found', '注册请求不存在');
    if (!secret || hashToken(secret) !== row.enroll_secret_hash) throw new ApiError(403, 'forbidden', 'enroll secret 不正确');
    if (row.status === 'pending') return { status: 'pending', poll_after_seconds: 10 };
    if (row.status === 'rejected') throw new ApiError(410, 'rejected', '注册已被拒绝');
    if (row.status === 'expired') throw new ApiError(410, 'expired', '注册请求已过期');
    if (row.status === 'approved') {
      const client = store.get('SELECT * FROM clients WHERE id=?', row.client_id);
      const cert = store.get(`SELECT * FROM client_certs WHERE client_id=? AND active=1 ORDER BY created_at DESC LIMIT 1`, row.client_id);
      return {
        status: 'approved', client_id: row.client_id, cert_pem: cert ? cert.cert_pem : null, ca_pem: ca.caPem,
        config: {
          server: cfg.server.agent_url, client_id: row.client_id, poll_wait_seconds: 25,
          allowed_roots: client ? client.allowed_roots : '/', repository_id: row.repository_id,
        },
      };
    }
    throw new ApiError(500, 'internal', '注册状态异常');
  }

  function approve(requestId, { userId, repositoryId = null } = {}) {
    const row = store.get('SELECT * FROM enroll_requests WHERE id=?', requestId);
    if (!row) throw new ApiError(404, 'not_found', '注册请求不存在');
    if (row.status !== 'pending') throw new ApiError(409, 'conflict', '该请求不在待审批状态');
    if (!row.csr_pem) throw new ApiError(409, 'conflict', '代理尚未提交 CSR');
    if (new Date(row.expires_at).getTime() < Date.now()) {
      store.run("UPDATE enroll_requests SET status='expired' WHERE id=?", row.id);
      throw new ApiError(410, 'expired', '注册请求已过期');
    }
    let repoId = repositoryId || row.repository_id;
    if (!repoId) {
      const def = store.get("SELECT * FROM repositories WHERE status='active' ORDER BY created_at LIMIT 1");
      if (!def) throw new ApiError(409, 'config', '请先创建存储库');
      repoId = def.id;
    }
    const repo = store.get('SELECT * FROM repositories WHERE id=?', repoId);
    if (!repo) throw new ApiError(404, 'not_found', '存储库不存在');
    const clientId = id('c', 8);
    const signed = ca.signClientCsr(ca, { csrPem: row.csr_pem, cn: clientId, days: 365 });
    store.run(`INSERT INTO clients(id,hostname,os,os_version,arch,agent_version,cert_serial,cert_fp,status,repository_id,allowed_roots,ip,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      clientId, row.hostname || clientId, row.os, row.os_version, row.arch, row.agent_version,
      signed.serial, signed.fingerprint, 'active', repoId, '/', row.ip, nowIso());
    store.run(`INSERT INTO client_certs(client_id,cert_pem,serial,fingerprint,active,created_at) VALUES(?,?,?,?,1,?)`,
      clientId, signed.certPem, signed.serial, signed.fingerprint, nowIso());
    storage.ensureClientRepo(clientId, repoId);
    store.run('UPDATE enroll_requests SET status=?, client_id=?, repository_id=?, approved_by=?, approved_at=? WHERE id=?',
      'approved', clientId, repoId, userId || '', nowIso(), requestId);
    audit({ actor: userId || 'system', action: 'client.approve', target: clientId, ip: row.ip, detail: { requestId, hostname: row.hostname, repositoryId: repoId } });
    return get(clientId);
  }

  function reject(requestId, { userId, reason = '' } = {}) {
    const row = store.get('SELECT * FROM enroll_requests WHERE id=?', requestId);
    if (!row) throw new ApiError(404, 'not_found', '注册请求不存在');
    if (row.status !== 'pending') throw new ApiError(409, 'conflict', '该请求不在待审批状态');
    store.run("UPDATE enroll_requests SET status='rejected', reject_reason=? WHERE id=?", String(reason || ''), requestId);
    audit({ actor: userId || 'system', action: 'client.reject', target: requestId, ip: row.ip, detail: { reason } });
    return getEnroll(requestId);
  }

  function heartbeat(clientId, body, ip) {
    const c = store.get('SELECT * FROM clients WHERE id=?', clientId);
    if (!c) throw new ApiError(404, 'not_found', '节点不存在');
    const payload = {
      agent_version: body.agent_version || '',
      os: body.os || '', arch: body.arch || '',
      uptime_seconds: Number(body.uptime_seconds || 0),
      restic_version: body.restic_version || '',
      disks: Array.isArray(body.disks) ? body.disks.slice(0, 64) : [],
      mounts: Array.isArray(body.mounts) ? body.mounts.slice(0, 128) : [],
      active_task_id: body.active_task_id || '',
      at: nowIso(),
    };
    store.run('UPDATE clients SET last_seen_at=?, ip=?, agent_version=?, os=?, arch=?, last_heartbeat_json=? WHERE id=?',
      nowIso(), ip || '', payload.agent_version || c.agent_version, payload.os || c.os, payload.arch || c.arch, JSON.stringify(payload), clientId);
    return { ok: true, next_poll_seconds: 15 };
  }

  function bySerial(serial) {
    if (!serial) return null;
    const c = store.get("SELECT * FROM clients WHERE cert_serial=? AND status='active'", serial);
    if (!c) {
      const cert = store.get('SELECT * FROM client_certs WHERE serial=? AND active=1', serial);
      if (!cert) return null;
      return store.get("SELECT * FROM clients WHERE id=? AND status='active'", cert.client_id) || null;
    }
    return c;
  }

  function storeCert(clientId, certPem, signed) {
    store.run("UPDATE client_certs SET active=0 WHERE client_id=?", clientId);
    store.run('INSERT INTO client_certs(client_id,cert_pem,serial,fingerprint,active,created_at) VALUES(?,?,?,?,1,?)',
      clientId, certPem, signed.serial, signed.fingerprint, nowIso());
    store.run('UPDATE clients SET cert_serial=?, cert_fp=? WHERE id=?', signed.serial, signed.fingerprint, clientId);
  }

  function renewCert(clientId, csrPem) {
    const c = store.get('SELECT * FROM clients WHERE id=?', clientId);
    if (!c) throw new ApiError(404, 'not_found', '节点不存在');
    const signed = ca.signClientCsr(ca, { csrPem, cn: clientId, days: 365 });
    storeCert(clientId, signed.certPem, signed);
    audit({ actor: clientId, action: 'client.renew_cert', target: clientId, detail: { serial: signed.serial } });
    return { cert_pem: signed.certPem, ca_pem: ca.caPem, valid_to: signed.validTo };
  }

  return {
    list, get, update, setStatus, remove, createEnroll, listEnroll, getEnroll, agentEnroll, agentEnrollStatus,
    approve, reject, heartbeat, bySerial, renewCert, storeCert,
  };
}
