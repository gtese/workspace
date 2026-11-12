'use strict';
/**
 * ============================================================
 * 会话与一次性票据（内存实现，单实例够用）
 * ============================================================
 * 为什么不在浏览器存令牌：门户只需要"这个人是谁、有什么角色"，
 * 令牌用完即弃，浏览器只拿一个 HttpOnly 的会话 cookie。
 *
 * 多实例部署时把这两个 Map 换成 Redis 即可（接口不变）。
 */

const crypto = require('node:crypto');

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_MINUTES || 480) * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

const sessions = new Map();   // sid -> { username, name, email, roles, groups, exp, lastSeen }
const pending = new Map();    // state -> { nonce, verifier, returnTo, exp }

const randomId = () => crypto.randomBytes(24).toString('base64url');

/** 定期清理过期条目（每分钟） */
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
  for (const [k, v] of pending) if (v.exp < now) pending.delete(k);
}, 60_000).unref();

/* ---------------- 一次性登录票据 ---------------- */
function putPending(state, data) {
  pending.set(state, { ...data, exp: Date.now() + PENDING_TTL_MS });
}
/** 取出即删（防止 state 重放） */
function takePending(state) {
  const v = pending.get(String(state));
  pending.delete(String(state));
  if (!v || v.exp < Date.now()) return null;
  return v;
}

/* ---------------- 会话 ---------------- */
function createSession(user) {
  const sid = randomId();
  sessions.set(sid, { ...user, exp: Date.now() + SESSION_TTL_MS, lastSeen: Date.now() });
  return sid;
}

function getSession(sid) {
  if (!sid) return null;
  const s = sessions.get(sid);
  if (!s) return null;
  if (s.exp < Date.now()) { sessions.delete(sid); return null; }
  s.lastSeen = Date.now();
  return s;
}

function destroySession(sid) {
  if (sid) sessions.delete(sid);
}

function stats() {
  return { sessions: sessions.size, pending: pending.size, ttlMinutes: SESSION_TTL_MS / 60000 };
}

module.exports = { putPending, takePending, createSession, getSession, destroySession, stats };