import { createDiagram } from './diagram.js';
import { createPdfView, openPdfDocument } from './pdfview.js';
import { extractDocumentBlocks } from './blocks.js';
import { renderMathIn } from './math.js';
import { getReportHtml, printReport, qaPairs, reportFilename, saveReportHtml } from './report.js';
import { escapeHtml, isSectionTitle, markAskCitations, parseReading, renderBlocks, splitParagraphs } from './text.js';
import { registerTopbarActions } from './topbar.js';

/* --------------------------------- 基础工具 -------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const LS_PAPER = 'paperlens.paper';
const LS_THEME = 'paperlens.theme';
const LS_DIAGRAM = 'paperlens.diagramCollapsed';
const LS_PAPER_WIDTH = 'paperlens.paperWidth';

/** 39,755 → 39.8k，给原文栏那行统计省宽度 */
/** 合并两次调用的用量（精读 + 结构化），费用直接相加 */
function mergeUsage(a, b) {
  if (!a) return b ? { ...b } : null;
  if (!b) return { ...a };
  return {
    prompt: (a.prompt || 0) + (b.prompt || 0),
    completion: (a.completion || 0) + (b.completion || 0),
    cached: (a.cached || 0) + (b.cached || 0),
    total: (a.total || 0) + (b.total || 0),
    cost: a.cost === null || b.cost === null ? null : (Number(a.cost) || 0) + (Number(b.cost) || 0),
  };
}

/**
 * 本篇累计用量：独立于「本次精读」的 readingUsage，重跑精读/清空追问都不归零。
 * 只有换论文时才重置；每次产生用量（精读/结构化/追问）都累加进来。
 */
function totalUsage() {
  return state.paperUsage;
}

/** 把一次调用的用量累加进本篇累计，并刷新徽标 */
function accumulateUsage(usage) {
  if (!usage) return;
  state.paperUsage = mergeUsage(state.paperUsage, usage);
  paintTotalUsage();
}

/** 精读栏标题区的「本篇累计」徽标 */
function paintTotalUsage() {
  const el = $('#total-usage');
  if (!el) return;
  const info = usageText(totalUsage());
  if (!info) {
    el.hidden = true;
    el.textContent = '';
    el.title = '';
    return;
  }
  el.hidden = false;
  el.textContent = `本篇累计 ${info.short}`;
  el.title = `本篇论文累计用量（精读 + 结构化 + 所有追问）\n${info.title}`;
}

/** 精读状态栏：基础文案 + 用量合计 */
function paintReadingStatus(base) {
  const el = $('#reading-status');
  const info = usageText(state.readingUsage);
  el.textContent = info ? `${base} · ${info.short}` : base;
  el.title = info ? info.title : '';
  paintTotalUsage();
}

