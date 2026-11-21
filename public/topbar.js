/**
 * 三视图共用顶栏：历史论文按钮、视图切换、品牌区、主题与设置入口。
 *
 * 各视图在 HTML 里只保留自己的中部信息（文件胶囊 / 标题 / 搜索）与业务按钮，
 * 本模块负责补齐公共部分并统一处理主题、设置点击；具体弹窗仍由各视图注册，
 * 避免把三套差异很大的设置表单硬合并。
 */

const VIEWS = ['translate', 'paper', 'kg'];

const NAV = `
  <nav class="app-switch" data-app-switch aria-label="切换视图">
    <button type="button" data-view="translate">翻译</button>
    <button type="button" data-view="paper">精读</button>
    <button type="button" data-view="kg">知识图谱</button>
  </nav>`;

const SIDEBAR_ICON = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>
  </svg>`;

const DOC_ICON = `
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/>
  </svg>`;

const MOON_ICON = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>
  </svg>`;

const GEAR_ICON = `
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.5 19l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 13.6H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.7 7l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.6 1.6 0 0 0 10 3.1V3a2 2 0 1 1 4 0v.1A1.6 1.6 0 0 0 16.5 5l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0 1.1 2.7H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1.5z"/>
  </svg>`;

/** 品牌名与图标沿用各视图原有内容，只统一样式与结构 */
const BRANDS = {
  translate: { icon: DOC_ICON, name: 'PaperTrans', sub: '论文对照翻译' },
  paper: { mark: '◈', name: 'PaperLens', sub: '原文 · 精读 · 交互图解' },
};

const handlers = new Map();

/**
 * 各视图注册自己的设置 / 主题行为。
 * @param {'translate'|'paper'|'kg'} view
 * @param {{settings?: () => void, theme?: () => void}} actions
 */
export function registerTopbarActions(view, actions) {
  handlers.set(view, { ...(handlers.get(view) || {}), ...actions });
}

function sidebarHtml(view) {
  if (view === 'kg') return '<span class="app-topbar-placeholder" aria-hidden="true"></span>';
  const id = view === 'translate' ? 'btnSidebar' : 'btn-sidebar-toggle';
  return `
    <button id="${id}" class="btn icon" type="button" title="历史论文（Ctrl+B）" aria-label="展开或收起历史论文">
      ${SIDEBAR_ICON}
    </button>`;
}

function brandHtml(view) {
  if (view === 'kg') {
    return `
      <div class="app-topbar-brand app-topbar-brand-kg">
        <span class="app-topbar-mark" aria-hidden="true"></span>
        <button id="kg-graph-switch" class="graph-switch" type="button" title="切换 / 管理知识图谱">
          <span id="kg-graph-name">我的知识库</span>
          <span class="graph-caret">▾</span>
        </button>
      </div>`;
  }
  const brand = BRANDS[view];
  const mark = brand.icon || `<span class="app-topbar-mark" aria-hidden="true">${brand.mark}</span>`;
  return `
    <div class="app-topbar-brand">
      ${mark}
      <div class="app-topbar-title">
        <strong>${brand.name}</strong>
        <small>${brand.sub}</small>
      </div>
    </div>`;
}

function utilsHtml() {
  return `
    <div class="app-topbar-utils">
      <button class="btn icon" data-topbar-theme type="button" title="切换主题" aria-label="切换主题">${MOON_ICON}</button>
      <button class="btn icon" data-topbar-settings type="button" title="设置" aria-label="设置">${GEAR_ICON}</button>
    </div>`;
}

function currentView() {
  const view = document.body.dataset.view;
  return VIEWS.includes(view) ? view : 'translate';
}

function fallbackTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem('paperlens.theme', next);
  } catch {
    /* 隐私模式下忽略 */
  }
}

function init() {
  for (const header of document.querySelectorAll('[data-topbar]')) {
    const view = header.dataset.topbar;
    if (!VIEWS.includes(view)) continue;
    header.insertAdjacentHTML('afterbegin', sidebarHtml(view) + NAV + brandHtml(view));
    header.insertAdjacentHTML('beforeend', utilsHtml());
  }
}

document.addEventListener('click', (ev) => {
  const themeBtn = ev.target.closest('[data-topbar-theme]');
  if (themeBtn) {
    ev.preventDefault();
    const action = handlers.get(currentView())?.theme;
    (action || fallbackTheme)();
    return;
  }
  const settingsBtn = ev.target.closest('[data-topbar-settings]');
  if (settingsBtn) {
    ev.preventDefault();
    handlers.get(currentView())?.settings?.();
  }
});

init();
