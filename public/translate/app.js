import * as pdfjsLib from '/vendor/pdfjs/pdf.min.mjs';
import { extractPageBlocks, extractPageLines, buildBlocksFromGroups, buildBlocksFromSpans, toPublicBlocks, dropRunningHeaders, textInRect } from '../blocks.js';
import {
  getProject, putProject, getPdf, putPdf, delPdf, getLast, setLast, clearLast,
  listProjects, delProject, touchProject,
  prefs, prefsReady, setPref, getStoreStats, migrateBrowserData, setStoreWarnHandler,
} from './store.mjs';
import { registerTopbarActions } from '../topbar.js';
import { headingMatchScore } from '../pdfview.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.min.mjs';

/* ------------------------------------------------------------------ */
/* 常量 / 工具                                                          */
/* ------------------------------------------------------------------ */
const VIEW_ROOT = document.getElementById('view-translate');
/** 翻译视图当前是否可见：不可见时全局监听一律放行给别的视图 */
const isActive = () => Boolean(VIEW_ROOT) && !VIEW_ROOT.hidden;

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const PROJECT_FORMAT = 'papertrans-project';
const PROJECT_VERSION = 1;

// 翻译服务目录由 /api/providers 提供（与后端同一份定义）
let CATALOG = [];
const catByKey = new Map();
const FALLBACK_CATALOG = [
  { key: 'free', label: '免费自动（推荐零配置）', group: '免费', needsKey: false, fields: [], defaults: {}, hint: '' },
  { key: 'google', label: '谷歌翻译（免费）', group: '免费', needsKey: false, fields: [], defaults: {}, hint: '' },
  {
    key: 'deepseek',
    label: 'DeepSeek',
    group: 'AI 大模型',
    needsKey: true,
    fields: [
      { key: 'apiKey', label: 'API Key', placeholder: 'sk-...', type: 'password' },
      { key: 'model', label: '模型', placeholder: 'deepseek-chat', type: 'text' },
      { key: 'baseUrl', label: '接口地址', placeholder: 'https://api.deepseek.com/v1', type: 'text' },
    ],
    defaults: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    hint: '',
  },
];

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

/* ------------------------------------------------------------------ */
/* 状态                                                                */
/* ------------------------------------------------------------------ */
const state = {
  doc: null,
  name: '',
  pages: [],
  blocks: [],
  byId: new Map(),
  cardEls: new Map(),
  scale: 1.2,
  autoFit: true,
  activeId: null,
  fontSize: 15,
  cfg: loadCfg(),
  serverKey: false,
  cfgStore: loadCfgStore(),
  lastProvider: '',
  runs: 0,
  abortBatch: false,
  aiSegment: prefs.ai === '1',
  editing: false,
  splittingId: null,
  undoStack: [],
  selected: new Set(),
  // 编辑模式下的选择粒度：block=整段，line=单行
  pickMode: 'block',
  selLines: new Set(),
  linePage: 0,
  // 最后点中的框：{id, key}，key = 'main' 或 'e0'/'e1'...（续接框下标）
  focus: null,
  // 「排序」模式：每页一份草稿，存按点击顺序排好的 group 下标
  orderDraft: new Map(),
  orderPage: 0,
  // 本地工程：当前文档指纹、已保存译文（原文 → 译文）、PDF 原件副本
  docId: '',
  zhMap: new Map(),
  pdfBuf: null,
  rememberDoc: prefs.remember !== '0',
  // 左侧历史文档栏
  sidebarOpen: prefs.sidebar !== '0',
  history: [],
  historyFilter: '',
  historySig: '',
  historyConfirm: '',
  translateLocked: false,
  orderEdit: null,
  historyLoading: false,
  // 与精读页共用的侧栏目录：章节结构 + 展开状态
  outline: null,
  outlineExpanded: new Set(),
};

let projectSaveTimer = 0;

const prog = { total: 0, done: 0, active: 0, hideTimer: null };

const el = {
  pages: $('#pages'),
  pdfScroll: $('#pdfScroll'),
  cards: $('#cards'),
  cardsEmpty: $('#cardsEmpty'),
  empty: $('#empty'),
  busy: $('#busy'),
  busyText: $('#busyText'),
  fileInput: $('#fileInput'),
  pageLabel: $('#pageLabel'),
  zoomLabel: $('#zoomLabel'),
  blockCount: $('#blockCount'),
  fileChip: $('#fileChip'),
  fileName: $('#fileName'),
  progressWrap: $('#progressWrap'),
  progressBar: $('#progressBar'),
  progressText: $('#progressText'),
  split: $('#split'),
  divider: $('#divider'),
  settingsModal: $('#settingsModal'),
  autoTranslate: $('#autoTranslate'),
  followScroll: $('#followScroll'),
  aiSegment: $('#aiSegment'),
  sidebar: $('#sidebar'),
  historyList: $('#historyList'),
  historyCount: $('#historyCount'),
  historyFilter: $('#historyFilter'),
};

/* ------------------------------------------------------------------ */
/* 通用 UI                                                             */
/* ------------------------------------------------------------------ */
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = 'toast ' + kind;
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => {
    t.style.opacity = '0';
    t.style.transform = 'translateY(6px)';
    t.style.transition = 'opacity .25s, transform .25s';
    setTimeout(() => t.remove(), 260);
  }, 3200);
}

function setBusy(text) {
  if (!text) {
    el.busy.hidden = true;
    return;
  }
  el.busyText.textContent = text;
  el.busy.hidden = false;
}

function progressStart(n) {
  prog.active++;
  prog.total += n;
  if (prog.hideTimer) {
    clearTimeout(prog.hideTimer);
    prog.hideTimer = null;
  }
  el.progressWrap.hidden = false;
  progressPaint();
}
function progressTick(n) {
  prog.done += n;
  progressPaint();
}
function progressEnd() {
  prog.active--;
  if (prog.active <= 0) {
    prog.active = 0;
    prog.hideTimer = setTimeout(() => {
      el.progressWrap.hidden = true;
      prog.total = 0;
      prog.done = 0;
      progressPaint();
    }, 700);
  }
}
function progressPaint() {
  const pct = prog.total ? Math.round((prog.done / prog.total) * 100) : 0;
  el.progressBar.style.width = pct + '%';
  el.progressText.textContent = `翻译中 ${Math.min(prog.done, prog.total)}/${prog.total}`;
}

/* ------------------------------------------------------------------ */
/* 配置                                                                */
/* ------------------------------------------------------------------ */
function loadCfg() {
  const base = { provider: 'free', baseUrl: '', model: '', apiKey: '', appId: '' };
  const saved = prefs.cfg && typeof prefs.cfg === 'object' ? prefs.cfg : {};
  // 旧版把明文 Key 放在这里：只记住「有」，不把明文留在内存
  return {
    ...base,
    ...saved,
    apiKey: '',
    legacy: Boolean(saved.apiKey),
  };
}
/**
 * 保存配置：Key 交给服务端用主密码加密后写进 config.json，
 * 浏览器这边不保留任何明文（cfgStore 里 apiKey 一律清空）。
 */
async function saveCfg(cfg, passphrase = '') {
  const resp = await fetch('/api/translate/config', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider: cfg.provider, config: cfg, passphrase }),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) throw new Error(data.error || `保存失败（HTTP ${resp.status}）`);

  const clean = { ...cfg, apiKey: '' };
  state.cfg = clean;
  state.cfgStore = { ...state.cfgStore, [cfg.provider]: clean };
  state.translateLocked = Boolean(data.translate?.locked);
  applyServerTranslate({ providers: data.translate?.providers || {}, provider: cfg.provider });
  refreshEngineHint();
  return data;
}

/** 服务端配置 → 内存：只拿地址/模型/has_key，Key 永远不取回 */
function applyServerTranslate(j) {
  if (!j) return;
  const providers = j.providers || {};
  const store = { ...state.cfgStore };
  for (const [id, e] of Object.entries(providers)) {
    store[id] = {
      provider: id,
      baseUrl: e.base_url || '',
      model: e.model || '',
      appId: e.app_id || '',
      apiKey: '',
      hasKey: Boolean(e.has_key),
    };
  }
  state.cfgStore = store;
  state.translateLocked = Boolean(j.locked);
  const id = j.provider || state.cfg.provider || 'free';
  const saved = store[id];
  if (saved) state.cfg = { ...state.cfg, ...saved, provider: id };
}

function loadCfgStore() {
  const j = prefs.cfgStore;
  if (!j || typeof j !== 'object' || Array.isArray(j)) return {};
  const out = {};
  for (const [id, v] of Object.entries(j)) {
    if (!v || typeof v !== 'object') continue;
    out[id] = {
      provider: id,
      baseUrl: v.baseUrl || '',
      model: v.model || '',
      appId: v.appId || '',
      apiKey: '',
      hasKey: Boolean(v.apiKey),
      legacy: Boolean(v.apiKey),
    };
  }
  return out;
}

/** 设置按钮上显示当前引擎，便于确认"到底在用哪家" */
function refreshEngineHint() {
  const meta = catByKey.get(state.cfg.provider);
  const btn = document.querySelector('#view-translate [data-topbar-settings]');
  if (btn) btn.title = `翻译设置 · 当前：${meta ? meta.label : state.cfg.provider}`;
}
function cfgUsable() {
  const meta = catByKey.get(state.cfg.provider);
  if (!meta) return true;
  if (!meta.needsKey) return true;
  return Boolean(state.cfg.apiKey || state.cfg.appId || state.serverKey);
}

/* ------------------------------------------------------------------ */
/* 历史文档侧边栏                                                       */
/* ------------------------------------------------------------------ */
let sidebarTimer = 0;
let historyTimer = 0;
let historyPending = false;

function relTime(ts) {
  const t = Number(ts) || 0;
  if (!t) return '';
  const d = Date.now() - t;
  if (d < 60000) return '刚刚';
  const min = Math.floor(d / 60000);
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  const dt = new Date(t);
  const pad = (n) => String(n).padStart(2, '0');
  const y = dt.getFullYear() === new Date().getFullYear() ? '' : `${dt.getFullYear()}-`;
  return `${y}${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`;
}

/** 展开 / 收起左侧历史栏；persist=false 用于启动时按已存偏好还原，不重复写库 */
function applySidebar(open, { persist = true } = {}) {
  state.sidebarOpen = Boolean(open);
  document.body.classList.toggle('sidebar-collapsed', !state.sidebarOpen);
  $('#btnSidebar')?.classList.toggle('on', state.sidebarOpen);
  if (persist) setPref('sidebar', state.sidebarOpen ? '1' : '0');

  // 宽度变化会改变 PDF 的可用宽度：等过渡结束再重排浮层，必要时重新适配缩放
  clearTimeout(sidebarTimer);
  sidebarTimer = setTimeout(() => {
    positionBars();
    if (!state.pages.length) return;
    if (state.autoFit) {
      const avail = el.pdfScroll.clientWidth - 48;
      if (avail > 0) setScale(avail / state.pages[0].base.w, { fit: true });
    } else {
      renderVisible();
    }
  }, 200);

  if (state.sidebarOpen) refreshHistory();
}

/** 翻译/保存后异步刷新列表：合并短时间内的多次改动，避免反复重建 DOM */
function scheduleHistoryRefresh(delay = 900) {
  clearTimeout(historyTimer);
  historyTimer = setTimeout(() => {
    historyTimer = 0;
    if (state.sidebarOpen) refreshHistory();
  }, delay);
}

async function refreshHistory() {
  // 切换文档时可能连着触发多次：在飞的请求结束后补跑一次，保证高亮跟着最新状态
  if (state.historyLoading) {
    historyPending = true;
    return;
  }
  state.historyLoading = true;
  try {
    const list = await listProjects();
    // 服务没起来时 list 为 null：保留旧列表，别让侧栏突然空掉
    if (list) {
      state.history = list;
      renderHistory();
    }
  } finally {
    state.historyLoading = false;
    if (historyPending) {
      historyPending = false;
      refreshHistory();
    }
  }
}

function renderHistory() {
  const box = el.historyList;
  if (!box) return;
  const all = state.history;
  if (el.historyCount) el.historyCount.textContent = String(all.length);

  const q = state.historyFilter.trim().toLowerCase();
  const items = q ? all.filter((h) => (h.name || '').toLowerCase().includes(q)) : all;

  box.innerHTML = '';
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.innerHTML = q
      ? '<strong>没有匹配的文档</strong>换个关键词试试'
      : '<strong>还没有历史文档</strong>打开一篇 PDF，翻译或调整分段后<br/>就会出现在这里，下次点一下接着读';
    box.appendChild(empty);
    return;
  }

  for (const h of items) box.appendChild(historyItem(h));
}

function historyItem(h) {
  const confirming = state.historyConfirm === h.id;
  const row = document.createElement('div');
  row.className =
    'hitem' + (h.id === state.docId ? ' active' : '') + (confirming ? ' confirming' : '');
  row.dataset.id = h.id;
  row.setAttribute('role', 'listitem');
  row.tabIndex = 0;
  if (h.id === state.docId) row.setAttribute('aria-current', 'true');

  const title = document.createElement('div');
  title.className = 'hitem-title';
  title.textContent = h.name || '未命名文档';
  title.title = h.name || '';
  row.appendChild(title);

  const meta = document.createElement('div');
  meta.className = 'hitem-meta';
  const parts = [];
  if (h.pages) parts.push(`${h.pages} 页`);
  if (h.translations) parts.push(`${h.translations} 段译文`);
  const rt = relTime(h.updatedAt);
  if (rt) parts.push(rt);
  parts.forEach((text, i) => {
    if (i) {
      const sep = document.createElement('span');
      sep.className = 'sep';
      sep.textContent = '·';
      meta.appendChild(sep);
    }
    const sp = document.createElement('span');
    sp.textContent = text;
    meta.appendChild(sp);
  });
  if (!h.hasPdf) {
    const badge = document.createElement('span');
    badge.className = 'hbadge';
    badge.textContent = '无 PDF';
    badge.title = '这篇只存了分段与译文；重新打开同名 PDF 即可接着读';
    meta.appendChild(badge);
  }
  row.appendChild(meta);

  if (confirming) {
    // 二次确认：整篇的分段、译文和 PDF 一起删，误点代价太大
    const bar = document.createElement('div');
    bar.className = 'hitem-confirm';
    const tip = document.createElement('span');
    tip.textContent = '删除记录与 PDF？';
    const sp = document.createElement('span');
    sp.className = 'spacer';
    const del = document.createElement('button');
    del.className = 'btn tiny danger';
    del.textContent = '删除';
    const cancel = document.createElement('button');
    cancel.className = 'btn tiny';
    cancel.textContent = '取消';
    bar.append(tip, sp, del, cancel);
    bar.addEventListener('click', (e) => e.stopPropagation());
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteHistory(h.id);
    });
    cancel.addEventListener('click', (e) => {
      e.stopPropagation();
      state.historyConfirm = '';
      renderHistory();
    });
    row.appendChild(bar);
  } else {
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'hitem-del';
    del.textContent = '×';
    del.title = '删除这条记录与已存的 PDF';
    del.setAttribute('aria-label', `删除 ${h.name || '文档'}`);
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      state.historyConfirm = h.id;
      renderHistory();
    });
    row.appendChild(del);
  }

  row.addEventListener('click', () => {
    if (state.historyConfirm) {
      state.historyConfirm = '';
      renderHistory();
      return;
    }
    openFromHistory(h.id);
  });
  row.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      row.click();
    }
  });
  return row;
}

/** 从历史栏切换论文：读回 PDF 原件，openFile 会按指纹接上分段、顺序与译文 */
async function openFromHistory(id) {
  if (!id) return;
  if (!isActive()) {
    if (window.paperlens?.loadPaperById) {
      await window.paperlens.loadPaperById(id);
      window.paperlens.setView?.('paper');
    }
    return;
  }
  if (id === state.docId) {
    if (window.innerWidth < 900) applySidebar(false);
    return;
  }
  const item = state.history.find((h) => h.id === id);
  if (item && !item.hasPdf) {
    toast('这条记录没存 PDF 原件（关着「记住上次文档」或已被删除）。重新打开同一份 PDF 就能接回分段与译文。', 'err');
    return;
  }
  const rec = await getPdf(id);
  if (!rec?.buf) {
    toast('读不到这份 PDF，可能已被删除', 'err');
    await refreshHistory();
    return;
  }
  await openFile({ name: rec.name || `${item?.name || 'document'}.pdf`, buffer: rec.buf, id });
  await refreshHistory();
  if (window.innerWidth < 900) applySidebar(false);
}

async function deleteHistory(id) {
  const item = state.history.find((h) => h.id === id);
  state.historyConfirm = '';
  const current = id === state.docId;

  if (current) {
    // 先摘掉指针再 resetDoc：否则它会把刚删掉的记录又写回去
    clearTimeout(projectSaveTimer);
    projectSaveTimer = 0;
    state.docId = '';
    resetDoc();
    showEmptyDoc();
  }

  const done = await delProject(id);
  if (!done) {
    toast('删除失败，请确认服务端在运行', 'err');
    await refreshHistory();
    return;
  }
  await refreshHistory();
  toast(`已删除「${item?.name || '文档'}」的分段、译文与 PDF 原文`, 'ok');
}

/** 删掉当前文档后回到空状态（resetDoc 不负责大空态，避免切文档时闪一下） */
function showEmptyDoc() {
  el.empty.hidden = false;
  el.fileChip.hidden = true;
  el.fileName.textContent = '';
  el.cardsEmpty.hidden = false;
  el.blockCount.textContent = '0 段';
  el.pageLabel.textContent = '— / —';
}

/* ------------------------------------------------------------------ */
/* 打开 PDF                                                            */
/* ------------------------------------------------------------------ */
async function openFile(file) {
  if (!file) return;
  const name = file.name || 'document.pdf';
  const isPdf = /\.pdf$/i.test(name) || file.type === 'application/pdf' || Boolean(file.buffer);
  if (!isPdf) {
    toast('请选择 PDF 文件', 'err');
    return;
  }

  setBusy('正在读取文件…');
  resetDoc();

  try {
    const raw = file.buffer ? file.buffer : await file.arrayBuffer();
    // pdf.js 会把 data 转移给 worker，原 buffer 会被 detach；先留一份副本给本地持久化
    const saved = typeof raw.slice === 'function' ? raw.slice(0) : raw;
    const doc = await pdfjsLib.getDocument({
      data: raw,
      cMapUrl: '/cmaps/',
      cMapPacked: true,
      standardFontDataUrl: '/standard_fonts/',
      isEvalSupported: false,
    }).promise;

    state.doc = doc;
    state.name = name.replace(/\.pdf$/i, '');
    state.pdfBuf = saved;
    el.fileName.textContent = name;
    el.fileChip.hidden = false;

    // 1) 建页壳
    for (let i = 1; i <= doc.numPages; i++) {
      setBusy(`正在解析 PDF 结构 ${i}/${doc.numPages}`);
      const page = await doc.getPage(i);
      const vp = page.getViewport({ scale: 1 });
      state.pages.push({
        num: i,
        page,
        base: { w: vp.width, h: vp.height },
        blocks: [],
        blockEls: new Map(),
        rendered: false,
        rendering: false,
        autoTried: false,
      });
    }

    // 2) 抽取文本块（规则 / AI 两种模式）
    await buildDocumentBlocks();
    dropRunningHeaders(state.pages);

    // 3) 读服务端数据库里的工程：译文 + 分段/顺序。指纹依赖上面解析出的行文本
    // 从历史列表进来的文档已经有论文库 id，直接沿用；拖进来的新文件才按内容算指纹
    state.docId = file.id || computeDocKey();
    const proj = await getProject(state.docId);
    state.zhMap = new Map();
    for (const t of proj?.translations || []) {
      if (t && typeof t.text === 'string' && typeof t.zh === 'string' && t.zh.trim()) {
        state.zhMap.set(t.text, t.zh);
      }
    }
    const ovr = proj?.overrides || {};
    // 以前打开过：只更新时间戳，让它排到历史列表最前（不重写整包工程）
    if (proj) await touchProject(state.docId);

    // 有手动分段记录就按记录重建（优先级最高）
    let restored = 0;
    if (Object.keys(ovr).length) {
      for (const p of state.pages) {
        const st = normalizeStored(ovr[p.num]);
        if (st && p.lines && p.lines.length) {
          p.groups = st.groups;
          p.orderLocked = st.orderLocked;
          p.areas = [];
          p.groupsEdited = true;
          rebuildPage(p);
          restored++;
        }
      }
    }

    state.undoStack = [];
    applyBlocks();
    // 侧栏目录：与精读页共用同一份 outline，异步加载（失败不影响翻译主流程）
    loadTranslateOutline();
    // 分块是精读页 PDF 视图的输入，打开就先落一次，不必等翻译
    scheduleBlocksSave(600);
    renderCorrBadge();
    const restoredZh = state.blocks.filter((b) => b.status === 'done').length;
    if (restored || restoredZh) toast(`已恢复 ${restored} 页手动分段 / ${restoredZh} 段译文`, '');
    // 第一次打开这篇：先落一条记录，历史列表里立刻能看到（即使还没翻译）
    if (!proj) await saveProjectNow();
    // 记住这份 PDF：刷新后自动重开，分段和译文一起回来（都存在服务端 SQLite）
    if (state.rememberDoc && state.pdfBuf) {
      const savedOk = await putPdf(state.docId, { name, buf: state.pdfBuf, savedAt: Date.now() });
      if (savedOk) await setLast(state.docId);
      else await clearLast();
    } else {
      await clearLast();
    }

    if (!state.blocks.length) {
      setBusy(null);
      toast('这个 PDF 没有可提取的文字（可能是扫描件），暂不支持', 'err');
      return;
    }

    setBusy(null);
    el.empty.hidden = true;
    el.cardsEmpty.hidden = true;
    $('#btnTranslateAll').disabled = false;
    $('#btnExport').disabled = false;
    $('#btnExportProject').disabled = false;

    const scanned = state.pages.filter((p) => !p.blocks.length).length;
    if (scanned > 0) {
      toast(`有 ${scanned} 页未提取到文字（可能是图片扫描页）`, '');
    }
    updatePageLabel();
    await refreshHistory();
    // 载入后立即处理当前页（若开启自动翻译）
    setTimeout(maybeAutoTranslate, 120);
    if (!cfgUsable() && !state.keyHinted) {
      state.keyHinted = true;
      toast('还没配置翻译引擎：点右上角「设置」填入 API Key（或选免费接口）', 'err');
    }
  } catch (e) {
    console.error(e);
    setBusy(null);
    toast('PDF 解析失败：' + (e?.message || e), 'err');
  }
}