/** 用量对象 → 状态栏文案；无用量返回空串 */
function usageText(u) {
  if (!u || !Number(u.total)) return '';
  const tokens = Number(u.total) >= 1000 ? `${(u.total / 1000).toFixed(1).replace(/\.0$/, '')}k` : String(u.total);
  let cost = '';
  if (u.cost === null || u.cost === undefined) cost = ' · 未配置单价';
  else if (Number(u.cost) > 0) {
    const v = Number(u.cost);
    const text = v < 0.000001 ? '<¥0.000001' : `¥${v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
    cost = ` · ${text}`;
  }
  const detail = `输入 ${u.prompt || 0}${u.cached ? `（缓存 ${u.cached}）` : ''} · 输出 ${u.completion || 0}${cost} · 估算，以账单为准`;
  return { short: `${tokens} tokens${cost}`, title: detail };
}

function formatCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1e4) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return v.toLocaleString();
}

const state = {
  paper: { title: '', text: '', source: '' },
  paperId: '',
  blocks: null,
  translations: [],
  library: [],
  readingText: '',
  readingError: '',
  structure: null,
  config: null,
  presets: {},
  running: false,
  readingStreaming: false,
  abort: null,
  aborted: false,
  selection: '',
  askThread: [],
  webSearch: localStorage.getItem('paperlens.askWeb') !== '0',
  readingUsage: null,
  paperUsage: null,
  outline: null,
  outlineExpanded: new Set(),
  hasPdf: false,
  pdfReady: null,
  pdfPages: 0,
  paperView: 'text',
};

// 追问轮次：每个「问题 + 回答」共用一个 id，供单轮删除使用
let askTurnSeq = 0;
const askControllers = new Map();
function nextAskTurn() {
  return `t${++askTurnSeq}`;
}

const diagram = createDiagram($('#diagram-host'), {
  onNodeClick: (nodeId, node) => {
    if (!nodeId || !node) {
      $$('#concept-list .concept-chip').forEach((c) => c.classList.remove('active'));
      return;
    }
    highlightConceptForNode(node);
  },
});
const pdfView = createPdfView($('#paper-pdf'), {
  onAsk: (text) => promptAskWith(text),
  onNotice: (msg) => toast(msg),
});

let toastTimer = 0;
function toast(message, ms = 2400) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

/* --------------------------------- SSE 读取 -------------------------------- */

async function streamRequest(url, body, onEvent, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    let message = `请求失败（${res.status}）`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  if (!res.body) throw new Error('浏览器不支持流式响应');

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      try {
        onEvent(JSON.parse(payload));
      } catch {
        /* 心跳等非 JSON 片段 */
      }
    }
  }
}

async function postJson(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

/* ------------------------------- 知识图谱联动 ------------------------------- */

const LS_KG = 'paperlens.kg';

/** 推送记录：兼容旧的单条对象与新式数组 */
function graphLinks() {
  let data;
  try {
    data = JSON.parse(localStorage.getItem(LS_KG) || 'null');
  } catch {
    return [];
  }
  const list = Array.isArray(data) ? data : data ? [data] : [];
  return list.filter((x) => x && x.sourceId);
}

function saveGraphLinks(links) {
  localStorage.setItem(LS_KG, JSON.stringify(links));
}

/** 当前论文已推送到的图谱记录（标题 + 正文字数一致即视为同一篇） */
function graphLinkMatches() {
  return graphLinks().filter(
    (x) => x.title === state.paper.title && x.textLen === state.paper.text.length,
  );
}

function updateGraphButton() {
  const btn = $('#btn-to-graph');
  if (!btn) return;
  const links = graphLinkMatches();
  btn.dataset.linked = links.length ? '1' : '';
  btn.textContent = links.length ? `已在 ${links.length} 个图谱中 · 查看` : '→ 知识图谱';
  btn.title = links.length
    ? `打开知识图谱中这条资料的出处（已推送到 ${links.map((x) => x.graphName || x.graphId || '默认').join('、')}）`
    : '把论文、精读与概念推送到知识图谱';
}

/**
 * 弹出「选择目标图谱」对话框。
 * @returns {Promise<Array<{id,name}>|null>} 选中的图谱；取消返回 null
 */
function openPushGraphDialog(graphs, currentGraphId, pushedIds) {
  const dlg = $('#dlg-push-graph');
  const list = $('#push-graph-list');
  const error = $('#push-graph-error');
  error.hidden = true;
  if (!graphs.length) {
    toast('还没有知识图谱，请先到知识图谱页创建一个');
    return Promise.resolve(null);
  }
  list.innerHTML = graphs
    .map((g) => {
      const checked = pushedIds.has(g.id) || (g.id === currentGraphId && !pushedIds.size) || g.active;
      const note = pushedIds.has(g.id) ? '<span class="push-graph-done">已推送</span>' : '';
      return `<label class="push-graph-row"><input type="checkbox" data-graph-id="${escapeHtml(g.id)}"${checked ? ' checked' : ''} /><span class="push-graph-name">${escapeHtml(g.name || g.id)}</span>${note}</label>`;
    })
    .join('');

  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      dlg.close();
      resolve(value);
    };
    $('#btn-push-graph-close').onclick = () => finish(null);
    $('#btn-push-graph-confirm').onclick = () => {
      const picked = $$('#push-graph-list input:checked').map((el) => ({
        id: el.dataset.graphId,
        name: el.closest('.push-graph-row').querySelector('.push-graph-name').textContent,
      }));
      if (!picked.length) {
        error.textContent = '请至少选择一个知识图谱';
        error.hidden = false;
        return;
      }
      finish(picked);
    };
    dlg.addEventListener('cancel', () => finish(null), { once: true });
    openDialog('#dlg-push-graph');
  });
}

/**
 * 一键入库：论文正文 + 精读 + 结构化结果，推送到用户选中的多个图谱。
 * 注意：?graph= 会全局激活目标图谱，因此必须串行，且结束后恢复原激活图谱。
 */
async function pushToGraph() {
  if (!state.paper.text) return toast('先放一篇论文进来');
  if (!state.readingText.trim()) return toast('先生成精读，再推送到知识图谱');

  // 拉图谱列表 + 当前已推送记录，弹出多选对话框
  let graphs = [];
  let originalGraphId = '';
  try {
    const res = await fetch('/api/kg/graphs').then((r) => r.json());
    graphs = Array.isArray(res.graphs) ? res.graphs : [];
    originalGraphId = res.graph?.id || '';
  } catch (err) {
    return toast(`读取图谱列表失败：${err.message}`);
  }
  const existing = graphLinkMatches();
  const picked = await openPushGraphDialog(
    graphs,
    originalGraphId,
    new Set(existing.map((x) => x.graphId)),
  );
  if (!picked) return;

  const btn = $('#btn-to-graph');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '推送中…';
  try {
    if (!state.paperId) await saveCurrentPaper();
    const payload = {
      paper: {
        id: state.paperId || '',
        title: state.paper.title,
        text: state.paper.text,
        source: state.paper.source,
      },
      paperId: state.paperId || '',
      reading: state.readingText,
      structure: state.structure,
      enrich: Boolean(state.config?.ready),
    };

    const done = [];
    let lastResult = null;
    // 串行：每次 ?graph= 会切换服务端激活图，不能并发
    for (const g of picked) {
      const res = await postJson(`/api/kg/import/paper?graph=${encodeURIComponent(g.id)}`, payload);
      if (res.ok === false) throw new Error(`「${g.name}」推送失败：${res.error || '未知错误'}`);
      done.push({
        graphId: g.id,
        graphName: g.name,
        sourceId: res.source?.id || '',
        title: state.paper.title,
        textLen: state.paper.text.length,
        at: Date.now(),
      });
      lastResult = res;
    }

    // 合并推送记录：同一篇论文 + 同一图谱只保留最新
    const rest = graphLinks().filter(
      (x) => !(x.title === state.paper.title && x.textLen === state.paper.text.length && done.some((d) => d.graphId === x.graphId)),
    );
    saveGraphLinks([...rest, ...done]);
    updateGraphButton();

    const count = lastResult?.concepts?.length || 0;
    toast(`已推送到 ${done.length} 个图谱，共 ${count} 个概念（每图）`);

    // 恢复用户原本激活的图谱，避免被最后一次 ?graph= 改掉
    if (originalGraphId) {
      try {
        await postJson('/api/kg/graphs/activate', { id: originalGraphId });
      } catch {
        /* 恢复失败不影响推送结果 */
      }
    }
  } catch (err) {
    toast(`推送失败：${err.message}`);
  } finally {
    btn.disabled = false;
    if (!btn.dataset.linked) btn.textContent = oldText;
  }
}

/** 从知识图谱回跳：/?fromSource=<sourceId> 载入该资料的论文原文 */
async function loadFromSource() {
  const id = new URLSearchParams(location.search).get('fromSource');
  if (!id) return false;
  try {
    const res = await postJson('/api/kg/sources/text', { id });
    if (!res?.ok || !res.text) return false;
    setPaper({ title: res.source?.title || '', text: res.text, source: res.source?.url || '' });
    toast('已从知识图谱载入论文原文');
    return true;
  } catch (err) {
    toast(`从知识图谱载入失败：${err.message}`);
    return false;
  }
}

/* -------------------------------- 论文库持久化 ------------------------------- */

const LS_LAST_PAPER = 'paperlens.lastPaperId';
let paperSaveTimer = 0;
let paperSaving = false;
let paperSaveAgain = false;

function paperPayload() {
  return {
    id: state.paperId || undefined,
    title: state.paper.title,
    source: state.paper.source,
    kind: state.hasPdf ? 'pdf' : 'text',
    text: state.paper.text,
    reading_md: state.readingText,
    reading_model: state.config?.model || '',
    structure: state.structure,
    ask_thread: state.askThread,
    usage: state.readingUsage,
    paperUsage: state.paperUsage,
    outline: state.outline,
  };
}

function schedulePaperSave(delay = 900) {
  if (!state.paper.text) return;
  clearTimeout(paperSaveTimer);
  paperSaveTimer = setTimeout(() => saveCurrentPaper(), delay);
}

async function saveCurrentPaper() {
  if (!state.paper.text) return;
  if (paperSaving) {
    paperSaveAgain = true;
    return;
  }
  paperSaving = true;
  try {
    const res = await postJson('/api/paper/save', paperPayload());
    if (res.ok && res.paper?.id) {
      state.paperId = res.paper.id;
      localStorage.setItem(LS_LAST_PAPER, res.paper.id);
    }
  } catch {
    /* 保存失败不打断阅读 */
  } finally {
    paperSaving = false;
    if (paperSaveAgain) {
      paperSaveAgain = false;
      schedulePaperSave(300);
    }
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function restorePdfFromServer(id) {
  try {
    const res = await fetch(`/api/paper/pdf?id=${encodeURIComponent(id)}`);
    if (!res.ok) return false;
    const bytes = await res.arrayBuffer();
    if (!state.blocks?.length) {
      const shared = await buildSharedBlocks(bytes, { quiet: true });
      if (shared?.length) {
        state.blocks = shared;
        await saveBlocksToServer(id, shared);
      }
    }
    const result = await pdfView.load(bytes, { blocks: state.blocks });
    state.hasPdf = true;
    state.pdfPages = result.numPages;
    $('#paper-view-switch').hidden = false;
    // 只有 PDF 的论文：把解析出的段落补成正文，精读才有东西可读
    if (!state.paper.text && String(result.text || '').trim().length > 100) {
      state.paper.text = result.text;
      renderPaper();
      renderOutline(); // PDF 抽出正文后才显示章节入口
      schedulePaperSave(600);
      if (!state.outline) loadOutline();
    }
    switchPaperView('pdf');
    return true;
  } catch (err) {
    toast(`PDF 恢复失败：${err.message}`);
    return false;
  }
}

/** 把论文库记录贴回界面：正文、精读、结构化、追问、PDF */
function applyPaperRecord(record) {
  state.paperId = record.id;
  localStorage.setItem(LS_LAST_PAPER, record.id);
  // 必须在 setPaper() 之前恢复：setPaper 内部有延迟保存，
  // 若此时 readingUsage / outline 还是旧值，会把库里正确的数据覆盖掉
  // paper_usage_json 存本篇累计（跨多次精读/追问）；usage_json 只存本次精读。
  // 老论文没有 paperUsage 字段：用 usage 兜底一次，之后走独立累计。
  state.paperUsage = record.paperUsage || record.usage || null;
  state.readingUsage = record.usage || null;
  state.outline = record.outline || null;
  setPaper({ title: record.title, text: record.text, source: record.source }, { keepReading: true });
  // 翻译页抽好的分块：有就直接用，两个视图的框才能对得上
  state.blocks = Array.isArray(record.blocks?.blocks) ? record.blocks.blocks : null;
  // 同一份译文：点段落时卡片里直接给中文对照
  state.translations = Array.isArray(record.translations) ? record.translations : [];
  pdfView.setTranslations(state.translations);

  state.readingText = record.reading_md || '';
  state.readingError = '';
  readingCards = [];
  if (state.readingText.trim()) {
    paintReading();
    paintReadingStatus('已保存');
  } else {
    clearReading();
  }

  if (record.structure && typeof record.structure === 'object') {
    state.structure = record.structure;
    renderStructure(record.structure);
  } else {
    renderStructure(null);
  }

  clearAskThread();
  let restoredTurn = '';
  for (const msg of Array.isArray(record.ask_thread) ? record.ask_thread : []) {
    if (!msg || !msg.role) continue;
    // 老记录没有轮次 id：按 user→assistant 顺序重建，后续回答沿用该轮 id
    if (msg.role === 'user') restoredTurn = nextAskTurn();
    pushAsk(msg.role, String(msg.text || ''), String(msg.quote || ''), msg.usage || null, restoredTurn);
  }
  paintTotalUsage();

  // PDF 异步恢复：存下 Promise，供目录跳转等待（否则刚打开就点目录会误跳文本视图）
  state.pdfReady = record.hasPdf
    ? restorePdfFromServer(record.id)
    : Promise.resolve(false);
  updateGraphButton();
  // 老论文可能没有 anchors（概念会退化成从头找词→跳摘要），自动补算一次
  ensureStructureAnchors(record.id);
}

/** 补齐老论文的 concept anchors：用已有 outline + 正文补算，不重跑精读/模型 */
async function ensureStructureAnchors(id) {
  const concepts = state.structure?.concepts || [];
  if (!concepts.length || !state.outline?.sections?.length) return;
  if (concepts.every((c) => Array.isArray(c.anchors))) return;
  try {
    const res = await postJson('/api/paper/anchors', { id });
    if (res.ok && res.structure?.concepts?.length) {
      state.structure = res.structure;
      renderStructure(res.structure);
      renderOutline();
    }
  } catch {
    /* 补算失败不影响主流程 */
  }
}

async function loadPaperById(id) {
  if (!id) return false;
  try {
    const res = await fetch(`/api/paper/get?id=${encodeURIComponent(id)}`).then((r) => r.json());
    if (!res.ok || !res.paper) return false;
    applyPaperRecord(res.paper);
    return true;
  } catch {
    return false;
  }
}

/** 启动时优先 ?paper=<id>，其次上次打开的论文库记录，最后浏览器本地缓存 */
async function loadInitialPaper() {
  const wanted =
    new URLSearchParams(location.search).get('paper') || localStorage.getItem(LS_LAST_PAPER) || '';
  if (wanted && (await loadPaperById(wanted))) return true;
  const restored = restorePaper();
  if (restored) schedulePaperSave(0);
  return restored;
}

async function refreshLibrary() {
  try {
    const res = await fetch('/api/paper/library').then((r) => r.json());
    state.library = res.papers || [];
  } catch {
    state.library = [];
  }
  renderLibrary();
}

function renderLibrary() {
  const host = $('#library-list');
  if (!host) return;
  if (!state.library.length) {
    host.innerHTML = '<p class="hint">论文库还是空的。载入并精读一篇论文后会自动保存到这里。</p>';
    return;
  }
  host.innerHTML = state.library
    .map(
      (paper) => `<div class="lib-item" data-id="${escapeHtml(paper.id)}">
        <button class="lib-open" type="button" data-id="${escapeHtml(paper.id)}">
          <strong>${escapeHtml(paper.title || '未命名论文')}</strong>
          <small>${Number(paper.chars || 0).toLocaleString()} 字 · ${paper.hasReading ? '有精读' : '未精读'} · ${new Date(paper.updatedAt).toLocaleString()}</small>
        </button>
        <button class="btn tiny ghost lib-del" type="button" data-del="${escapeHtml(paper.id)}" title="从论文库删除">删除</button>
      </div>`,
    )
    .join('');
}

async function deleteLibraryPaper(id) {
  try {
    const res = await postJson('/api/paper/delete', { id });
    if (!res.ok) return toast('删除失败');
    if (state.paperId === id) {
      state.paperId = '';
      localStorage.removeItem(LS_LAST_PAPER);
    }
    await refreshLibrary();
    toast('已从论文库删除');
  } catch (err) {
    toast(`删除失败：${err.message}`);
  }
}

/**
 * 抽一份 PDF 的规范分块（与翻译页同一套 extractor），失败返回 null。
 * 精读页自己上传的 PDF 也走这条路，所以第一次打开就有共享分块。
 */
async function buildSharedBlocks(bytes, { quiet = false } = {}) {
  try {
    const doc = await openPdfDocument(bytes.slice(0));
    const total = doc.numPages;
    const blocks = await extractDocumentBlocks(doc, {
      onProgress: (done, all) => {
        if (!quiet) $('#upload-status').textContent = `正在提取分块 ${done}/${all}…`;
      },
    });
    try {
      doc.destroy();
    } catch {
      /* 已销毁 */
    }
    return blocks;
  } catch (err) {
    console.warn('[blocks] 提取失败', err);
    return null;
  }
}

async function saveBlocksToServer(id, blocks) {
  if (!id || !blocks?.length) return;
  try {
    await postJson('/api/paper/blocks', { id, hash: id, blocks, generator: 'extract/4.10' });
  } catch (err) {
    console.warn('[blocks] 写入失败', err);
  }
}

async function uploadPdfToServer(bytes) {
  if (!state.paperId && state.paper.text) await saveCurrentPaper();
  if (!state.paperId) return;
  try {
    const base64 = await blobToBase64(new Blob([bytes], { type: 'application/pdf' }));
    await postJson('/api/paper/pdf', { id: state.paperId, base64 });
    await saveBlocksToServer(state.paperId, state.blocks);
    schedulePaperSave(0);
  } catch (err) {
    toast(`PDF 保存失败：${err.message}`);
  }
}

/** 从图谱出处回跳时定位到那一句（文本视图） */
function locateQuoteInText(quote) {
  const needle = String(quote || '').trim();
  if (!needle) return false;
  const body = $('#paper-body');
  if (!body || body.hidden) return false;
  const nodes = [...body.querySelectorAll('p, li, h1, h2, h3, h4')];
  const head = needle.slice(0, 24);
  const target = nodes.find((node) => node.textContent.includes(needle)) ||
    nodes.find((node) => node.textContent.includes(head));
  if (!target) return false;
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  target.classList.add('quote-flash');
  setTimeout(() => target.classList.remove('quote-flash'), 2400);
  return true;
}

/* --------------------------------- 论文原文 -------------------------------- */

function renderPaper() {
  const body = $('#paper-body');
  const empty = $('#paper-empty');
  const parts = splitParagraphs(state.paper.text);

  if (!parts.length) {
    body.hidden = true;
    // 只有 PDF、还没抽正文时，空态会盖住原版页面 —— 有 PDF 就不显示空态
    empty.hidden = Boolean(state.hasPdf);
    $('#paper-stats').textContent = '';
    return;
  }

  empty.hidden = true;
  body.hidden = !state.paper.text || (state.hasPdf && state.paperView === 'pdf');
  const sectionOf = state.outline?.sectionOf || [];
  const sections = state.outline?.sections || [];
  body.innerHTML = parts
    .map((para, i) => {
      const cls = isSectionTitle(para) ? ' section-title' : '';
      const secIdx = sectionOf[i];
      const sec = secIdx >= 0 ? sections[secIdx] : null;
      const data = `data-i="${i}"${sec ? ` data-section="${escapeHtml(sec.id)}"` : ''}`;
      return `<p ${data}${cls ? ` class="${cls.trim()}"` : ''}>${escapeHtml(para)}</p>`;
    })
    .join('');

  const words = state.paper.text.replace(/\s+/g, '').length;
  $('#paper-stats').textContent = `${formatCount(words)} 字 · ${parts.length} 段`;
}

/* ------------------------------ 论文章节目录 ------------------------------ */

/** 章节解析用的正文：纯文本论文用 paper.text，PDF 论文复用 pdfView 已抽好的文本 */
function paperTextForOutline() {
  const direct = String(state.paper?.text || '').trim();
  if (direct.length > 60) return direct;
  if (pdfView.isLoaded()) {
    const pdfText = String(pdfView.getText() || '').trim();
    if (pdfText.length > 60) return pdfText;
  }
  return '';
}

/** 按 concept 的 anchor.section 反查每节涉及的概念 */
function conceptsBySection() {
  const map = new Map();
  for (const c of state.structure?.concepts || []) {
    const anchors = Array.isArray(c.anchors) ? c.anchors : [];
    const sid = anchors[0]?.section || '';
    if (!sid) continue;
    if (!map.has(sid)) map.set(sid, []);
    map.get(sid).push(c);
  }
  return map;
}

/**
 * 精读页目录提供者：shell.js 按当前视图拉取，统一渲染/展开/点击分发。
 * 返回 null 表示当前没有可用正文，目录不显示。
 */
function getPaperOutlineProvider() {
  if (!paperTextForOutline() && !state.outline?.sections?.length) return null;
  return {
    outline: () => state.outline,
    expanded: () => state.outlineExpanded,
    onPick: (id) => jumpToSection(id),
    onResolve: async () => {
      await loadOutline({ force: true });
      state.outlineExpanded.clear();
      renderOutline();
    },
  };
}

/** 刷新侧栏目录（外壳统一渲染，这里只触发） */
function renderOutline() {
  window.paperlens?.refreshOutline?.();
}

/** 高亮侧栏目录树里当前章节 */
function markActiveSection(sectionId) {
  $$('#side-outline [data-section]').forEach((b) => b.classList.toggle('active', b.dataset.section === sectionId));
}

/** 目录项点击：优先跳 PDF 原版对应章节标题，失败再退回文本视图 */
async function jumpToSection(sectionId) {
  const sec = (state.outline?.sections || []).find((s) => s.id === sectionId);
  if (!sec) return;

  // PDF 是异步恢复的：刚打开论文就点目录时先等它加载完（超时则退回文本）。
  // 无条件 await（已完成的 Promise 会立即返回），避免依赖 isLoaded() 的竞态——
  // setPaper 会 destroy pdfView，导致"看似已加载、实际正在重新加载"的窗口期。
  if (state.pdfReady) {
    await Promise.race([
      state.pdfReady.catch(() => false),
      new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
    ]);
  }

  // 有 PDF 就跳 PDF 页：heading 段匹配 → 滚到该标题热区
  // 只用 pdfView.isLoaded() 判断（不叠加 state.hasPdf）——后者在 setPaper 时序里可能还是 false，
  // 而 pdfView 加载完成本身就足以证明有 PDF 可跳。
  if (pdfView.isLoaded()) {
    switchPaperView('pdf');
    try {
      await pdfView.mount();
      const hit = pdfView.locateSection(sec.number, sec.title);
      if (hit) {
        markActiveSection(sectionId);
        return;
      }
    } catch { /* 失败退回文本视图 */ }
  }

  switchPaperView('text');
  const target = $(`#paper-body p[data-section="${CSS.escape(sec.id)}"]`) || $(`#paper-body p[data-i="${sec.headingIndex}"]`);
  if (!target) return;
  target.scrollIntoView({ block: 'start', behavior: 'smooth' });
  markActiveSection(sectionId);
}

/**
 * 按需解析章节结构：优先读论文记录里已缓存的 outline，
 * 否则调 /api/paper/outline（会触发一次轻量 LLM 整理）。
 */
async function loadOutline({ force = false } = {}) {
  const text = paperTextForOutline();
  if (!text) {
    toast('论文正文还没抽取出来，请稍后再试或先用精读解析 PDF');
    return;
  }
  // PDF 论文的正文在 pdfView 里，回写一份供下游（精读/追问/保存）复用
  if (!String(state.paper.text || '').trim() && text === pdfView.getText()) {
    state.paper.text = text;
  }
  const cached = state.outline;
  if (cached && !force) {
    state.outline = cached;
    renderPaper();
    renderOutline();
    paintReading();
    return;
  }
  try {
    const res = await postJson('/api/paper/outline', {
      id: state.paperId || undefined,
      text,
      force,
    });
    if (res.ok && res.outline?.sections?.length) {
      state.outline = res.outline;
      renderPaper();
      renderOutline();
      paintReading();
      schedulePaperSave(300);
      ensureStructureAnchors(state.paperId);
      toast(`章节解析完成：${res.outline.sections.length} 节`);
    } else {
      toast('正文里没识别出章节标题，目录暂不可用');
    }
  } catch (err) {
    toast(`章节解析失败：${err.message || '未知错误'}`);
  }
}

function setPaper(paper, { keepReading = false } = {}) {
  state.paper = {
    title: String(paper.title || '').trim(),
    text: String(paper.text || '').trim(),
    source: String(paper.source || ''),
  };
  state.hasPdf = Boolean(paper.hasPdf) && pdfView.isLoaded();
  state.pdfPages = Number(paper.pdfPages || 0);
  state.blocks = null;
  state.translations = [];
  pdfView.setTranslations([]);
  if (!state.hasPdf) pdfView.destroy();
  state.pdfReady = null; // 旧论文的 PDF 恢复 Promise 失效

  $('#paper-title').value = state.paper.title;
  $('#paper-view-switch').hidden = !state.hasPdf;
  renderPaper();
  switchPaperView(state.hasPdf ? 'pdf' : 'text');
  if (!keepReading) {
    state.outline = null;
    state.paperUsage = null; // 换论文：本篇累计归零
    clearReading();
    clearAskThread(); // 换论文后旧追问不能带进新论文的报告
    renderStructure(null); // 同时清空概念卡与图解
  }
  renderOutline();
  persistPaper();
  updateGraphButton();
  schedulePaperSave(300);
  // 章节结构按需解析：有缓存直接用，没有则异步请求（服务端也会缓存结果）
  if (state.paper.text && !state.outline) loadOutline();
}

/** PDF 原版 / 纯文本两种原文视图切换 */
function switchPaperView(view) {
  const usePdf = view === 'pdf' && state.hasPdf;
  state.paperView = usePdf ? 'pdf' : 'text';
  $('#paper-body').hidden = usePdf || !state.paper.text;
  $('#paper-pdf').hidden = !usePdf;
  $$('#paper-view-switch .seg').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === state.paperView);
  });

  if (usePdf) {
    const chars = state.paper.text.replace(/\s+/g, '').length;
    const zhCount = state.translations.length;
    $('#paper-stats').textContent = `${state.pdfPages} 页 · ${formatCount(chars)} 字${
      zhCount ? ` · ${zhCount} 段译文` : ''
    }`;
    pdfView
      .mount()
      .then(updatePdfZoomLabel)
      .catch((err) => toast(`PDF 渲染失败：${err.message}`));
  } else if (state.paper.text) {
    renderPaper();
  }
}

