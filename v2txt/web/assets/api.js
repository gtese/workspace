/* 共享前端工具：会话、请求、提示、i18n */
(function () {
  const TOKEN_KEY = 'vt_token';
  const ORG_KEY = 'vt_org';
  const LANG_KEY = 'vt_lang';

  const I18N = {
    zh: {
      signin: '登录', signup: '注册', logout: '退出',
      email: '邮箱', password: '密码', name: '姓名', confirm: '确认密码',
      submit: '提交', cancel: '取消', save: '保存', delete: '删除',
      loading: '处理中…', copied: '已复制',
    },
    en: {
      signin: 'Sign in', signup: 'Sign up', logout: 'Sign out',
      email: 'Email', password: 'Password', name: 'Name', confirm: 'Confirm password',
      submit: 'Submit', cancel: 'Cancel', save: 'Save', delete: 'Delete',
      loading: 'Working…', copied: 'Copied',
    },
  };

  function lang() {
    return localStorage.getItem(LANG_KEY) || (navigator.language.startsWith('zh') ? 'zh' : 'en');
  }

  const Api = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    org: localStorage.getItem(ORG_KEY) || '',
    setToken(t) {
      this.token = t || '';
      if (t) localStorage.setItem(TOKEN_KEY, t); else localStorage.removeItem(TOKEN_KEY);
    },
    setOrg(id) {
      this.org = id || '';
      if (id) localStorage.setItem(ORG_KEY, id); else localStorage.removeItem(ORG_KEY);
    },
    get lang() { return lang(); },
    setLang(v) { localStorage.setItem(LANG_KEY, v); location.reload(); },
    t(key) { return (I18N[lang()] || I18N.zh)[key] || key; },
    async req(path, opts = {}) {
      const headers = Object.assign({}, opts.headers || {});
      if (this.token) headers.Authorization = 'Bearer ' + this.token;
      if (this.org) headers['X-Org-Id'] = this.org;
      if (opts.body && !(opts.body instanceof FormData)) {
        headers['Content-Type'] = 'application/json';
        opts.body = JSON.stringify(opts.body);
      }
      const res = await fetch(path, Object.assign({}, opts, { headers }));
      if (res.status === 401) {
        this.setToken('');
        if (!location.pathname.startsWith('/login') && !location.pathname.startsWith('/register')) {
          let app = '';
          try { app = sessionStorage.getItem('feishu_app') || ''; } catch (e) { /* 忽略 */ }
          location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash) +
            (app ? '&app=' + encodeURIComponent(app) : '');
        }
        throw new Error('未登录');
      }
      let data = null;
      const ct = res.headers.get('content-type') || '';
      if (ct.includes('application/json')) data = await res.json();
      if (!res.ok) {
        const msg = (data && (data.detail || data.message)) || ('HTTP ' + res.status);
        const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        err.status = res.status;
        err.data = data;
        throw err;
      }
      return data;
    },
  };

  let toastTimer = null;
  function toast(msg, isError) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.toggle('err', !!isError);
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
  }

  function needAuth() {
    if (!Api.token) {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.hash);
      return false;
    }
    return true;
  }

  function fmtDate(iso, withTime) {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, '0');
    const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return withTime ? `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}` : base;
  }

  function fmtMin(v) {
    const n = Number(v || 0);
    return (Math.round(n * 10) / 10).toLocaleString();
  }

  window.UI = { Api, toast, needAuth, fmtDate, fmtMin };
})();
