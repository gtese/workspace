import net from 'node:net';
import { ApiError } from './util.mjs';

export function createMountd(cfg) {
  const socket = cfg.mountd.socket;
  function call(payload, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      if (!cfg.mountd.enabled) return reject(new ApiError(501, 'mountd_disabled', '挂载助手未启用（mountd.enabled=false）'));
      const sock = net.createConnection(socket);
      let buf = '';
      const timer = setTimeout(() => { sock.destroy(); reject(new ApiError(504, 'mountd_timeout', '挂载助手超时')); }, timeoutMs);
      const done = (err, val) => { clearTimeout(timer); sock.destroy(); err ? reject(err) : resolve(val); };
      sock.on('connect', () => sock.write(JSON.stringify(payload) + '\n'));
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        const idx = buf.indexOf('\n');
        if (idx < 0) return;
        const line = buf.slice(0, idx);
        try {
          const resp = JSON.parse(line);
          if (resp.ok) done(null, resp); else done(new ApiError(500, 'mount_failed', resp.error || '挂载失败', resp));
        } catch {
          done(new ApiError(502, 'mountd_bad_response', '挂载助手响应无效'));
        }
      });
      sock.on('error', (e) => done(new ApiError(503, 'mountd_unavailable', `挂载助手不可用：${e.message}`)));
    });
  }
  return {
    call,
    ensure(payload) { return call({ op: 'ensure', ...payload }); },
    remove(payload) { return call({ op: 'remove', ...payload }); },
    status(payload) { return call({ op: 'status', ...payload }); },
  };
}
