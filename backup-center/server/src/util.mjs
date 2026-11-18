import crypto from 'node:crypto';

export class ApiError extends Error {
  constructor(status, code, message, detail) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export function fail(status, code, message, detail) {
  throw new ApiError(status, code, message, detail);
}

export function id(prefix, bytes = 6) {
  return `${prefix}_${crypto.randomBytes(bytes).toString('hex')}`;
}

export function nowIso(d = new Date()) {
  return new Date(d).toISOString();
}

export function parseJson(str, fallback = null) {
  if (str === null || str === undefined || str === '') return fallback;
  try { return JSON.parse(str); } catch { return fallback; }
}

export function parseBool(v, def = false) {
  if (v === undefined || v === null || v === '') return def;
  return v === true || v === 'true' || v === 1 || v === '1' || v === 'yes' || v === 'on';
}

export function toInt(v, def = 0) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

export function maskSecret(v) {
  return v ? '***' : '';
}

export function isoShift(iso, ms) {
  return new Date(new Date(iso).getTime() + ms).toISOString();
}

export function isoTimestamp() {
  return new Date().toISOString();
}

export function safeFilename(name) {
  return String(name || '').replace(/[^A-Za-z0-9._+-]/g, '_').slice(0, 120) || 'download';
}

export function hostnameOf(req) {
  return (req.socket && req.socket.remoteAddress) || '';
}

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || '';
}

export function sniffJson(buf) {
  if (!buf || !buf.length) return null;
  try { return JSON.parse(buf.toString('utf8')); } catch { return null; }
}
