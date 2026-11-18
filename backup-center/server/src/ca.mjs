import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const CA_CN = '/CN=backup-center Platform CA/O=TRI/OU=IT';
const EXT = `basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature
extendedKeyUsage=clientAuth
subjectKeyIdentifier=hash
authorityKeyIdentifier=keyid,issuer
`;

export function ensureCa(dataDir) {
  const dir = path.join(dataDir, 'ca');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const keyPath = path.join(dir, 'ca.key');
  const crtPath = path.join(dir, 'ca.crt');
  if (!fs.existsSync(keyPath) || !fs.existsSync(crtPath)) {
    execFileSync('openssl', ['ecparam', '-name', 'secp384r1', '-genkey', '-noout', '-out', keyPath], { stdio: 'pipe' });
    // 用显式配置文件生成 CA，避免 openssl 1.1.1 下 -addext 与默认扩展重复导致链校验失败
    const confPath = path.join(dir, 'ca.cnf');
    fs.writeFileSync(confPath, `[req]
distinguished_name = dn
x509_extensions = v3_ca
prompt = no

[dn]
CN = backup-center Platform CA
O = TRI
OU = IT

[v3_ca]
basicConstraints = critical, CA:TRUE
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
`, { mode: 0o600 });
    execFileSync('openssl', ['req', '-x509', '-new', '-key', keyPath, '-sha384', '-days', '3650',
      '-config', confPath, '-extensions', 'v3_ca', '-out', crtPath], { stdio: 'pipe' });
    fs.chmodSync(keyPath, 0o600);
    fs.rmSync(confPath, { force: true });
  }
  return { dir, keyPath, crtPath, caPem: fs.readFileSync(crtPath, 'utf8') };
}

export function signClientCsr(ca, { csrPem, cn, days = 365 }) {
  if (!/BEGIN CERTIFICATE REQUEST/.test(String(csrPem || ''))) throw new Error('CSR 格式无效');
  if (!/^[A-Za-z0-9_.-]{3,64}$/.test(String(cn || ''))) throw new Error('CN 无效');
  const tmp = fs.mkdtempSync(path.join(ca.dir, 'tmp-'));
  try {
    const csrPath = path.join(tmp, 'req.csr');
    const extPath = path.join(tmp, 'ext.cnf');
    const outPath = path.join(tmp, 'cert.pem');
    fs.writeFileSync(csrPath, csrPem, { mode: 0o600 });
    fs.writeFileSync(extPath, EXT, { mode: 0o600 });
    execFileSync('openssl', ['x509', '-req', '-in', csrPath, '-CA', ca.crtPath, '-CAkey', ca.keyPath,
      '-CAcreateserial', '-CAserial', path.join(ca.dir, 'ca.srl'),
      '-days', String(days), '-sha256', '-extfile', extPath, '-out', outPath], { stdio: 'pipe' });
    const certPem = fs.readFileSync(outPath, 'utf8');
    const cert = new crypto.X509Certificate(certPem);
    // 以 openssl verify 作为权威校验（跨 Node/OpenSSL 版本更可靠）
    try {
      execFileSync('openssl', ['verify', '-CAfile', ca.crtPath, outPath], { stdio: 'pipe' });
    } catch (e) {
      throw new Error(`签发的证书链校验失败：${String(e.stderr || e.message).slice(0, 300)}`);
    }
    const caCert = new crypto.X509Certificate(ca.caPem);
    if (!cert.checkIssued(caCert)) throw new Error('签发的证书 issuer 与平台 CA 不匹配');
    return {
      certPem,
      serial: cert.serialNumber,
      fingerprint: cert.fingerprint256,
      validFrom: cert.validFrom,
      validTo: cert.validTo,
    };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

export function certInfo(pem) {
  const cert = new crypto.X509Certificate(pem);
  return { serial: cert.serialNumber, fingerprint: cert.fingerprint256, cn: cert.subject, ca: cert.issuer };
}

export function generateCsr(keyPem, cn) {
  // 仅用于测试：Node 无法直接生成 CSR，测试里改用 openssl 命令行。
  throw new Error('generateCsr 未实现：测试请用 openssl req -new');
}
