import { id, nowIso, parseJson } from './util.mjs';
import { decryptText } from './crypt.mjs';
import { sendMail } from './smtp.mjs';

export function createAlerts({ cfg, store, masterKey }) {
  function settings() {
    const row = store.get("SELECT value FROM settings WHERE key='alerts'");
    const raw = parseJson(row && row.value, {});
    const out = { smtp: { ...cfg.smtp }, webhook: { ...cfg.webhook }, recipients: [], enabled: true };
    if (raw.smtp) out.smtp = { ...out.smtp, ...raw.smtp };
    if (raw.webhook) out.webhook = { ...out.webhook, ...raw.webhook };
    if (raw.recipients) out.recipients = raw.recipients;
    if (out.smtp.username && !out.smtp.user) out.smtp.user = out.smtp.username;
    if (out.smtp.tls !== undefined) out.smtp.secure = out.smtp.tls !== false;
    if (Array.isArray(out.smtp.to) && out.smtp.to.length) out.recipients = out.smtp.to;
    if (out.smtp.password_enc) {
      try { out.smtp.password = decryptText(masterKey, out.smtp.password_enc); } catch { out.smtp.password = ''; }
    }
    return out;
  }

  function list({ limit = 100, offset = 0 } = {}) {
    return store.all('SELECT * FROM alerts ORDER BY created_at DESC LIMIT ? OFFSET ?', Number(limit), Number(offset));
  }

  function ack(alertId) {
    store.run('UPDATE alerts SET acked_at=? WHERE id=?', nowIso(), alertId);
    return { ok: true };
  }

  async function send({ type, severity = 'warning', message, clientId = null, runId = null, dedupeMinutes = 60 }) {
    const dedupeKey = `${type}|${clientId || ''}|${message}`;
    if (dedupeMinutes > 0) {
      const since = new Date(Date.now() - dedupeMinutes * 60000).toISOString();
      const dup = store.get('SELECT id FROM alerts WHERE dedupe_key=? AND created_at>=?', dedupeKey, since);
      if (dup) return { deduped: true };
    }
    const alertId = id('a', 8);
    store.run('INSERT INTO alerts(id,type,severity,message,client_id,run_id,created_at,dedupe_key) VALUES(?,?,?,?,?,?,?,?)',
      alertId, type, severity, String(message).slice(0, 2000), clientId, runId, nowIso(), dedupeKey);
    const s = settings();
    const subject = `[backup-center] ${severity.toUpperCase()} ${type}`;
    const text = `${message}\n\n时间: ${nowIso()}\n节点: ${clientId || '-'}\n运行: ${runId || '-'}`;
    if (s.smtp.enabled && s.smtp.host && s.recipients.length) {
      sendMail({
        host: s.smtp.host, port: Number(s.smtp.port || 465), secure: s.smtp.secure !== false,
        user: s.smtp.user, pass: s.smtp.password, from: s.smtp.from || s.smtp.user || 'backup-center@local',
        to: s.recipients, subject, text,
      }).catch((e) => console.error('[alert:smtp]', e.message));
    }
    if (s.webhook.enabled && s.webhook.url) {
      fetch(s.webhook.url, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(s.webhook.headers || {}) },
        body: JSON.stringify({ type, severity, message, client_id: clientId, run_id: runId, at: nowIso() }),
      }).catch((e) => console.error('[alert:webhook]', e.message));
    }
    return { id: alertId };
  }

  return { list, ack, send, settings };
}
