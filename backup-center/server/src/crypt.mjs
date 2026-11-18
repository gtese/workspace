import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGO = 'aes-256-gcm';
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };

export function loadOrCreateMasterKey(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  if (fs.existsSync(file)) {
    const buf = fs.readFileSync(file);
    if (buf.length !== 32) throw new Error(`主密钥长度错误：${file}`);
    return buf;
  }
  const buf = crypto.randomBytes(32);
  fs.writeFileSync(file, buf, { mode: 0o600 });
  return buf;
}

export function encryptText(masterKey, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, masterKey, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptText(masterKey, blob) {
  if (!blob) return '';
  const parts = String(blob).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('密文格式错误');
  const iv = Buffer.from(parts[1], 'base64');
  const tag = Buffer.from(parts[2], 'base64');
  const ct = Buffer.from(parts[3], 'base64');
  const d = crypto.createDecipheriv(ALGO, masterKey, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(ct), d.final()]).toString('utf8');
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(String(password), salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    const parts = String(stored || '').split('$');
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
    const [, n, r, p, saltB64, hashB64] = parts;
    const salt = Buffer.from(saltB64, 'base64');
    const expect = Buffer.from(hashB64, 'base64');
    const got = crypto.scryptSync(String(password), salt, expect.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
    return got.length === expect.length && crypto.timingSafeEqual(got, expect);
  } catch {
    return false;
  }
}

export function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}
