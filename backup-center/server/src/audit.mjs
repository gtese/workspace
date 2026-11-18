import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './util.mjs';

export function createAudit({ store, cfg }) {
  const file = path.join(cfg.paths.log, 'audit.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return function audit({ actor, action, target, result = 'ok', ip = '', detail = null }) {
    const at = nowIso();
    const detailJson = detail ? JSON.stringify(detail) : null;
    try {
      store.run('INSERT INTO audit_log(at,actor,action,target,result,ip,detail_json) VALUES(?,?,?,?,?,?,?)',
        at, actor || 'system', action, target || '', result, ip, detailJson);
    } catch (e) {
      // 审计失败不影响主流程，但必须落文件
    }
    try {
      fs.appendFileSync(file, JSON.stringify({ at, actor, action, target, result, ip, detail }) + '\n', { mode: 0o600 });
    } catch { /* ignore */ }
  };
}
