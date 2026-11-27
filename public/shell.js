/**
 * 单页外壳：同一个地址承载「翻译 / 精读 / 知识图谱」三个视图。
 * 顶栏切换，URL 用 ?view= 记录，刷新后保持；左侧历史论文侧栏在翻译与精读之间共用。
 */
const PREF_KEY = 'paperlens.view';
const SIDEBAR_KEY = 'paperlens.sidebar';
const VIEWS = ['translate', 'paper', 'kg'];
const DEFAULT_VIEW = 'paper';

function normalize(view) {
  return VIEWS.includes(view) ? view : '';
}

function currentView() {
  const params = new URLSearchParams(location.search);
  const requested = normalize(params.get('view'));
  if (requested) return requested;
  // 深链参数优先：论文/出处参数回精读，图谱参数进图谱
  if (params.get('graph') || params.get('source') || params.get('concept')) return 'kg';
  if (params.get('paper') || params.get('fromSource') || params.get('quote')) return 'paper';
  return normalize(localStorage.getItem(PREF_KEY)) || DEFAULT_VIEW;
}

function setView(view, { updateUrl = true } = {}) {
  const next = normalize(view) || DEFAULT_VIEW;
  document.body.dataset.view = next;
  // 旧版样式里还有 html[data-view=kg] 的选择器，保留兼容
  document.documentElement.dataset.view = next;

  for (const name of VIEWS) {
    const host = document.getElementById(`view-${name}`);
    if (host) host.hidden = name !== next;
  }
  document.querySelectorAll('[data-app-switch] [data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === next);
  });

  try {
    localStorage.setItem(PREF_KEY, next);
  } catch {
    /* 隐私模式下忽略 */
  }

  if (updateUrl) {
    const url = new URL(location.href);
    if (next === DEFAULT_VIEW) url.searchParams.delete('view');
    else url.searchParams.set('view', next);
    if (next !== 'kg') {
      url.searchParams.delete('source');
      url.searchParams.delete('graph');
    }
    history.replaceState(null, '', url);
  }

  // 图谱画布在隐藏容器里宽度是 0，显示后让它按真实尺寸重新适配
  if (next === 'kg') setTimeout(() => window.dispatchEvent(new Event('resize')), 40);
  // 目录是跨视图共享的：切视图后刷新为当前视图的章节数据
  if (typeof refreshOutline === 'function') refreshOutline();
}

/* --------------------------- 侧栏面板 Tab --------------------------- */

const SIDE_TAB_KEY = 'paperlens.sideTab';

function setSideTab(tab, { persist = true } = {}) {
  const next = tab === 'outline' ? 'outline' : 'history';
  for (const btn of document.querySelectorAll('[data-side-tab]')) {
    const active = btn.dataset.sideTab === next;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', active ? 'true' : 'false');
  }
  for (const panel of document.querySelectorAll('[data-side-panel]')) {
    panel.hidden = panel.dataset.sidePanel !== next;
  }
  // 切到目录时确保侧栏展开（否则看不到）
  if (next === 'outline') applySidebar(true);
  if (persist) {
    try { localStorage.setItem(SIDE_TAB_KEY, next); } catch { /* ignore */ }
  }
  window.dispatchEvent(new CustomEvent('sidepanelchange', { detail: { tab: next } }));
}

function currentSideTab() {
  return localStorage.getItem(SIDE_TAB_KEY) === 'outline' ? 'outline' : 'history';
}

document.addEventListener('click', (ev) => {
  const tab = ev.target.closest('[data-side-tab]');
  if (tab) {
    ev.preventDefault();
    setSideTab(tab.dataset.sideTab);
  }
});

/* -------------------- 共享目录树：渲染 + 点击分发 --------------------
 * 精读页与翻译页各自 registerOutlineProvider(view, provider)，
 * 由外壳统一渲染 #side-outline 并把点击分发给当前视图，跳转逻辑各页自治。
 * provider = { outline(), expanded(), onPick(id), onResolve() }
 */