function updatePdfZoomLabel() {
  const pct = Math.round(pdfView.getScale() * 100);
  $('#pdf-zoom').textContent = `${pct}%`;
}

function persistPaper() {
  try {
    if (state.paper.text.length > 800000) return;
    localStorage.setItem(LS_PAPER, JSON.stringify(state.paper));
  } catch {
    /* 配额满了就算了 */
  }
}

function restorePaper() {
  try {
    const raw = localStorage.getItem(LS_PAPER);
    if (!raw) return false;
    const paper = JSON.parse(raw);
    if (!paper?.text) return false;
    setPaper(paper);
    return true;
  } catch {
    return false;
  }
}

/* ---------------------- PDF 字节持久化（刷新后还能看原版） ---------------------- */

const IDB_NAME = 'paperlens';
const IDB_STORE = 'files';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbDelete(key) {
  const db = await openDb();
  return new Promise((resolve) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(key);
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
  });
}

/** 启动时尝试恢复上次的 PDF（只恢复同一篇，失败就静默留在文本视图） */
async function restoreCachedPdf() {
  if (state.hasPdf || !state.paper.source) return;
  if (!/\.pdf$/i.test(state.paper.source)) return;
  let record = null;
  try {
    record = await idbGet('last-pdf');
  } catch {
    return; // 隐私模式等情况，直接用文本视图
  }
  if (!record?.bytes || record.name !== state.paper.source) return;
  try {
    const result = await pdfView.load(record.bytes, { blocks: state.blocks });
    setPaper(
      {
        title: state.paper.title,
        text: state.paper.text || result.text,
        source: state.paper.source,
        hasPdf: true,
        pdfPages: result.numPages,
      },
      { keepReading: true },
    );
    toast('已按上次的文件恢复 PDF 原版视图');
  } catch {
    /* 缓存坏了就当没有 */
  }
}

/* --------------------------------- 精读渲染 -------------------------------- */


const READING_EMPTY_HTML =
  '<div class="empty-state"><p class="empty-title">还没有精读结果</p><p class="empty-sub">点右上角「开始精读」，AI 会按固定小节拆解这篇论文。</p></div>';
// 本次用量条随精读列表滚动：innerHTML 重建时必须一起拼回去，否则会被清掉
const READING_USAGE_HTML =
  '<div class="reading-usage-bar"><span id="reading-status" class="pane-meta"></span></div>';

/**
 * 精读卡片按小节增量维护：流式时只重画内容变化的那一张，
 * 不再每个 token 都把整份 innerHTML 重建一遍（那样会整块闪动、滚动条乱跳）。
 */
let readingCards = [];
let readingRenderTimer = 0;
let readingLastPaint = 0;
let readingSaveAt = 0;
let demoToastShown = false;

function clearReading() {
  state.readingText = '';
  state.structure = null;
  state.readingUsage = null;
  clearTimeout(readingRenderTimer);
  readingRenderTimer = 0;
  readingCards = [];
  $('#reading-list').innerHTML = READING_EMPTY_HTML + READING_USAGE_HTML;
  $('#reading-status').textContent = '';
  paintTotalUsage();
}

function queueReadingRender() {
  if (readingRenderTimer) return;
  // 约 80ms 一帧：看起来仍是逐字出现，又不会每个 token 都重排一次
  const wait = Math.max(0, 80 - (performance.now() - readingLastPaint));
  readingRenderTimer = setTimeout(() => {
    readingRenderTimer = 0;
    requestAnimationFrame(() => paintReading());
  }, wait);
}

function ensureReadingCard(list, index) {
  let entry = readingCards[index];
  if (entry) return entry;
  const node = document.createElement('section');
  node.className = 'card';
  const heading = document.createElement('h4');
  const body = document.createElement('div');
  body.className = 'reading-body';
  node.appendChild(heading);
  node.appendChild(body);
  // 用量条固定在列表末尾，新卡片插到它前面（否则 appendChild 会把用量条顶到上面）
  const usageBar = list.querySelector('.reading-usage-bar');
  if (usageBar) list.insertBefore(node, usageBar);
  else list.appendChild(node);
  entry = { node, heading, body, html: '', title: '' };
  readingCards[index] = entry;
  return entry;
}