function resetDoc() {
  // 切换文档前把挂起改动写出去：docId 马上会被清空，不能再简单丢掉定时器
  flushProjectSave();
  if (state.doc) {
    try {
      state.doc.destroy();
    } catch {}
  }
  if (io) io.disconnect();
  state.abortBatch = true; // 停掉还在跑的翻译批次（worker 也会按 docId 自行退出）
  state.doc = null;
  state.pages = [];
  state.blocks = [];
  state.orderEdit = null;
  blocksSig = '';
  clearTimeout(blocksTimer);
  blocksTimer = 0;
  state.byId.clear();
  state.cardEls.clear();
  state.activeId = null;
  // 换文档时清掉编辑态，避免"按钮亮着但选不中任何块"
  state.editing = false;
  state.pickMode = 'block';
  state.splittingId = null;
  state.undoStack = [];
  state.selected.clear();
  state.selLines.clear();
  state.linePage = 0;
  state.orderDraft.clear();
  state.orderPage = 0;
  state.docId = '';
  state.zhMap.clear();
  state.pdfBuf = null;
  state.historyConfirm = '';
  document.body.classList.remove('editing', 'line-mode', 'area-mode', 'order-mode');
  $('#btnEdit')?.classList.remove('primary');
  const undoBtn = $('#btnUndo');
  if (undoBtn) undoBtn.hidden = true;
  const modeSw = $('#modeSwitch');
  if (modeSw) {
    modeSw.hidden = true;
    syncModeSwitch();
  }
  const lineBar = $('#lineBar');
  if (lineBar) lineBar.hidden = true;
  const selBar = $('#selBar');
  if (selBar) selBar.hidden = true;
  const orderBar = $('#orderBar');
  if (orderBar) orderBar.hidden = true;
  el.pages.innerHTML = '';
  el.cards.innerHTML = '';
  el.cards.appendChild(el.cardsEmpty);
  el.cardsEmpty.hidden = false;
  el.blockCount.textContent = '0 段';
  el.pageLabel.textContent = '— / —';
  $('#btnTranslateAll').disabled = true;
  $('#btnExport').disabled = true;
  $('#btnExportProject').disabled = true;
}

/* ------------------------------------------------------------------ */
/* 文本块构建：规则切分 / AI 分段                                        */
/* ------------------------------------------------------------------ */
function aiUsable() {
  const meta = catByKey.get(state.cfg.provider);
  return ['openai', 'gemini', 'claude'].includes(meta?.kind);
}

/** 逐页取文本并切块。AI 模式下先按规则切一份做兜底，再请模型重切，失败就用兜底 */
async function buildDocumentBlocks() {
  const useAI = Boolean(state.aiSegment) && aiUsable();

  for (const p of state.pages) {
    try {
      const tc = await p.page.getTextContent();
      if (!useAI) {
        const res = extractPageBlocks(tc, p.base.w, p.base.h);
        p.blocks = res.blocks;
        p.lines = res.lines;
        p.preBlocks = res.preBlocks;
        p.dominant = res.stats ? res.stats.dominant : 10;
        p.columns = res.columns;
        p.items = res.items || [];
        p.turned = res.turnedItems || [];
        p.gutter = res.gutter;
        if (!p.areas) p.areas = [];
        continue;
      }
      const res = extractPageLines(tc, p.base.w, p.base.h);
      p.lines = res.lines;
      p.preBlocks = res.preBlocks;
      p.dominant = res.dominant;
      p.columns = res.columns;
      p.heuristic = extractPageBlocks(tc, p.base.w, p.base.h).blocks;
      p.blocks = p.heuristic;
      p.items = res.items || [];
      p.turned = res.turnedItems || [];
      p.gutter = res.gutter;
      if (!p.areas) p.areas = [];
    } catch (e) {
      console.warn('页面文本抽取失败', p.num, e);
      p.blocks = [];
    }
  }

  if (!useAI) return;

  const queue = state.pages.filter((p) => p.lines && p.lines.length);
  const total = queue.length;
  let done = 0;
  let failed = 0;
  let aborted = false;

  const worker = async () => {
    while (queue.length && !aborted) {
      const p = queue.shift();
      setBusy(`AI 分段 ${Math.min(done + 1, total)}/${total}（失败会自动用规则兜底）`);
      try {
        const r = await fetch('/api/translate/segment', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ lines: p.lines, columns: p.columns, config: state.cfg }),
        });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) {
          const err = new Error(data.message || `分段失败 (${r.status})`);
          err.status = r.status;
          throw err;
        }
        const blocks = buildBlocksFromGroups(p.lines, data.groups, p.dominant);
        p.blocks = toPublicBlocks(blocks, p.preBlocks);
        p.aiOk = true;
      } catch (e) {
        failed++;
        p.aiError = e.message;
        p.blocks = p.heuristic || p.blocks;
        if (e.status === 400 || e.status === 401) {
          aborted = true;
          toast(e.message, 'err');
        }
      } finally {
        done++;
      }
    }
  };

  await Promise.all([worker(), worker()]);
  setBusy(null);
  if (failed && !aborted) toast(`${failed} 页 AI 分段失败，已用规则切分`, 'err');
}

/** 过滤掉不该翻译的块，编号，重建版面与卡片 */
function applyBlocks() {
  // 重组版面时把译文接回去：优先用本地工程里保存的，再叠加内存里刚翻好的
  const zhByText = new Map(state.zhMap);
  for (const b of state.blocks) if (b.zh) zhByText.set(b.text, b.zh);

  state.blocks = [];
  state.byId.clear();
  state.annoCount = 0;
  state.formulaCount = 0;

  for (const p of state.pages) {
    const all = (p.blocks || []).map((b) => ({ ...b, page: p.num, status: 'idle', zh: null, err: null }));
    p.rawBlocks = all;// 未过滤的原始块，手动分段以它为准
    // 图内标注、独立公式不进右栏（逐条翻译没有意义），只保留正文、标题、图注
    const keep = all.filter((b) => b.kind !== 'annotation' && b.kind !== 'formula');
    state.annoCount += all.filter((b) => b.kind === 'annotation').length;
    state.formulaCount += all.filter((b) => b.kind === 'formula').length;
    p.blocks = keep;

    // 首次加载的块来自规则切分，没有顺序索引；按 from/to 对回 groups
    if (keep.some((b) => b.gIndex == null)) {
      const gs = groupsOf(p);
      const byKey = new Map();
      gs.forEach((g, gi) => {
        if (g.area || !g.spans || !g.spans.length) return;
        const f = Math.min(...g.spans.map((sp) => sp[0]));
        const t = Math.max(...g.spans.map((sp) => sp[1]));
        byKey.set(f + '-' + t, gi);
      });
      for (const b of keep) {
        if (b.gIndex == null) b.gIndex = byKey.has(b.from + '-' + b.to) ? byKey.get(b.from + '-' + b.to) : -1;
      }
    }

    keep.forEach((b, i) => {
      b.id = `p${p.num}b${i}`;
      b.idx = i;
      if (!b.zh && zhByText.has(b.text)) {
        b.zh = zhByText.get(b.text);
        b.status = 'done';
      }
      state.blocks.push(b);
      state.byId.set(b.id, b);
    });
  }

  // 译文库只留当前段落用得上的：改过分段后，旧段落的译文不该一直堆积
  const live = new Map();
  for (const b of state.blocks) if (b.zh) live.set(b.text, b.zh);
  state.zhMap = live;

  buildLayout();
  buildCards();
}

/* ------------------------------------------------------------------ */
/* 手动分段：左侧 PDF 上圈选/点选，多块合成一段                          */
/* ------------------------------------------------------------------ */
function docChars() {
  return state.pages.reduce(
    (n, p) => n + (p.lines ? p.lines.reduce((m, l) => m + l.text.length, 0) : 0),
    0
  );
}

function computeDocKey() {
  // 用"行"的总字数做指纹：分组怎么改，这个值都不变
  const str = `${state.name}|${state.pages.length}|${docChars()}`;
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return 'k' + Math.abs(h).toString(36);
}

function docKey() {
  return state.docId || computeDocKey();
}

/** 段落分组：一个 group 可以由不连续的几段行区间组成（被公式隔开的两半） */
/**
 * 段落分组。数组顺序 = 段落顺序（用户可手动调整）。
 * 首次推导时按视觉位置排一次，之后不再自动重排。
 */
function groupsOf(p) {
  if (!p.groups) {
    // 顺序照抄原始切分结果（已经是阅读顺序）；区域块按纵向位置插进去
    p.groups = (p.rawBlocks || p.blocks || [])
      .filter((b) => b.from && b.to && b.kind !== 'annotation')
      .map((b) => ({ spans: [[b.from, b.to]], type: b.kind }));
    for (const a of p.areas || []) {
      if (a && a.text) insertGroupByY(p, { area: { ...a }, type: a.kind || 'body', lines: a.lines });
    }
    p.areas = [];
  }
  return p.groups;
}

/** 组的纵向位置，用于插入新段 */
function groupY(p, g) {
  if (g.area) return g.area.yTop || 0;
  if (!g.spans || !g.spans.length) return 0;
  const first = Math.min(...g.spans.map((sp) => sp[0]));
  const ln = p.lines && p.lines[first - 1];
  return ln ? ln.yTop : 0;
}

/** 按视觉位置把新段插进顺序里；手动定过序的页只追加到末尾 */
function insertGroupByY(p, g) {
  const gs = groupsOf(p);
  // 用户已经手动指定过本页顺序，任何"按坐标插回"都会把顺序打乱。
  // 新段一律排最后，位置由用户自己再调（或用「↑ 上移」挪）。
  if (p.orderLocked) {
    gs.push(g);
    return gs.length - 1;
  }
  const y = groupY(p, g);
  let idx = gs.findIndex((x) => groupY(p, x) < y);
  if (idx === -1) idx = gs.length;
  gs.splice(idx, 0, g);
  return idx;
}

/** 合并段里一个片段占的框：有行区间就按文字算，没有就用合并时记下的框 */
function partBoxes(part) {
  const pg = state.pages[part.page - 1];
  const out = [];
  for (const sp of part.spans || []) {
    const bx = pg && linesBox(pg, sp);
    // 不标 span：区域段的框拖动时按「额外框」处理，不去改行区间
    if (bx) out.push({ page: part.page, ...bx });
  }
  if (!out.length && part.box) out.push({ page: part.page, ...part.box });
  return out;
}

/** 老数据没存 area.parts：从 spans / removed 记录里还原片段（一块一条） */
function areaPartsFromSpans(hostPage, g) {
  const parts = [];
  const add = (pageNo, spans, type) => {
    const pg = state.pages[pageNo - 1];
    if (!pg || !Array.isArray(spans) || !spans.length) return;
    for (const sp of spans) {
      const blk = buildBlocksFromSpans(pg.lines, [{ spans: [sp], type }], pg.dominant || 10)[0];
      if (blk) parts.push({ page: pageNo, spans: [[...sp]], text: blk.text });
    }
  };
  // 宿主自己的片段：优先 spans，老数据只留了 lines
  const hostSpans =
    Array.isArray(g.spans) && g.spans.length
      ? g.spans
      : Array.isArray(g.lines) && g.lines.length
        ? normRanges(g.lines)
        : [];
  add(hostPage.num, hostSpans, g.type);
  for (const r of g.removed || []) for (const gg of r.groups || []) add(r.page, gg.spans, gg.type);
  return parts;
}

/** 拿到这一段的分片：片段来自实际存下的 spans，所以可以直接接管（正文先不改） */
function adoptAreaParts(hostPage, g) {
  if (Array.isArray(g.area.parts) && g.area.parts.length > 1) return g.area.parts;
  const parts = areaPartsFromSpans(hostPage, g);
  if (parts.length < 2) return null;
  g.area.parts = parts;
  return parts;
}

function rebuildPage(p) {
  if (!p.lines || !p.lines.length) return;

  // 合并来的区域段：一块一个框（老数据只存了整体 bbox，会少画好几块）
  for (const g of p.groups || []) {
    if (!g.area || g.area.boxEdited) continue;
    if (!Array.isArray(g.removed) || !g.removed.length) continue;
    const parts = adoptAreaParts(p, g);
    if (!parts || parts.length < 2) continue;
    const boxes = parts.flatMap(partBoxes);
    if (boxes.length < 2) continue;
    const [main, ...rest] = boxes;
    g.area.x0 = main.x0;
    g.area.x1 = main.x1;
    g.area.yTop = main.yTop;
    g.area.yBottom = main.yBottom;
    g.area.extraBoxes = rest;
  }

  const blocks = buildBlocksFromSpans(p.lines, p.groups, p.dominant || 10);
  const gs = p.groups || [];

  // 一个段落由多段不连续的行组成时，每段各画一个框；
  // 否则整体 bbox 会把中间那段不相干的内容也框进去。
  for (const b of blocks) {
    const g = gs[b.gIndex];
    if (!g || g.area || !g.spans || g.spans.length <= 1) continue;
    // 合并段（≥2 个片段）一律按片段各画一个框。
    // g.box 只是用户拖动时留下的一个整体外框，拿它当主框会把几截片段糊成一块，
    // 看不出这段其实由哪几处合成 —— 那正是合并后「少了几块」的原因。
    const boxes = g.spans.map((sp) => linesBox(p, sp)).filter(Boolean);
    if (boxes.length <= 1) continue;
    b.x0 = boxes[0].x0;
    b.x1 = boxes[0].x1;
    b.yTop = boxes[0].yTop;
    b.yBottom = boxes[0].yBottom;
    b.extraBoxes = boxes.slice(1).map((bx) => ({ page: p.num, ...bx, span: true }));
  }

  p.blocks = toPublicBlocks(blocks, p.preBlocks || []);
}

/** 若干行的包围盒 */
function linesBox(p, span) {
  const [a, b] = span;
  const seg = (p.lines || []).slice(a - 1, b);
  if (!seg.length) return null;
  return {
    x0: Math.min(...seg.map((l) => l.x0)),
    x1: Math.max(...seg.map((l) => l.x1)),
    yTop: Math.max(...seg.map((l) => l.yTop)),
    yBottom: Math.min(...seg.map((l) => l.yBottom)),
  };
}

/** 兼容三种历史格式：{from,to} 数组 / groups 数组 / {groups,areas} */
function normalizeStored(raw) {
  if (Array.isArray(raw)) return { groups: normalizeGroupsArray(raw), orderLocked: false };
  if (raw && typeof raw === 'object') {
    const gs = normalizeGroupsArray(raw.groups);
    // 旧版本把区域块单存，这里并进 groups
    for (const a of Array.isArray(raw.areas) ? raw.areas : []) {
      if (a && a.text && Number.isFinite(a.yTop)) gs.push({ area: { ...a }, type: a.kind || 'body', lines: a.lines });
    }
    // 手动指定过顺序的页：后续新建段不许再按视觉位置插回去
    return { groups: gs, orderLocked: Boolean(raw.orderLocked) };
  }
  return null;
}

function normalizeGroupsArray(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const g of list) {
    if (!g) continue;
    if (g.area && g.area.text) {
      out.push({
        area: { ...g.area },
        type: g.type || 'body',
        spans: Array.isArray(g.spans) ? g.spans.map((x) => [+x[0], +x[1]]) : undefined,
        lines: g.lines,
        groupsBefore: g.groupsBefore,
        pages: g.pages,
        removed: g.removed,
      });
      continue;
    }
    if (Array.isArray(g.spans)) {
      out.push({ spans: g.spans.map((x) => [+x[0], +x[1]]), type: g.type || 'body', box: g.box });
    } else if (g.from && g.to) {
      out.push({ spans: [[+g.from, +g.to]], type: g.type || 'body', box: g.box });
    }
  }
  return out;
}

function collectOverrides() {
  // 只存用户动过的页：没动过的页继续跟随规则切分（规则改进后能自动生效）
  const out = {};
  for (const p of state.pages) {
    if (!p.groupsEdited) continue;
    out[p.num] = { groups: p.groups || [], orderLocked: Boolean(p.orderLocked) };
  }
  return out;
}

function saveOverrides() {
  // 分段/顺序改动直接写服务端 SQLite，浏览器不再存任何副本，也就没有配额问题。
  // 编辑是低频主动操作，立即落库而不是防抖：改完立刻刷新也不会丢。
  saveProjectNow();
  // 精读页的 PDF 热区读的是同一份分块，分段改完也要跟着更新。
  // 这里防抖：拖动框会连续触发，等手停下来再写一次。
  scheduleBlocksSave(600);
}

/** 当前文档的完整工程数据（不含 PDF 二进制，也不含 API Key） */
function projectData(overrides = collectOverrides()) {
  const zh = new Map(state.zhMap);
  for (const b of state.blocks) if (b.zh) zh.set(b.text, b.zh);
  return {
    name: state.name,
    pages: state.pages.length,
    chars: docChars(),
    overrides,
    translations: [...zh].map(([text, zhText]) => ({ text, zh: zhText })),
    savedAt: Date.now(),
  };
}

/** 把整包工程数据写进服务端 SQLite，失败由 store 层统一提示 */
async function saveProjectNow() {
  if (!state.docId) return true;
  const ok = await putProject(state.docId, projectData());
  // 顺带刷新历史列表里的「N 段译文」和排序（防抖，避免每批翻译都重建 DOM）
  if (ok) scheduleHistoryRefresh();
  return ok;
}

function scheduleProjectSave() {
  if (!state.docId) return;
  clearTimeout(projectSaveTimer);
  projectSaveTimer = setTimeout(() => {
    projectSaveTimer = 0;
    saveProjectNow();
  }, 300);
  scheduleBlocksSave(1500);
}

/* ------------------------------------------------------------------ */
/* 分块落库：精读页的 PDF 视图直接消费这一份，                        */
/* 所以「点概念高亮的那块」就是「翻译卡片里那段」。                      */
/* ------------------------------------------------------------------ */
let blocksTimer = 0;
let blocksSig = '';

