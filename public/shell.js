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
}

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
};

setView(currentView(), { updateUrl: false });
