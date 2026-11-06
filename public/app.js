import { createDiagram } from './diagram.js';
import { createPdfView, openPdfDocument } from './pdfview.js';
import { extractDocumentBlocks } from './blocks.js';
import { renderMathIn } from './math.js';
import { getReportHtml, printReport, qaPairs, reportFilename, saveReportHtml } from './report.js';
import { escapeHtml, isSectionTitle, parseReading, renderBlocks, splitParagraphs } from './text.js';

/* --------------------------------- 基础工具 -------------------------------- */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const LS_PAPER = 'paperlens.paper';
const LS_THEME = 'paperlens.theme';

/** 39,755 → 39.8k，给原文栏那行统计省宽度 */
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
  hasPdf: false,
  pdfPages: 0,
  paperView: 'text',
};

const diagram = createDiagram($('#diagram-host'));
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

function graphLink() {
  try {
    return JSON.parse(localStorage.getItem(LS_KG) || 'null');
  } catch {
    return null;
  }
}

/** 当前论文是否已经推送到图谱（标题 + 正文字数一致即视为同一篇） */
function graphLinkMatches() {
  const linked = graphLink();
  return Boolean(
    linked && linked.sourceId && linked.title === state.paper.title && linked.textLen === state.paper.text.length,
  );
}

function updateGraphButton() {
  const btn = $('#btn-to-graph');
  if (!btn) return;
  const linked = graphLinkMatches();
  btn.dataset.linked = linked ? '1' : '';
  btn.textContent = linked ? '已在图谱中 · 查看' : '→ 知识图谱';
  btn.title = linked ? '打开知识图谱中这条资料的出处' : '把论文、精读与概念推送到知识图谱';
}