/** 块坐标是 PDF 用户空间（原点左下），页码转成 0 基，order 用全局阅读顺序 */
function blocksPayload() {
  const list = state.blocks
    .filter((b) => b && b.text)
    .slice()
    .sort((a, b) => Number(a.page || 1) - Number(b.page || 1) || Number(a.idx || 0) - Number(b.idx || 0));
  return list.map((b, i) => ({
    page: Math.max(0, Number(b.page || 1) - 1),
    order: i,
    text: String(b.text),
    x: Number(b.x) || 0,
    y: Number(b.y) || 0,
    w: Math.max(1, Number(b.w) || 1),
    h: Math.max(1, Number(b.h) || 1),
    kind: b.kind || 'body',
    // 合并段在这里占了好几块：一并写进去，精读页才是同样几个框
    extraBoxes: Array.isArray(b.extraBoxes) && b.extraBoxes.length
      ? b.extraBoxes.map((eb) => ({
          page: Math.max(0, Number(eb.page || b.page) - 1),
          x0: Number(eb.x0) || 0,
          x1: Number(eb.x1) || 0,
          yTop: Number(eb.yTop) || 0,
          yBottom: Number(eb.yBottom) || 0,
        }))
      : null,
  }));
}

/** 只比结构，不比译文：翻译一段不该触发一次分块写入 */
const blocksSignature = (list) => {
  const s = JSON.stringify(list);
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `${s.length}:${h}`;
};

async function saveBlocksNow() {
  if (!state.docId || !state.blocks.length) return false;
  const blocks = blocksPayload();
  const sig = blocksSignature(blocks);
  if (sig === blocksSig) return true;
  try {
    const res = await fetch('/api/paper/blocks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: state.docId, hash: state.docId, blocks, generator: 'extract/4.10' }),
    });
    if (!res.ok) return false;
    blocksSig = sig;
    return true;
  } catch {
    return false;
  }
}

function scheduleBlocksSave(delay = 1200) {
  if (!state.docId) return;
  clearTimeout(blocksTimer);
  blocksTimer = setTimeout(() => {
    blocksTimer = 0;
    saveBlocksNow();
  }, delay);
}

/** 一批翻译结束 / 页面隐藏 / 切换文档时立即落盘，不等防抖 */
function flushProjectSave() {
  if (blocksTimer) {
    clearTimeout(blocksTimer);
    blocksTimer = 0;
    saveBlocksNow();
  }
  if (!state.docId) return;
  clearTimeout(projectSaveTimer);
  projectSaveTimer = 0;
  saveProjectNow();
}

function loadCorrections() {
  return Array.isArray(prefs.corrections) ? prefs.corrections : [];
}

function logCorrection(action, p, merged) {
  const first = merged.spans[0];
  const last = merged.spans[merged.spans.length - 1];
  const head = p.lines[first[0] - 1];
  const tail = p.lines[last[1] - 1];
  if (!head || !tail) return;
  const list = loadCorrections();
  list.push({
    at: Date.now(),
    doc: docKey(),
    name: (state.name || '').slice(0, 60),
    action,
    page: p.num,
    feat: {
      lines: merged.spans.reduce((n, [a, b]) => n + (b - a + 1), 0),
      spans: merged.spans.length,
      sizeHead: head.size,
      sizeTail: tail.size,
      colHead: head.col,
      colTail: tail.col,
      tailEndsTerminal: /[.!?。！？:：;；,，)\]）】"'”’]$/.test(tail.text.trim()),
      headStartsLower: /^[a-z(]/.test(head.text),
    },
  });
  setPref('corrections', list.slice(-500));
  renderCorrBadge();
}

function renderCorrBadge() {
  const n = loadCorrections().length;
  const badge = $('#corrBadge');
  if (!badge) return;
  badge.hidden = n === 0;
  badge.textContent = `已修正 ${n} 处`;
  badge.title = '这些修正记录可以导出，用来继续调整切分规则';
}