/** 精读小节 → 依据的论文章节编号（关键词匹配 outline 标题） */
function sectionForReadingTitle(title) {
  const sections = state.outline?.sections || [];
  if (!sections.length) return '';
  const rules = [
    [/^一句话结论$/, /摘要|abstract|结论|conclusion/i],
    [/实验与结论/, /实验|结果|experiment|result|evaluation/i],
    [/问题|痛点/, /引言|背景|问题|introduction|motivation/i],
    [/核心方法|方法/, /方法|method|approach|model|架构/i],
    [/创新/, /创新|贡献|contribution|方法|method/i],
    [/局限|延伸/, /局限|讨论|limitation|discussion|future/i],
    [/结论|总结/, /结论|conclusion/i],
  ];
  for (const [titleRe, sectionRe] of rules) {
    if (!titleRe.test(title)) continue;
    const sec = sections.find((s) => sectionRe.test(`${s.number} ${s.title} ${s.summary || ''}`));
    if (sec) return `§${sec.number || sec.title}`;
  }
  return '';
}

function paintReading() {
  readingLastPaint = performance.now();
  const list = $('#reading-list');
  const sections = parseReading(state.readingText);
  const streaming = state.readingStreaming;

  if (!sections.length) {
    if (!streaming && state.readingError) {
      readingCards = [];
      list.innerHTML = `<div class="reading-error">${escapeHtml(state.readingError)}</div>` + READING_USAGE_HTML;
      return;
    }
    if (readingCards.length) {
      readingCards = [];
      list.innerHTML = '<div class="empty-state"><p class="empty-sub">正在生成…</p></div>' + READING_USAGE_HTML;
    }
    return;
  }

  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  // 第一张卡片出现时清掉「正在生成…」占位；只删占位节点，别用 innerHTML=''
  // 否则会把末尾的用量条一起清掉
  if (!readingCards.length) {
    const empty = list.querySelector('.empty-state');
    if (empty) empty.remove();
  }

  while (readingCards.length > sections.length) {
    const extra = readingCards.pop();
    extra.node.remove();
  }

  sections.forEach((section, i) => {
    const entry = ensureReadingCard(list, i);
    const title = section.title || '精读';
    const isLast = streaming && i === sections.length - 1;
    entry.node.classList.toggle('streaming', isLast);
    if (entry.title !== title) {
      entry.heading.textContent = title;
      const ref = sectionForReadingTitle(title);
      if (ref) {
        const tag = document.createElement('span');
        tag.className = 'reading-section-ref';
        tag.textContent = ref;
        tag.title = '依据论文章节';
        entry.heading.appendChild(tag);
      }
      entry.title = title;
    }
    // 只有内容真的变了才重排；公式只在流式结束后渲染，
    // 避免 KaTeX 在公式还没写完整时替换文本节点、把后续内容吃掉
    const html = renderBlocks(section.lines);
    if (entry.html !== html) {
      entry.body.innerHTML = html;
      entry.html = html;
      if (!streaming) renderMathIn(entry.body);
    } else if (!streaming) {
      renderMathIn(entry.body);
    }
  });

  const errorEl = list.querySelector('.reading-error');
  if (!streaming && state.readingError) {
    if (errorEl) errorEl.textContent = state.readingError;
    else
      list.insertAdjacentHTML(
        'beforeend',
        `<div class="reading-error">${escapeHtml(state.readingError)}</div>`,
      );
  } else if (errorEl) {
    errorEl.remove();
  }

  if (streaming && nearBottom) list.scrollTop = list.scrollHeight;
}

/* -------------------------------- 结构化解图 ------------------------------- */

/**
 * 概念卡上的中文名不一定出现在 PDF 原文里。
 * 优先用模型给的原文检索词（terms），旧数据则从「中文（English term）」的括号里兜底提取。
 */
function conceptTerms(concept) {
  const out = [];
  const push = (value) => {
    const text = String(value || '').trim();
    if (text && !out.includes(text)) out.push(text);
  };
  (Array.isArray(concept?.terms) ? concept.terms : []).forEach(push);
  for (const text of [concept?.name, concept?.explain]) {
    for (const match of String(text || '').matchAll(/[（(]([^）)]*[A-Za-z][^）)]*)[）)]/g)) {
      push(match[1]);
    }
  }
  push(concept?.name);
  return out.slice(0, 6);
}

function renderStructure(data) {
  const conceptList = $('#concept-list');
  const claimList = $('#claim-list');

  if (!data) {
    conceptList.innerHTML = '';
    claimList.innerHTML = '';
    diagram.render(null);
    $('#diagram-status').textContent = '';
    return;
  }

  conceptList.innerHTML = (data.concepts || [])
    .map((c, i) => {
      const terms = conceptTerms(c);
      const anchors = Array.isArray(c.anchors) ? c.anchors : [];
      const section = anchors[0]?.section
        ? (state.outline?.sections || []).find((s) => s.id === anchors[0].section)?.title || anchors[0].section
        : '';
      const title = `在原文中定位：${terms.join(' / ')}${section ? `\n依据章节：${section}` : ''}`;
      return `<button class="concept-chip" type="button" data-i="${i}" data-name="${escapeHtml(c.name)}" data-terms="${escapeHtml(JSON.stringify(terms))}" data-anchors="${escapeHtml(JSON.stringify(anchors))}" title="${escapeHtml(title)}"><b>${escapeHtml(c.name)}</b><span>${escapeHtml(c.explain)}</span></button>`;
    })
    .join('');

  claimList.innerHTML = (data.claims || [])
    .map((c) => `<div class="claim-row"><span class="claim-tag">${escapeHtml(c.label)}</span><span>${escapeHtml(c.text)}</span></div>`)
    .join('');

  // tags 不再显示在顶栏（避免宽度不足时换行），图解本身已体现方法链路
  if (data.diagram?.nodes?.length) {
    diagram.render(data.diagram);
  }
}

/* -------------------------------- 精读主流程 ------------------------------- */

function setRunning(running) {
  state.running = running;
  const btn = $('#btn-run');
  btn.classList.toggle('running', running);
  btn.innerHTML = running ? '<span class="run-dot"></span>停止' : '<span class="run-dot"></span>开始精读';
  $('#btn-rerun').disabled = running;
}

async function runAnalysis() {
  if (state.running) {
    state.abort?.abort();
    return;
  }
  if (!state.paper.text) {
    toast('先放一篇论文进来');
    openDialog('#dlg-open');
    return;
  }

  setRunning(true);
  state.abort = new AbortController();
  state.aborted = false;
  state.readingStreaming = true;
  state.readingText = '';
  state.readingError = '';
  state.structure = null;
  readingCards = [];
  readingSaveAt = Date.now();
  clearTimeout(readingRenderTimer);
  readingRenderTimer = 0;
  state.readingUsage = null;
  renderStructure(null);
  $('#reading-list').innerHTML =
    '<div class="empty-state"><p class="empty-sub">模型正在读这篇论文…</p></div>' + READING_USAGE_HTML;
  $('#reading-status').textContent = '生成中';
  switchPaneIfNarrow('reading');

  const body = { paper: state.paper };
  try {
    await streamRequest(
      '/api/analyze',
      body,
      (evt) => {
        if (evt.type === 'delta') {
          state.readingText += evt.text;
          queueReadingRender();
          // 长精读边生成边存，避免中途关页/崩溃丢掉已生成内容
          if (Date.now() - readingSaveAt > 8000) {
            readingSaveAt = Date.now();
            schedulePaperSave(0);
          }
        } else if (evt.type === 'meta') {
          $('#reading-status').textContent = `生成中 · ${evt.model || ''}`;
        } else if (evt.type === 'thinking') {
          // 模型在输出思维链，正文还没开始
          $('#reading-status').textContent = `推理中… ${evt.chars} 字`;
        } else if (evt.type === 'notice') {
          toast(evt.message, 4600);
        } else if (evt.type === 'done') {
          state.readingUsage = evt.usage || null;
          accumulateUsage(evt.usage); // 累加到本篇累计（重跑精读不清零）
          paintReadingStatus(evt.demo ? 'demo 示例结果' : '已完成');
        } else if (evt.type === 'error') {
          state.readingError = evt.message;
          $('#reading-status').textContent = '出错';
        }
      },
      state.abort.signal,
    );
  } catch (err) {
    if (err.name === 'AbortError') {
      state.aborted = true;
      $('#reading-status').textContent = '已中断';
    } else {
      state.readingError = err.message;
      $('#reading-status').textContent = '出错';
    }
  } finally {
    state.readingStreaming = false;
    setRunning(false);
    clearTimeout(readingRenderTimer);
    readingRenderTimer = 0;
    paintReading();
  }

  if (!state.aborted && state.readingText.trim()) await loadStructure();
  // 手动停止也把已生成的部分存进论文库
  if (state.readingText.trim()) schedulePaperSave(300);
}

async function loadStructure() {
  $('#diagram-status').textContent = '生成图解…';
  try {
    const res = await postJson('/api/structure', {
      paper: state.paper,
      reading: state.readingText,
    });
    if (res.ok && res.data) {
      state.structure = res.data;
      // /api/structure 已顺带算出 outline（规则层零成本），直接接住，避免章节功能失效
      if (res.outline?.sections?.length) {
        state.outline = res.outline;
        renderPaper();
      }
      renderStructure(res.data);
      renderOutline();
      paintReading();
      if (res.usage) {
        state.readingUsage = mergeUsage(state.readingUsage, res.usage);
        accumulateUsage(res.usage);
        paintReadingStatus('已完成');
      }
      schedulePaperSave(300);
      if (res.demo && !demoToastShown) {
        demoToastShown = true;
        toast('demo 模式：图解来自内置示例，填 API Key 后即为本文专属图解', 3600);
      }
    } else {
      $('#diagram-status').textContent = '图解生成失败';
      toast(res.error || res.message || '图解生成失败');
    }
  } catch (err) {
    $('#diagram-status').textContent = '图解生成失败';
    toast(err.message || '图解生成失败');
  }
}

/** 图解节点点击 → 反向高亮对应概念卡，并提示原文引用 */
/**
 * 概念 chip 的统一定位入口：概念卡、章节地图里的概念都走这里。
 * 三向联动：高亮图解节点 + 用 anchor 定位原文，失败退回术语匹配。
 */
function locateConcept(chip) {
  switchPaneIfNarrow('paper');
  const conceptName = chip.dataset.name || '';
  const nodes = state.structure?.diagram?.nodes || [];
  const matchedNode = nodes.find((n) => n.conceptRef === conceptName) ||
    nodes.find((n) => n.conceptRef === chip.dataset.i) ||
    nodes.find((n) => n.label && (conceptName.includes(n.label) || n.label.includes(conceptName)));
  if (matchedNode) diagram.selectNode(matchedNode.id);

  let anchors = [];
  let terms = [];
  try {
    anchors = JSON.parse(chip.dataset.anchors || '[]');
  } catch { /* ignore */ }
  try {
    terms = JSON.parse(chip.dataset.terms || '[]');
  } catch { /* ignore */ }

  if (anchors.length && locateAnchor(anchors[0])) return;
  locateTerm(terms.length ? terms : [chip.dataset.term || '']);
}

function highlightConceptForNode(node) {
  const chips = $$('#concept-list .concept-chip');
  const name = String(node.conceptRef || node.label || '');
  let hit = chips.find((c) => c.dataset.name === name);
  if (!hit) {
    hit = chips.find((c) => name && (c.dataset.name.includes(name) || name.includes(c.dataset.name)));
  }
  if (!hit && node.sectionRef) {
    hit = chips.find((c) => {
      try {
        return (JSON.parse(c.dataset.anchors || '[]')[0]?.section || '') === node.sectionRef;
      } catch {
        return false;
      }
    });
  }
  chips.forEach((c) => c.classList.toggle('active', c === hit));
  if (!hit) return;
  hit.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  let anchors = [];
  try {
    anchors = JSON.parse(hit.dataset.anchors || '[]');
  } catch {
    anchors = [];
  }
  if (anchors.length && anchors[0].quote) {
    toast(`原文：${anchors[0].quote.slice(0, 60)}${anchors[0].quote.length > 60 ? '…' : ''}`, 3200);
  }
}