/** 一键入库：论文正文 + 精读 + 结构化结果。同进程直接调用，不经 HTTP 跨端口 */
async function pushToGraph() {
  if (!state.paper.text) return toast('先放一篇论文进来');
  if (!state.readingText.trim()) return toast('先生成精读，再推送到知识图谱');
  if (graphLinkMatches()) {
    location.href = `/kg/?source=${encodeURIComponent(graphLink().sourceId)}`;
    return;
  }
  const btn = $('#btn-to-graph');
  const oldText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '推送中…';
  try {
    if (!state.paperId) await saveCurrentPaper();
    const res = await postJson('/api/kg/import/paper', {
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
    });
    if (res.ok === false) throw new Error(res.error || '推送失败');
    const sourceId = res.source?.id || '';
    localStorage.setItem(
      LS_KG,
      JSON.stringify({
        sourceId,
        title: state.paper.title,
        textLen: state.paper.text.length,
        at: Date.now(),
      }),
    );
    updateGraphButton();
    const count = res.concepts?.length || 0;
    const warning = (res.warnings || [])[0];
    toast(warning ? `已入库（${count} 个概念）：${warning}` : `已入库：${count} 个概念，点开可查看图谱`);
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
      schedulePaperSave(600);
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
    $('#reading-status').textContent = '已保存';
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
  for (const msg of Array.isArray(record.ask_thread) ? record.ask_thread : []) {
    if (!msg || !msg.role) continue;
    pushAsk(msg.role, String(msg.text || ''), String(msg.quote || ''));
  }

  if (record.hasPdf) restorePdfFromServer(record.id);
  updateGraphButton();
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
  body.innerHTML = parts
    .map((para, i) => {
      const cls = isSectionTitle(para) ? ' class="section-title"' : '';
      return `<p data-i="${i}"${cls}>${escapeHtml(para)}</p>`;
    })
    .join('');

  const words = state.paper.text.replace(/\s+/g, '').length;
  $('#paper-stats').textContent = `${formatCount(words)} 字 · ${parts.length} 段`;
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

  $('#paper-title').value = state.paper.title;
  $('#paper-view-switch').hidden = !state.hasPdf;
  renderPaper();
  switchPaperView(state.hasPdf ? 'pdf' : 'text');
  if (!keepReading) {
    clearReading();
    clearAskThread(); // 换论文后旧追问不能带进新论文的报告
    renderStructure(null); // 同时清空概念卡与图解
  }
  persistPaper();
  updateGraphButton();
  schedulePaperSave(300);
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
      zhCount ? ` · ${zhCount} 段译文（点段落看中文）` : ''
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
  clearTimeout(readingRenderTimer);
  readingRenderTimer = 0;
  readingCards = [];
  $('#reading-list').innerHTML = READING_EMPTY_HTML;
  $('#reading-status').textContent = '';
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
  list.appendChild(node);
  entry = { node, heading, body, html: '', title: '' };
  readingCards[index] = entry;
  return entry;
}

function paintReading() {
  readingLastPaint = performance.now();
  const list = $('#reading-list');
  const sections = parseReading(state.readingText);
  const streaming = state.readingStreaming;

  if (!sections.length) {
    if (!streaming && state.readingError) {
      readingCards = [];
      list.innerHTML = `<div class="reading-error">${escapeHtml(state.readingError)}</div>`;
      return;
    }
    if (readingCards.length) {
      readingCards = [];
      list.innerHTML = '<div class="empty-state"><p class="empty-sub">正在生成…</p></div>';
    }
    return;
  }

  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  // 第一张卡片出现时清掉「正在生成…」占位
  if (!readingCards.length && list.querySelector('.empty-state')) list.innerHTML = '';

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
    .map((c) => {
      const terms = conceptTerms(c);
      return `<button class="concept-chip" type="button" data-terms="${escapeHtml(JSON.stringify(terms))}" title="在原文中定位：${escapeHtml(terms.join(' / '))}"><b>${escapeHtml(c.name)}</b><span>${escapeHtml(c.explain)}</span></button>`;
    })
    .join('');

  claimList.innerHTML = (data.claims || [])
    .map((c) => `<div class="claim-row"><span class="claim-tag">${escapeHtml(c.label)}</span><span>${escapeHtml(c.text)}</span></div>`)
    .join('');

  if (data.tags?.length) {
    $('#diagram-status').textContent = data.tags.map((t) => `#${t}`).join(' ');
  }
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
  renderStructure(null);
  $('#reading-list').innerHTML = '<div class="empty-state"><p class="empty-sub">模型正在读这篇论文…</p></div>';
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
          $('#reading-status').textContent = evt.demo ? 'demo 示例结果' : '已完成';
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
      renderStructure(res.data);
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

/* ---------------------------------- 追问 ---------------------------------- */

/** 追问对话同时存进 state.askThread，导出报告时要用（DOM 只是渲染结果） */
function pushAsk(role, text, quote = '') {
  const thread = $('#ask-thread');
  const div = document.createElement('div');
  div.className = `ask-item ${role === 'user' ? 'q' : 'a'}`;
  if (quote) {
    const q = document.createElement('span');
    q.className = 'quote';
    q.textContent = quote.length > 120 ? `${quote.slice(0, 120)}…` : quote;
    div.appendChild(q);
  }
  const content = document.createElement('span');
  content.textContent = text;
  div.appendChild(content);
  thread.appendChild(div);
  thread.scrollTop = thread.scrollHeight;
  const entry = { role, text: String(text || ''), quote: String(quote || '') };
  state.askThread.push(entry);
  schedulePaperSave(1200);
  return { el: content, entry };
}

function clearAskThread() {
  $('#ask-thread').innerHTML = '';
  state.askThread = [];
  state.selection = '';
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
  pushAsk('user', question, selection);
  const { el: target, entry: answerEntry } = pushAsk('assistant', '…');
  $('#ask-input').value = '';
  autoGrow($('#ask-input'));

  try {
    await streamRequest('/api/ask', {
      paper: state.paper,
      selection,
      reading: state.readingText,
      question,
    }, (evt) => {
      if (evt.type === 'delta') {
        const pending = answerEntry.text === '…' || answerEntry.text === '思考中…';
        answerEntry.text = pending ? evt.text : answerEntry.text + evt.text;
        target.textContent = answerEntry.text;
        $('#ask-thread').scrollTop = $('#ask-thread').scrollHeight;
      } else if (evt.type === 'thinking') {
        if (answerEntry.text === '…') {
          answerEntry.text = '思考中…';
          target.textContent = answerEntry.text;
        }
      } else if (evt.type === 'error') {
        answerEntry.text = `出错了：${evt.message}`;
        answerEntry.error = true;
        target.textContent = answerEntry.text;
      }
    });
  } catch (err) {
    answerEntry.text = `出错了：${err.message}`;
    answerEntry.error = true;
    target.textContent = answerEntry.text;
  }
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
  $('#btn-settings').onclick = () => {
    fillSettings();
    openDialog('#dlg-settings');
  };
  $('#btn-theme').onclick = () => {
    applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
    setTimeout(() => diagram.fit(), 50);
  };

  $('#btn-sample-2').onclick = loadSample;

  // 原文栏右上角的载入入口
  $('#btn-upload-pdf').onclick = () => {
    const input = $('#file-input');
    input.value = '';
    input.click();
  };
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

  // 概念定位
  $('#concept-list').onclick = (ev) => {
    const chip = ev.target.closest('.concept-chip');
    if (!chip) return;
    switchPaneIfNarrow('paper');
    let terms = [];
    try {
      terms = JSON.parse(chip.dataset.terms || '[]');
    } catch {
      terms = [];
    }
    locateTerm(terms.length ? terms : [chip.dataset.term || '']);
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

  // 图解工具
  $('#btn-diagram-relayout').onclick = () => diagram.relayout();
  $('#btn-diagram-fit').onclick = () => diagram.fit();
  $('#btn-diagram-export').onclick = exportDiagram;
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
};

main();
