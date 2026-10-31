/**
 * 单页外壳：同一个地址承载「精读」与「知识图谱」两个视图。
 * 左上角开关切换，URL 用 ?view=kg 记录，刷新后保持。
 */
const PREF_KEY = 'paperlens.view';

function currentView() {
  const params = new URLSearchParams(location.search);
  const requested = params.get('view');
  if (requested === 'kg' || requested === 'paper') return requested;
  // 深链参数优先：论文/出处参数回精读，图谱参数进图谱
  if (params.get('paper') || params.get('fromSource') || params.get('quote')) return 'paper';
  if (params.get('graph') || params.get('source')) return 'kg';
  return localStorage.getItem(PREF_KEY) === 'kg' ? 'kg' : 'paper';
}

function setView(view, { updateUrl = true } = {}) {
  const isKg = view === 'kg';
  document.documentElement.dataset.view = isKg ? 'kg' : 'paper';
  document.querySelectorAll('[data-app-switch] [data-view]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.view === view);
  });
  const host = document.getElementById('view-kg');
  if (host) host.hidden = !isKg;
  try {
    localStorage.setItem(PREF_KEY, view);
  } catch {
    /* 隐私模式下忽略 */
  }
  if (updateUrl) {
    const url = new URL(location.href);
    if (isKg) {
      url.searchParams.set('view', 'kg');
    } else {
      url.searchParams.delete('view');
      // 切回精读时清掉图谱参数，避免刷新又回到图谱
      url.searchParams.delete('source');
      url.searchParams.delete('graph');
    }
    history.replaceState(null, '', url);
  }
  // 图谱画布在隐藏容器里宽度是 0，显示后让它按真实尺寸重新适配
  if (isKg) setTimeout(() => window.dispatchEvent(new Event('resize')), 40);
}

document.addEventListener('click', (ev) => {
  const btn = ev.target.closest('[data-app-switch] [data-view]');
  if (!btn) return;
  ev.preventDefault();
  setView(btn.dataset.view);
});

setView(currentView(), { updateUrl: false });