/* ---------------------------------- 追问 ---------------------------------- */

/** 追问回答渲染成 Markdown；流式期间未闭合的语法由 renderBlocks/inlineMd 原样保留 */
function paintAskAnswer(el, text) {
  el.innerHTML = markAskCitations(renderBlocks(String(text || '').split('\n')));
}

/** 回答下方的用量行：done 帧到达时插入，位置在正文容器之后 */
function paintAskUsage(target, usage) {
  const info = usageText(usage);
  if (!info) return;
  const item = target.closest('.ask-item');
  if (!item || item.querySelector('.ask-usage')) return;
  const line = document.createElement('div');
  line.className = 'ask-usage';
  line.textContent = info.short;
  line.title = info.title;
  item.appendChild(line);
}

/** 追问对话同时存进 state.askThread，导出报告时要用（DOM 只是渲染结果） */
function pushAsk(role, text, quote = '', usage = null, turn = '') {
  const thread = $('#ask-thread');
  const div = document.createElement('div');
  div.className = `ask-item ${role === 'user' ? 'q' : 'a'}`;
  if (turn) div.dataset.turn = turn;
  // 每轮问题的左侧放一个小徽标，点开菜单可单独删除这一轮问答
  if (role === 'user' && turn) {
    const badge = document.createElement('div');
    badge.className = 'ask-turn-badge';
    badge.innerHTML =
      '<button class="ask-turn-menu" type="button" aria-label="这轮问答选项" aria-expanded="false" title="这轮问答选项">⋯</button>' +
      '<div class="ask-turn-popover" hidden><button class="ask-turn-delete" type="button">删除这轮问答</button></div>';
    div.appendChild(badge);
  }
  if (quote) {
    const q = document.createElement('span');
    q.className = 'quote';
    q.textContent = quote.length > 120 ? `${quote.slice(0, 120)}…` : quote;
    div.appendChild(q);
  }
  const content = document.createElement('div');
  if (role === 'user') content.textContent = text;
  else paintAskAnswer(content, text);
  div.appendChild(content);
  const info = usageText(usage);
  if (info) {
    const line = document.createElement('div');
    line.className = 'ask-usage';
    line.textContent = info.short;
    line.title = info.title;
    div.appendChild(line);
  }
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
  const entry = { role, text: String(text || ''), quote: String(quote || '') };
  if (turn) entry.turn = turn;
  if (usage) entry.usage = usage;
  state.askThread.push(entry);
  // 历史消息恢复时补渲染公式（流式输出中途不渲染，避免 KaTeX 打断增量文本）
  if (role !== 'user') renderMathIn(content);
  schedulePaperSave(1200);
  return { el: content, entry };
}

/** 关闭所有轮次菜单（可保留当前点击的那个） */
function closeAskTurnMenus(except = null) {
  $$('#ask-thread .ask-turn-badge.open').forEach((badge) => {
    if (badge === except) return;
    badge.classList.remove('open');
    const btn = $('.ask-turn-menu', badge);
    if (btn) btn.setAttribute('aria-expanded', 'false');
    const pop = $('.ask-turn-popover', badge);
    if (pop) pop.hidden = true;
  });
}

/** 只删除某一轮：问题 + 它的回答（含用量行），其他轮次与累计用量不动 */
function deleteAskTurn(turn) {
  const removed = state.askThread.filter((entry) => entry.turn === turn);
  if (!removed.length) return;
  // 正在流式输出的回答：标记失效并中断请求，避免删掉后又写回已脱离 DOM 的节点
  removed.forEach((entry) => { entry.deleted = true; });
  const controller = askControllers.get(turn);
  if (controller) {
    controller.abort();
    askControllers.delete(turn);
  }
  $$('#ask-thread .ask-item').forEach((el) => {
    if (el.dataset.turn === turn) el.remove();
  });
  state.askThread = state.askThread.filter((entry) => entry.turn !== turn);
  closeAskTurnMenus();
  schedulePaperSave(200);
  toast('已删除这轮问答');
}

function clearAskThread() {
  for (const controller of askControllers.values()) controller.abort();
  askControllers.clear();
  state.askThread.forEach((entry) => { entry.deleted = true; });
  $('#ask-thread').innerHTML = '';
  state.askThread = [];
  state.selection = '';
  paintTotalUsage();
}

/** 把一段原文交给追问区（PDF 段落卡片、选中文字都走这里） */
function promptAskWith(selection) {
  state.selection = String(selection || '');
  switchPaneIfNarrow('reading');
  $('#ask-input').value = state.selection ? '这段在说什么：' : '';
  $('#ask-input').focus();
  autoGrow($('#ask-input'));
  toast('问题已预填，回车发送');
}

async function ask(question, selection = '') {
  if (!question.trim()) return;
  if (!state.paper.text) {
    toast('先放一篇论文进来');
    return;
  }
  const turn = nextAskTurn();
  pushAsk('user', question, selection, null, turn);
  const { el: target, entry: answerEntry } = pushAsk('assistant', '…', '', null, turn);
  const controller = new AbortController();
  askControllers.set(turn, controller);
  $('#ask-input').value = '';
  autoGrow($('#ask-input'));

  try {
    await streamRequest('/api/ask', {
      paper: state.paper,
      selection,
      reading: state.readingText,
      structure: state.structure,
      askThread: state.askThread.slice(-6),
      outline: state.outline || undefined,
      webSearch: state.webSearch,
      question,
    }, (evt) => {
      if (answerEntry.deleted) return; // 这一轮已被单独删除
      if (evt.type === 'delta') {
        const pending = answerEntry.text === '…' || answerEntry.text === '思考中…';
        answerEntry.text = pending ? evt.text : answerEntry.text + evt.text;
        paintAskAnswer(target, answerEntry.text);
        $('#ask-thread').scrollTop = $('#ask-thread').scrollHeight;
      } else if (evt.type === 'thinking') {
        if (answerEntry.text === '…') {
          answerEntry.text = '思考中…';
          target.textContent = answerEntry.text;
        }
      } else if (evt.type === 'notice') {
        toast(evt.message || '提示', 3600);
      } else if (evt.type === 'done') {
        if (evt.usage) {
          answerEntry.usage = evt.usage;
          paintAskUsage(target, evt.usage);
          accumulateUsage(evt.usage);
          schedulePaperSave(200);
        }
      } else if (evt.type === 'error') {
        answerEntry.text = `出错了：${evt.message}`;
        answerEntry.error = true;
        target.textContent = answerEntry.text;
      }
    }, controller.signal);
  } catch (err) {
    if (answerEntry.deleted || err?.name === 'AbortError') return;
    answerEntry.text = `出错了：${err.message}`;
    answerEntry.error = true;
    target.textContent = answerEntry.text;
  } finally {
    askControllers.delete(turn);
  }
  if (answerEntry.deleted) return;
  // 流式结束后再渲染公式：写到一半的 $...$ 不会被 KaTeX 拆坏
  if (!answerEntry.error) await renderMathIn(target);
  // 完整回答已经写回 answerEntry，补一次保存
  schedulePaperSave(200);
}

/* -------------------------------- 导出报告 -------------------------------- */

const exportState = { busy: false };

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function openExportDialog() {
  if (!state.readingText.trim()) {
    toast('还没有精读结果，先点「开始精读」');
    return;
  }
  $('#export-error').hidden = true;
  $('#export-status').hidden = true;
  $('#dlg-export').showModal();
}

function readExportOptions() {
  const flags = {};
  $$('#dlg-export [data-export]').forEach((el) => {
    flags[el.dataset.export] = el.checked;
  });
  const range = $('#export-ask-range .seg.active')?.dataset.range || 'all';
  let askLimit = 0;
  if (range === 'none') flags.ask = false;
  else if (range !== 'all') askLimit = Number(range) || 0;
  return { ...flags, askLimit };
}

/** 按导出范围截断追问，并还原成 role/text 结构交给摘要接口 */
function exportAskThread(limit) {
  const pairs = qaPairs(state.askThread);
  const picked = limit > 0 ? pairs.slice(-limit) : pairs;
  const out = [];
  for (const pair of picked) {
    out.push({ role: 'user', text: pair.question, quote: pair.quote });
    out.push({ role: 'assistant', text: pair.answer });
  }
  return out;
}

async function runExport(mode) {
  if (exportState.busy) return;
  const options = readExportOptions();
  const askThread = options.ask ? exportAskThread(options.askLimit) : [];
  const status = $('#export-status');
  const error = $('#export-error');
  const printBtn = $('#btn-export-print');
  const htmlBtn = $('#btn-export-html');

  exportState.busy = true;
  printBtn.disabled = true;
  htmlBtn.disabled = true;
  error.hidden = true;
  status.hidden = false;
  status.textContent = '正在生成执行摘要…';

  try {
    let summary = null;
    if (state.readingText.trim()) {
      const res = await postJson('/api/export/summary', {
        paper: state.paper,
        reading: state.readingText,
        askThread,
      });
      if (!res || res.ok === false) {
        const message = res?.error || '摘要生成失败';
        if (message.includes('未知接口')) {
          throw new Error('服务端进程还是旧版本：请重启 node server/index.mjs 后再导出');
        }
        throw new Error(message);
      }
      summary = {
        ...(res.data || {}),
        demo: Boolean(res.demo),
        fallback: Boolean(res.fallback),
        error: res.error || '',
      };
    }

    const diagramResult = options.diagram ? diagram.exportSvg({ theme: 'light' }) : null;
    const data = {
      paper: state.paper,
      reading: state.readingText,
      structure: state.structure,
      askThread,
      summary,
      diagramSvg: diagramResult?.svg || '',
      options: {
        reading: options.reading,
        structure: options.structure,
        diagram: Boolean(diagramResult),
        ask: options.ask,
        appendix: options.appendix,
        askLimit: 0, // 已经在 exportAskThread 里截断
      },
      meta: {
        source: state.paper.source,
        model: state.config?.model || '',
        generatedAt: timestamp(),
      },
    };

    if (mode === 'print') {
      status.textContent = '正在准备打印…';
      await printReport(data);
      $('#dlg-export').close();
      toast('已打开打印预览，在打印对话框里选「另存为 PDF」', 4200);
    } else {
      status.textContent = '正在生成 HTML…';
      const html = await getReportHtml(data);
      saveReportHtml(html, reportFilename(data.structure?.title || state.paper.title));
      toast('已下载报告 HTML');
    }
  } catch (err) {
    error.textContent = err.message || '导出失败';
    error.hidden = false;
  } finally {
    exportState.busy = false;
    printBtn.disabled = false;
    htmlBtn.disabled = false;
    status.hidden = true;
  }
}

/* ------------------------------- 原文中定位概念 ------------------------------ */

/** 把检索词里的空格/连字符当作可选分隔，兼容 "state space" / "state-space" / 跨行断词 */
function findTerm(text, term) {
  const parts = String(term || '')
    .trim()
    .split(/[\s\-‐‑]+/)
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!parts.length) return null;
  const match = new RegExp(parts.join('[\\s\\-‐‑]*'), 'i').exec(String(text || ''));
  return match ? { index: match.index, length: match[0].length } : null;
}

/** 概念定位：依次尝试原文检索词（英文术语/缩写）→ 中文名，PDF 与文本视图都支持 */
/**
 * 按服务端算好的 anchor 定位原文：文本视图直接用段落索引与偏移包 <mark>，
 * PDF 视图用 anchor.quote 反查段落热区。返回是否命中。
 */
