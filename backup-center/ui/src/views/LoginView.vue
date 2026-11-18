<script setup>
import { onMounted, reactive, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  ArrowRight,
  Database,
  Eye,
  EyeOff,
  Fingerprint,
  HardDriveDownload,
  KeyRound,
  ShieldCheck,
  User,
} from 'lucide-vue-next'
import BaseButton from '../components/ui/BaseButton.vue'
import { useAuthStore } from '../stores/auth.js'
import { api } from '../api/index.js'
import { toast } from '../lib/toast.js'

const auth = useAuthStore()
const route = useRoute()
const router = useRouter()

const form = reactive({ username: '', password: '' })
const showPassword = ref(false)
const error = ref('')
const health = ref(null)
const healthError = ref(false)

onMounted(async () => {
  try {
    const data = await api.health.get()
    if (data && typeof data === 'object' && data.ok) {
      health.value = data
    } else {
      healthError.value = true
    }
  } catch {
    healthError.value = true
  }
})

function redirectTarget() {
  const redirect = route.query.redirect
  if (typeof redirect === 'string' && redirect.startsWith('/') && !redirect.startsWith('//')) {
    return redirect
  }
  return '/'
}

async function submit() {
  error.value = ''
  if (!form.username.trim()) {
    error.value = '请输入账号'
    return
  }
  if (!form.password) {
    error.value = '请输入密码'
    return
  }
  try {
    await auth.login(form.username.trim(), form.password)
    toast.success('登录成功')
    router.replace(redirectTarget())
  } catch (err) {
    error.value = err?.message || '登录失败，请检查账号或密码'
  }
}
</script>

<template>
  <div class="flex min-h-screen bg-slate-100">
    <!-- 左侧品牌区 -->
    <div class="relative hidden w-[46%] flex-col justify-between overflow-hidden bg-slate-900 p-12 text-slate-300 lg:flex">
      <div class="absolute -right-32 -top-32 h-96 w-96 rounded-full bg-brand-600/20 blur-3xl" />
      <div class="absolute -bottom-24 -left-24 h-80 w-80 rounded-full bg-indigo-500/10 blur-3xl" />

      <div class="relative">
        <div class="flex items-center gap-3">
          <span class="flex h-11 w-11 items-center justify-center rounded-xl bg-brand-600 text-white shadow-lg shadow-brand-900/40">
            <HardDriveDownload class="h-6 w-6" />
          </span>
          <div>
            <p class="text-lg font-semibold tracking-tight text-white">backup-center</p>
            <p class="text-xs text-slate-400">集中备份管理平台</p>
          </div>
        </div>

        <h1 class="mt-16 max-w-md text-3xl font-semibold leading-snug text-white">
          集中管理文件备份、<br />
          版本快照与文件级恢复
        </h1>
        <p class="mt-4 max-w-md text-sm leading-6 text-slate-400">
          基于 restic 的永久增量去重与 AES-256 加密，支持本地、NFS、SMB/CIFS 与 FTP(S) 存储，
          mTLS 双向认证保障代理接入安全。
        </p>

        <ul class="mt-10 space-y-4 text-sm">
          <li class="flex items-start gap-3">
            <ShieldCheck class="mt-0.5 h-5 w-5 shrink-0 text-emerald-400" />
            <span>Keycloak 统一身份 + 本地应急管理员，RBAC 细粒度授权</span>
          </li>
          <li class="flex items-start gap-3">
            <Database class="mt-0.5 h-5 w-5 shrink-0 text-brand-400" />
            <span>多存储库统一容量监控，仓库校验与使用量可视化</span>
          </li>
          <li class="flex items-start gap-3">
            <Fingerprint class="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <span>代理证书指纹审批，所有写操作与恢复全程审计</span>
          </li>
        </ul>
      </div>

      <div class="relative flex items-center gap-2 text-xs text-slate-500">
        <span
          class="inline-block h-2 w-2 rounded-full"
          :class="healthError ? 'bg-red-500' : health?.ok ? 'bg-emerald-400' : 'bg-slate-500'"
        />
        <span v-if="health?.ok">服务运行正常 · v{{ health.version || '1.0' }}</span>
        <span v-else-if="healthError">无法连接后端服务，请确认服务已启动</span>
        <span v-else>正在检查服务状态…</span>
      </div>
    </div>

    <!-- 右侧登录表单 -->
    <div class="flex flex-1 items-center justify-center px-4 py-10 sm:px-8">
      <div class="w-full max-w-md">
        <div class="mb-8 flex items-center gap-3 lg:hidden">
          <span class="flex h-10 w-10 items-center justify-center rounded-xl bg-brand-600 text-white">
            <HardDriveDownload class="h-5 w-5" />
          </span>
          <div>
            <p class="text-base font-semibold text-slate-900">backup-center</p>
            <p class="text-xs text-slate-500">集中备份管理平台</p>
          </div>
        </div>

        <div class="rounded-2xl border border-slate-200 bg-white p-7 shadow-xl shadow-slate-200/60 sm:p-8">
          <h2 class="text-xl font-semibold text-slate-900">登录管理控制台</h2>
          <p class="mt-1 text-sm text-slate-500">使用本地管理员账号或企业统一身份登录</p>

          <form class="mt-6 space-y-4" @submit.prevent="submit">
            <div>
              <label for="username" class="bc-label">账号</label>
              <div class="relative">
                <User class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="username"
                  v-model="form.username"
                  type="text"
                  autocomplete="username"
                  class="bc-input pl-9"
                  placeholder="请输入用户名"
                />
              </div>
            </div>

            <div>
              <label for="password" class="bc-label">密码</label>
              <div class="relative">
                <KeyRound class="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
                <input
                  id="password"
                  v-model="form.password"
                  :type="showPassword ? 'text' : 'password'"
                  autocomplete="current-password"
                  class="bc-input pl-9 pr-10"
                  placeholder="请输入密码"
                />
                <button
                  type="button"
                  class="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  :aria-label="showPassword ? '隐藏密码' : '显示密码'"
                  @click="showPassword = !showPassword"
                >
                  <EyeOff v-if="showPassword" class="h-4 w-4" />
                  <Eye v-else class="h-4 w-4" />
                </button>
              </div>
            </div>

            <p v-if="error" class="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {{ error }}
            </p>

            <BaseButton type="submit" block size="lg" :loading="auth.loggingIn">
              登录
              <ArrowRight class="h-4 w-4" />
            </BaseButton>
          </form>

          <div class="my-6 flex items-center gap-3">
            <span class="h-px flex-1 bg-slate-200" />
            <span class="text-xs text-slate-400">或</span>
            <span class="h-px flex-1 bg-slate-200" />
          </div>

          <a
            href="/auth/oidc/start"
            class="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 transition hover:bg-slate-50 focus:outline-none focus:ring-2 focus:ring-brand-500/30"
          >
            <ShieldCheck class="h-4 w-4 text-brand-600" />
            统一身份登录（Keycloak）
          </a>

          <p class="mt-6 text-center text-xs leading-5 text-slate-400">
            本地账号用于应急管理；企业账号经 Keycloak 单点登录后自动创建并映射角色。
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
