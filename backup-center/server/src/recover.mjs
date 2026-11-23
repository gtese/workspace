// 灾难恢复/手工恢复辅助 CLI：用主密钥解密指定节点+备份池的仓库密码并打印到终端。
// 仅限管理员在服务器控制台执行；输出含敏感信息，勿重定向到日志。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { decryptText } from './crypt.mjs';

const args = process.argv.slice(2);
const arg = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const cfgPath = arg('--config');
const clientId = arg('--client');
const repoId = arg('--repo-id');
if (!cfgPath || !clientId) {
  console.error('用法: node server/src/recover.mjs --config /etc/backup-center/config.json --client <client_id> [--repo-id <repository_id>] [--env|--repo]');
  process.exit(2);
}
const cfg = loadConfig(cfgPath);
const store = openDb(cfg.db.path);
const masterKey = fs.readFileSync(path.join(cfg.paths.data, 'master.key'));
const rows = store.all(
  `SELECT crk.repo_password_enc, crk.repository_id, c.hostname, r.name AS repo_name, r.mountpoint
     FROM client_repo_keys crk
     JOIN clients c ON c.id = crk.client_id
     JOIN repositories r ON r.id = crk.repository_id
    WHERE crk.client_id = ?`,
  clientId,
);
if (!rows.length) {
  console.error('未找到该节点的仓库密码记录:', clientId);
  process.exit(1);
}
const row = repoId ? rows.find((r) => r.repository_id === repoId) : (rows.length === 1 ? rows[0] : null);
if (!row) {
  console.error(`该节点有 ${rows.length} 个备份池，请用 --repo-id 指定：`);
  for (const r of rows) console.error(`  ${r.repository_id}  ${r.repo_name}  ${r.mountpoint}/${clientId}`);
  process.exit(2);
}
const password = decryptText(masterKey, row.repo_password_enc);
const repoPath = path.join(row.mountpoint, clientId);
if (args.includes('--repo')) {
  process.stdout.write(repoPath + '\n');
} else if (args.includes('--env')) {
  process.stdout.write(`RESTIC_REPOSITORY='${repoPath}'\nRESTIC_PASSWORD='${password}'\n`);
} else {
  process.stdout.write(`${password}\n`);
}