function locateAnchor(anchor) {
  if (!anchor) return false;
  if (state.hasPdf && state.paperView === 'pdf') {
    // 术语比整句更适合词级高亮；句子兜底（PDF 抽取文本可能与原文有出入）
    if (anchor.term && pdfView.locate(anchor.term)) return true;
    return anchor.quote ? pdfView.locate(anchor.quote) : false;
  }
  const target = $(`#paper-body p[data-i="${Number(anchor.paragraph)}"]`);
  if (!target) return false;

  $$('#paper-body mark').forEach((m) => {
    const parent = m.parentNode;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  });
  const text = target.textContent || '';
  const offset = Math.max(0, Math.min(Number(anchor.offset) || 0, text.length - 1));
  // 从 offset 向前找检索词的起点；anchor.term 是服务端记下的命中词
  const term = String(anchor.term || '');
  let start = offset;
  if (term) {
    const at = text.toLowerCase().indexOf(term.toLowerCase(), Math.max(0, offset - term.length));
    if (at >= 0) start = at;
  }
  const len = Math.max(1, term.length);
  const before = text.slice(0, start);
  const matched = text.slice(start, start + len);
  const after = text.slice(start + len);
  target.innerHTML = `${escapeHtml(before)}<mark>${escapeHtml(matched)}</mark>${escapeHtml(after)}`;
  target.classList.add('focused');
  target.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => target.classList.remove('focused'), 2200);
  return true;
}

function locateTerm(input) {
  const terms = (Array.isArray(input) ? input : [input])
    .map((term) => String(term || '').trim())
    .filter(Boolean);
  if (!terms.length) return;

  // PDF 视图优先在段落热区里定位
  if (state.paperView === 'pdf' && state.hasPdf) {
    for (const term of terms) {
      if (pdfView.locate(term)) return;
    }
    switchPaperView('text');
  }

  const body = $('#paper-body');
  if (!body) return;
  const paras = $$('p', body);
  let hit = null;
  for (const term of terms) {
    for (const p of paras) {
      const found = findTerm(p.textContent || '', term);
      if (found) {
        hit = { p, ...found };
        break;
      }
    }
    if (hit) break;
  }
  if (!hit) {
    toast(`原文里没找到「${terms[0]}」`);
    return;
  }
  $$('mark', body).forEach((m) => {
    const parent = m.parentNode;
    parent.replaceChild(document.createTextNode(m.textContent), m);
    parent.normalize();
  });
  const raw = hit.p.textContent;
  const before = raw.slice(0, hit.index);
  const matched = raw.slice(hit.index, hit.index + hit.length);
  const after = raw.slice(hit.index + hit.length);
  hit.p.innerHTML = `${escapeHtml(before)}<mark>${escapeHtml(matched)}</mark>${escapeHtml(after)}`;
  hit.p.classList.add('focused');
  hit.p.scrollIntoView({ block: 'center', behavior: 'smooth' });
  setTimeout(() => hit.p.classList.remove('focused'), 2200);
}

/* --------------------------------- 设置面板 -------------------------------- */

function renderPresets() {
  const row = $('#preset-row');
  row.innerHTML = Object.entries(state.presets)
    .map(([key, p]) => {
      const tip = p.note ? `${p.base_url}\n${p.note}` : `${p.base_url}\n默认模型：${p.model || '自定义'}`;
      return `<button type="button" class="preset" data-preset="${key}" title="${escapeHtml(tip)}">${escapeHtml(p.label)}</button>`;
    })
    .join('');
  row.onclick = (ev) => {
    const btn = ev.target.closest('[data-preset]');
    if (!btn) return;
    applyPreset(btn.dataset.preset, btn);
  };
  updateModelOptions();
}

/** 点预设：地址、模型、max_tokens、temperature 一起回填，避免只换一半 */
function applyPreset(key, btn = null) {
  const preset = state.presets[key];
  if (!preset) return;
  $$('.preset').forEach((b) => b.classList.toggle('active', btn ? b === btn : b.dataset.preset === key));
  if (preset.base_url) $('#cfg-base').value = preset.base_url;
  if (preset.model) $('#cfg-model').value = preset.model;
  $('#cfg-tokens').value = preset.max_tokens ?? '';
  if (preset.temperature !== undefined) $('#cfg-temp').value = preset.temperature;
  updateModelOptions();
  updateSettingsTip();
  $('#settings-error').hidden = true;
  $('#settings-ok').hidden = true;
}

/** 按地址反查是哪个服务商（与服务端 detectProvider 同规则，用于前端提示） */
function providerOf(base) {
  const raw = String(base || '').trim().toLowerCase();
  if (!raw) return null;
  for (const [key, preset] of Object.entries(state.presets)) {
    if (key === 'custom' || !preset.base_url) continue;
    const host = preset.base_url.toLowerCase().replace(/^https?:\/\//, '').split('/')[0];
    if (host && raw.includes(host)) return key;
  }
  return null;
}

/** 模型名候选：跟着当前地址/服务商变 */
function updateModelOptions() {
  const key = providerOf($('#cfg-base').value);
  const list = (key && state.presets[key]?.models) || [];
  $('#model-options').innerHTML = list.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
}

/** 底部说明：只在真的可能出问题时提示 */
function updateSettingsTip() {
  const tokens = Number($('#cfg-tokens').value) || 0;
  const tips = [];
  if (tokens && tokens < 4096) {
    tips.push(`输出上限 ${tokens} 偏小，长精读会被截断；留空表示由模型决定`);
  }
  const base = $('#cfg-base').value.trim();
  if (base && !/\/v\d+$/.test(base) && !/\/chat\/completions$/.test(base)) {
    tips.push('Base URL 一般要以 /v1 结尾（Ollama 也一样），否则可能 404');
  }
  $('#cfg-tip').textContent = tips.join('；');
  $('#cfg-tip').hidden = tips.length === 0;
}

/** 用主密码解密保存在本机的 Key（成功后服务端只在内存里保留明文） */
async function unlockWithPassphrase(passphrase) {
  const res = await postJson('/api/config/unlock', { passphrase });
  if (!res || res.ok === false) throw new Error(res?.error || '解密失败');
  state.config = res.config;
  applyBadge();
  if ($('#dlg-settings').open) fillSettings();
  return res.config;
}

/** 顶栏锁徽标：弹出独立的主密码对话框 */
function openUnlockDialog() {
  if (!state.config?.locked) {
    fillSettings();
    openDialog('#dlg-settings');
    return;
  }
  $('#unlock-pass').value = '';
  $('#unlock-error').hidden = true;
  $('#dlg-unlock').showModal();
  setTimeout(() => $('#unlock-pass').focus(), 30);
}

function fillSettings() {
  const cfg = state.config || {};
  const locked = Boolean(cfg.locked);
  $('#cfg-base').value = cfg.base_url || '';
  $('#cfg-model').value = cfg.model || '';
  $('#cfg-tokens').value = cfg.max_tokens ?? '';
  $('#cfg-temp').value = cfg.temperature ?? '';
  $('#cfg-extra').value = cfg.extra_body ? JSON.stringify(cfg.extra_body, null, 2) : '';
  $('#cfg-key').value = '';
  $('#cfg-pass').value = '';
  $('#cfg-key').placeholder = cfg.has_key
    ? `${cfg.api_key_masked}（已保存，留空不修改）`
    : locked
      ? '已加密，先输入主密码解锁'
      : 'sk-...';
  const providerLabel = state.presets[cfg.provider]?.label || cfg.provider || '自定义';
  $('#cfg-state').textContent = cfg.has_key
    ? `已配置：${providerLabel} · ${cfg.model} · 来源 ${cfg.source === 'file' ? '本机配置文件' : cfg.source}${cfg.encrypted ? ' · 已加密' : ''}`
    : locked
      ? 'API Key 已加密，等待解锁'
      : '未配置 API Key，当前使用 demo 示例数据';

  const lockState = $('#cfg-lock-state');
  if (locked) lockState.textContent = '输入主密码后点「解密」';
  else if (cfg.has_key) {
    lockState.textContent = cfg.encrypted
      ? 'API Key 只以密文形式保存在本机'
      : '当前 Key 仍是明文存储，建议设置主密码后重新保存';
  } else {
    lockState.textContent = '保存 Key 时需要设置主密码（至少 6 位）';
  }
  $('#btn-unlock').hidden = !locked;

  $('#settings-error').hidden = true;
  $('#settings-ok').hidden = true;
  $$('.preset').forEach((b) => b.classList.toggle('active', b.dataset.preset === cfg.provider));
  updateModelOptions();
  updateSettingsTip();
}

function applyBadge() {
  const badge = $('#model-badge');
  const cfg = state.config || {};
  if (cfg.locked) {
    badge.textContent = '🔒 已加密（待解锁）';
    badge.className = 'badge demo clickable';
    badge.title = 'API Key 已加密，点击输入主密码解密';
    return;
  }
  if (cfg.ready) {
    badge.textContent = cfg.model;
    badge.className = 'badge live';
    const providerLabel = state.presets[cfg.provider]?.label || '自定义端点';
    const limit = cfg.max_tokens ? `输出上限 ${cfg.max_tokens}` : '输出上限由模型决定';
    badge.title = `${providerLabel} · ${cfg.base_url}\n${limit} · temperature ${cfg.temperature}`;
  } else {
    badge.textContent = 'demo 模式（未配置 Key）';
    badge.className = 'badge demo';
    badge.title = '点击「模型设置」填入任意 OpenAI 兼容 API';
  }
}

async function loadConfig() {
  try {
    const data = await fetch('/api/config').then((r) => r.json());
    state.config = data.config;
    state.presets = data.presets || {};
    renderPresets();
    applyBadge();
  } catch (err) {
    toast(`读取配置失败：${err.message}`);
  }
}

/* --------------------------------- 打开论文 -------------------------------- */

function openDialog(sel) {
  const dlg = $(sel);
  if (dlg && !dlg.open) dlg.showModal();
}

function switchOpenTab(tab) {
  $$('#open-tabs .seg').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  $$('#dlg-open .tab-panel').forEach((p) => {
    p.hidden = p.dataset.tab !== tab;
  });
  $('#open-error').hidden = true;
}

function openError(message) {
  const el = $('#open-error');
  el.textContent = message;
  el.hidden = !message;
}

async function loadArxiv() {
  const input = $('#arxiv-input').value.trim();
  if (!input) return openError('请填写 arXiv 编号');
  openError('');
  $('#btn-arxiv-load').disabled = true;
  $('#btn-arxiv-load').textContent = '抓取中…';
  try {
    const res = await postJson('/api/paper/fetch', { input });
    if (!res.ok) {
      openError(res.error || '抓取失败');
      return;
    }
    setPaper({ title: res.paper.title, text: res.paper.text, source: res.paper.source });
    $('#dlg-open').close();
    toast(res.paper.full_text ? '已载入 arXiv 全文' : '已载入标题与摘要（无 HTML 全文）');
  } catch (err) {
    openError(err.message);
  } finally {
    $('#btn-arxiv-load').disabled = false;
    $('#btn-arxiv-load').textContent = '抓取';
  }
}

async function loadPdfFile(file) {
  const status = $('#upload-status');
  status.textContent = '正在解析 PDF（提取段落与坐标）…';
  try {
    const bytes = await file.arrayBuffer();
    // 先用翻译页同一套 extractor 抽规范分块，保证两个视图第一次打开就对得上
    status.textContent = '正在提取分块…';
    const shared = await buildSharedBlocks(bytes);
    // pdf.js 会把传入的 ArrayBuffer transfer 走（之后 byteLength 变成 0），
    // 这里先复制一份再解析，原始 bytes 留给 IndexedDB 持久化
    const result = await pdfView.load(bytes.slice(0), { blocks: shared });
    if (result.text.length < 200) {
      throw new Error('PDF 里几乎没抽到文本，可能是扫描件');
    }
    setPaper({
      title: file.name.replace(/\.pdf$/i, ''),
      text: result.text,
      source: file.name,
      hasPdf: true,
      pdfPages: result.numPages,
    });
    // setPaper 会清空 state.blocks，这里把刚抽好的分块放回来，供落库使用
    state.blocks = shared?.length ? shared : null;
    // 存一份原始字节，刷新页面后还能回到 PDF 原版视图
    idbPut('last-pdf', { name: file.name, bytes, savedAt: Date.now() }).catch(() => {});
    await saveCurrentPaper();
    await uploadPdfToServer(bytes);
    status.textContent = '';
    $('#dlg-open').close();
    toast(`已解析 ${result.numPages} 页 · ${result.text.length.toLocaleString()} 字符，点任意段落可问 AI`, 3600);
  } catch (err) {
    status.textContent = '';
    openError(`PDF 解析失败：${err.message}（需要联网加载 pdf.js，或改用「粘贴正文」）`);
  }
}

async function handleFile(file) {
  if (!file) return;
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf')) return loadPdfFile(file);
  const text = await file.text();
  setPaper({ title: file.name.replace(/\.(txt|md|markdown)$/i, ''), text, source: file.name });
  $('#dlg-open').close();
  toast('已载入文本');
}

/* -------------------------------- 界面装配 -------------------------------- */

function switchPane(name) {
  $$('.mobile-tabs .tab').forEach((t) => t.classList.toggle('active', t.dataset.pane === name));
  $$('.workspace .pane').forEach((p) => p.classList.toggle('mobile-active', p.dataset.pane === name));
  // 窄屏下 PDF 页在隐藏时才渲染，切回来要按真实宽度重新适配
  if (name === 'paper' && state.paperView === 'pdf' && state.hasPdf) {
    setTimeout(() => pdfView.fit().then(updatePdfZoomLabel), 60);
  }
}

/** 桌面端三栏同时可见，只有窄屏才需要切换 */
function switchPaneIfNarrow(name) {
  if (window.innerWidth <= 1080) switchPane(name);
}

/* --------------------------- 图解栏折叠（两栏模式） --------------------------- */

/** 应用折叠状态到界面；persist=true 时同时写入 localStorage（用户主动切换才写） */
function setDiagramCollapsed(collapsed, { persist = true } = {}) {
  document.body.classList.toggle('diagram-collapsed', collapsed);
  $('#view-paper .workspace')?.classList.toggle('diagram-collapsed', collapsed);
  if (persist) localStorage.setItem(LS_DIAGRAM, collapsed ? '1' : '0');
  const btn = $('#btn-diagram-toggle');
  if (btn) {
    btn.setAttribute('aria-pressed', String(!collapsed));
    btn.title = collapsed ? '展开交互图解（三栏）' : '收起交互图解（两栏）';
  }
  // 折叠时若在放大态，先还原，避免再展开时残留 fixed 定位
  if (collapsed) {
    const pane = $('.pane[data-pane="diagram"]');
    if (pane?.classList.contains('zoom')) {
      pane.classList.remove('zoom');
      $('#btn-diagram-zoom').textContent = '⤢';
    }
  }
  setTimeout(() => diagram.fit(), 80);
}

function toggleDiagram() {
  setDiagramCollapsed(!document.body.classList.contains('diagram-collapsed'));
}

/* --------------------------- 栏间拖动（原文 ↔ 精读） --------------------------- */

const PAPER_MIN = 280;
const READING_MIN = 300;
const DIAGRAM_MIN = 300;
const DEFAULT_PAPER_PCT = 34;

function applyPaperWidth(pct, { persist = true } = {}) {
  const workspace = $('#view-paper .workspace');
  if (!workspace) return;
  const value = Math.max(10, Math.min(80, Number(pct) || DEFAULT_PAPER_PCT));
  workspace.style.setProperty('--paper-w', `${value}%`);
  $('#pane-resizer')?.setAttribute('aria-valuenow', String(Math.round(value)));
  if (persist) localStorage.setItem(LS_PAPER_WIDTH, String(value));
}

function reflowAfterResize() {
  diagram.fit();
  if (state.hasPdf && state.paperView === 'pdf' && !$('#paper-pdf')?.hidden) {
    pdfView.fit().then(updatePdfZoomLabel);
  }
}

function initPaneResizer() {
  const resizer = $('#pane-resizer');
  const workspace = $('#view-paper .workspace');
  if (!resizer || !workspace) return;

  let dragging = false;
  let startX = 0;
  let startW = 0;
  let workspaceW = 0;
  let maxPaper = 0;

  resizer.addEventListener('pointerdown', (ev) => {
    // 窄屏隐藏了手柄，这里也挡一道
    if (ev.button !== 0 || window.innerWidth <= 1080) return;
    ev.preventDefault();
    dragging = true;
    startX = ev.clientX;
    startW = $('#view-paper .pane[data-pane="paper"]').getBoundingClientRect().width;
    workspaceW = workspace.getBoundingClientRect().width;
    const diagramMin = document.body.classList.contains('diagram-collapsed') ? 0 : DIAGRAM_MIN;
    maxPaper = workspaceW - READING_MIN - diagramMin;
    resizer.classList.add('dragging');
    document.body.classList.add('pane-resizing');
    resizer.setPointerCapture(ev.pointerId);
  });

  resizer.addEventListener('pointermove', (ev) => {
    if (!dragging) return;
    const nextPx = Math.min(Math.max(startW + (ev.clientX - startX), PAPER_MIN), Math.max(PAPER_MIN, maxPaper));
    applyPaperWidth((nextPx / workspaceW) * 100, { persist: false });
  });

  const endDrag = () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.classList.remove('pane-resizing');
    localStorage.setItem(LS_PAPER_WIDTH, (workspace.style.getPropertyValue('--paper-w') || `${DEFAULT_PAPER_PCT}%`).replace('%', ''));
    reflowAfterResize();
  };
  resizer.addEventListener('pointerup', endDrag);
  resizer.addEventListener('pointercancel', endDrag);
}

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(LS_THEME, theme);
}