function exportCorrections() {
  const list = loadCorrections();
  if (!list.length) return;
  const blob = new Blob([JSON.stringify(list, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'papertrans-corrections.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`已导出 ${list.length} 条修正记录`, 'ok');
}

/** 多个页面共用一张撤销快照：跨页操作必须一次回退，否则两页会不一致 */
function snapshotUndoMulti(pages) {
  state.undoStack = state.undoStack || [];
  state.undoStack.push({
    multi: pages.map((p) => ({
      page: p.num,
      groups: JSON.parse(JSON.stringify(groupsOf(p))),
      blocks: JSON.parse(JSON.stringify(p.blocks || [])),
      groupsEdited: Boolean(p.groupsEdited),
      orderLocked: Boolean(p.orderLocked),
    })),
  });
  if (state.undoStack.length > 60) state.undoStack.shift();
}

function snapshotUndo(p) {
  state.undoStack = state.undoStack || [];
  // 连块本身一起存：撤销时直接还原，避免"用分组重建"产生细微的文本差异
  state.undoStack.push({
    page: p.num,
    groups: JSON.parse(JSON.stringify(groupsOf(p))),
    areas: JSON.parse(JSON.stringify(p.areas || [])),
    blocks: JSON.parse(JSON.stringify(p.blocks || [])),
    groupsEdited: Boolean(p.groupsEdited),
    orderLocked: Boolean(p.orderLocked),
  });
  if (state.undoStack.length > 60) state.undoStack.shift();
}

function applyEdit(p) {
  // 版面会整体重建，行元素随之替换，选择状态必须清空
  clearLineSel(true);
  p.groupsEdited = true;
  rebuildPage(p);
  saveOverrides();
  const keepY = el.pdfScroll.scrollTop;
  const keepCards = el.cards.scrollTop;
  applyBlocks();
  el.pdfScroll.scrollTop = keepY;
  el.cards.scrollTop = keepCards;
  updatePageLabel();
  renderCorrBadge();
  renderSelBar();
  renderLineBar();
  renderOrderBar();   // 版面重建后，排序面板与序号标记要跟着重画
  refreshOrderMarks();
}

/** 找到块对应的 group 下标（先信 groupIndex，再用区间兜底） */
/* ------------------------------------------------------------------ */
/* 合并段的内部顺序：一次合并会留下多个片段，这里可以逐个上移 / 下移      */
/* ------------------------------------------------------------------ */

/** 片段（行号区间）能读到的文字，用作列表预览 */
function spanText(p, span) {
  const [a, b] = span || [];
  const parts = [];
  for (let i = a; i <= b; i += 1) {
    const ln = p?.lines?.[i - 1];
    if (ln?.text) parts.push(ln.text);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * 合并段的片段列表。两种合并走同一套 UI：
 * - 同页合并：pieces 来自 group.spans（行号区间）
 * - 跨页 / 含框选段的合并：pieces 来自 area.parts（每段一条记录）
 */
function mergeParts(p, g) {
  if (!g) return null;
  if (g.area) {
    const parts = Array.isArray(g.area.parts) ? g.area.parts : null;
    return parts && parts.length > 1 ? parts.map((x) => ({ ...x })) : null;
  }
  if (!Array.isArray(g.spans) || g.spans.length < 2) return null;
  return g.spans.map((sp) => ({ spans: [...sp], text: spanText(p, sp) }));
}

/** 这一段由几块合成；≤1 说明没什么可调的 */
function mergePartCount(b) {
  const p = state.pages[b.page - 1];
  const g = p ? groupsOf(p)[b.gIndex] : null;
  const parts = mergeParts(p, g);
  return parts ? parts.length : 0;
}

function openMergeOrder(block) {
  const p = state.pages[block.page - 1];
  const g = p ? groupsOf(p)[block.gIndex] : null;
  const items = mergeParts(p, g);
  if (!items) {
    toast('这一段只有一个片段，不需要调整顺序');
    return;
  }
  items.forEach((it, i) => {
    it.key = it.spans ? it.spans.join('-') : `${it.page}:${it.text.slice(0, 24)}:${i}`;
  });
  state.orderEdit = {
    page: block.page,
    gIndex: block.gIndex,
    area: Boolean(g.area),
    items,
    orig: items.map((it) => it.key).join('|'),
  };
  renderMergeOrder();
  $('#mergeOrderModal').hidden = false;
}

function renderMergeOrder() {
  const st = state.orderEdit;
  const box = $('#mergeOrderList');
  if (!st || !box) return;
  box.innerHTML = '';

  st.items.forEach((item, i) => {
    const row = document.createElement('div');
    row.className = 'order-row';

    const no = document.createElement('span');
    no.className = 'order-no';
    no.textContent = String(i + 1);

    const text = document.createElement('span');
    text.className = 'order-text';
    const full = String(item.text || '').replace(/\s+/g, ' ').trim();
    text.textContent = full.slice(0, 160) || '（空片段）';
    text.title = full;

    const up = document.createElement('button');
    up.className = 'mini always';
    up.type = 'button';
    up.textContent = '↑';
    up.title = '往前挪';
    up.disabled = i === 0;
    up.onclick = () => moveMergeSpan(i, -1);

    const down = document.createElement('button');
    down.className = 'mini always';
    down.type = 'button';
    down.textContent = '↓';
    down.title = '往后挪';
    down.disabled = i === st.items.length - 1;
    down.onclick = () => moveMergeSpan(i, 1);

    row.append(no, text, up, down);
    box.appendChild(row);
  });

  const hint = $('#mergeOrderHint');
  if (hint) {
    hint.textContent = `这一段由 ${st.items.length} 个片段合并而成；用 ↑ ↓ 调整先后，应用后只影响这一段（可撤销）。`;
  }
}

function moveMergeSpan(i, delta) {
  const st = state.orderEdit;
  if (!st) return;
  const j = i + delta;
  if (j < 0 || j >= st.items.length) return;
  const [item] = st.items.splice(i, 1);
  st.items.splice(j, 0, item);
  renderMergeOrder();
}

function closeMergeOrder() {
  state.orderEdit = null;
  const modal = $('#mergeOrderModal');
  if (modal) modal.hidden = true;
}

function applyMergeOrder() {
  const st = state.orderEdit;
  if (!st) return;
  const p = state.pages[st.page - 1];
  const g = p ? groupsOf(p)[st.gIndex] : null;
  if (!p || !g) {
    closeMergeOrder();
    return;
  }

  const moved = st.items.map((it) => it.key).join('|') !== st.orig;
  const items = st.items;
  const area = st.area;
  const target = { page: st.page, gIndex: st.gIndex };
  closeMergeOrder();
  if (!moved) return;

  snapshotUndo(p);
  if (area) {
    if (!g.area) return;
    // 区域段的正文是合并时固化下来的，重排后要按新顺序重新拼
    g.area.parts = items.map(({ key, ...part }) => part);
    g.area.text = joinPartText(g.area.parts);
    g.area.extraBoxes = [];
    delete g.area.boxEdited;
  } else {
    g.spans = items.map((it) => [...it.spans]);
  }
  p.groupsEdited = true;
  applyEdit(p);

  const nb = state.blocks.find((b) => b.page === target.page && b.gIndex === target.gIndex);
  if (nb) {
    setActive(nb.id);
    state.cardEls.get(nb.id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }
  toast('已更新这一段内部的顺序', 'ok');
}

function groupIdxOf(p, block) {
  const gs = groupsOf(p);
  const gi = block.gIndex;
  if (gi == null || gi < 0 || gi >= gs.length) return -1;
  const g = gs[gi];
  if (g.area) return block.isArea ? gi : -1;
  if (block.isArea) return -1;
  const f = Math.min(...g.spans.map((sp) => sp[0]));
  const t = Math.max(...g.spans.map((sp) => sp[1]));
  return f === block.from && t === block.to ? gi : -1;
}

/** 把若干块合并成一段（只并区间，中间的公式/图注不受影响） */
function mergeBlocks(blocks) {
  const list = blocks.filter(Boolean).sort((a, b) => a.page - b.page || (a.gIndex ?? 0) - (b.gIndex ?? 0));
  if (list.length < 2) {
    toast('至少选两段再合并', 'err');
    return;
  }
  const pages = [...new Set(list.map((b) => b.page))];
  if (list.some((b) => b.isArea)) {
    mergeWithArea(list, pages);
    return;
  }
  if (pages.length > 1) {
    mergeAcrossPages(list, pages);
    return;
  }

  const p = state.pages[list[0].page - 1];
  const gs = groupsOf(p);
  const allIdxs = [...new Set(list.map((b) => groupIdxOf(p, b)))].filter((i) => i >= 0);
  const idxs = allIdxs.filter((i) => !gs[i].area).sort((a, b) => a - b);
  if (idxs.length < 2) {
    toast('至少选两段普通段落才能合并', 'err');
    return;
  }

  snapshotUndo(p);
  const merged = { spans: [], type: 'body' };
  // idxs 是按「段落数组顺序」＝用户看到的先后排的，片段必须照这个顺序拼接。
  // 以前这里按行号再排一次，手动排过序的页会出现"第一段跑到第三段去"。
  for (const i of idxs) {
    merged.spans.push(...gs[i].spans.map((s) => [...s]));
    if (gs[i].type !== 'body' && merged.type === 'body') merged.type = gs[i].type;
  }
  logCorrection('merge', p, merged);

  const first = idxs[0];
  for (const i of idxs.slice(1).sort((a, b) => b - a)) gs.splice(i, 1);
  gs[first] = merged;

  state.selected.clear();
  applyEdit(p);
}

/**
 * 合并时把参与的各段落记成「片段」：文字 + 位置。
 * 顺序编辑、一块一个框、撤销后重建都靠它，不再依赖整体 bbox。
 */
function mergePartsFromBlocks(list) {
  const out = [];
  for (const b of list) {
    const spans = Array.isArray(b.spans) && b.spans.length ? b.spans.map((sp) => [...sp]) : null;
    if (!spans) {
      // 区域段没有行区间，整段算一块
      const text = String(b.text || '').trim();
      if (text) out.push({ page: b.page, spans: null, box: { x0: b.x, x1: b.x + b.w, yTop: b.y, yBottom: b.y - b.h }, text });
      continue;
    }
    // 一个段落自己占好几块时，按块拆开：合并三段就该在顺序里看到三条
    for (const sp of spans) {
      const p = state.pages[b.page - 1];
      const blk = p ? buildBlocksFromSpans(p.lines, [{ spans: [sp] }], p.dominant || 10)[0] : null;
      if (blk) out.push({ page: b.page, spans: [[...sp]], text: blk.text });
    }
  }
  return out;
}

/** 按顺序把片段拼成一段：跨行断词（结尾连字符）照原文接回去 */
function joinPartText(parts) {
  let text = '';
  for (const it of parts) {
    const t = String(it.text || '').trim();
    if (!t) continue;
    if (!text) text = t;
    else if (/-$/.test(text) && /^[a-z]/.test(t)) text = text.slice(0, -1) + t;
    else text += ' ' + t;
  }
  return text;
}

/**
 * 一个段落实际占的位置：合并过的段落按片段拆成多个框。
 * 只取整体 bbox 会把中间的空隙一起框进去，也会让「三段合并」看起来只有一块。
 */
function pieceBoxes(b) {
  const p = state.pages[b.page - 1];
  const out = [];
  for (const sp of Array.isArray(b.spans) ? b.spans : []) {
    const bx = p && linesBox(p, sp);
    if (bx) out.push({ page: b.page, ...bx });
  }
  if (!out.length) out.push({ page: b.page, x0: b.x, x1: b.x + b.w, yTop: b.y, yBottom: b.y - b.h });
  return out;
}

/**
 * 跨页合并：文本按页序拼成一段，留在第一页那一段的位置上；
 * 其余页对应的段落从各自的分组里移除（否则同一段文字会出现两次）。
 * 被移除的段落结构记在宿主上，删掉合并段时能原样还回去。
 */
/**
 * 含「按区域」段的合并：文字一律固化成区域文本（各段文本按顺序拼接），
 * 放在第一段的框里；其它段从各自页的分组里移除，行也一并让出。
 */
function mergeWithArea(list, pages) {
  const host = list[0];
  const hostPage = state.pages[host.page - 1];
  const hostGs = groupsOf(hostPage);
  const hostGroup = hostGs[host.gIndex];
  if (!host || !hostGroup) return;

  snapshotUndoMulti(pages.map((n) => state.pages[n - 1]));

  const partsNew = mergePartsFromBlocks(list.slice(1));
  const partsOld = hostGroup.area && Array.isArray(hostGroup.area.parts) ? hostGroup.area.parts : null;
  const parts = partsOld ? [...partsOld, ...partsNew] : mergePartsFromBlocks(list);
  const text = joinPartText(parts);
  const removed = [];

  for (const b of list.slice(1)) {
    const p = state.pages[b.page - 1];
    const gs = groupsOf(p);
    const g = gs[b.gIndex];
    if (!g) continue;
    if (g.spans && g.spans.length) {
      removed.push({ page: b.page, groups: [{ spans: g.spans.map((sp) => [...sp]), type: g.type }] });
    }
    const i = gs.indexOf(g);
    if (i >= 0) gs.splice(i, 1);
    p.groupsEdited = true;
    rebuildPage(p);
  }

  const lines = [];
  if (hostGroup.spans) for (const [a, b] of hostGroup.spans) for (let i = a; i <= b; i++) lines.push(i);
  else if (Array.isArray(hostGroup.lines)) lines.push(...hostGroup.lines);

  // 主框只放第一块，其余每块单独一个框（跨栏、跨段合并都能看出由哪几截组成）
  let box;
  const extra = [];
  if (hostGroup.area) {
    box = { x0: hostGroup.area.x0, x1: hostGroup.area.x1, yTop: hostGroup.area.yTop, yBottom: hostGroup.area.yBottom };
    extra.push(...(hostGroup.area.extraBoxes || []));
  } else {
    const hostBoxes = pieceBoxes(host);
    box = hostBoxes[0] || { x0: host.x, x1: host.x + host.w, yTop: host.y, yBottom: host.y - host.h };
    extra.push(...hostBoxes.slice(1));
  }
  for (const b of list.slice(1)) extra.push(...pieceBoxes(b));

  hostGroup.area = {
    text,
    ...box,
    size: (hostGroup.area && hostGroup.area.size) || host.size || 10,
    extraBoxes: extra,
    parts,
  };
  hostGroup.lines = lines;
  hostGroup.pages = pages;
  hostGroup.removed = removed;
  delete hostGroup.box;
  hostPage.groupsEdited = true;
  rebuildPage(hostPage);

  saveOverrides();
  state.selected.clear();

  const keepY = el.pdfScroll.scrollTop;
  const keepCards = el.cards.scrollTop;
  applyBlocks();
  el.pdfScroll.scrollTop = keepY;
  el.cards.scrollTop = keepCards;
  updatePageLabel();
  renderCorrBadge();
  renderSelBar();
  toast(`已合并 ${list.length} 段（含按区域的段，文字合并到 P${host.page}）`, 'ok');
}

function mergeAcrossPages(list, pages) {
  const hostPageNo = pages[0];
  const host = list.find((b) => b.page === hostPageNo);
  const hostPage = state.pages[hostPageNo - 1];
  if (!host || !hostPage) return;

  const hostGs = groupsOf(hostPage);
  const hostGroup = hostGs[host.gIndex];
  if (!hostGroup || hostGroup.area) return;

  // 两页共用一张快照：撤销必须一起回退
  snapshotUndoMulti(pages.map((pno) => state.pages[pno - 1]));

  const parts = mergePartsFromBlocks(list);
  const text = joinPartText(parts);
  const removed = [];

  for (const pno of pages.slice(1)) {
    const p = state.pages[pno - 1];
    const gs = groupsOf(p);
    const idxs = list
      .filter((b) => b.page === pno)
      .map((b) => b.gIndex)
      .filter((i) => i >= 0 && gs[i] && !gs[i].area);
    if (!idxs.length) continue;
    removed.push({
      page: pno,
      groups: idxs.map((i) => ({ spans: gs[i].spans.map((sp) => [...sp]), type: gs[i].type })),
    });
    for (const i of [...new Set(idxs)].sort((a, b) => b - a)) gs.splice(i, 1);
    p.groupsEdited = true;
    rebuildPage(p);
  }

  const spans = hostGroup.spans ? hostGroup.spans.map((sp) => [...sp]) : [];
  const lines = [];
  for (const [a, b] of spans) for (let i = a; i <= b; i++) lines.push(i);

  // 主框只负责第一块，剩下的每一块都单独画：三段合并就该看到三个框
  const hostBoxes = pieceBoxes(host);
  const main = hostBoxes[0] || { page: host.page, x0: host.x, x1: host.x + host.w, yTop: host.y, yBottom: host.y - host.h };
  const extra = hostBoxes.slice(1);
  for (const b of list.slice(1)) extra.push(...pieceBoxes(b));

  hostGroup.area = {
    text,
    x0: main.x0,
    x1: main.x1,
    yTop: main.yTop,
    yBottom: main.yBottom,
    size: host.size || 10,
    extraBoxes: extra,
    parts,
  };
  hostGroup.lines = lines;
  hostGroup.pages = pages;
  hostGroup.removed = removed;
  hostPage.groupsEdited = true;
  rebuildPage(hostPage);

  saveOverrides();
  state.selected.clear();

  const keepY = el.pdfScroll.scrollTop;
  const keepCards = el.cards.scrollTop;
  applyBlocks();
  el.pdfScroll.scrollTop = keepY;
  el.cards.scrollTop = keepCards;
  updatePageLabel();
  renderCorrBadge();
  renderSelBar();
  toast(`已跨页合并（P${pages.join(' + P')}），文字落在 P${hostPageNo}，其余页那几行已并入`, 'ok');
}

/** 删掉跨页段时，把其它页被移除的段落还回去 */
function restoreCrossPage(g) {
  for (const r of g.removed || []) {
    const rp = state.pages[r.page - 1];
    if (!rp) continue;
    for (const gg of r.groups) {
      if (gg.spans && gg.spans.length) insertGroupByY(rp, { spans: gg.spans.map((sp) => [...sp]), type: gg.type || 'body' });
    }
    rp.groupsEdited = true;
    rebuildPage(rp);
  }
}

function mergeSelected() {
  const blocks = [...state.selected].map((id) => state.byId.get(id)).filter(Boolean);
  mergeBlocks(blocks);
}

/** 删除选中的分段（对应的行不再出现在译文里，也不再画框） */
function deleteSelected() {
  const blocks = [...state.selected].map((id) => state.byId.get(id)).filter(Boolean);
  if (!blocks.length) {
    toast('先选中要删除的分段', 'err');
    return;
  }

  const byPage = new Map();
  for (const b of blocks) {
    if (!byPage.has(b.page)) byPage.set(b.page, []);
    byPage.get(b.page).push(b);
  }

  let removed = 0;
  const dirty = [];
  for (const [page, list] of byPage) {
    const p = state.pages[page - 1];
    const gs = groupsOf(p);
    const idxs = [...new Set(list.map((b) => groupIdxOf(p, b)))].filter((i) => i >= 0);
    if (!idxs.length) continue;
    snapshotUndo(p);

    const areaIdxs = idxs.filter((i) => gs[i] && gs[i].area);
    const allAreaIdxs = gs.map((g, i) => (g.area ? i : -1)).filter((i) => i >= 0);

    // 删的都是区域块、且该页区域块被删光 → 直接回到最早那次框选之前的结构
    const onlyAreas = idxs.length === areaIdxs.length;
    const allAreas = areaIdxs.length > 0 && areaIdxs.length === allAreaIdxs.length;
    if (onlyAreas && allAreas) {
      const earliest = gs[allAreaIdxs[0]];
      if (Array.isArray(earliest.groupsBefore) && earliest.groupsBefore.length) {
        const snap = JSON.parse(JSON.stringify(earliest.groupsBefore)).filter((g) => !g.area);
        gs.splice(0, gs.length, ...snap);
        removed += idxs.length;
        dirty.push(p);
        continue;
      }
    }

    // 先收集要归还的行（插入会改变索引，必须等删除做完再插）
    const pending = [];
    for (const i of areaIdxs) {
      const g = gs[i];
      const hitSet = new Set(g.lines || []);
      if (!hitSet.size) continue;
      const occupied = new Set();
      for (let j = 0; j < gs.length; j++) {
        if (j === i || !gs[j].spans) continue;
        for (const [a, b] of gs[j].spans) for (let k = a; k <= b; k++) if (hitSet.has(k)) occupied.add(k);
      }
      const snap = Array.isArray(g.groupsBefore) && g.groupsBefore.length
        ? g.groupsBefore
        : [{ spans: normRanges([...hitSet]), type: 'body' }];
      for (const t of snap) {
        if (!t.spans) continue;
        const nums = [];
        for (const [a, b] of t.spans) for (let k = a; k <= b; k++) if (hitSet.has(k) && !occupied.has(k)) nums.push(k);
        if (!nums.length) continue;
        for (const k of nums) occupied.add(k);
        pending.push({ spans: normRanges(nums), type: t.type });
      }
    }

    for (const i of [...idxs].sort((a, b) => b - a)) {
      const g = gs[i];
      if (g.removed && g.removed.length) restoreCrossPage(g);
      if (!g.area) logCorrection('delete', p, g);
      gs.splice(i, 1);
      removed++;
    }
    for (const g of pending) insertGroupByY(p, g);

    dirty.push(p);
  }
  if (!removed) return;

  state.selected.clear();
  for (const p of dirty) rebuildPage(p);
  saveOverrides();

  const keepY = el.pdfScroll.scrollTop;
  const keepCards = el.cards.scrollTop;
  applyBlocks();
  el.pdfScroll.scrollTop = keepY;
  el.cards.scrollTop = keepCards;
  updatePageLabel();
  renderCorrBadge();
  renderSelBar();
  toast(`已删除 ${removed} 个分段（可撤销）`, 'ok');
}

function mergeUp(b) {
  const p = state.pages[b.page - 1];
  const list = p.blocks;
  const i = list.findIndex((x) => x.id === b.id);
  if (i <= 0) {
    toast('上面没有可合并的段落了', 'err');
    return;
  }
  mergeBlocks([list[i - 1], list[i]]);
}

function splitAt(b, lineNo) {
  const p = state.pages[b.page - 1];
  const gs = groupsOf(p);
  const gi = groupIdxOf(p, b);
  if (gi < 0) return;
  const g = gs[gi];
  if (!g || g.area || !g.spans) return;
  const si = g.spans.findIndex(([a, z]) => lineNo > a && lineNo <= z);
  if (si < 0) return;
  const [a, z] = g.spans[si];
  snapshotUndo(p);
  const tail = { spans: [[lineNo, z], ...g.spans.slice(si + 1).map((s) => [...s])], type: g.type === 'formula' ? 'body' : g.type };
  g.spans = [...g.spans.slice(0, si), [a, lineNo - 1]];
  gs.splice(gi + 1, 0, tail);
  logCorrection('split', p, tail);
  state.splittingId = null;
  applyEdit(p);
}

function undoEdit() {
  const item = state.undoStack && state.undoStack.pop();
  if (!item) {
    toast('没有可撤销的操作', 'err');
    return;
  }

  if (item.multi) {
    for (const s of item.multi) {
      const pg = state.pages[s.page - 1];
      if (!pg) continue;
      pg.groups = s.groups;
      pg.areas = [];
      pg.groupsEdited = s.groupsEdited;
      pg.orderLocked = Boolean(s.orderLocked);
      if (s.blocks && s.blocks.length) pg.blocks = s.blocks;
      else rebuildPage(pg);
    }
    saveOverrides();
    const ky = el.pdfScroll.scrollTop;
    const kc = el.cards.scrollTop;
    applyBlocks();
    el.pdfScroll.scrollTop = ky;
    el.cards.scrollTop = kc;
    updatePageLabel();
    renderCorrBadge();
    renderSelBar();
    renderLineBar();
    renderOrderBar();
    refreshOrderMarks();
    toast('已撤销（跨页操作整页回退）', 'ok');
    return;
  }

  const p = state.pages[item.page - 1];
  p.groups = item.groups;
  p.areas = [];
  p.groupsEdited = item.groupsEdited;
  p.orderLocked = Boolean(item.orderLocked);
  if (item.blocks && item.blocks.length) {
    p.blocks = item.blocks;
  } else {
    rebuildPage(p);
  }
  saveOverrides();

  const keepY = el.pdfScroll.scrollTop;
  const keepCards = el.cards.scrollTop;
  applyBlocks();
  el.pdfScroll.scrollTop = keepY;
  el.cards.scrollTop = keepCards;
  updatePageLabel();
  renderCorrBadge();
  renderSelBar();
  renderLineBar();
  renderOrderBar();
  refreshOrderMarks();
}

function areaIdxPush(arr, v) {
  if (!arr.includes(v)) arr.push(v);
}

/* ---------------- 行级分段操作 ---------------- */
const minLine = (g) => (g.area || !g.spans || !g.spans.length ? Infinity : Math.min(...g.spans.map(([a]) => a)));
const maxLine = (g) => (g.area || !g.spans || !g.spans.length ? -Infinity : Math.max(...g.spans.map(([, b]) => b)));

function rangeNums(a, b) {
  const out = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

/** 行号集合 → 连续区间 */
function normRanges(nums) {
  const a = [...new Set(nums)].sort((x, y) => x - y);
  const out = [];
  for (const n of a) {
    const last = out[out.length - 1];
    if (last && last[1] + 1 === n) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/** 从所有段落里抽走这些行：区间被切开，抽空的段落自动删除 */
function removeLinesFromGroups(gs, lines) {
  const set = new Set(lines);
  for (const g of gs) {
    if (!g.spans) continue;
    const out = [];
    for (const [a, b] of g.spans) {
      let start = 0;
      for (let i = a; i <= b; i++) {
        if (set.has(i)) {
          if (start) out.push([start, i - 1]);
          start = 0;
        } else if (!start) {
          start = i;
        }
      }
      if (start) out.push([start, b]);
    }
    g.spans = out;
  }
  for (let i = gs.length - 1; i >= 0; i--) if (gs[i].spans && !gs[i].spans.length) gs.splice(i, 1);
}

function sortGroups(gs) {
  gs.sort((a, b) => minLine(a) - minLine(b));
}

/** 选中行上方 / 下方最近的段落（用于"并入"） */
function neighborGroup(p, dir) {
  if (!state.selLines.size) return null;
  const lines = [...state.selLines];
  const lo = Math.min(...lines);
  const hi = Math.max(...lines);
  const gs = groupsOf(p);
  let best = null;
  if (dir === 'prev') {
    for (const g of gs) if (maxLine(g) < lo && (!best || maxLine(g) > maxLine(best))) best = g;
  } else {
    for (const g of gs) if (minLine(g) > hi && (!best || minLine(g) < minLine(best))) best = g;
  }
  return best;
}

/** 用选中的行新建一段 */
function newGroupFromLines() {
  const p = selPage();
  if (!p || !state.selLines.size) return;
  const lines = [...state.selLines];
  const gs = groupsOf(p);

  // 沿用来源段的类型（切出标题仍是标题），但从公式里切出来的一律当正文，否则新建的段会被隐藏
  const src = new Set();
  for (const ln of lines) {
    const g0 = gs.find((g) => g.spans && g.spans.some(([a, b]) => ln >= a && ln <= b));
    if (g0) src.add(g0.type);
  }
  let type = src.size === 1 ? [...src][0] : 'body';
  if (type === 'formula') type = 'body';

  snapshotUndo(p);
  removeLinesFromGroups(gs, lines);
  const g = { spans: normRanges(lines), type };
  insertGroupByY(p, g);
  logCorrection('new', p, g);
  toast(`已用 ${lines.length} 行新建一段`, 'ok');
  applyEdit(p);
}

/** 把选中的行并入上方 / 下方最近的段落 */
function joinLinesTo(dir) {
  const p = selPage();
  if (!p || !state.selLines.size) return;
  const lines = [...state.selLines];
  const target = neighborGroup(p, dir);
  if (!target) {
    toast(dir === 'prev' ? '上方没有可并入的段落' : '下方没有可并入的段落', 'err');
    return;
  }
  const gs = groupsOf(p);
  snapshotUndo(p);
  removeLinesFromGroups(gs, lines);
  target.spans = normRanges([...target.spans.flatMap(([a, b]) => rangeNums(a, b)), ...lines]);
  logCorrection(dir === 'prev' ? 'join-prev' : 'join-next', p, target);
  toast(dir === 'prev' ? '已并入上一段' : '已并入下一段', 'ok');
  applyEdit(p);
}

/** 移除这些行：不再成段、不再画框、不参与翻译 */
function dropLines() {
  const p = selPage();
  if (!p || !state.selLines.size) return;
  const lines = [...state.selLines];
  const gs = groupsOf(p);
  snapshotUndo(p);
  removeLinesFromGroups(gs, lines);
  logCorrection('drop', p, { spans: normRanges(lines), type: 'body' });
  toast(`已移除 ${lines.length} 行`, 'ok');
  applyEdit(p);
}

/** 重建后按组索引重新选中（块 id 会变，选中态得跟着走） */
function reselectGroup(p, gi, key = 'main') {
  const nb = (p.blocks || []).find((x) => x.gIndex === gi && x.page === p.num);
  if (!nb) return;
  state.selected.clear();
  state.selected.add(nb.id);
  state.focus = { id: nb.id, key };
  syncSelectionStyles();
}

/** 拖的是「多区间段」的某个分框：只改这一段包含哪些行 */
function commitResizeSpan(p, b, spanIdx, rect) {
  const [ax, ay] = p.vp.convertToPdfPoint(rect.l, rect.t);
  const [bx, by] = p.vp.convertToPdfPoint(rect.l + rect.w, rect.t + rect.h);
  const pdf = {
    x0: Math.min(ax, bx),
    x1: Math.max(ax, bx),
    yTop: Math.max(ay, by),
    yBottom: Math.min(ay, by),
  };

  const gs = groupsOf(p);
  const g = gs[b.gIndex];
  if (!g || !g.spans || spanIdx >= g.spans.length) return;

  const nums = linesInRect(p, pdf);
  if (!nums.length) {
    toast('这个框里没有文字行，已还原', 'err');
    applyEdit(p);
    return;
  }

  snapshotUndo(p);
  const idx = gs.indexOf(g);
  gs.splice(idx, 1);
  removeLinesFromGroups(gs, nums);
  const others = g.spans.filter((_, i) => i !== spanIdx);
  g.spans = normRanges([...others.flatMap(([a, c]) => rangeNums(a, c)), ...nums]);
  delete g.box;
  gs.splice(idx, 0, g);

  toast(`这一段现在包含 ${g.spans.length} 处区域`, 'ok');
  applyEdit(p);
  reselectGroup(p, b.gIndex, 'e' + Math.max(0, spanIdx - 1));
}

/** 拖的是合并段的续接框：只调整这个框的位置，不改文字 */
function commitResizeExtra(p, b, extraIdx, rect) {
  const gs = groupsOf(p);
  const g = gs[b.gIndex];
  if (!g || !g.area || !Array.isArray(g.area.extraBoxes) || !g.area.extraBoxes[extraIdx]) return;

  const [ax, ay] = p.vp.convertToPdfPoint(rect.l, rect.t);
  const [bx, by] = p.vp.convertToPdfPoint(rect.l + rect.w, rect.t + rect.h);

  snapshotUndo(p);
  const eb = g.area.extraBoxes[extraIdx];
  eb.x0 = Math.min(ax, bx);
  eb.x1 = Math.max(ax, bx);
  eb.yTop = Math.max(ay, by);
  eb.yBottom = Math.min(ay, by);

  toast('续接框已调整（只改框，不改文字）', 'ok');
  applyEdit(p);
  reselectGroup(p, b.gIndex, 'e' + extraIdx);
}

/* ---------------- 手动调整段落顺序 ---------------- */
/** 与「右栏看得见的相邻段」交换位置（只在同一页内） */
function moveBlock(b, dir) {
  const p = state.pages[b.page - 1];
  const gs = groupsOf(p);
  const i = b.gIndex;
  if (i == null || i < 0 || !gs[i]) return;
  // groups 里可能夹着不生成卡片的组（公式 / 图内标注），直接 i±1 会换到
  // 一个看不见的组上，用户看到的就是"点了没反应"。按可见卡片的组序找邻居。
  const visible = [...new Set((p.blocks || []).map((x) => x.gIndex).filter((n) => n >= 0))];
  const at = visible.indexOf(i);
  const j = at < 0 ? undefined : visible[at + dir];
  if (j == null) {
    toast(dir < 0 ? '已经是本页第一段' : '已经是本页最后一段', 'err');
    return;
  }
  snapshotUndo(p);
  const tmp = gs[i];
  gs[i] = gs[j];
  gs[j] = tmp;
  p.orderLocked = true; // 手动挪过顺序的页，之后不再被自动插入打乱
  applyEdit(p);
  reselectGroup(p, j);
  toast(`已${dir < 0 ? '上移' : '下移'}一段（只影响顺序，不改文字）`, 'ok');
}

/* ---------------- 排序模式：按点击顺序指定本页分段顺序 ----------------
 * 自动阅读顺序（分栏 / 通栏图表）判错时，↑↓ 一次只挪一格、整页重建，
 * 一页几十段根本没法纠。这里按希望的阅读顺序依次点 PDF 上的块，
 * 一次性重排整页：点过的按点击顺序在前，没点的按原顺序接在后面。
 * 草稿按页保存，翻页自动切换；应用后该页上锁，后续新建段只追加不插回。
 */
function orderPageObj() {
  return state.pages[state.orderPage - 1] || null;
}

function orderDraftOf(pageNum) {
  if (!state.orderDraft.has(pageNum)) state.orderDraft.set(pageNum, []);
  return state.orderDraft.get(pageNum);
}

/** 本页能参与排序的组下标（= 右栏有卡片的那些段） */
function orderableGis(p) {
  if (!p) return [];
  return [...new Set((p.blocks || []).map((b) => b.gIndex).filter((n) => n >= 0))];
}

function orderPick(id) {
  const b = state.byId.get(id);
  if (!b) return;
  const p = state.pages[b.page - 1];
  if (!p) return;
  if (p.num !== state.orderPage) {
    state.orderPage = p.num;
    toast(`已切到 P${p.num} 排序`, '');
  }
  if (b.gIndex == null || b.gIndex < 0) {
    toast('这一段不能参与排序', 'err');
    return;
  }
  const draft = orderDraftOf(p.num);
  const at = draft.indexOf(b.gIndex);
  if (at >= 0) draft.splice(at, 1); // 再点一次取消，后面的序号自动补上
  else draft.push(b.gIndex);
  refreshOrderMarks();
  renderOrderBar();
}

/** 把草稿里的序号同步到 PDF 块和右栏卡片（版面重建后也要重打） */
function refreshOrderMarks() {
  for (const pg of state.pages) {
    const nodes = [...(pg.blockEls?.values() || [])];
    for (const list of pg.contEls?.values() || []) nodes.push(...(list || []));
    for (const node of nodes) {
      if (node.dataset.seq) delete node.dataset.seq;
      node.classList.remove('ordered');
    }
  }
  for (const card of state.cardEls.values()) {
    if (card.dataset.seq) delete card.dataset.seq;
    card.classList.remove('order-picked');
    const ord = card.querySelector('.ord');
    if (ord && card.dataset.ord) ord.textContent = card.dataset.ord;
  }
  if (!state.editing || state.pickMode !== 'order') return;

  const p = orderPageObj();
  if (!p) return;
  const byGi = new Map((p.blocks || []).map((b) => [b.gIndex, b.id]));
  orderDraftOf(p.num).forEach((gi, i) => {
    const id = byGi.get(gi);
    if (!id) return;
    const main = p.blockEls?.get(id);
    if (main) {
      main.dataset.seq = String(i + 1);
      main.classList.add('ordered');
    }
    for (const node of p.contEls?.get(id) || []) {
      node.dataset.seq = String(i + 1);
      node.classList.add('ordered');
    }
    const card = state.cardEls.get(id);
    if (card) {
      card.dataset.seq = String(i + 1);
      card.classList.add('order-picked');
      const ord = card.querySelector('.ord');
      if (ord) ord.textContent = `第 ${i + 1} 位`;
    }
  });
}

function renderOrderBar() {
  const bar = $('#orderBar');
  if (!bar) return;
  const on = state.editing && state.pickMode === 'order';
  bar.hidden = !on;
  if (!on) return;
  const p = orderPageObj();
  const draft = orderDraftOf(state.orderPage);
  const total = orderableGis(p).length;
  $('#orderInfo').textContent =
    `P${state.orderPage} · 已排 ${draft.length} / ${total} 段${p?.orderLocked ? ' · 顺序已锁定' : ''}`;
  $('#btnOrderUndo').disabled = draft.length === 0;
  $('#btnOrderClear').disabled = draft.length === 0;
  $('#btnOrderApply').disabled = draft.length === 0;
  $('#btnOrderReset').disabled = !p?.orderLocked && draft.length === 0;
  placeBar(bar, null); // 操作面板停靠左栏底部，点块时不跳来跳去
}

/** 按点击顺序重排本页，并锁住顺序（后续自动插入不再打乱） */
function applyPageOrder() {
  const p = orderPageObj();
  const draft = orderDraftOf(state.orderPage);
  if (!p || !draft.length) {
    toast('先按顺序点几个段落', 'err');
    return;
  }
  const gs = groupsOf(p);
  // 草稿可能来自组数变化前的旧状态：滤掉失效下标，再补齐所有剩下的组
  const valid = [...new Set(draft.filter((i) => Number.isInteger(i) && i >= 0 && i < gs.length))];
  const used = new Set(valid);
  const clean = [...valid, ...gs.map((_, i) => i).filter((i) => !used.has(i))];
  snapshotUndo(p);
  p.groups = clean.map((i) => gs[i]);
  p.orderLocked = true;
  p.groupsEdited = true;
  applyEdit(p);
  draft.length = 0;
  renderOrderBar();
  refreshOrderMarks();
  toast(`P${p.num} 已按点击顺序排好（自动排序不会再打乱它）`, 'ok');
}

/** 清掉手动顺序，恢复按视觉位置的自动顺序 */
function resetPageOrder() {
  const p = orderPageObj();
  if (!p) return;
  const gs = groupsOf(p);
  snapshotUndo(p);
  gs.sort((a, b) => minLine(a) - minLine(b));
  p.orderLocked = false;
  p.groupsEdited = true;
  orderDraftOf(p.num).length = 0;
  applyEdit(p);
  renderOrderBar();
  refreshOrderMarks();
  toast(`P${p.num} 已恢复自动顺序`, 'ok');
}

/* ---------------- 拖动块边界 ---------------- */
const HANDLE_DIRS = ['n', 's', 'e', 'w', 'nw', 'ne', 'sw', 'se'];

/** 框内的行（按水平重叠比例判断，宽行也能正确处理） */
function linesInRect(p, pdf) {
  const out = [];
  const cx = (pdf.x0 + pdf.x1) / 2;
  for (const ln of p.lines || []) {
    const cy = (ln.yTop + ln.yBottom) / 2;
    if (cy < pdf.yBottom || cy > pdf.yTop) continue;
    const ov = Math.max(0, Math.min(ln.x1, pdf.x1) - Math.max(ln.x0, pdf.x0));
    const ratio = ov / Math.max(ln.x1 - ln.x0, 1);
    // 盖住半行以上，或者框的水平中心就落在这行上（拖高度但宽度没变时靠这条）
    if (ratio >= 0.5 || (cx >= ln.x0 && cx <= ln.x1)) out.push(ln.i);
  }
  return out;
}

function startResize(ev, p, b, node, dir, target) {
  if (!state.editing || state.pickMode !== 'block') return;
  if (b.gIndex == null) return;
  ev.stopPropagation();
  ev.preventDefault();

  const l0 = parseFloat(node.style.left) || 0;
  const t0 = parseFloat(node.style.top) || 0;
  const w0 = parseFloat(node.style.width) || 0;
  const h0 = parseFloat(node.style.height) || 0;
  node.classList.add('resizing');

  const move = (e) => {
    const dx = e.clientX - ev.clientX;
    const dy = e.clientY - ev.clientY;
    let l = l0;
    let t = t0;
    let w = w0;
    let h = h0;
    if (dir.includes('w')) {
      l = l0 + dx;
      w = w0 - dx;
    }
    if (dir.includes('e')) w = w0 + dx;
    if (dir.includes('n')) {
      t = t0 + dy;
      h = h0 - dy;
    }
    if (dir.includes('s')) h = h0 + dy;
    if (w < 10 || h < 7) return;
    node.style.left = l + 'px';
    node.style.top = t + 'px';
    node.style.width = w + 'px';
    node.style.height = h + 'px';
  };

  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    node.classList.remove('resizing');
    const rect = {
      l: parseFloat(node.style.left) || 0,
      t: parseFloat(node.style.top) || 0,
      w: parseFloat(node.style.width) || 0,
      h: parseFloat(node.style.height) || 0,
    };
    if (target && target.span != null) commitResizeSpan(p, b, target.span, rect);
    else if (target && target.extra != null) commitResizeExtra(p, b, target.extra, rect);
    else commitResize(p, b, rect);
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

/** 松手：把新框换算回 PDF 坐标，重新决定这段包含哪些文字 */
function commitResize(p, b, rect) {
  const [ax, ay] = p.vp.convertToPdfPoint(rect.l, rect.t);
  const [bx, by] = p.vp.convertToPdfPoint(rect.l + rect.w, rect.t + rect.h);
  const pdf = {
    x0: Math.min(ax, bx),
    x1: Math.max(ax, bx),
    yTop: Math.max(ay, by),
    yBottom: Math.min(ay, by),
  };

  const gs = groupsOf(p);
  const g = gs[b.gIndex];
  if (!g) return;

  if (g.area) {
    const got = rectText(p, pdf);
    if (!got || !got.text || got.text.trim().length < 2) {
      toast('这个框里没有文字，已还原', 'err');
      applyEdit(p);
      return;
    }
    snapshotUndo(p);
    g.area = {
      ...g.area,
      // 用户拖过这个框就以它为准，不再按片段自动拆框
      boxEdited: true,
      extraBoxes: [],
      parts: undefined,
      text: got.text,
      x0: pdf.x0,
      x1: pdf.x1,
      yTop: pdf.yTop,
      yBottom: pdf.yBottom,
      size: got.size || g.area.size || 10,
      count: got.count,
      contentBox: { x0: got.x0, x1: got.x1, yTop: got.yTop, yBottom: got.yBottom },
    };
    g.lines = linesInRect(p, pdf);
    toast('区域段已按新框重算文字', 'ok');
    applyEdit(p);
    reselectGroup(p, b.gIndex);
    return;
  }

  const nums = linesInRect(p, pdf);
  if (!nums.length) {
    toast('这个框里没有文字行，已还原', 'err');
    applyEdit(p);
    return;
  }
  snapshotUndo(p);
  // 先把自己摘出来，否则 removeLinesFromGroups 会把自己的行清空
  const idx = gs.indexOf(g);
  gs.splice(idx, 1);
  removeLinesFromGroups(gs, nums);
  g.spans = normRanges(nums);
  // 记住用户拖出来的框，重建时不再自动贴合文字。
  // 但拖出来的是几块不连续的文字时，按片段各画一个框更准确，整体框会把空隙也框住。
  if (g.spans.length === 1) {
    g.box = { x0: pdf.x0, x1: pdf.x1, yTop: pdf.yTop, yBottom: pdf.yBottom };
  } else {
    delete g.box;
  }
  gs.splice(idx, 0, g);
  toast(`这一段现在包含 ${nums.length} 行`, 'ok');
  applyEdit(p);
  reselectGroup(p, b.gIndex);
}

/** 把框收回到文字的实际范围（手动拖过的框才需要） */
function fitBlock(b) {
  const p = state.pages[b.page - 1];
  const gs = groupsOf(p);
  const g = gs[b.gIndex];
  if (!g) return;
  snapshotUndo(p);

  if (g.area) {
    const got = rectText(p, { x0: g.area.x0, x1: g.area.x1, yTop: g.area.yTop, yBottom: g.area.yBottom });
    if (got) {
      g.area.x0 = got.x0;
      g.area.x1 = got.x1;
      g.area.yTop = got.yTop;
      g.area.yBottom = got.yBottom;
    }
    // 贴合等于「回到自动」，合并来的段落重新按片段拆框
    delete g.area.boxEdited;
  } else {
    delete g.box;
  }

  toast('框已贴合文字', 'ok');
  applyEdit(p);
  reselectGroup(p, b.gIndex);
}

/**
 * 取框内文字。默认只取水平文字：arXiv 左侧竖排编号、旋转表头这类旋转文字
 * 的宽度是沿书写方向量的，混进来会把文字顺序搅乱、把框撑变形。
 * 只有框里确实一个水平字都没有时才退回去取旋转文字。
 */
function rectText(p, rect) {
  const got = textInRect(p.items || [], rect, { gutter: p.gutter });
  if (got) return got;
  return textInRect(p.turned || [], rect, { gutter: p.gutter, allowTurned: true });
}

/* ---------------- 按区域：框哪块就是哪块 ---------------- */
/**
 * 用框选矩形新建一段。
 * 文本由矩形内的字符项直接重排（先左栏后右栏），完全不依赖行/栏的自动判定；
 * 被框住的行从原段落里抽走，避免同一段文字出现两次。
 */
function makeAreaFromRect(p, sel) {
  if (!(p.items && p.items.length) && !(p.turned && p.turned.length)) {
    toast('这一页没有可用的文字层', 'err');
    return;
  }
  const [ax, ay] = p.vp.convertToPdfPoint(sel.l, sel.t);
  const [bx, by] = p.vp.convertToPdfPoint(sel.r, sel.b);
  const rect = {
    x0: Math.min(ax, bx),
    x1: Math.max(ax, bx),
    yTop: Math.max(ay, by),
    yBottom: Math.min(ay, by),
  };

  const got = rectText(p, rect);
  if (!got || !got.text || got.text.trim().length < 2) {
    toast('这块区域里没有文字', 'err');
    return;
  }

  const gs = groupsOf(p);
  snapshotUndo(p);

  // 被矩形覆盖的行让位给区域块
  const hit = [];
  for (const ln of p.lines || []) {
    const cy = (ln.yTop + ln.yBottom) / 2;
    if (cy < rect.yBottom || cy > rect.yTop) continue;
    const cx = (ln.x0 + ln.x1) / 2;
    const inside = cx >= rect.x0 && cx <= rect.x1;
    const ov = Math.max(0, Math.min(ln.x1, rect.x1) - Math.max(ln.x0, rect.x0));
    const ratio = ov / Math.max(ln.x1 - ln.x0, 1);
    if (inside || ratio >= 0.45) hit.push(ln.i);
  }
  // 存一份"框选之前"的分组快照，删掉区域块时按原样还回去
  const groupsBefore = JSON.parse(JSON.stringify(gs));

  if (hit.length) removeLinesFromGroups(gs, hit);

  const g = {
    area: {
      text: got.text,
      x0: rect.x0,
      x1: rect.x1,
      yTop: rect.yTop,
      yBottom: rect.yBottom,
      size: got.size || 10,
      count: got.count,
      contentBox: { x0: got.x0, x1: got.x1, yTop: got.yTop, yBottom: got.yBottom },
    },
    type: 'body',
    lines: hit,
    groupsBefore,
  };
  insertGroupByY(p, g);
  logCorrection('area', p, { spans: hit.length ? normRanges(hit) : [[1, 1]], type: 'body' });
  toast(`已按框选新建一段（${got.count} 项文字${hit.length ? `，接管 ${hit.length} 行` : ''}）`, 'ok');
  applyEdit(p);

  // 让新建的区域块闪一下，方便确认落在哪
  const made = p.blocks.find((b) => b.isArea && b.text === got.text);
  const node = made && p.blockEls && p.blockEls.get(made.id);
  if (node) {
    node.classList.add('flash');
    setTimeout(() => node.classList.remove('flash'), 1200);
  }
}

/* ---------------- 选择：点选 + 框选 ---------------- */
function toggleSelect(id, key = 'main') {
  if (state.selected.has(id)) {
    // 同一段的另一个框：只把焦点挪过去，不取消选中
    if (state.focus && state.focus.id === id && state.focus.key !== key) {
      state.focus = { id, key };
      const same = state.byId.get(id);
      if (same) refreshBlockClass(same);
      return;
    }
    state.selected.delete(id);
    if (state.focus && state.focus.id === id) state.focus = null;
  } else {
    state.selected.add(id);
    state.focus = { id, key };
  }
  const b = state.byId.get(id);
  if (b) refreshBlockClass(b);
  state.cardEls.get(id)?.classList.toggle('sel', state.selected.has(id));
  renderSelBar();
}

function clearSelection() {
  const ids = [...state.selected];
  state.selected.clear();
  state.focus = null; // 否则取消选择后手柄还留在旧框上，工具条也会锚到旧框
  for (const id of ids) {
    const b = state.byId.get(id);
    if (b) refreshBlockClass(b);
    state.cardEls.get(id)?.classList.remove('sel');
  }
  renderSelBar();
}

/* ---------------- 选择操作条：贴着选区浮动 ----------------
 * 旧版把工具条放在 .pdf-scroll 里做 absolute + bottom，定位基准是滚动内容的
 * 原点，所以它永远停在 PDF 第一屏；翻到后面几页选块时工具条早就滚出视野了。
 * 现在改成 fixed 浮层，锚点取「最后点中的那个框」或框选/行选的合并包围盒，
 * 滚动、缩放、改分栏宽度时实时重算；选区滚出视野就停靠在左栏边缘。
 */
function unionRect(rects) {
  const rs = rects.filter((r) => r && r.width >= 0 && r.height >= 0);
  if (!rs.length) return null;
  let left = Infinity, top = Infinity, right = -Infinity, bottom = -Infinity;
  for (const r of rs) {
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

/** 最后点中的那个框：主框 main，或合并段的某个续接框 eN */
function focusBlockNode() {
  const f = state.focus;
  const b = f && state.byId.get(f.id);
  if (!b) return null;
  if (f.key === 'main') return state.pages[b.page - 1]?.blockEls?.get(b.id) || null;
  const idx = Number(String(f.key).slice(1));
  if (!Number.isFinite(idx)) return null;
  const eb = b.extraBoxes && b.extraBoxes[idx];
  if (!eb) return null;
  const p = state.pages[eb.page - 1];
  const list = p && p.contEls && p.contEls.get(b.id);
  if (!list) return null;
  const onPage = b.extraBoxes.filter((x) => x.page === eb.page);
  return list[onPage.indexOf(eb)] || null;
}

/** 按段：优先跟焦点框走；框选（没有焦点）时用所有选中框的包围盒 */
function selAnchorRect() {
  const focus = focusBlockNode();
  if (focus && focus.isConnected) return focus.getBoundingClientRect();
  const view = el.pdfScroll.getBoundingClientRect();
  const rects = [];
  for (const id of state.selected) {
    const b = state.byId.get(id);
    const p = b && state.pages[b.page - 1];
    if (!p) continue;
    const main = p.blockEls && p.blockEls.get(id);
    if (main) rects.push(main.getBoundingClientRect());
    for (const n of (p.contEls && p.contEls.get(id)) || []) rects.push(n.getBoundingClientRect());
  }
  // 跨页合并时只锚定当前看得见的那些框，别让包围盒把工具条推出屏幕
  const visible = rects.filter((r) => r.bottom > view.top && r.top < view.bottom);
  return unionRect(visible.length ? visible : rects);
}

/** 按行：所有选中行的包围盒 */
function lineAnchorRect() {
  const p = selPage();
  if (!p) return null;
  const rects = [];
  for (const i of state.selLines) {
    const n = p.lineEls && p.lineEls.get(i);
    if (n) rects.push(n.getBoundingClientRect());
  }
  return unionRect(rects);
}

const BAR_GAP = 10;
function placeBar(bar, anchor) {
  const view = el.pdfScroll.getBoundingClientRect();
  if (!bar.offsetWidth || !bar.offsetHeight || view.width < 40) return;
  // 宽度上限跟着左栏走，避免工具条横跨到右栏去（滚动时宽度不变就不写，减少重排）
  const maxW = Math.max(160, view.width - 32) + 'px';
  if (bar.style.maxWidth !== maxW) bar.style.maxWidth = maxW;
  const w = bar.offsetWidth;
  const h = bar.offsetHeight;
  const minL = view.left + 12;
  const maxL = Math.max(minL, view.right - w - 16);
  const minT = view.top + 12;
  const maxT = Math.max(minT, view.bottom - h - 12);

  let left, top, pinned = false;
  if (!anchor) {
    left = (view.left + view.right - w) / 2;
    top = maxT;
    pinned = true;
  } else {
    left = anchor.left + anchor.width / 2 - w / 2;
    const below = Math.min(anchor.bottom, view.bottom) + BAR_GAP;
    const above = Math.max(anchor.top, view.top) - BAR_GAP - h;
    if (anchor.bottom < view.top) {
      top = minT;                       // 选区滚到上方去了 → 贴顶，方向不跳
      pinned = true;
    } else if (anchor.top > view.bottom) {
      top = maxT;                       // 选区还在下方 → 贴底
      pinned = true;
    } else if (below + h <= view.bottom - 12) {
      top = below;                      // 常规：紧跟在选区下面
    } else if (above >= view.top + 12) {
      top = above;                      // 下方放不下就翻到上面
    } else {
      top = maxT;                       // 上下都放不下（选区整屏高）→ 停靠
      pinned = true;
    }
  }
  bar.style.left = clamp(left, minL, maxL) + 'px';
  bar.style.top = clamp(top, minT, maxT) + 'px';
  bar.classList.toggle('pinned', pinned);
}

function positionBars() {
  const sel = $('#selBar');
  const line = $('#lineBar');
  const order = $('#orderBar');
  if (sel && !sel.hidden) placeBar(sel, selAnchorRect());
  if (line && !line.hidden) placeBar(line, lineAnchorRect());
  if (order && !order.hidden) placeBar(order, null); // 排序面板固定停靠左栏底部
}

function renderSelBar() {
  const bar = $('#selBar');
  if (!bar) return;
  const n = state.selected.size;
  bar.hidden = !state.editing || n === 0;
  if (bar.hidden) return;
  $('#selCount').textContent = `已选 ${n} 段`;
  $('#btnMergeSel').disabled = n < 2;
  const del = $('#btnDelSel');
  if (del) del.disabled = n < 1;
  positionBars();
}

/* ------------------------------------------------------------------ */
/* 版面：页壳、canvas、分块覆盖层、框选                                  */
/* ------------------------------------------------------------------ */
let io = null;

function buildLayout() {
  if (io) io.disconnect();
  state.activeId = null;
  const avail = el.pdfScroll.clientWidth - 48;
  const baseW = state.pages[0].base.w;
  if (state.autoFit) state.scale = clamp(avail / baseW, 0.35, 4);

  el.pages.innerHTML = '';
  io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        const p = state.pages[Number(e.target.dataset.page) - 1];
        if (!p) continue;
        if (e.isIntersecting) renderPage(p);
        else unloadPage(p);
      }
    },
    { root: el.pdfScroll, rootMargin: '900px 0px' }
  );

  for (const p of state.pages) {
    const pageEl = document.createElement('div');
    pageEl.className = 'page';
    pageEl.dataset.page = String(p.num);

    const canvas = document.createElement('canvas');
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const pnum = document.createElement('div');
    pnum.className = 'pnum';
    pnum.textContent = String(p.num);

    pageEl.append(canvas, overlay, pnum);
    el.pages.appendChild(pageEl);

    p.el = pageEl;
    p.canvas = canvas;
    p.overlay = overlay;
    p.blockEls = new Map();
    p.lineEls = new Map();
    p.rendered = false;

    createBlockEls(p);
    createLineEls(p);
    applyViewport(p);
    attachMarquee(pageEl, p);
    io.observe(pageEl);
  }
  updateZoomLabel();
  positionBars(); // 版面重建后重新贴到选区（选中的块元素已被替换）
}

function applyViewport(p) {
  const vp = p.page.getViewport({ scale: state.scale });
  p.vp = vp;
  const w = Math.round(vp.width);
  const h = Math.round(vp.height);
  p.el.style.width = w + 'px';
  p.el.style.height = h + 'px';
  p.canvas.style.width = w + 'px';
  p.canvas.style.height = h + 'px';
  positionBlocks(p);
  positionLines(p);
}

function positionBlocks(p) {
  if (!p.vp) return;
  for (const b of p.blocks) {
    const node = p.blockEls.get(b.id);
    if (!node) continue;
    const [ax, ay] = p.vp.convertToViewportPoint(b.x, b.y);
    const [bx, by] = p.vp.convertToViewportPoint(b.x + b.w, b.y - b.h);
    const left = Math.min(ax, bx);
    const top = Math.min(ay, by);
    node.style.left = left - 1 + 'px';
    node.style.top = top - 2 + 'px';
    node.style.width = Math.abs(bx - ax) + 2 + 'px';
    node.style.height = Math.abs(by - ay) + 4 + 'px';
  }

  for (const [id, nodes] of p.contEls || []) {
    const b = state.byId.get(id);
    if (!b) continue;
    const boxes = (b.extraBoxes || []).filter((eb) => eb.page === p.num);
    boxes.forEach((eb, i) => {
      const node = nodes[i];
      if (!node) return;
      const [ax, ay] = p.vp.convertToViewportPoint(eb.x0, eb.yTop);
      const [bx, by] = p.vp.convertToViewportPoint(eb.x1, eb.yBottom);
      node.style.left = Math.min(ax, bx) - 1 + 'px';
      node.style.top = Math.min(ay, by) - 2 + 'px';
      node.style.width = Math.abs(bx - ax) + 2 + 'px';
      node.style.height = Math.abs(by - ay) + 4 + 'px';
    });
  }
}

function createBlockEls(p) {
  p.overlay.innerHTML = '';
  for (const b of p.blocks) {
    const node = document.createElement('div');
    node.dataset.id = b.id;
    node.className = blockClass(b);
    node.title = b.text.slice(0, 140);
    node.addEventListener('click', (ev) => {
      ev.stopPropagation();
      onBlockClick(b.id, 'main');
    });
    node.addEventListener('mouseenter', () => state.cardEls.get(b.id)?.classList.add('hover'));
    node.addEventListener('mouseleave', () => state.cardEls.get(b.id)?.classList.remove('hover'));
    // 八个方向的拖拽手柄：选中后可以手动改这个段覆盖的范围
    for (const dir of HANDLE_DIRS) {
      const hd = document.createElement('div');
      hd.className = 'hd hd-' + dir;
      hd.dataset.dir = dir;
      hd.addEventListener('pointerdown', (ev) => startResize(ev, p, b, node, dir));
      node.appendChild(hd);
    }
    p.overlay.appendChild(node);
    p.blockEls.set(b.id, node);
  }

  // 续接框：合并后的段落在本页额外占的位置（同页合并、跨页合并都算）
  p.contEls = new Map();
  for (const b of state.blocks) {
    if (!b.extraBoxes || !b.extraBoxes.length) continue;
    for (const eb of b.extraBoxes) {
      if (eb.page !== p.num) continue;
      const node = document.createElement('div');
      node.className = blockClass(b) + ' cont';
      node.dataset.id = b.id;
      node.dataset.cont = '1';
      node.title = '与 P' + b.page + ' 的那段是同一段：' + b.text.slice(0, 100);
      node.addEventListener('click', (ev) => {
        ev.stopPropagation();
        onBlockClick(b.id, 'e' + b.extraBoxes.indexOf(eb));
      });
      node.addEventListener('mouseenter', () => state.cardEls.get(b.id)?.classList.add('hover'));
      node.addEventListener('mouseleave', () => state.cardEls.get(b.id)?.classList.remove('hover'));

      // 每个框都有自己的手柄：点哪个框就能调哪个框
      const hostPage = state.pages[b.page - 1] || p;
      const idx = b.extraBoxes.indexOf(eb);
      for (const dir of HANDLE_DIRS) {
        const hd = document.createElement('div');
        hd.className = 'hd hd-' + dir;
        hd.dataset.dir = dir;
        hd.addEventListener('pointerdown', (ev) =>
          startResize(ev, hostPage, b, node, dir, eb.span ? { span: idx + 1 } : { extra: idx })
        );
        node.appendChild(hd);
      }

      p.overlay.appendChild(node);
      if (!p.contEls.has(b.id)) p.contEls.set(b.id, []);
      p.contEls.get(b.id).push(node);
    }
  }
}

function blockClass(b) {
  let c = 'blk';
  if (b.status !== 'done') c += ' untranslated';
  if (state.activeId === b.id) c += ' active';
  if (state.selected.has(b.id)) c += ' sel';
  return c;
}

function refreshBlockClass(b) {
  const focusKey = state.focus && state.focus.id === b.id ? state.focus.key : null;
  const p = state.pages[b.page - 1];
  const node = p && p.blockEls ? p.blockEls.get(b.id) : null;
  if (node) {
    node.className = blockClass(b) + (focusKey === 'main' ? ' hd-on' : '');
  }
  // 合并段的其它框跟着一起高亮，但手柄只挂在被点中的那个上
  for (const pg of state.pages) {
    const list = (pg.contEls && pg.contEls.get(b.id)) || [];
    const boxes = (b.extraBoxes || []).filter((eb) => eb.page === pg.num);
    list.forEach((n, i) => {
      const key = 'e' + (b.extraBoxes ? b.extraBoxes.indexOf(boxes[i]) : i);
      n.className = blockClass(b) + ' cont' + (focusKey === key ? ' hd-on' : '');
    });
  }
}

/* ---------------- 行层：按行选择 ---------------- */
/** 每行一个透明覆盖块；只在「按行」模式下接住鼠标 */
function createLineEls(p) {
  p.lineEls = new Map();
  if (!p.lines || !p.lines.length) return;
  const frag = document.createDocumentFragment();
  for (const ln of p.lines) {
    const node = document.createElement('div');
    node.className = 'ln';
    node.dataset.i = String(ln.i);
    node.title = ln.text.slice(0, 120);
    p.lineEls.set(ln.i, node);
    frag.appendChild(node);
  }
  p.overlay.appendChild(frag);
  markLineOwners(p);
}

/** 标记每行当前属于第几段：同段同色，-1 表示不属于任何段（如被删掉的页眉） */
function markLineOwners(p) {
  const owner = new Map();
  const gs = p.groups || groupsOf(p);
  const starts = new Set();
  gs.forEach((g, gi) => {
    if (!g.spans || !g.spans.length) return;
    for (const [a, b] of g.spans) for (let i = a; i <= b; i++) owner.set(i, gi);
    starts.add(Math.min(...g.spans.map((sp) => sp[0])));
  });
  for (const [i, node] of p.lineEls || []) {
    const gi = owner.has(i) ? owner.get(i) : -1;
    node.dataset.g = String(gi < 0 ? -1 : gi % 4);
    node.dataset.gi = String(gi);
    node.classList.toggle('orphan', gi < 0);
    node.classList.toggle('gstart', gi >= 0 && starts.has(i));
  }
}

function positionLines(p) {
  if (!p.vp || !p.lineEls) return;
  for (const ln of p.lines || []) {
    const node = p.lineEls.get(ln.i);
    if (!node) continue;
    const [ax, ay] = p.vp.convertToViewportPoint(ln.x0, ln.yTop);
    const [bx, by] = p.vp.convertToViewportPoint(ln.x1, ln.yBottom);
    const left = Math.min(ax, bx);
    const top = Math.min(ay, by);
    node.style.left = left - 1 + 'px';
    node.style.top = top - 1.5 + 'px';
    node.style.width = Math.abs(bx - ax) + 2 + 'px';
    node.style.height = Math.max(Math.abs(by - ay) + 3, 5) + 'px';
  }
}

/* ---------------- 框选 / 行选 ---------------- */
function attachMarquee(pageEl, p) {
  pageEl.addEventListener('pointerdown', (ev) => {
    if (!state.editing || ev.button !== 0) return;
    if (state.pickMode === 'order') return; // 排序模式只接受点块，不框选、不拖框
    const lineMode = state.pickMode === 'line';
    const areaMode = state.pickMode === 'area';
    if (!lineMode && !areaMode && ev.target.closest('.blk')) return; // 点在块上交给 click
    ev.preventDefault();

    const rect = pageEl.getBoundingClientRect();
    const sx = ev.clientX - rect.left;
    const sy = ev.clientY - rect.top;
    const hitLine = Number(ev.target.closest('.ln')?.dataset.i || 0);
    const additive = ev.shiftKey || ev.metaKey || ev.ctrlKey;

    const box = document.createElement('div');
    box.className = 'marquee';
    pageEl.appendChild(box);

    let moved = false;
    const move = (e) => {
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      if (Math.abs(x - sx) + Math.abs(y - sy) > 5) moved = true;
      box.style.left = Math.min(x, sx) + 'px';
      box.style.top = Math.min(y, sy) + 'px';
      box.style.width = Math.abs(x - sx) + 'px';
      box.style.height = Math.abs(y - sy) + 'px';
    };
    const up = (e) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      box.remove();

      // 没拖动 → 当成单击
      if (!moved) {
        if (!lineMode) return;
        if (hitLine) toggleLine(p, hitLine);
        else clearLineSel();
        return;
      }

      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const sel = {
        l: Math.min(x, sx),
        t: Math.min(y, sy),
        r: Math.max(x, sx),
        b: Math.max(y, sy),
      };
      if ((sel.r - sel.l) * (sel.b - sel.t) < 120) return; // 只是单击
      if (areaMode) makeAreaFromRect(p, sel);
      else if (lineMode) selectLinesInRect(p, sel, additive);
      else selectInRect(p, sel, additive);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
}

/* ---------------- 行选择 ---------------- */
function selPage() {
  return state.pages[(state.linePage || 0) - 1] || null;
}

function addLine(p, i) {
  state.selLines.add(i);
  p.lineEls?.get(i)?.classList.add('sel');
}

function toggleLine(p, i) {
  if (p.num !== state.linePage) clearLineSel(true);
  state.linePage = p.num;
  if (state.selLines.has(i)) {
    state.selLines.delete(i);
    p.lineEls?.get(i)?.classList.remove('sel');
  } else {
    addLine(p, i);
  }
  renderLineBar();
}

function selectLinesInRect(p, sel, additive) {
  if (!additive || p.num !== state.linePage) clearLineSel(true);
  state.linePage = p.num;
  for (const ln of p.lines || []) {
    const node = p.lineEls?.get(ln.i);
    if (!node) continue;
    const l = parseFloat(node.style.left) || 0;
    const t = parseFloat(node.style.top) || 0;
    const w = parseFloat(node.style.width) || 0;
    const h = parseFloat(node.style.height) || 0;
    if (l < sel.r && l + w > sel.l && t < sel.b && t + h > sel.t) addLine(p, ln.i);
  }
  renderLineBar();
}

function clearLineSel(silent = false) {
  const p = selPage();
  if (p) for (const i of state.selLines) p.lineEls?.get(i)?.classList.remove('sel');
  state.selLines.clear();
  state.linePage = 0;
  if (!silent) renderLineBar();
}

function renderLineBar() {
  const bar = $('#lineBar');
  if (!bar) return;
  const n = state.selLines.size;
  bar.hidden = !(state.editing && state.pickMode === 'line' && n > 0);
  if (bar.hidden) return;
  $('#lineCount').textContent = `已选 ${n} 行`;
  const p = selPage();
  $('#btnJoinPrev').disabled = !(p && neighborGroup(p, 'prev'));
  $('#btnJoinNext').disabled = !(p && neighborGroup(p, 'next'));
  positionBars();
}

function syncModeSwitch() {
  const sw = $('#modeSwitch');
  if (!sw) return;
  for (const b of sw.querySelectorAll('.chip')) b.classList.toggle('on', b.dataset.mode === state.pickMode);
}

/** 切换选择粒度：block=整段，line=单行 */
function setPickMode(mode) {
  if (mode === state.pickMode) return;
  state.pickMode = mode;
  document.body.classList.toggle('line-mode', mode === 'line');
  document.body.classList.toggle('area-mode', mode === 'area');
  document.body.classList.toggle('order-mode', mode === 'order');
  if (mode !== 'block') clearSelection();
  if (mode !== 'line') clearLineSel();
  if (mode === 'order') state.orderPage = updatePageLabel()?.num || 1;
  syncModeSwitch();
  renderSelBar();
  renderLineBar();
  renderOrderBar();
  refreshOrderMarks();
  const tips = {
    block: '按段：点选或框选整段，再合并 / 删除',
    line: '按行：点一行选中，按住拖动可框选多行；再点「新建为一段」或「并入上一段」',
    area: '按区域：在 PDF 上拉一个框，框住哪块文字就单独成一段（双栏也按左栏→右栏读）',
    order: '排序：按希望的阅读顺序依次点 PDF 上的段落（再点一次取消），然后点「应用顺序」一次性定好本页顺序',
  };
  toast(tips[mode] || '', '');
}

function selectInRect(p, sel, additive) {
  if (!additive) state.selected.clear();
  const hit = (node) => {
    if (!node) return false;
    const l = parseFloat(node.style.left) || 0;
    const t = parseFloat(node.style.top) || 0;
    const w = parseFloat(node.style.width) || 0;
    const h = parseFloat(node.style.height) || 0;
    return l < sel.r && l + w > sel.l && t < sel.b && t + h > sel.t;
  };
  for (const b of p.blocks) {
    if (hit(p.blockEls.get(b.id))) state.selected.add(b.id);
  }
  for (const [id, nodes] of p.contEls || []) {
    if (nodes.some(hit)) state.selected.add(id);
  }
  // 框选没有「最后点中的框」，让工具条锚到这次框选出来的整片区域
  state.focus = null;
  syncSelectionStyles();
}

function syncSelectionStyles() {
  for (const b of state.blocks) refreshBlockClass(b);
  for (const [id, card] of state.cardEls) card.classList.toggle('sel', state.selected.has(id));
  renderSelBar();
}

/* ---------------- 渲染 ---------------- */
async function renderPage(p) {
  if (!p.el) return;
  if (p.rendering) {
    clearTimeout(p._retry);
    p._retry = setTimeout(() => renderPage(p), 180);
    return;
  }
  if (p.rendered) return;
  p.rendering = true;
  try {
    const vp = p.vp || p.page.getViewport({ scale: state.scale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cv = p.canvas;
    cv.width = Math.floor(vp.width * dpr);
    cv.height = Math.floor(vp.height * dpr);
    cv.style.width = Math.round(vp.width) + 'px';
    cv.style.height = Math.round(vp.height) + 'px';
    const ctx = cv.getContext('2d');
    const task = p.page.render({
      canvasContext: ctx,
      viewport: vp,
      transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null,
    });
    p.renderTask = task;
    await task.promise;
    p.rendered = true;
  } catch (e) {
    if (e && e.name !== 'RenderingCancelledException') console.warn('render fail', p.num, e);
  } finally {
    p.rendering = false;
    p.renderTask = null;
  }
}

function unloadPage(p) {
  if (!p.rendered || !p.canvas) return;
  if (p.renderTask) p.renderTask.cancel();
  p.canvas.width = 0;
  p.canvas.height = 0;
  p.rendered = false;
}

function renderVisible() {
  const r = el.pdfScroll.getBoundingClientRect();
  for (const p of state.pages) {
    if (!p.el) continue;
    const pr = p.el.getBoundingClientRect();
    if (pr.bottom > r.top - 900 && pr.top < r.bottom + 900) renderPage(p);
  }
}

function setScale(next, { fit = false } = {}) {
  state.scale = clamp(next, 0.3, 4);
  state.autoFit = fit;
  for (const p of state.pages) {
    if (!p.el) continue;
    if (p.renderTask) p.renderTask.cancel();
    p.rendered = false;
    applyViewport(p);
  }
  updateZoomLabel();
  renderVisible();
  positionBars(); // 缩放后块的屏幕位置全变了
}

function updateZoomLabel() {
  el.zoomLabel.textContent = Math.round(state.scale * 100) + '%';
}

/* ------------------------------------------------------------------ */
/* 右侧卡片                                                            */
/* ------------------------------------------------------------------ */
function buildCards() {
  el.cards.innerHTML = '';
  state.cardEls.clear();
  const frag = document.createDocumentFragment();

  for (const b of state.blocks) {
    const card = document.createElement('article');
    card.className = state.selected.has(b.id) ? 'card sel' : 'card';
    card.dataset.id = b.id;
    if (b.kind && b.kind !== 'body') card.dataset.kind = b.kind;

    const meta = document.createElement('div');
    meta.className = 'card-meta';
    const pg = document.createElement('span');
    pg.className = 'pg';
    pg.textContent = b.pages && b.pages.length > 1 ? `P${b.pages[0]}–${b.pages[b.pages.length - 1]}` : 'P' + b.page;
    if (b.pages && b.pages.length > 1) pg.title = `跨页合并：P${b.pages.join(' + P')}`;
    const ord = document.createElement('span');
    ord.className = 'ord';
    ord.textContent = '#' + (b.idx + 1);
    card.dataset.ord = ord.textContent;
    const sp = document.createElement('span');
    sp.className = 'spacer';
    const btnRetry = document.createElement('button');
    btnRetry.className = 'mini';
    btnRetry.dataset.act = 'retry';
    btnRetry.textContent = '重译';
    btnRetry.title = '跳过缓存，重新调用模型翻译本段（可能产生费用）';
    const btnCopy = document.createElement('button');
    btnCopy.className = 'mini';
    btnCopy.dataset.act = 'copy';
    btnCopy.textContent = '复制';
    const partCount = mergePartCount(b);
    if (partCount > 1) {
      const btnOrder = document.createElement('button');
      btnOrder.className = 'mini always order-mini';
      btnOrder.dataset.act = 'order';
      btnOrder.textContent = `⇅ 顺序 ${partCount}`;
      btnOrder.title = `这一段由 ${partCount} 个片段合并而成，点这里调整它们的先后`;
      meta.append(pg, ord, sp, btnOrder, btnRetry, btnCopy);
    } else {
      meta.append(pg, ord, sp, btnRetry, btnCopy);
    }

    const en = document.createElement('p');
    en.className = 'en';
    en.textContent = b.text;

    const zhBox = document.createElement('div');
    zhBox.className = 'zh-box';

    card.append(meta, en, zhBox);

    if (state.editing && b.gIndex != null && b.gIndex >= 0) {
      const bar = document.createElement('div');
      bar.className = 'card-edit';
      const mvUp = document.createElement('button');
      mvUp.className = 'mini always';
      mvUp.textContent = '↑ 上移';
      mvUp.title = '与上一段交换顺序';
      mvUp.onclick = (ev) => {
        ev.stopPropagation();
        moveBlock(b, -1);
      };
      const mvDown = document.createElement('button');
      mvDown.className = 'mini always';
      mvDown.textContent = '↓ 下移';
      mvDown.title = '与下一段交换顺序';
      mvDown.onclick = (ev) => {
        ev.stopPropagation();
        moveBlock(b, 1);
      };
      const up = document.createElement('button');
      up.className = 'mini always';
      up.textContent = '↑ 并到上一段';
      up.onclick = (ev) => {
        ev.stopPropagation();
        mergeUp(b);
      };
      bar.append(mvUp, mvDown, up);
      const editPartCount = mergePartCount(b);
      if (editPartCount > 1) {
        const orderBtn = document.createElement('button');
        orderBtn.className = 'mini always order-mini';
        orderBtn.textContent = `⇅ 合并顺序 ${editPartCount}`;
        orderBtn.title = '这一段由多个片段合并而成，调整它们的先后';
        orderBtn.onclick = (ev) => {
          ev.stopPropagation();
          openMergeOrder(b);
        };
        bar.append(orderBtn);
      }
      if (b.canFit) {
        const fit = document.createElement('button');
        fit.className = 'mini always';
        fit.textContent = '⤢ 贴合';
        fit.title = '把框收回到文字的实际范围';
        fit.onclick = (ev) => {
          ev.stopPropagation();
          fitBlock(b);
        };
        bar.append(fit);
      }
      // 只有一行的块没得拆；区域段没有行，不显示
      if (!b.isArea && b.to - b.from >= 1) {
        const sb = document.createElement('button');
        sb.className = 'mini always';
        sb.textContent = state.splittingId === b.id ? '收起' : '✂ 拆分';
        sb.onclick = (ev) => {
          ev.stopPropagation();
          state.splittingId = state.splittingId === b.id ? null : b.id;
          buildCards();
        };
        bar.append(sb);
      }
      card.appendChild(bar);
      if (state.splittingId === b.id) card.appendChild(buildSplitPanel(b));
    }

    card.addEventListener('click', (ev) => {
      const act = ev.target.closest('[data-act]')?.dataset.act;
      if (act === 'retry') {
        ev.stopPropagation();
        b.status = 'idle';
        translateBlocks([b], { fresh: true });
        return;
      }
      if (act === 'order') {
        ev.stopPropagation();
        openMergeOrder(b);
        return;
      }
      if (act === 'copy') {
        ev.stopPropagation();
        navigator.clipboard
          ?.writeText(b.zh || b.text)
          .then(() => toast('已复制', 'ok'))
          .catch(() => toast('复制失败', 'err'));
        return;
      }
      if (state.editing) {
        toggleSelect(b.id);
        return;
      }
      onCardClick(b.id);
    });

    frag.appendChild(card);
    state.cardEls.set(b.id, card);
    renderZh(b);
  }

  el.cards.appendChild(frag);
  el.blockCount.textContent = state.blocks.length + ' 段';
  el.blockCount.title =
    `共 ${state.pages.length} 页 / ${state.blocks.length} 个正文块` +
    (state.annoCount ? `；另有 ${state.annoCount} 处图表内文字已跳过` : '') +
    (state.formulaCount ? `；${state.formulaCount} 个独立公式已跳过` : '');
}

/** 拆分面板：把这块的每一行列出来，在行间点"断开" */
function buildSplitPanel(b) {
  const p = state.pages[b.page - 1];
  const lines = (p.lines || []).slice(b.from - 1, b.to);
  const box = document.createElement('div');
  box.className = 'split-panel';
  lines.forEach((ln, i) => {
    if (i > 0) {
      const btn = document.createElement('button');
      btn.className = 'split-btn';
      btn.textContent = '↥ 从这里断开';
      btn.onclick = (ev) => {
        ev.stopPropagation();
        splitAt(b, ln.i);
      };
      box.appendChild(btn);
    }
    const row = document.createElement('div');
    row.className = 'split-line';
    row.textContent = ln.text;
    box.appendChild(row);
  });
  return box;
}

function renderZh(b) {
  const card = state.cardEls.get(b.id);
  if (!card) return;
  const box = card.querySelector('.zh-box');
  box.innerHTML = '';
  if (b.status === 'done' && b.zh) {
    const d = document.createElement('div');
    d.className = 'zh-done';
    d.textContent = b.zh;
    box.appendChild(d);
  } else if (b.status === 'pending') {
    box.innerHTML = '<div class="zh-pending"><div class="sk"></div><div class="sk w80"></div></div>';
  } else if (b.status === 'error') {
    const d = document.createElement('div');
    d.className = 'zh-error';
    const msg = document.createElement('span');
    msg.textContent = '翻译失败：' + (b.err || '未知错误');
    const btn = document.createElement('button');
    btn.textContent = '重试';
    btn.onclick = (ev) => {
      ev.stopPropagation();
      b.status = 'idle';
      translateBlocks([b]);
    };
    d.append(msg, btn);
    box.appendChild(d);
  }
}

/* ------------------------------------------------------------------ */
/* 联动                                                                */
/* ------------------------------------------------------------------ */
let suppressCardScrollUntil = 0;
let suppressPdfScrollUntil = 0;

function setActive(id, { scrollCard = false, scrollPdf = false } = {}) {
  if (state.activeId === id && !scrollCard && !scrollPdf) return;
  const prev = state.activeId;
  state.activeId = id;
  if (id) state.focus = { id, key: 'main' };

  if (prev && prev !== id) {
    const pb = state.byId.get(prev);
    if (pb) refreshBlockClass(pb);
    state.cardEls.get(prev)?.classList.remove('active');
  }
  const b = state.byId.get(id);
  if (!b) return;
  refreshBlockClass(b);
  state.cardEls.get(id)?.classList.add('active');

  if (scrollCard) {
    // 手动滚到"探测线"位置，避免随后的滚动监听把高亮换成相邻段落
    suppressCardScrollUntil = Date.now() + 900;
    const card = state.cardEls.get(id);
    if (card) {
      const target = card.offsetTop - 96;
      el.cards.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
    }
  }
  if (scrollPdf) scrollPdfToBlock(b);
}

function scrollPdfToBlock(b) {
  const p = state.pages[b.page - 1];
  if (!p?.el || !p.vp) return;
  const [, yTop] = p.vp.convertToViewportPoint(b.x, b.y);
  const target = p.el.offsetTop + yTop - el.pdfScroll.clientHeight * 0.28;
  suppressPdfScrollUntil = Date.now() + 700;
  el.pdfScroll.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });

  const node = p.blockEls.get(b.id);
  if (node) {
    node.classList.remove('flash');
    void node.offsetWidth;
    node.classList.add('flash');
  }
}

/* ---- 侧栏目录：与精读页共用 outline，点章节跳到对应 PDF 块 ---- */

/** 取当前论文的章节结构：先读库里缓存，没有就用分块文本现解析一次 */
async function loadTranslateOutline() {
  const id = state.docId;
  if (!id) return;
  try {
    const res = await fetch(`/api/paper/get?id=${encodeURIComponent(id)}`);
    const data = res.ok ? await res.json() : null;
    let outline = data?.paper?.outline || null;
    if (!outline?.sections?.length && state.blocks.length) {
      // 该论文还没在精读页解析过章节：用已有分块文本现跑一次（服务端会缓存）
      const text = state.blocks
        .slice()
        .sort((a, b) => a.page - b.page || (a.idx || 0) - (b.idx || 0))
        .map((b) => b.text)
        .join('\n\n');
      if (text.trim().length > 60) {
        const gen = await fetch('/api/paper/outline', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, text }),
        }).then((r) => r.json());
        outline = gen?.outline || null;
      }
    }
    state.outline = outline;
    window.paperlens?.refreshOutline?.();
  } catch {
    /* 目录加载失败不影响翻译主流程 */
  }
}

/** 章节 → 翻译页 block：复用精读页的标题匹配算法，保证两页跳到同一个标题 */
function locateTranslateSection(sec) {
  let best = null;
  let bestScore = 0;
  for (const b of state.blocks) {
    const score = headingMatchScore(
      { text: b.text, kind: b.kind, heading: b.kind === 'heading' },
      sec.number,
      sec.title,
    );
    if (score > bestScore) {
      best = b;
      bestScore = score;
    }
  }
  return bestScore >= 8 ? best : null;
}

/** 点侧栏章节：跳到翻译页 PDF 里对应的标题块并高亮 */
function jumpToTranslateSection(sectionId) {
  const sec = (state.outline?.sections || []).find((s) => s.id === sectionId);
  if (!sec) return;
  const b = locateTranslateSection(sec);
  if (!b) {
    toast(`没在原文里找到「${sec.title}」对应的位置`, 'warn');
    return;
  }
  setActive(b.id, { scrollPdf: true });
  // 高亮目录项
  $$('#side-outline [data-section]').forEach((el) => el.classList.toggle('active', el.dataset.section === sectionId));
}

/** 供外壳拉取的目录提供者 */
function getTranslateOutlineProvider() {
  if (!state.outline?.sections?.length) return null;
  return {
    outline: () => state.outline,
    expanded: () => state.outlineExpanded,
    onPick: (id) => jumpToTranslateSection(id),
    onResolve: async () => {
      state.outline = null;
      await loadTranslateOutline();
    },
  };
}

function onBlockClick(id, key = 'main') {
  if (state.editing) {
    if (state.pickMode === 'order') {
      orderPick(id);
      return;
    }
    toggleSelect(id, key);
    return;
  }
  setActive(id, { scrollCard: true });
}

function onCardClick(id) {
  setActive(id, { scrollPdf: true });
}

/* 右侧滚动 → 高亮左侧对应块（不反向拖动 PDF） */
let cardScrollRaf = 0;
let lastCardSync = 0;
function onCardsScroll() {
  if (cardScrollRaf) return;
  if (Date.now() - lastCardSync < 90) return;
  cardScrollRaf = requestAnimationFrame(() => {
    cardScrollRaf = 0;
    lastCardSync = Date.now();
    if (Date.now() < suppressCardScrollUntil) return;
    const rect = el.cards.getBoundingClientRect();
    const probe = rect.top + 96;
    let best = null;
    let bestD = Infinity;
    for (const card of el.cards.children) {
      if (!card.dataset.id) continue;
      const r = card.getBoundingClientRect();
      if (r.bottom < rect.top || r.top > rect.bottom) continue;
      const d = Math.abs(r.top - probe);
      if (d < bestD) {
        bestD = d;
        best = card;
      }
    }
    if (best && best.dataset.id !== state.activeId) setActive(best.dataset.id);
  });
}

/* PDF 滚动 → 更新页码 + 自动翻译当前页 */
let pdfScrollRaf = 0;
function onPdfScroll() {
  if (pdfScrollRaf) return;
  pdfScrollRaf = requestAnimationFrame(() => {
    pdfScrollRaf = 0;
    positionBars(); // fixed 浮层不随滚动移动，这里同帧重算，贴着选区走
    const cur = updatePageLabel();
    maybeFollowCards(cur);
    maybeAutoTranslate();
  });
}

/** 滚 PDF 时，把右栏跟到"视口顶部第一个段落"（该卡片已可见时只高亮，不滚动，避免抖动） */
function maybeFollowCards(curPage) {
  if (!el.followScroll.checked) return;
  if (Date.now() < suppressPdfScrollUntil) return;
  if (!state.blocks.length) return;

  const rect = el.pdfScroll.getBoundingClientRect();
  const probe = rect.top + 96;

  // 只检查当前页及相邻页，避免长文档每帧遍历全部页面
  const idx = curPage ? curPage.num - 1 : 0;
  const candidates = [state.pages[idx - 1], state.pages[idx], state.pages[idx + 1]].filter(Boolean);

  let target = null;
  let bestD = Infinity;
  for (const p of candidates) {
    if (!p.el) continue;
    const pr = p.el.getBoundingClientRect();
    if (pr.bottom < probe || pr.top > rect.bottom) continue;
    for (const b of p.blocks) {
      const node = p.blockEls.get(b.id);
      if (!node) continue;
      const top = pr.top + (parseFloat(node.style.top) || 0);
      if (top < probe - 10) continue;
      const d = top - probe;
      if (d < bestD) {
        bestD = d;
        target = b;
      }
    }
  }
  if (!target || target.id === state.activeId) return;

  const card = state.cardEls.get(target.id);
  if (!card) return;

  const panel = el.cards.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  const visible = cr.top >= panel.top + 30 && cr.bottom <= panel.bottom - 40;

  if (visible) {
    setActive(target.id);
    return;
  }
  suppressCardScrollUntil = Date.now() + 800;
  setActive(target.id);
  el.cards.scrollTo({ top: Math.max(0, card.offsetTop - 96), behavior: 'auto' });
}

function updatePageLabel() {
  if (!state.pages.length) return;
  const rect = el.pdfScroll.getBoundingClientRect();
  const probe = rect.top + Math.min(140, rect.height * 0.3);
  let best = state.pages[0];
  let bestD = Infinity;
  for (const p of state.pages) {
    const r = p.el.getBoundingClientRect();
    if (r.bottom < rect.top || r.top > rect.bottom) continue;
    const d = Math.abs(r.top - probe);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  el.pageLabel.textContent = `${best.num} / ${state.pages.length}`;
  // 排序是逐页做的：滚到哪一页就切到哪一页；但本页已经点了序号时别切走，
  // 免得同一屏里能看到两页时，一点滚动草稿就跳到另一页。
  if (state.editing && state.pickMode === 'order' && best.num !== state.orderPage &&
      !orderDraftOf(state.orderPage).length) {
    state.orderPage = best.num;
    renderOrderBar();
    refreshOrderMarks();
  }
  return best;
}

function maybeAutoTranslate() {
  if (!el.autoTranslate.checked) return;
  if (!cfgUsable()) return;
  const p = updatePageLabel();
  if (!p || p.autoTried || !p.blocks.length) return;
  const idle = p.blocks.filter((b) => b.status === 'idle');
  if (!idle.length) return;
  p.autoTried = true;
  translateBlocks(idle);
}

/* ------------------------------------------------------------------ */
/* 翻译                                                                */
/* ------------------------------------------------------------------ */
async function translateBlocks(list, opts = {}) {
  const todo = list.filter((b) => b.status !== 'done' && b.status !== 'pending');
  if (!todo.length) return;
  // 绑定发起时的文档：结果回来时可能已经切到别的论文，不能把 A 的译文写进 B
  const docId = state.docId;

  if (!cfgUsable()) {
    openSettings();
    toast('请先配置翻译引擎（API Key）', 'err');
    return;
  }

  state.abortBatch = false;
  todo.forEach((b) => {
    b.status = 'pending';
    b.err = null;
    renderZh(b);
    refreshBlockClass(b);
  });

  progressStart(todo.length);

  const CHUNK = 8;
  const CONCURRENCY = 3;
  let cursor = 0;

  const worker = async () => {
    while (!state.abortBatch && state.docId === docId) {
      const start = cursor;
      cursor += CHUNK;
      if (start >= todo.length) return;
      const slice = todo.slice(start, start + CHUNK);
      await runBatch(slice);
    }
  };

  const runBatch = async (slice) => {
    try {
      const resp = await fetch('/api/translate/batch', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ texts: slice.map((b) => b.text), config: state.cfg, fresh: Boolean(opts.fresh) }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        const err = new Error(data.message || `请求失败 (${resp.status})`);
        err.status = resp.status;
        err.code = data.error;
        throw err;
      }
      // 文档已经切走：这批结果直接丢弃（旧块对象随后被 GC，不会污染新文档）
      if (state.docId !== docId) {
        state.abortBatch = true;
        return;
      }
      slice.forEach((b, k) => {
        const zh = data.translations?.[k];
        if (zh && String(zh).trim()) {
          b.zh = String(zh).trim();
          b.status = 'done';
          state.zhMap.set(b.text, b.zh);
        } else {
          b.status = 'error';
          b.err = '模型未返回该段译文';
        }
        renderZh(b);
        refreshBlockClass(b);
      });
    } catch (e) {
      if (state.docId === docId) {
        slice.forEach((b) => {
          if (b.status === 'pending') {
            b.status = 'error';
            b.err = e.message;
          }
          renderZh(b);
          refreshBlockClass(b);
        });
      }
      if (e.status === 401 || e.status === 403 || e.code === 'missing_api_key') {
        state.abortBatch = true;
        openSettings();
        toast(e.message, 'err');
      }
    } finally {
      progressTick(slice.length);
      if (state.docId === docId) scheduleProjectSave();
    }
  };

  try {
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  } finally {
    progressEnd();
    if (state.docId === docId) flushProjectSave();
  }

  const failed = todo.filter((b) => b.status === 'error').length;
  if (failed && !state.abortBatch && state.docId === docId) {
    toast(`${failed} 段翻译失败，可点击「重译」重试`, 'err');
  }
}

async function translateAll() {
  if (!state.blocks.length) return;
  const idle = state.blocks.filter((b) => b.status !== 'done');
  if (!idle.length) {
    toast('全文已翻译完成', 'ok');
    return;
  }
  state.pages.forEach((p) => (p.autoTried = true));
  toast(`开始翻译 ${idle.length} 段…`);
  await translateBlocks(idle);
}

/* ------------------------------------------------------------------ */
/* 导出                                                                */
/* ------------------------------------------------------------------ */
function exportMarkdown() {
  if (!state.blocks.length) return;
  let md = `# ${state.name}\n\n> 由 PaperTrans 生成 · 共 ${state.pages.length} 页 / ${state.blocks.length} 段\n`;
  let lastPage = 0;
  for (const b of state.blocks) {
    if (b.page !== lastPage) {
      md += `\n---\n\n## 第 ${b.page} 页\n\n`;
      lastPage = b.page;
    }
    md += `**原文**\n\n> ${b.text.replace(/\n+/g, ' ')}\n\n`;
    md += b.zh ? `**译文**\n\n${b.zh}\n\n` : `**译文**\n\n_（未翻译）_\n\n`;
  }
  const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.name || 'paper'}-对照.md`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast('已导出 Markdown', 'ok');
}

/* ------------------------------------------------------------------ */
/* 工程文件：导出 / 导入                                                 */
/* ------------------------------------------------------------------ */
/** 把分段、顺序锁、译文打包成一个 JSON；不含 PDF 二进制，也不含 API Key */
function exportProject() {
  if (!state.blocks.length) return;
  const data = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    doc: { name: state.name, pages: state.pages.length, chars: docChars(), key: docKey() },
    note: '不含 PDF 原文件与 API Key。打开同一份 PDF 后会自动恢复分段、顺序与译文。',
    ...projectData(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${state.name || 'paper'}.papertrans.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  toast(`已导出工程：${data.translations.length} 段译文 / ${Object.keys(data.overrides).length} 页手动分段`, 'ok');
}

async function importProject(file) {
  if (!file) return;
  let j;
  try {
    j = JSON.parse(await file.text());
  } catch {
    toast('工程文件不是合法的 JSON', 'err');
    return;
  }
  if (j?.format !== PROJECT_FORMAT || !j.doc || typeof j.doc.key !== 'string') {
    toast('这不是 PaperTrans 工程文件', 'err');
    return;
  }
  if (Number(j.version) > PROJECT_VERSION) {
    toast('工程文件版本较新，请升级后再导入', 'err');
    return;
  }

  const overrides = j.overrides && typeof j.overrides === 'object' ? j.overrides : {};
  const translations = Array.isArray(j.translations) ? j.translations : [];
  const key = j.doc.key;

  // 按工程自带指纹落盘：打开对应 PDF 时 openFile 会自动命中
  await putProject(key, {
    name: j.doc.name || j.name || '',
    pages: j.doc.pages || 0,
    chars: j.doc.chars || 0,
    overrides,
    translations,
    savedAt: Date.now(),
  });
  const zh = new Map();
  for (const t of translations) {
    if (t && typeof t.text === 'string' && typeof t.zh === 'string' && t.zh.trim()) zh.set(t.text, t.zh);
  }

  if (state.blocks.length && docKey() === key) {
    // 指纹一致：直接重建当前文档，不用重新解析 PDF
    state.zhMap = zh;
    // 导入要覆盖现有译文：先清掉内存里的旧值，否则 applyBlocks 会把旧译文接回去
    for (const b of state.blocks) {
      b.zh = null;
      b.status = 'idle';
      b.err = null;
    }
    let pages = 0;
    for (const p of state.pages) {
      const st = normalizeStored(overrides[p.num]);
      if (!st || !p.lines?.length) continue;
      p.groups = st.groups;
      p.orderLocked = st.orderLocked;
      p.areas = [];
      p.groupsEdited = true;
      rebuildPage(p);
      pages++;
    }
    const keepY = el.pdfScroll.scrollTop;
    const keepCards = el.cards.scrollTop;
    applyBlocks();
    el.pdfScroll.scrollTop = keepY;
    el.cards.scrollTop = keepCards;
    updatePageLabel();
    renderCorrBadge();
    toast(`工程已导入：${pages} 页分段 / ${zh.size} 段译文已恢复`, 'ok');
  } else {
    const rec = state.rememberDoc ? await getPdf(key) : null;
    if (rec?.buf) {
      openFile({ name: rec.name || `${j.doc.name || 'document'}.pdf`, buffer: rec.buf });
      toast('工程已导入，正在打开对应 PDF…', 'ok');
    } else {
      toast(`工程已保存：打开「${j.doc.name || '对应'}」这份 PDF 后会自动恢复`, 'ok');
    }
  }
  refreshHistory();
}

/* ------------------------------------------------------------------ */
/* 设置弹窗                                                            */
/* ------------------------------------------------------------------ */
function openSettings() {
  const sel = $('#cfgProvider');
  sel.innerHTML = '';
  const groups = new Map();
  for (const p of CATALOG) {
    if (!groups.has(p.group)) {
      const og = document.createElement('optgroup');
      og.label = p.group;
      groups.set(p.group, og);
      sel.appendChild(og);
    }
    const o = document.createElement('option');
    o.value = p.key;
    o.textContent = p.label;
    groups.get(p.group).appendChild(o);
  }
  sel.value = state.cfg.provider || 'free';
  if (!sel.value) sel.value = CATALOG[0]?.key || 'free';

  // 记住每个服务各自填过的值，来回切换不丢 Key
  state.cfgStore = state.cfgStore || {};
  state.cfgStore[state.cfg.provider] = { ...state.cfg };
  state.lastProvider = state.cfg.provider;
  state.cfgSnapshot = { ...state.cfg }; // 取消时回滚

  renderCfgFields();
  $('#cfgRemember').checked = state.rememberDoc;
  $('#settingsModal').hidden = false;
  showStoreInfo();
  const firstInput = $('#cfgFields input');
  if (firstInput) setTimeout(() => firstInput.focus(), 40);
}

/** 设置面板底部显示数据库用量，明确「数据不在浏览器里」 */
async function showStoreInfo() {
  const node = $('#cfgStoreInfo');
  if (!node) return;
  const s = await getStoreStats();
  if (!s) {
    node.textContent = '存储服务不可用：当前改动不会被保存，请检查服务端是否已重启。';
    return;
  }
  const mb = (s.bytes / 1048576).toFixed(1);
  const kind = s.engine === 'sqlite' ? 'SQLite 数据库' : 'JSON 文件';
  node.textContent =
    `数据存在服务端 ${kind}（${mb} MB）：${s.projects} 篇文档 / ${s.pdfs} 份 PDF / ` +
    `${s.translations} 条译文缓存 / ${s.segments} 条分段缓存。浏览器本地不再保存论文数据。`;
}

function closeSettings({ restore = true } = {}) {
  // 取消时把内存里的配置还原，避免"没保存却已切了引擎"
  if (restore && state.cfgSnapshot) state.cfg = { ...state.cfgSnapshot };
  state.cfgSnapshot = null;
  $('#settingsModal').hidden = true;
  $('#testResult').textContent = '';
  $('#testResult').className = 'test-result';
  refreshEngineHint();
}

/** 关掉「记住上次文档」时，立刻移除本机保存的 PDF 原件与恢复指针 */
async function applyRememberPref(on) {
  state.rememberDoc = Boolean(on);
  setPref('remember', state.rememberDoc ? '1' : '0');
  if (!state.rememberDoc) {
    await clearLast();
    if (state.docId) await delPdf(state.docId);
    return;
  }
  if (state.docId && state.pdfBuf) {
    await putPdf(state.docId, {
      name: el.fileName.textContent || `${state.name}.pdf`,
      buf: state.pdfBuf,
      savedAt: Date.now(),
    });
    await setLast(state.docId);
  }
}

/** 按所选服务动态渲染配置项 */
function renderCfgFields() {
  const key = $('#cfgProvider').value;
  const meta = catByKey.get(key);
  const saved = state.cfgStore[key] || {};
  const box = $('#cfgFields');
  box.innerHTML = '';
  if (!meta) return;

  for (const f of meta.fields) {
    const label = document.createElement('label');
    label.className = 'field';
    const span = document.createElement('span');
    span.textContent = f.label;
    const input = document.createElement('input');
    input.type = f.type === 'password' ? 'password' : 'text';
    input.dataset.key = f.key;
    input.spellcheck = false;
    if (f.type === 'password') input.autocomplete = 'off';
    input.placeholder =
      f.key === 'apiKey' && saved.hasKey
        ? '已保存（留空表示不修改）'
        : f.placeholder || meta.defaults[f.key] || '';
    input.value = f.key === 'apiKey' ? '' : state.cfg[f.key] ?? meta.defaults[f.key] ?? '';
    label.append(span, input);
    box.appendChild(label);
  }

  // 需要 Key 的服务才显示主密码框：Key 会用主密码加密后写进 config.json
  const passField = $('#cfgPassField');
  if (passField) {
    passField.hidden = !meta.needsKey;
    const passInput = $('#cfgPass');
    if (passInput) {
      passInput.value = '';
      passInput.placeholder = saved.hasKey
        ? '已保存 Key：留空表示不修改；要换 Key 时填新 Key + 主密码'
        : '至少 6 位；只用于本机加密，不会落盘';
    }
  }

  const note = $('#cfgNote');
  const parts = [];
  if (meta.hint) parts.push(meta.hint);
  if (meta.needsKey && saved.legacy) {
    parts.push('检测到旧版明文 Key：填一次主密码保存，就会加密迁移到 config.json。');
  } else if (meta.needsKey && saved.hasKey) {
    parts.push('这个服务商的 Key 已加密保存在 config.json；浏览器不保留明文。');
  } else if (meta.needsKey) {
    parts.push('Key 会用主密码加密后保存到本机 config.json，不写浏览器。');
  }
  if (!meta.hint) parts.push(meta.needsKey ? '' : '无需 Key，选中即用。');
  note.textContent = parts.filter(Boolean).join(' ');
}

/** 切换服务：保留各家已填内容，新服务填入自己的默认地址/模型 */
function onProviderChange() {
  const key = $('#cfgProvider').value;
  const meta = catByKey.get(key);
  const prev = state.lastProvider;

  state.cfgStore = state.cfgStore || {};
  if (prev && prev !== key) state.cfgStore[prev] = cfgFromForm(prev);

  const saved = state.cfgStore[key] || {};
  state.cfg = {
    provider: key,
    baseUrl: saved.baseUrl !== undefined ? saved.baseUrl : meta?.defaults.baseUrl || '',
    model: saved.model !== undefined ? saved.model : meta?.defaults.model || '',
    apiKey: saved.apiKey || '',
    appId: saved.appId || '',
  };
  state.lastProvider = key;
  renderCfgFields();
}

function cfgFromForm(providerOverride) {
  const provider = providerOverride || $('#cfgProvider').value;
  const cfg = { provider, baseUrl: '', model: '', apiKey: '', appId: '' };
  for (const input of $$('#cfgFields input')) {
    cfg[input.dataset.key] = input.value.trim();
  }
  // 未填的地址/模型回落到默认值，避免空串覆盖
  const meta = catByKey.get(provider);
  if (meta) {
    if (!cfg.baseUrl) cfg.baseUrl = meta.defaults.baseUrl || '';
    if (!cfg.model) cfg.model = meta.defaults.model || '';
  }
  return cfg;
}

/* ------------------------------------------------------------------ */
/* 事件绑定                                                            */
/* ------------------------------------------------------------------ */
function bind() {
  $('#btnOpen').onclick = () => el.fileInput.click();
  $('#btnOpen2').onclick = () => el.fileInput.click();

  // 历史文档栏
  $('#btnSidebar').onclick = () => applySidebar(!state.sidebarOpen);
  $('#btnSideCollapse').onclick = () => applySidebar(false);
  $('#btnSideOpen').onclick = () => el.fileInput.click();
  $('#btnSideRefresh').onclick = () => {
    refreshHistory();
    toast('历史列表已刷新', '');
  };
  el.historyFilter.addEventListener('input', (e) => {
    state.historyFilter = e.target.value;
    renderHistory();
  });
  $('#btnDemo').onclick = async () => {
    try {
      const resp = await fetch('/sample/example.pdf');
      if (!resp.ok) throw new Error('示例文件缺失');
      openFile({ name: 'example.pdf', buffer: await resp.arrayBuffer() });
    } catch (e) {
      toast(e.message, 'err');
    }
  };
  el.fileInput.onchange = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) openFile(f);
  };

  $('#btnTranslateAll').onclick = translateAll;
  $('#btnExport').onclick = exportMarkdown;
  $('#btnExportProject').onclick = exportProject;
  $('#btnImportProject').onclick = () => $('#projectInput').click();
  $('#projectInput').onchange = (e) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) importProject(f);
  };

  el.cards.addEventListener('scroll', onCardsScroll, { passive: true });
  el.pdfScroll.addEventListener('scroll', onPdfScroll, { passive: true });

  $('#btnPrev').onclick = () => {
    const p = updatePageLabel();
    const target = state.pages[Math.max(0, (p?.num || 1) - 2)];
    if (target) scrollToPage(target);
  };
  $('#btnNext').onclick = () => {
    const p = updatePageLabel();
    const target = state.pages[Math.min(state.pages.length - 1, (p?.num || 1))];
    if (target) scrollToPage(target);
  };

  function scrollToPage(p) {
    suppressPdfScrollUntil = Date.now() + 600;
    el.pdfScroll.scrollTo({ top: p.el.offsetTop - 22, behavior: 'smooth' });
  }

  $('#btnZoomIn').onclick = () => setScale(state.scale * 1.15);
  $('#btnZoomOut').onclick = () => setScale(state.scale / 1.15);
  $('#btnFit').onclick = () => {
    const avail = el.pdfScroll.clientWidth - 48;
    setScale(avail / state.pages[0].base.w, { fit: true });
  };

  // 字号
  const applyFont = (v) => {
    state.fontSize = clamp(v, 13, 22);
    VIEW_ROOT?.style.setProperty('--card-font', state.fontSize + 'px');
    setPref('font', String(state.fontSize));
  };
  $('#btnFontInc').onclick = () => applyFont(state.fontSize + 1);
  $('#btnFontDec').onclick = () => applyFont(state.fontSize - 1);

  // 隐藏中文
  $('#btnToggleZh').onclick = (e) => {
    const hidden = document.body.classList.toggle('hide-zh');
    e.currentTarget.classList.toggle('primary', hidden);
    e.currentTarget.title = hidden ? '显示中文' : '隐藏中文';
  };

  // 主题与设置入口由共用顶栏触发，这里注册翻译页自己的行为
  registerTopbarActions('translate', {
    settings: openSettings,
    theme: () => {
      const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      setPref('theme', next);
    },
  });

  // AI 分段：切换后立刻按新方式重切当前文档
  el.aiSegment.checked = state.aiSegment;
  el.aiSegment.onchange = async (e) => {
    state.aiSegment = e.target.checked;
    setPref('ai', state.aiSegment ? '1' : '0');
    if (!state.doc) return;
    if (state.aiSegment && !aiUsable()) {
      toast('AI 分段需要大模型服务：请在「设置」里选 DeepSeek / Gemini / Claude 等', 'err');
    }
    setBusy('正在重新切分…');
    const hadZh = state.blocks.some((b) => b.zh);
    await buildDocumentBlocks();
    dropRunningHeaders(state.pages);
    applyBlocks();
    setBusy(null);
    updatePageLabel();
    if (hadZh) toast('已重新切分，卡片按新的段落重建；段落边界变了，译文需要重新翻译一次', '');
    setTimeout(maybeAutoTranslate, 150);
  };

  // 手动分段
  $('#btnEdit').onclick = () => {
    state.editing = !state.editing;
    state.splittingId = null;
    if (!state.editing) state.pickMode = 'block';
    clearSelection();
    clearLineSel();
    document.body.classList.toggle('editing', state.editing);
    document.body.classList.toggle('line-mode', state.editing && state.pickMode === 'line');
    document.body.classList.toggle('area-mode', state.editing && state.pickMode === 'area');
    document.body.classList.toggle('order-mode', state.editing && state.pickMode === 'order');
    $('#btnEdit').classList.toggle('primary', state.editing);
    $('#btnUndo').hidden = !state.editing;
    $('#modeSwitch').hidden = !state.editing;
    syncModeSwitch();
    buildCards();
    renderSelBar();
    renderLineBar();
    renderOrderBar();
    refreshOrderMarks();
    toast(
      state.editing
        ? '编辑模式：按段（点/框选整段合并删除）或按行（点选行新建段落、并入相邻段）'
        : '已退出编辑模式',
      ''
    );
  };
  $('#modeSwitch').onclick = (ev) => {
    const mode = ev.target.closest('.chip')?.dataset.mode;
    if (mode) setPickMode(mode);
  };
  $('#btnNewGroup').onclick = () => newGroupFromLines();
  $('#btnJoinPrev').onclick = () => joinLinesTo('prev');
  $('#btnJoinNext').onclick = () => joinLinesTo('next');
  $('#btnDelLines').onclick = () => dropLines();
  $('#btnClearLines').onclick = () => clearLineSel();
  $('#btnMergeSel').onclick = () => mergeSelected();
  $('#btnDelSel').onclick = () => deleteSelected();
  $('#btnClearSel').onclick = () => clearSelection();
  $('#btnUndo').onclick = () => undoEdit();

  // 手动指定本页分段顺序
  $('#btnOrderUndo').onclick = () => {
    orderDraftOf(state.orderPage).pop();
    refreshOrderMarks();
    renderOrderBar();
  };
  $('#btnOrderClear').onclick = () => {
    orderDraftOf(state.orderPage).length = 0;
    refreshOrderMarks();
    renderOrderBar();
  };
  $('#btnOrderApply').onclick = () => applyPageOrder();
  $('#btnOrderReset').onclick = () => resetPageOrder();
  $('#btnOrderExit').onclick = () => setPickMode('block');
  $('#corrBadge').onclick = () => exportCorrections();

  // 设置弹窗
  $('#btnCloseCfg').onclick = closeSettings;
  $('#btnCancelCfg').onclick = closeSettings;
  $('#settingsModal').addEventListener('click', (e) => {
    if (e.target === el.settingsModal) closeSettings();
  });
  $('#cfgProvider').onchange = onProviderChange;
  $('#btnMergeOrderApply').onclick = applyMergeOrder;
  $('#btnMergeOrderCancel').onclick = closeMergeOrder;
  $('#btnCloseMergeOrder').onclick = closeMergeOrder;

  $('#btnSaveCfg').onclick = async () => {
    const cfg = cfgFromForm();
    const passphrase = $('#cfgPass')?.value || '';
    try {
      await saveCfg(cfg, passphrase);
    } catch (e) {
      const note = $('#cfgNote');
      note.textContent = e.message;
      note.classList.add('warn');
      toast(e.message, 'err');
      return;
    }
    const note = $('#cfgNote');
    note.classList.remove('warn');
    await applyRememberPref($('#cfgRemember').checked);
    closeSettings({ restore: false });
    toast('设置已保存（Key 已加密存储）', 'ok');
  };
  $('#btnTest').onclick = async () => {
    const out = $('#testResult');
    out.className = 'test-result';
    out.textContent = '测试中…';
    try {
      const resp = await fetch('/api/translate/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ config: cfgFromForm() }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || '失败');
      out.className = 'test-result ok';
      out.textContent = `连接正常 · ${data.ms}ms · ${data.sample}`;
    } catch (e) {
      out.className = 'test-result err';
      out.textContent = e.message;
    }
  };

  // 分隔条拖拽
  let dragging = false;
  let splitPctDraft = null;
  el.divider.addEventListener('pointerdown', (e) => {
    dragging = true;
    el.divider.classList.add('dragging');
    el.divider.setPointerCapture(e.pointerId);
    document.body.style.cursor = 'col-resize';
  });
  el.divider.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = el.split.getBoundingClientRect();
    const pct = clamp(((e.clientX - rect.left) / rect.width) * 100, 25, 78);
    el.split.style.setProperty('--left-w', pct + '%');
    splitPctDraft = pct;
    positionBars(); // 左栏宽度变了，浮层要重新夹回左栏内
  });
  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    if (splitPctDraft != null) {
      setPref('split', String(splitPctDraft)); // 拖完只写一次，避免拖动时刷请求
      splitPctDraft = null;
    }
    el.divider.classList.remove('dragging');
    document.body.style.cursor = '';
    if (state.autoFit && state.pages.length) $('#btnFit').click();
  };
  el.divider.addEventListener('pointerup', endDrag);
  el.divider.addEventListener('pointercancel', endDrag);

  // 窗口尺寸变化
  let resizeTimer = null;
  window.addEventListener('resize', () => {
    if (!isActive()) return;
    clearTimeout(resizeTimer);
    positionBars();
    resizeTimer = setTimeout(() => {
      if (state.autoFit && state.pages.length) {
        const avail = el.pdfScroll.clientWidth - 48;
        setScale(avail / state.pages[0].base.w, { fit: true });
      }
    }, 220);
  });

  // 拖拽载入
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!isActive()) return;
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    dragDepth++;
    document.body.classList.add('drop-active');
  });
  window.addEventListener('dragover', (e) => {
    if (!isActive()) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) document.body.classList.remove('drop-active');
  });
  window.addEventListener('drop', (e) => {
    if (!isActive()) return;
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('drop-active');
    const f = e.dataTransfer?.files?.[0];
    if (f) openFile(f);
  });

  // 快捷键
  window.addEventListener('keydown', (e) => {
    if (!isActive()) return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'o') {
      e.preventDefault();
      el.fileInput.click();
    }
    // Ctrl/Cmd+B：展开 / 收起历史文档栏
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'b') {
      e.preventDefault();
      applySidebar(!state.sidebarOpen);
    }
    if (e.key === 'Escape') {
      if (!el.settingsModal.hidden) closeSettings();
      else if (state.historyConfirm) {
        state.historyConfirm = '';
        renderHistory();
      }
    }
  });
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */
/** 把 SQLite 里的偏好应用到内存与 DOM；启动和旧数据迁移后各跑一次 */
function applyPrefs() {
  const savedFont = Number(prefs.font);
  if (savedFont) {
    state.fontSize = savedFont;
    VIEW_ROOT?.style.setProperty('--card-font', savedFont + 'px');
  }
  const splitPct = Number(prefs.split);
  if (splitPct) el.split.style.setProperty('--left-w', clamp(splitPct, 25, 78) + '%');
  state.cfg = loadCfg();
  state.cfgStore = loadCfgStore();
  state.aiSegment = prefs.ai === '1';
  state.rememberDoc = prefs.remember !== '0';
  // 侧栏开合已经由外壳统一管理（localStorage: paperlens.sidebar）
  // 这里只把状态同步过来，避免旧的 translate 偏好把共用的侧栏又收起来
  applySidebar(!document.body.classList.contains('sidebar-collapsed'), { persist: false });
}

async function boot() {
  setStoreWarnHandler(() =>
    toast('无法写入服务端数据库，改动可能没保存；请确认服务已重启', 'err')
  );

  // 后端改动必须重启服务；旧服务没有 /api/store/*，先给出明确提示
  const probe = await fetch('/api/store/stats').catch(() => null);
  const storeReady = Boolean(probe?.ok);

  await prefsReady; // 设置、修正记录等从服务端读取
  applyPrefs();

  if (!storeReady) {
    toast('服务端还是旧版：请重启 npm start，否则分段、译文和设置都不会保存', 'err');
  } else {
    // 旧版把数据存在浏览器里：一次性搬到 SQLite，成功后清掉本地副本释放空间
    let mig = { cleaned: false };
    try {
      mig = await migrateBrowserData();
    } catch {}
    if (mig.cleaned) {
      applyPrefs();
      if (mig.projects || mig.pdfs || mig.overrides) {
        toast(
          `已把 ${mig.projects} 篇文档 / ${mig.pdfs} 份 PDF / ${mig.overrides} 页分段迁到服务端数据库，浏览器空间已释放`,
          'ok'
        );
      }
    } else if (mig.failed) {
      toast('旧版本地数据迁移失败，原数据仍保留，下次启动会重试', 'err');
    }
  }

  bind();
  refreshHistory(); // 历史栏即使收起也先备好数据，展开时直接可用

  // 刷新 / 切走页面前，把翻译防抖里还没落盘的改动推出去
  let hiddenFlushed = false;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden' && !hiddenFlushed) {
      hiddenFlushed = true;
      flushProjectSave();
    } else if (document.visibilityState === 'visible') {
      hiddenFlushed = false;
    }
  });

  try {
    const [cfgResp, provResp] = await Promise.all([fetch('/api/translate/config'), fetch('/api/translate/providers')]);
    const j = await cfgResp.json();
    state.serverKey = Boolean(j.serverKey);

    const pj = await provResp.json();
    CATALOG = Array.isArray(pj.providers) && pj.providers.length ? pj.providers : FALLBACK_CATALOG;
    catByKey.clear();
    for (const p of CATALOG) catByKey.set(p.key, p);

    applyServerTranslate(j);
    if (state.translateLocked) {
      toast('翻译 Key 已加密：打开「设置」输入主密码解锁后即可翻译', '');
    }
  } catch {} finally {
    if (!CATALOG.length) {
      CATALOG = FALLBACK_CATALOG;
      for (const p of CATALOG) catByKey.set(p.key, p);
    }
    refreshEngineHint();
  }

  if (new URLSearchParams(location.search).get('demo') === '1') {
    try {
      const resp = await fetch('/sample/example.pdf');
      if (resp.ok) openFile({ name: 'example.pdf', buffer: await resp.arrayBuffer() });
    } catch {}
  } else if (state.rememberDoc && isActive()) {
    // 刷新后自动重开上次文档；openFile 会按指纹把分段与译文一起读回来
    try {
      const last = await getLast();
      if (last) {
        const rec = await getPdf(last);
        if (rec?.buf) await openFile({ name: rec.name || 'document.pdf', buffer: rec.buf });
        else await clearLast();
      }
    } catch {}
  }
}

// 供外壳共享侧栏目录使用（shell.js 按当前视图拉取）
window.paperlens = {
  ...(window.paperlens || {}),
  getTranslateOutlineProvider,
};

boot();
