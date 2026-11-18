// 灾难恢复/手工恢复辅助 CLI：用主密钥解密指定节点的仓库密码并打印到终端。
// 仅限管理员在服务器控制台执行；输出含敏感信息，勿重定向到日志。
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config.mjs';
import { openDb } from './db.mjs';
import { decryptText } from './crypt.mjs';

const args = process.argv.slice(2);
const cfgPath = args[args.indexOf('--config') + 1];
const clientId = args[args.indexOf('--client') + 1];
if (!cfgPath || !clientId) {
  console.error('用法: node server/src/recover.mjs --config /etc/backup-center/config.json --client <client_id> [--repo]');
  process.exit(2);
}
const cfg = loadConfig(cfgPath);
const store = openDb(cfg.db.path);
const masterKey = fs.readFileSync(path.join(cfg.paths.data, 'master.key'));
const row = store.get('SELECT cr.repo_password_enc, c.hostname, r.mountpoint FROM client_repos cr JOIN clients c ON c.id=cr.client_id JOIN repositories r ON r.id=cr.repository_id WHERE cr.client_id=?', clientId);
if (!row) {
  console.error('未找到该节点的仓库密码记录:', clientId);
  process.exit(1);
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
