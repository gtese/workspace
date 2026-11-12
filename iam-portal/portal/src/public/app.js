/* ============================================================
   企业应用门户 — 前端逻辑（无框架，原生 JS）
   ------------------------------------------------------------
   功能：
     1. 展示应用卡片（按分组与保存的顺序）
     2. 未登录时展示公开应用 + 「登录」按钮
     3. 管理员：进入编辑模式 → 拖动排序 / 编辑 / 增删 / 隐藏 → 保存
     4. 拖拽用 Pointer Events 实现（鼠标 + 触屏 + 笔都能用）
   ============================================================ */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ 工具 */
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));

  async function api(path, opts = {}) {
    const res = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts));
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!res.ok) {
      const err = new Error((data && (data.message || data.error)) || `HTTP ${res.status}`);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  /* ------------------------------------------------------------------ 状态 */
  const State = {
    user: null,
    isAdmin: false,
    apps: [],           // 展示用
    categories: [],
    editing: false,
    draft: [],          // 编辑中的副本
    editingIndex: -1,   // 正在编辑的卡片下标（-1 = 新增）
  };

  /* ------------------------------------------------------------------ 首屏 */
  function cardHtml(a, interactive) {
    const badge = a.coming
      ? '<span class="badge soon">即将上线</span>'
      : (a.sso ? '<span class="badge ok">免登录</span>' : '<span class="badge warn">需单独登录</span>');
    const pub = a.public ? '<span class="badge pub">公开</span>' : '';
    const href = a.coming ? '#' : a.url;
    const attrs = a.coming ? '' : (a.external ? ' target="_blank" rel="noopener"' : '');
    const tag = interactive ? 'a' : 'div';
    return `<${tag} class="app-card${a.coming ? ' disabled' : ''}" href="${esc(href)}"${attrs} data-id="${esc(a.id)}">
      <div class="app-icon" aria-hidden="true">${esc(a.icon)}</div>
      <div class="app-body">
        <div class="app-title">${esc(a.name)}${badge}${pub}</div>
        <p class="app-desc">${esc(a.desc)}</p>
        <div class="app-url muted">${esc(String(a.url || '').replace(/^https?:\/\//, ''))}</div>
      </div>
    </${tag}>`;
  }

  function renderHome() {
    const grid = $('grid');
    if (!State.apps.length) {
      grid.innerHTML = '<p class="muted">暂无可用的应用</p>';
      return;
    }
    // 按配置的分组顺序分组；未声明的分组按出现顺序追加
    const byCat = new Map();
    for (const a of State.apps) {
      if (!byCat.has(a.category)) byCat.set(a.category, []);
      byCat.get(a.category).push(a);
    }
    const order = [
      ...State.categories.filter((c) => byCat.has(c)),
      ...Array.from(byCat.keys()).filter((c) => !State.categories.includes(c)),
    ];
    grid.innerHTML = order.map((cat) => `
      <h2 class="group-title">${esc(cat)}</h2>
      <div class="group-grid">${byCat.get(cat).map((a) => cardHtml(a, true)).join('')}</div>
    `).join('');
  }

  async function boot() {
    try {
      const me = await api('/api/me');
      State.user = me;
      State.isAdmin = (me.roles || []).some((r) => /:admin$/.test(r));
    } catch { State.user = null; State.isAdmin = false; }

    const appsRes = await api('/api/apps');
    State.apps = appsRes.apps || [];
    State.categories = appsRes.categories || [];

    // 顶栏
    if (State.user) {
      $('userinfo').hidden = false;
      $('logoutBtn').hidden = false;
      $('uname').textContent = State.user.name || State.user.username;
      $('uemail').textContent = State.user.email || '';
      $('avatar').textContent = (State.user.username || '?').slice(0, 1).toUpperCase();
      if (State.isAdmin) $('editBtn').hidden = false;
    } else {
      // 未登录：服务端在无 public 应用时已 302 到登录页；
      // 能渲染到这里说明有公开内容（或带 ?auto=0），只展示公开应用 + 登录按钮
      $('loginBtn').hidden = false;
      $('footNote').textContent = '当前未登录，仅显示公开内容';
    }
    renderHome();
    if (State.apps.some((a) => a.sso)) $('ssoNotice').hidden = false;
  }

  /* ------------------------------------------------------------------ 登录/退出 */
  $('loginBtn').addEventListener('click', () => {
    location.href = '/auth/login?returnTo=' + encodeURIComponent(location.pathname + location.search);
  });

  $('logoutBtn').addEventListener('click', async () => {
    $('logoutBtn').disabled = true;
    try {
      const r = await api('/auth/logout', { method: 'POST' });
      location.href = r.logoutUrl || 'https://sso.tri.local';
    } catch {
      location.href = 'https://sso.tri.local';
    }
  });

  /* ================================================================== 编辑模式 */
  async function openEditor() {
    try {
      const cfg = await api('/api/admin/config');
      State.draft = (cfg.apps || []).map((a) => ({ ...a }));
      State.categories = cfg.categories || [];
    } catch (e) {
      alert('读取配置失败：' + e.message);
      return;
    }
    State.editing = true;
    $('editorMask').hidden = false;
    $('editorMsg').hidden = true;
    renderEditor();
  }

  function closeEditor() {
    State.editing = false;
    $('editorMask').hidden = true;
  }

  function renderEditor() {
    const list = $('editList');
    if (!State.draft.length) list.innerHTML = '<li class="muted">还没有应用，点「新增应用」</li>';
    else {
      list.innerHTML = State.draft.map((a, i) => `
        <li class="edit-row" data-index="${i}">
          <span class="drag-handle" title="拖动排序">⠿</span>
          <span class="app-icon small" aria-hidden="true">${esc(a.icon)}</span>
          <span class="edit-main">
            <span class="edit-name">${esc(a.name)}${a.hidden ? ' <em class="muted small">（已隐藏）</em>' : ''}</span>
            <span class="edit-url muted small">${esc(String(a.url || '').replace(/^https?:\/\//, ''))}</span>
          </span>
          <span class="edit-badges">
            ${a.sso ? '<span class="badge ok">免登录</span>' : ''}
            ${a.coming ? '<span class="badge soon">即将上线</span>' : ''}
            ${a.adminOnly ? '<span class="badge pub">仅管理员</span>' : ''}
            ${a.public ? '<span class="badge pub">公开</span>' : ''}
            ${a.hidden ? '<span class="badge warn">隐藏</span>' : ''}
          </span>
          <span class="edit-ops">
            <button class="btn tiny" data-op="edit" data-i="${i}" type="button">编辑</button>
            <button class="btn tiny ghost" data-op="hide" data-i="${i}" type="button">${a.hidden ? '显示' : '隐藏'}</button>
            <button class="btn tiny danger" data-op="del" data-i="${i}" type="button">删除</button>
          </span>
        </li>`).join('');
    }
    $('catList').innerHTML = Array.from(new Set(State.draft.map((a) => a.category).concat(State.categories)))
      .filter(Boolean).map((c) => `<option value="${esc(c)}">`).join('');
  }

  $('editBtn').addEventListener('click', openEditor);
  $('cancelBtn').addEventListener('click', closeEditor);
  $('editorMask').addEventListener('click', (e) => { if (e.target === $('editorMask')) closeEditor(); });

  // 列表内的编辑/隐藏/删除
  $('editList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-op]');
    if (!btn) return;
    const i = Number(btn.dataset.i);
    const op = btn.dataset.op;
    if (op === 'edit') openAppForm(i);
    else if (op === 'hide') { State.draft[i].hidden = !State.draft[i].hidden; renderEditor(); }
    else if (op === 'del') {
      if (confirm(`确定从门户移除「${State.draft[i].name}」？（不会删除该系统本身）`)) {
        State.draft.splice(i, 1);
        renderEditor();
      }
    }
  });

  $('addBtn').addEventListener('click', () => openAppForm(-1));

  /* ================================================================== 拖拽排序 */
  let drag = null;

  function onPointerDown(e) {
    const handle = e.target.closest('.drag-handle');
    if (!handle) return;
    const row = handle.closest('.edit-row');
    if (!row) return;
    e.preventDefault();
    const rect = row.getBoundingClientRect();
    drag = {
      row,
      from: Number(row.dataset.index),
      startY: e.clientY,
      offsetY: e.clientY - rect.top,
      pointerId: e.pointerId,
      ghost: null,
      to: Number(row.dataset.index),
    };
    row.classList.add('dragging');
    handle.setPointerCapture(e.pointerId);
    // 自定义拖拽镜像（比 HTML5 DnD 更可控，且支持触屏）
    const ghost = row.cloneNode(true);
    ghost.className = 'edit-row drag-ghost';
    ghost.style.width = rect.width + 'px';
    ghost.style.left = rect.left + 'px';
    ghost.style.top = rect.top + 'px';
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp, { once: true });
  }

  function onPointerMove(e) {
    if (!drag) return;
    drag.ghost.style.top = (e.clientY - drag.offsetY) + 'px';
    const rows = Array.from($('editList').querySelectorAll('.edit-row:not(.dragging)'));
    let target = rows.length;
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].getBoundingClientRect();
      if (e.clientY < r.top + r.height / 2) { target = i; break; }
    }
    drag.to = target;
    // 视觉提示插入位置
    rows.forEach((r, i) => r.classList.toggle('insert-before', i === target));
  }

  function onPointerUp() {
    if (!drag) return;
    document.removeEventListener('pointermove', onPointerMove);
    drag.ghost.remove();
    drag.row.classList.remove('dragging');
    $('editList').querySelectorAll('.insert-before').forEach((r) => r.classList.remove('insert-before'));
    let { from, to } = drag;
    drag = null;
    if (to > from) to -= 1;               // 移除源项后目标下标前移
    if (to === from) return;
    const [item] = State.draft.splice(from, 1);
    State.draft.splice(to, 0, item);
    renderEditor();
    flash(`已移到第 ${to + 1} 位（记得保存）`);
  }

  $('editList').addEventListener('pointerdown', onPointerDown);

  /* ================================================================== 单卡编辑弹层 */
  function openAppForm(index) {
    State.editingIndex = index;
    const a = index >= 0 ? State.draft[index] : {
      id: '', name: '', desc: '', url: 'https://', icon: '🔗', category: State.categories[0] || '其他',
      sso: false, external: false, coming: false, adminOnly: false, public: false, hidden: false,
    };
    $('modalTitle').textContent = index >= 0 ? '编辑应用' : '新增应用';
    const f = $('appForm');
    for (const [k, v] of Object.entries(a)) {
      const el = f.elements[k];
      if (!el) continue;
      if (el.type === 'checkbox') el.checked = !!v;
      else if (k !== 'id' || index >= 0) el.value = v == null ? '' : v;
    }
    if (index < 0) f.elements.id.value = '';
    $('modalMask').hidden = false;
    f.elements.name.focus();
  }

  function closeAppForm() { $('modalMask').hidden = true; }

  $('modalCancel').addEventListener('click', closeAppForm);
  $('modalMask').addEventListener('click', (e) => { if (e.target === $('modalMask')) closeAppForm(); });

  $('appForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const f = e.target;
    const data = {};
    for (const el of f.elements) {
      if (!el.name) continue;
      data[el.name] = el.type === 'checkbox' ? el.checked : el.value.trim();
    }
    // 前端先做一层校验，服务端还会再校验
    try {
      const u = new URL(data.url);
      if (u.protocol !== 'https:') throw new Error('地址必须是 https');
    } catch { alert('地址必须是合法的 https 地址'); return; }
    if (!data.name) { alert('名称不能为空'); return; }
    if (!/^[A-Za-z0-9_-]*$/.test(data.id)) { alert('ID 只能包含字母、数字、下划线、短横线'); return; }

    if (State.editingIndex >= 0) {
      const prev = State.draft[State.editingIndex];
      data.id = data.id || prev.id;
      data.coming = !!data.coming; data.sso = !!data.sso;
      State.draft[State.editingIndex] = Object.assign({}, prev, data);
    } else {
      data.id = data.id || ('app-' + Date.now().toString(36));
      if (State.draft.some((x) => x.id === data.id)) { alert('ID 已存在'); return; }
      State.draft.push(data);
    }
    closeAppForm();
    renderEditor();
    flash('已修改（记得保存）');
  });

  /* ------------------------------------------------------------------ 保存 / 重置 */
  function flash(msg, isError) {
    const el = $('editorMsg');
    el.hidden = false;
    el.textContent = msg;
    el.className = 'editor-msg' + (isError ? ' error' : '');
    clearTimeout(flash._t);
    flash._t = setTimeout(() => { el.hidden = true; }, 2600);
  }

  $('saveBtn').addEventListener('click', async () => {
    const btn = $('saveBtn');
    btn.disabled = true;
    try {
      const cats = Array.from(new Set(State.draft.map((a) => a.category || '其他')))
        .concat(State.categories.filter((c) => !State.draft.some((a) => a.category === c)));
      await api('/api/admin/config', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apps: State.draft, categories: cats }),
      });
      closeEditor();
      await boot();
    } catch (e) {
      flash('保存失败：' + e.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  $('resetBtn').addEventListener('click', async () => {
    if (!confirm('恢复为默认应用列表？当前自定义会备份到服务器（可找回）。')) return;
    try {
      await api('/api/admin/config/reset', { method: 'POST' });
      closeEditor();
      await boot();
    } catch (e) { flash('重置失败：' + e.message, true); }
  });

  // Esc 关闭弹层
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!$('modalMask').hidden) closeAppForm();
    else if (State.editing) closeEditor();
  });

  boot().catch((e) => {
    $('grid').innerHTML = '<p class="muted">门户加载失败：' + esc(e.message) + '</p>';
  });
})();