// provider 由各视图挂到 window.paperlens（getPaperOutlineProvider / getTranslateOutlineProvider），
// shell 按当前视图主动拉取——避免 app.js 先于 shell.js 加载时的注册时序问题。
function currentOutlineProvider() {
  const view = currentView();
  if (view === 'paper') return window.paperlens?.getPaperOutlineProvider?.() || null;
  if (view === 'translate') return window.paperlens?.getTranslateOutlineProvider?.() || null;
  return null;
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function arrowPlaceholder() {
  return '<span class="tree-arrow placeholder"></span>';
}

function refreshOutline() {
  const tree = document.getElementById('side-outline');
  if (!tree) return;
  const provider = currentOutlineProvider();
  const sections = provider?.outline?.()?.sections || [];
  const expanded = provider?.expanded?.() || new Set();
  const count = document.getElementById('side-outline-count');
  const resolveBtn = document.getElementById('btn-outline-resolve');
  if (resolveBtn) resolveBtn.hidden = !provider || !sections.length;
  if (count) count.textContent = sections.length ? `${sections.length} 节` : '未解析';

  if (!sections.length) {
    tree.innerHTML = '<div class="side-outline-empty">还没有章节结构。<br />点下方「重新解析」生成目录。</div>';
    return;
  }

  const roots = [];
  let current = null;
  for (const s of sections) {
    const level = Math.min(3, Math.max(1, Number(s.level) || 1));
    if (level === 1 || !current) {
      current = { sec: s, children: [] };
      roots.push(current);
    } else {
      current.children.push(s);
    }
  }

  tree.innerHTML = roots
    .map(({ sec, children }, i) => {
      const num = sec.number ? `<span class="tree-num">${esc(sec.number)}</span>` : '';
      const title = esc(sec.title || '未命名章节');
      const summary = sec.summary ? esc(sec.summary) : '';
      const open = expanded.has(sec.id);
      const hasKids = children.length > 0;
      const arrow = hasKids
        ? `<button class="tree-arrow${open ? ' open' : ''}" type="button" data-expand="${esc(sec.id)}" aria-label="${open ? '收起' : '展开'}子节">▸</button>`
        : '<span class="tree-arrow placeholder"></span>';
      const kidsHtml = hasKids && open
        ? `<div class="tree-children">${children
            .map((c) => {
              const cn = c.number ? `<span class="tree-num">${esc(c.number)}</span>` : '';
              const ct = esc(c.title || '未命名');
              const cs = c.summary ? esc(c.summary) : '';
              return `<button class="tree-item child" type="button" data-section="${esc(c.id)}" title="${ct}${cs ? '：' + cs : ''}">${arrowPlaceholder()}${cn}<span class="tree-title">${ct}</span></button>`;
            })
            .join('')}</div>`
        : '';
      return `<div class="tree-group" data-index="${i}">
        <div class="tree-row">
          ${arrow}
          <button class="tree-item" type="button" data-section="${esc(sec.id)}" title="${title}${summary ? '：' + summary : ''}">${num}<span class="tree-title">${title}</span></button>
        </div>
        ${kidsHtml}
      </div>`;
    })
    .join('');
}

document.addEventListener('click', (ev) => {
  const tree = ev.target.closest('#side-outline');
  if (!tree) return;
  const provider = currentOutlineProvider();
  if (!provider) return;
  const expand = ev.target.closest('[data-expand]');
  if (expand) {
    const id = expand.dataset.expand;
    const set = provider.expanded?.();
    if (set) {
      if (set.has(id)) set.delete(id);
      else set.add(id);
    }
    refreshOutline();
    return;
  }
  const item = ev.target.closest('[data-section]');
  if (item) provider.onPick?.(item.dataset.section);
});

document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#btn-outline-resolve')) return;
  currentOutlineProvider()?.onResolve?.();
});

/* ------------------------------ 侧栏开关 ------------------------------ */

function sidebarOpen() {
  return !document.body.classList.contains('sidebar-collapsed');
}

function applySidebar(open, { persist = true } = {}) {
  const changed = document.body.classList.contains('sidebar-collapsed') === Boolean(open);
  document.body.classList.toggle('sidebar-collapsed', !open);
  if (persist) {
    try {
      localStorage.setItem(SIDEBAR_KEY, open ? '1' : '0');
    } catch {
      /* ignore */
    }
  }
  // 工作区宽度变了：让画布 / PDF 重新适配（翻译页自己也会算一次）
  if (changed) setTimeout(() => window.dispatchEvent(new Event('resize')), 60);
}

applySidebar(localStorage.getItem(SIDEBAR_KEY) !== '0', { persist: false });

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-app-switch] [data-view]');
  if (btn) {
    ev.preventDefault();
    setView(btn.dataset.view);
    return;
  }
  if (ev.target.closest('#btn-sidebar-toggle')) {
    ev.preventDefault();
    applySidebar(!sidebarOpen());
  }
});

document.addEventListener('keydown', (ev) => {
  if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'b') return;
  // 翻译视图自己处理 Ctrl+B（它还要同步自己的 prefs），这里只兜其他视图
  if (document.body.dataset.view === 'translate') return;
  ev.preventDefault();
  applySidebar(!sidebarOpen());
});

/* 精读页需要「点了侧栏里的论文就切回来」 */
window.paperlens = {
  ...(window.paperlens || {}),
  setView,
  currentView,
  applySidebar,
  sidebarOpen,
  setSideTab,
  currentSideTab,
  refreshOutline,
};

// 切到目录 tab 时刷新为当前视图的目录
window.addEventListener('sidepanelchange', (ev) => {
  if (ev.detail?.tab === 'outline') refreshOutline();
});

setView(currentView(), { updateUrl: false });
setSideTab(currentSideTab(), { persist: false });
