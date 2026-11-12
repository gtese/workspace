# ============================================================
# 企业应用门户 — 运行时镜像
# ============================================================
# 零第三方依赖（只用 Node 内置模块），因此镜像很小、无需 npm install。
# 构建：podman build -t localhost/tri-portal:1.0.0 .
FROM docker.1panel.live/library/node:20-alpine

ENV NODE_ENV=production \
    PORT=8090 \
    HOST=0.0.0.0

WORKDIR /app
COPY src/ ./src/
# 企业根 CA 烤进镜像：容器以 uid 1000 运行，挂载宿主目录在 SELinux/userns 下
# 容易出现 Permission denied，烤进镜像最稳（与 Keycloak 镜像同样做法）
COPY deploy/certs/tri.local_ca.crt /app/certs/tri.local_ca.crt

# 复制后显式授权：registry 预设的 umask 会让 COPY 出来的文件对 uid 1000 不可读
# 同时创建数据目录（门户配置持久化在 /app/data，由数据卷覆盖）
RUN chmod -R a+rX /app && mkdir -p /app/data && chown 1000:1000 /app/data

# 以非 root 运行（node 镜像自带 uid 1000 的 node 用户）
USER node

EXPOSE 8090

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8090/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
