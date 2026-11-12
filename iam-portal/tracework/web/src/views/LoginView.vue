<template>
  <div class="login-wrap">
    <div class="login-card">
      <div class="login-logo">
        <svg width="42" height="42" viewBox="0 0 32 32" aria-hidden="true">
          <rect width="32" height="32" rx="7" fill="#006185"/>
          <path d="M16 6v10l7 4" stroke="#fff" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="16" cy="16" r="11" stroke="#fff" stroke-width="2.2" fill="none"/>
        </svg>
        <div>
          <div class="login-title">TraceWork</div>
          <div class="login-sub">Research &amp; Development Work Platform</div>
        </div>
      </div>

      <div v-if="error" class="alert bad">{{ error }}</div>

      <!-- OIDC 模式：统一身份单点登录 -->
      <template v-if="mode === 'oidc'">
        <button class="btn pri btn-block" type="button" :disabled="busy" @click="ssoLogin">
          <span v-if="busy" class="spinner" style="border-top-color:#fff;border-color:rgba(255,255,255,.35);"></span>
          {{ busy ? '正在跳转统一身份…' : '使用公司账号登录' }}
        </button>
        <div class="login-note" style="margin-top:14px;">
          将通过<strong>公司统一身份</strong>（sso.tri.local）完成登录，
          本系统不接触、不保存您的口令。<br>
          已登录过任一公司系统时，点击后<strong>无需再次输入密码</strong>。
        </div>
      </template>

      <!-- LDAP 模式：保留口令登录（仅回滚时使用） -->
      <form v-else @submit.prevent="submit" autocomplete="off">
        <div class="form-row">
          <label for="u">域账号（AD 用户名）</label>
          <input id="u" v-model.trim="username" class="input" type="text"
                 name="ad-account" autocomplete="off" autocapitalize="none" spellcheck="false"
                 placeholder="请输入您的域账号" required :disabled="busy">
        </div>
        <div class="form-row">
          <label for="p">密码</label>
          <input id="p" v-model="password" class="input" type="password"
                 name="ad-password" autocomplete="current-password"
                 placeholder="域账号密码" required :disabled="busy">
        </div>
        <button class="btn pri btn-block" type="submit" :disabled="busy || !username || !password">
          <span v-if="busy" class="spinner" style="border-top-color:#fff;border-color:rgba(255,255,255,.35);border-top-color:#fff;"></span>
          {{ busy ? '正在验证域账号…' : '登 录' }}
        </button>
      </form>

      <div v-if="mode !== 'oidc'" class="login-note">
        使用公司域账号（AD）登录，账号密码由域控统一验证，本系统不保存您的密码。<br>
        如无法登录，请联系 IT 或人力资源部。
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { useRouter, useRoute } from 'vue-router';
import { useAppStore } from '../store.js';

const store = useAppStore();
const router = useRouter();
const route = useRoute();

const username = ref('');
const password = ref('');
const busy = ref(false);
const error = ref('');
// 'oidc' | 'ldap'；启动时向服务端确认，避免前端硬编码
const mode = ref('ldap');

/** 计算登录后的返回地址（只允许站内路径） */
function returnTo() {
  const r = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard';
  return r.startsWith('/') && !r.startsWith('//') ? r : '/dashboard';
}

/** 跳转统一身份登录（整页跳转，不用 fetch） */
function ssoLogin() {
  busy.value = true;
  window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(returnTo())}`;
}

// 读取当前认证模式
(async () => {
  try {
    const r = await fetch('/api/auth/mode', { headers: { accept: 'application/json' } });
    if (r.ok) {
      const d = await r.json();
      mode.value = d.mode === 'oidc' ? 'oidc' : 'ldap';
    }
  } catch { /* 忽略，回退到 ldap 表单 */ }
  // 从 IdP 返回时可能带错误信息
  if (typeof route.query.error === 'string' && route.query.error) {
    error.value = route.query.error;
  }
})();

async function submit() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  try {
    await store.login(username.value, password.value);
    const target = typeof route.query.redirect === 'string' ? route.query.redirect : '/dashboard';
    await router.replace(target);
  } catch (e) {
    error.value = e.message || '登录失败，请重试';
    password.value = '';
  } finally {
    busy.value = false;
  }
}
</script>