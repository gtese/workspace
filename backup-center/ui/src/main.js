import { createApp } from 'vue'
import App from './App.vue'
import router from './router/index.js'
import { pinia } from './stores/index.js'
import { useAuthStore } from './stores/auth.js'
import { setUnauthorizedHandler } from './api/client.js'
import './style.css'

const app = createApp(App)

app.use(pinia)
app.use(router)

// 401 统一处理：清空本地会话并跳转登录页（登录页自身除外）。
setUnauthorizedHandler(() => {
  const auth = useAuthStore(pinia)
  auth.reset()
  const current = router.currentRoute.value
  if (current.name !== 'login') {
    router.push({
      name: 'login',
      query: current.fullPath && current.fullPath !== '/' ? { redirect: current.fullPath } : undefined,
    })
  }
})

app.mount('#app')