function autoGrow(textarea) {
  textarea.style.height = 'auto';
  textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
}

function exportDiagram() {
  const result = diagram.exportSvg();
  if (!result) {
    toast('还没有可导出的图解');
    return;
  }
  const blob = new Blob([result.svg], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${(state.paper.title || 'paper').slice(0, 40).replace(/[\\/:*?"<>|]/g, '_')}-diagram.svg`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast('已导出 SVG');
}

function bindEvents() {
  $('#btn-run').onclick = runAnalysis;
  $('#btn-rerun').onclick = runAnalysis;

  $('#btn-open').onclick = () => {
    openDialog('#dlg-open');
    switchOpenTab('arxiv');
  };
  registerTopbarActions('paper', {
    settings: () => {
      fillSettings();
      openDialog('#dlg-settings');
    },
    theme: () => {
      applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
      setTimeout(() => diagram.fit(), 50);
    },
  });

  $('#btn-sample-2').onclick = loadSample;

  // 原文栏右上角的载入入口（按钮已从顶栏移除，保留可选绑定兼容其它入口）
  const uploadPdfBtn = $('#btn-upload-pdf');
  if (uploadPdfBtn) {
    uploadPdfBtn.onclick = () => {
      const input = $('#file-input');
      input.value = '';
      input.click();
    };
  }
  $('#btn-sample-dialog').onclick = async () => {
    await loadSample();
    $('#dlg-open').close();
  };

  // 原文视图切换（PDF 原版 / 文本）
  $('#paper-view-switch').onclick = (ev) => {
    const btn = ev.target.closest('.seg');
    if (btn) switchPaperView(btn.dataset.view);
  };
  $('#btn-pdf-in').onclick = async () => {
    await pdfView.zoom(1);
    updatePdfZoomLabel();
  };
  $('#btn-pdf-out').onclick = async () => {
    await pdfView.zoom(-1);
    updatePdfZoomLabel();
  };
  $('#btn-pdf-fit').onclick = async () => {
    await pdfView.fit();
    updatePdfZoomLabel();
  };
  const sample = async () => {
    const res = await fetch('/api/sample').then((r) => r.json());
    setPaper(res.paper);
    toast('已载入示例论文，点「开始精读」');
  };
  async function loadSample() {
    try {
      await sample();
    } catch (err) {
      toast(err.message);
    }
  }

  $('#btn-clear').onclick = () => {
    setPaper({ title: '', text: '', source: '' });
    state.paperId = '';
    $('#paper-title').value = '';
    localStorage.removeItem(LS_PAPER);
    localStorage.removeItem(LS_LAST_PAPER);
    idbDelete('last-pdf').catch(() => {});
  };

  $('#paper-title').oninput = (ev) => {
    state.paper.title = ev.target.value;
    persistPaper();
    schedulePaperSave(800);
  };

  $$('[data-open]').forEach((btn) => {
    btn.onclick = () => {
      openDialog('#dlg-open');
      switchOpenTab(btn.dataset.open);
    };
  });

  $('#open-tabs').onclick = (ev) => {
    const btn = ev.target.closest('.seg');
    if (!btn) return;
    switchOpenTab(btn.dataset.tab);
    if (btn.dataset.tab === 'library') refreshLibrary();
  };

  const libraryHost = $('#library-list');
  if (libraryHost) {
    libraryHost.onclick = async (ev) => {
      const del = ev.target.closest('[data-del]');
      if (del) {
        await deleteLibraryPaper(del.dataset.del);
        return;
      }
      const open = ev.target.closest('[data-id]');
      if (open && (await loadPaperById(open.dataset.id))) {
        $('#dlg-open').close();
        toast('已打开论文库中的论文');
      }
    };
  }
  $('#btn-arxiv-load').onclick = loadArxiv;
  $('#arxiv-input').onkeydown = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      loadArxiv();
    }
  };
  $('#btn-paste-load').onclick = () => {
    const text = $('#paste-input').value.trim();
    if (!text) return openError('先把正文粘进来');
    setPaper({ title: $('#paper-title').value.trim(), text, source: 'paste' });
    $('#dlg-open').close();
    toast('已载入正文');
  };

  const dz = $('#dropzone');
  dz.onclick = () => $('#file-input').click();
  $('#file-input').onchange = (ev) => handleFile(ev.target.files?.[0]);
  dz.ondragover = (ev) => {
    ev.preventDefault();
    dz.classList.add('over');
  };
  dz.ondragleave = () => dz.classList.remove('over');
  dz.ondrop = (ev) => {
    ev.preventDefault();
    dz.classList.remove('over');
    handleFile(ev.dataTransfer?.files?.[0]);
  };

  // 追问
  $('#ask-form').onsubmit = (ev) => {
    ev.preventDefault();
    const value = $('#ask-input').value.trim();
    if (value) ask(value, state.selection);
    state.selection = '';
  };
  $('#ask-input').oninput = (ev) => autoGrow(ev.target);
  $('#ask-input').onkeydown = (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      $('#ask-form').requestSubmit();
    }
  };
  $('#btn-ask-clear').onclick = clearAskThread;

  // 每轮问题左侧的徽标：点开菜单 → 只删除这一轮问答
  $('#ask-thread').addEventListener('click', (ev) => {
    const menu = ev.target.closest('.ask-turn-menu');
    if (menu) {
      const badge = menu.closest('.ask-turn-badge');
      const wasOpen = badge.classList.contains('open');
      closeAskTurnMenus();
      if (!wasOpen) {
        badge.classList.add('open');
        menu.setAttribute('aria-expanded', 'true');
        const pop = $('.ask-turn-popover', badge);
        if (pop) pop.hidden = false; // hidden 不去掉，CSS 的 [hidden] 规则会一直压住弹层
      }
      return;
    }
    const del = ev.target.closest('.ask-turn-delete');
    if (del) {
      const item = del.closest('.ask-item');
      if (item?.dataset.turn) deleteAskTurn(item.dataset.turn);
      return;
    }
    if (!ev.target.closest('.ask-turn-badge')) closeAskTurnMenus();
  });
  document.addEventListener('click', (ev) => {
    if (!ev.target.closest('.ask-turn-badge')) closeAskTurnMenus();
  });

  // 联网增强开关：默认开，状态存 localStorage
  const webToggle = $('#btn-ask-web');
  const paintWebToggle = () => {
    webToggle.classList.toggle('active', state.webSearch);
    webToggle.setAttribute('aria-pressed', String(state.webSearch));
    webToggle.title = state.webSearch
      ? '已开启：可用网络补充论文之外的信息（点击关闭）'
      : '已关闭：只依据论文内容回答（点击开启）';
  };
  paintWebToggle();
  webToggle.onclick = () => {
    state.webSearch = !state.webSearch;
    localStorage.setItem('paperlens.askWeb', state.webSearch ? '1' : '0');
    paintWebToggle();
    toast(state.webSearch ? '联网增强已开启' : '联网增强已关闭，只依据论文回答');
  };

  // 追问区分割线：上下拖动调整高度
  const askDock = $('#ask-dock');
  const askResizer = $('#ask-resizer');
  const askPane = askDock.parentElement;
  const ASK_MIN_H = 120;
  const askMaxH = () => {
    const paneHeight = askPane.clientHeight;
    // 上限既不超过面板的 70%，也给上方正文至少留 160px
    return Math.max(ASK_MIN_H, Math.min(paneHeight * 0.7, paneHeight - 160));
  };
  let askDragging = false;
  askResizer.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    askDragging = true;
    askResizer.classList.add('dragging');
    askDock.classList.add('resizing');
    askResizer.setPointerCapture(ev.pointerId);
    document.body.style.cursor = 'row-resize';
  });
  askResizer.addEventListener('pointermove', (ev) => {
    if (!askDragging) return;
    const rect = askPane.getBoundingClientRect();
    const next = Math.min(Math.max(rect.bottom - ev.clientY, ASK_MIN_H), askMaxH());
    askDock.style.height = `${Math.round(next)}px`;
  });
  const endAskDrag = () => {
    if (!askDragging) return;
    askDragging = false;
    askResizer.classList.remove('dragging');
    askDock.classList.remove('resizing');
    document.body.style.cursor = '';
  };
  askResizer.addEventListener('pointerup', endAskDrag);
  askResizer.addEventListener('pointercancel', endAskDrag);

  // 选中原文 → 浮动「问 AI」
  const selTool = $('#sel-tool');
  document.addEventListener('mouseup', (ev) => {
    if (ev.target.closest('.sel-tool')) return;
    setTimeout(() => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() || '';
      if (!text || text.length < 4 || !sel.rangeCount) {
        selTool.hidden = true;
        return;
      }
      const anchor = sel.anchorNode?.nodeType === 3 ? sel.anchorNode.parentElement : sel.anchorNode;
      if (!anchor?.closest?.('#paper-body')) {
        selTool.hidden = true;
        return;
      }
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      selTool.hidden = false;
      selTool.style.left = `${rect.left + rect.width / 2}px`;
      selTool.style.top = `${rect.top}px`;
      state.selection = text;
    }, 10);
  });

  $('#btn-ask-selection').onclick = () => {
    selTool.hidden = true;
    promptAskWith(state.selection);
  };

  // 概念定位：优先用 anchor（节+段落索引），失败再退回术语字符串匹配
  $('#concept-list').onclick = (ev) => {
    const chip = ev.target.closest('.concept-chip');
    if (chip) locateConcept(chip);
  };

  // 导出报告
  $('#btn-export-report').onclick = openExportDialog;
  $('#btn-export-print').onclick = () => runExport('print');
  $('#btn-export-html').onclick = () => runExport('html');
  $('#btn-export-close').onclick = () => $('#dlg-export').close();
  $('#export-ask-range').onclick = (ev) => {
    const btn = ev.target.closest('.seg');
    if (!btn) return;
    $$('#export-ask-range .seg').forEach((b) => b.classList.toggle('active', b === btn));
  };

  // 精读复制
  $('#btn-copy-reading').onclick = async () => {
    if (!state.readingText.trim()) return toast('还没有精读结果');
    try {
      await navigator.clipboard.writeText(state.readingText);
      toast('已复制精读全文');
    } catch {
      toast('复制失败，请手动选择文本');
    }
  };

  // 推送到知识图谱
  $('#btn-to-graph').onclick = pushToGraph;

  // 侧栏目录树的渲染/展开/点击由 shell.js 统一分发，精读页通过 renderOutline() 注册提供者

  $('#btn-diagram-relayout').onclick = () => diagram.relayout();
  $('#btn-diagram-fit').onclick = () => diagram.fit();
  $('#btn-diagram-export').onclick = exportDiagram;
  $('#btn-diagram-collapse').onclick = () => setDiagramCollapsed(true);
  $('#btn-diagram-toggle').onclick = toggleDiagram;
  $('#btn-diagram-zoom').onclick = (ev) => {
    const pane = $('.pane[data-pane="diagram"]');
    const zoomed = pane.classList.toggle('zoom');
    ev.target.textContent = zoomed ? '⤡' : '⤢';
    setTimeout(() => diagram.fit(), 60);
  };

  // 移动端 tab
  $('#mobile-tabs').onclick = (ev) => {
    const tab = ev.target.closest('.tab');
    if (tab) switchPane(tab.dataset.pane);
  };

  // 设置
  $('#btn-save-config').onclick = async () => {
    const payload = {
      base_url: $('#cfg-base').value.trim(),
      model: $('#cfg-model').value.trim(),
      api_key: $('#cfg-key').value,
      max_tokens: $('#cfg-tokens').value,
      temperature: $('#cfg-temp').value,
      extra_body: $('#cfg-extra').value.trim(),
      passphrase: $('#cfg-pass').value,
    };
    const ok = $('#settings-ok');
    const err = $('#settings-error');
    try {
      const res = await postJson('/api/config', payload);
      if (res.ok === false) {
        err.textContent = res.error || '保存失败';
        err.hidden = false;
        ok.hidden = true;
        return;
      }
      state.config = res.config;
      applyBadge();
      fillSettings();
      ok.textContent = res.config.ready
        ? `已保存：${res.config.model}，现在开始用真实模型精读。`
        : res.config.locked
          ? '已保存。API Key 已加密，输入主密码点「解锁」后即可使用。'
          : '已保存。注意：还没有 API Key，仍是 demo 模式。';
      ok.hidden = false;
      toast('配置已保存');
    } catch (e) {
      err.textContent = `保存失败：${e.message}`;
      err.hidden = false;
      ok.hidden = true;
    }
  };

  $('#btn-test').onclick = async () => {
    if (state.config?.locked) {
      toast('API Key 已加密，先输入主密码点「解锁」');
      return;
    }
    const btn = $('#btn-test');
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      const res = await postJson('/api/config/test', {
        base_url: $('#cfg-base').value.trim(),
        model: $('#cfg-model').value.trim(),
        api_key: $('#cfg-key').value,
      });
      const ok = $('#settings-ok');
      const err = $('#settings-error');
      if (res.ok) {
        ok.textContent = `连接成功 · ${res.model} · ${res.latency_ms} ms · 回复：${res.reply}`;
        ok.hidden = false;
        err.hidden = true;
      } else {
        err.textContent = res.error || '连接失败';
        err.hidden = false;
        ok.hidden = true;
      }
    } catch (e) {
      const err = $('#settings-error');
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = '测试连接';
    }
  };

  $('#btn-unlock').onclick = async () => {
    const passphrase = $('#cfg-pass').value;
    if (!passphrase.trim()) {
      toast('先输入主密码');
      return;
    }
    try {
      await unlockWithPassphrase(passphrase);
      toast('已解密，可以开始精读了');
    } catch (err) {
      const box = $('#settings-error');
      box.textContent = err.message || '解密失败';
      box.hidden = false;
    }
  };

  // 顶栏锁徽标 → 独立的解密对话框；未加密时点击打开模型设置
  $('#model-badge').onclick = () => {
    if (state.config?.locked) openUnlockDialog();
    else {
      fillSettings();
      openDialog('#dlg-settings');
    }
  };

  $('#btn-unlock-submit').onclick = async () => {
    const passphrase = $('#unlock-pass').value;
    const box = $('#unlock-error');
    if (!passphrase.trim()) {
      box.textContent = '请输入主密码';
      box.hidden = false;
      return;
    }
    try {
      await unlockWithPassphrase(passphrase);
      $('#dlg-unlock').close();
      toast('已解密，可以开始精读了');
    } catch (err) {
      box.textContent = err.message || '解密失败';
      box.hidden = false;
    }
  };
  $('#btn-unlock-close').onclick = () => $('#dlg-unlock').close();
  $('#unlock-pass').onkeydown = (ev) => {
    if (ev.key === 'Enter') {
      ev.preventDefault();
      $('#btn-unlock-submit').click();
    }
  };

  $('#btn-clear-key').onclick = async () => {
    const res = await postJson('/api/config', { clear_key: true });
    if (res.ok === false) {
      toast(res.error || '清除失败');
      return;
    }
    state.config = res.config;
    applyBadge();
    fillSettings();
    toast('已清除本机保存的 Key');
  };

  $('#btn-close-settings').onclick = () => $('#dlg-settings').close();

  // 地址/模型/tokens 变动时刷新提示与模型候选
  ['#cfg-base', '#cfg-model', '#cfg-tokens'].forEach((sel) => {
    $(sel).addEventListener('input', () => {
      updateModelOptions();
      updateSettingsTip();
    });
  });

  document.addEventListener('keydown', (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 'Enter') {
      ev.preventDefault();
      runAnalysis();
    }
    if (ev.key === 'Escape') $('#sel-tool').hidden = true;
  });
}

