<!--
  ============================================================
  改造后的登录页（替换 web/src/views/LoginView.vue 的模板与脚本）
  ============================================================
  关键点：
   - 不再有账号密码输入框（口令只出现在 sso.tri.local）
   - 一个按钮整页跳转（不要用 fetch / axios，否则 IdP 的 302 走不通）
   - 支持登录后回到原页面：returnTo 必须是站内相对路径
   - 保留原有品牌样式（styles.css 里的类名不变）
-->
<template>
  <div class="login-wrap">
    <div class="login-card">
      <h1 class="login-title">Tri 科研项目职能支持系统</h1>
      <p class="login-sub">使用公司域账号登录</p>

      <button class="btn btn-primary btn-block" :disabled="going" @click="goLogin">
        {{ going ? '正在跳转…' : '使用公司账号登录（统一身份）' }}
      </button>

      <p class="login-tip">
        登录由公司统一身份平台（sso.tri.local）处理，
        本系统不会保存您的密码。登录一次即可访问工时、知识库等已接入系统。
      </p>

      <p v-if="loggedOut" class="login-ok">您已安全退出。</p>
      <p v-if="denied" class="login-error">{{ denied }}</p>
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();
const going = ref(false);
const loggedOut = computed(() => route.query.logout === '1');
const denied = computed(() => (typeof route.query.error === 'string' ? route.query.error : ''));

function goLogin() {
  going.value = true;
  // returnTo 只允许站内路径，服务端（routes.js）还会再校验一次
  const back = route.query.returnTo && String(route.query.returnTo).startsWith('/')
    ? String(route.query.returnTo)
    : '/';
  window.location.href = `/api/auth/login?returnTo=${encodeURIComponent(back)}`;
}
</script>
