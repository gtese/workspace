import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

// 开发时通过 VITE_MOCK=1（npm run dev:mock）启用本地 mock，无需后端即可浏览页面。
// mock 模块只在 dev server 配置中动态加载，不会进入生产构建产物。
export default defineConfig(async () => {
  const useMock = process.env.VITE_MOCK === '1'
  const plugins = [vue()]

  if (useMock) {
    const { devMockPlugin } = await import('./dev-mock/mock.js')
    plugins.push(devMockPlugin())
  }

  return {
    base: '/',
    plugins,
    server: {
      port: 5173,
      strictPort: false,
      proxy: useMock
        ? undefined
        : {
            '/api': {
              target: 'http://127.0.0.1:9443',
              changeOrigin: false,
            },
            '/auth': {
              target: 'http://127.0.0.1:9443',
              changeOrigin: false,
            },
            '/healthz': {
              target: 'http://127.0.0.1:9443',
              changeOrigin: false,
            },
          },
    },
    build: {
      outDir: '../server/public',
      emptyOutDir: true,
      sourcemap: false,
      chunkSizeWarningLimit: 1024,
    },
  }
})