/* --------------------------------- 启动 ---------------------------------- */

async function main() {
  const savedTheme = localStorage.getItem(LS_THEME);
  applyTheme(savedTheme || 'dark');
  bindEvents();
  await loadConfig();

  // ?fromSource=<sourceId>：从知识图谱的出处跳回来，先载入原文
  const fromGraph = await loadFromSource();
  let restored = false;
  if (fromGraph) {
    restored = true;
    schedulePaperSave(0);
  } else {
    restored = await loadInitialPaper();
  }
  updateGraphButton();
  refreshLibrary();
  setDiagramCollapsed(localStorage.getItem(LS_DIAGRAM) === '1', { persist: false });
  applyPaperWidth(localStorage.getItem(LS_PAPER_WIDTH) ?? DEFAULT_PAPER_PCT, { persist: false });
  initPaneResizer();
  switchPaneIfNarrow('paper');
  if (restored) restoreCachedPdf();
  const quote = new URLSearchParams(location.search).get('quote');
  if (quote) setTimeout(() => locateQuoteInText(quote), 180);
  window.addEventListener('resize', () => {
    diagram.fit();
    // 从宽屏缩到窄屏时补一次分栏切换，否则三栏会被媒体查询全部隐藏
    if (window.innerWidth <= 1080 && !$('.pane.mobile-active')) switchPane('paper');
  });
}

/* 外壳与共享侧栏从这里打开论文：翻译页点侧栏时也走这条路 */
window.paperlens = {
  ...(window.paperlens || {}),
  loadPaperById,
  refreshLibrary,
  getPaperOutlineProvider,
};

main();
