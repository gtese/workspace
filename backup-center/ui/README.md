# backup-center 前端（ui/）

Vue 3 + Vite 5 + vue-router 4 + Pinia + Tailwind 3 + ECharts 5 + lucide-vue-next。
构建产物输出到 `../server/public`，由管理端直接托管。

## 开发

```bash
cd ui
npm install        # 或 npm ci
npm run dev        # http://127.0.0.1:5173，/api、/auth、/healthz 代理到 http://127.0.0.1:9443

# 后端未就绪时，使用内置 mock（仅 dev server 中间件，不进入生产构建）
npm run dev:mock   # 登录页任意非空账号密码即可进入
```

## 构建

```bash
npm run build      # 输出 ../server/public（vite.config.js 中 outDir + emptyOutDir）
```

## 约定

- 所有接口使用相对路径 `/api/...`，无硬编码域名；Cookie 会话 + `x-csrf-token`。
- `src/api/client.js`：统一 fetch 封装（credentials、CSRF、401 跳转、错误 Toast、JSON 解析）。
- `src/api/sse.js`：基于 fetch 流的 SSE 封装，自动携带 Cookie，支持自动重连。
- `dev-mock/mock.js`：开发 mock，通过 `VITE_MOCK=1` 动态加载；生产构建不包含任何 mock 数据。
- 页面路由与角色限制见 `src/router/index.js`；`users` 仅 admin，`audit` 仅 admin/auditor。
- 敏感字段（仓库密码、SMTP 密码、Webhook 密钥）只写不读，读取时显示 `***`，留空表示不修改。

## 目录

```text
src/api/          fetch 封装、SSE、接口定义
src/components/   布局、通用 UI、目录选择器、计划编辑器、任务抽屉、快照浏览
src/views/        各页面
src/stores/       auth / meta（节点、存储库缓存）
src/lib/          格式化、Toast、确认弹窗
dev-mock/         开发 mock
```
