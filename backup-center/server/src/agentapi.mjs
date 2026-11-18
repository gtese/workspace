import fs from 'node:fs';
import path from 'node:path';
import { createRouter, sendJson, sendError, readJsonBody, securityHeaders } from './http.mjs';
import { ApiError, clientIp } from './util.mjs';

export function createAgentApi({ cfg, store, clients, jobs, audit, authenticate }) {
  const router = createRouter();

  function requireAgent(ctx) {
    const client = authenticate(ctx.req);
    if (!client) throw new ApiError(401, 'unauthorized', '代理证书无效或未授权');
    ctx.client = client;
    return client;
  }

  router.add('POST', '/api/enroll', async (ctx) => {
    const body = await readJsonBody(ctx.req, 256 * 1024);
    const out = clients.agentEnroll({
      token: body.token, hostname: body.hostname, os: body.os, os_version: body.os_version,
      arch: body.arch, agent_version: body.agent_version, csr_pem: body.csr_pem, ip: clientIp(ctx.req),
    });
    audit({ actor: 'agent', action: 'agent.enroll_request', target: out.request_id, ip: clientIp(ctx.req), detail: { hostname: body.hostname, os: body.os } });
    sendJson(ctx.res, 202, out);
  });

  router.add('GET', '/api/enroll/:id', async (ctx) => {
    const secret = ctx.req.headers['x-enroll-secret'];
    const out = clients.agentEnrollStatus(ctx.params.id, String(secret || ''));
    sendJson(ctx.res, out.status === 'approved' ? 200 : 202, out);
  });

  router.add('POST', '/api/agent/heartbeat', async (ctx) => {
    const client = requireAgent(ctx);
    const body = await readJsonBody(ctx.req, 512 * 1024);
    const out = clients.heartbeat(client.id, body, clientIp(ctx.req));
    sendJson(ctx.res, 200, out);
  });

  router.add('GET', '/api/agent/tasks', async (ctx) => {
    requireAgent(ctx);
    const wait = Math.min(30000, Math.max(0, Number(ctx.query.get('wait') || 25) * 1000));
    const task = await jobs.waitTask(ctx.client.id, wait);
    sendJson(ctx.res, 200, { tasks: task ? [task.payload] : [] });
  });

  router.add('POST', '/api/agent/tasks/:id/progress', async (ctx) => {
    requireAgent(ctx);
    const task = store.get('SELECT * FROM tasks WHERE id=?', ctx.params.id);
    if (!task || task.client_id !== ctx.client.id) throw new ApiError(403, 'forbidden', '任务不属于该节点');
    const body = await readJsonBody(ctx.req, 256 * 1024);
    const out = jobs.reportProgress(ctx.params.id, body);
    sendJson(ctx.res, 200, out);
  });

  router.add('POST', '/api/agent/tasks/:id/result', async (ctx) => {
    requireAgent(ctx);
    const task = store.get('SELECT * FROM tasks WHERE id=?', ctx.params.id);
    if (!task || task.client_id !== ctx.client.id) throw new ApiError(403, 'forbidden', '任务不属于该节点');
    const body = await readJsonBody(ctx.req, 1024 * 1024);
    const out = jobs.reportResult(ctx.params.id, body);
    sendJson(ctx.res, 200, out);
  });

  router.add('POST', '/api/agent/renew', async (ctx) => {
    requireAgent(ctx);
    const body = await readJsonBody(ctx.req, 256 * 1024);
    if (!body.csr_pem) throw new ApiError(400, 'validation', '缺少 CSR');
    const out = clients.renewCert(ctx.client.id, body.csr_pem);
    sendJson(ctx.res, 200, out);
  });

  router.add('GET', '/api/agent/dist/:version/:os/:arch', async (ctx) => {
    requireAgent(ctx);
    const file = path.join(cfg.agent_dist_dir, 'agent', String(ctx.params.version), String(ctx.params.os), String(ctx.params.arch), 'backup-agent');
    if (!fs.existsSync(file)) throw new ApiError(404, 'not_found', '该平台升级包不存在');
    const st = fs.statSync(file);
    ctx.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(ctx.res);
  });

  return {
    async handle(req, res, url) {
      securityHeaders(res);
      const match = router.match(req.method, url.pathname);
      if (!match) throw new ApiError(404, 'not_found', '接口不存在');
      const ctx = { req, res, url, params: match.params, query: url.searchParams };
      try { await match.handler(ctx); } catch (e) { sendError(res, e); }
    },
  };
}
