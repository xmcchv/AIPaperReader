/**
 * 前端：三栏工作台 + 导入 + 详情 + 设置。
 * 状态全部来自服务端（/api/state），刷新后布局、选中、模式都能还原。
 */
import { GraphView, edgeLabel } from './graph.js';
import { StarfieldView } from './starfield.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const state = {
  library: { sources: [], concepts: [], edges: [], layout: { dag: {}, mind: {} }, view: {} },
  config: null,
  presets: {},
  storage: null,
  graph: null,
  graphId: '',
  graphs: [],
  demo: null,
  tab: 'concepts',
  query: '',
  railQuery: '',
  remoteSearch: null,
  searchTimer: 0,
  searchSeq: 0,
  selectedId: '',
  selectedSourceId: '',
  mode: 'dag',
  rootId: '',
  editing: false,
  pendingImage: null,
  pendingImportPane: 'text',
  busy: false,
  showStubs: localStorage.getItem('kg-show-stubs') === '1',
  sourceFilter: '',
};

/* --------------------------------- 小工具 --------------------------------- */

const escapeHtml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** 服务端用【】标出命中位置，这里转成 <mark> */
const markSnippet = (text) => escapeHtml(text).replace(/【([^】]{1,80})】/g, '<mark>$1</mark>');

/** 资料正文里只高亮第一处命中，并把视口滚过去 */
function highlightFirst(text, query) {
  const escaped = escapeHtml(text);
  const needle = String(query || '').trim();
  if (!needle) return escaped;
  const idx = escaped.toLowerCase().indexOf(escapeHtml(needle).toLowerCase());
  if (idx < 0) return escaped;
  const length = escapeHtml(needle).length;
  return `${escaped.slice(0, idx)}<mark>${escaped.slice(idx, idx + length)}</mark>${escaped.slice(idx + length)}`;
}

const fmtCount = (n) => (n >= 10000 ? `${(n / 10000).toFixed(1)} 万` : String(n));

let toastTimer = 0;
function toast(message, kind = '') {
  const node = $('#kg-toast');
  node.textContent = message;
  node.className = `toast ${kind}`.trim();
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, kind === 'error' ? 6000 : 3800);
}

/**
 * 统一请求：默认把当前图谱带到 query 上，服务端据此切换工作区。
 * 同源合并后所有图谱接口都在 /api/kg/*，这里统一加前缀，调用点保持原样。
 * graphOverride 传空字符串表示这次请求不指定图谱（例如激活另一个图谱时）。
 */
async function api(path, body, graphOverride) {
  const apiPath = path.startsWith('/api/') ? `/api/kg${path.slice('/api'.length)}` : path;
  const graphId = graphOverride === undefined ? state.graphId : graphOverride;
  let url = apiPath;
  if (graphId) url += `${apiPath.includes('?') ? '&' : '?'}graph=${encodeURIComponent(graphId)}`;
  const init =
    body === undefined
      ? {}
      : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败（${res.status}）`);
  return data;
}

const byId = (id) => state.library.concepts.find((concept) => concept.id === id);
const sourceById = (id) => state.library.sources.find((source) => source.id === id);

const KIND_LABEL = {
  concept: '概念',
  method: '方法',
  formula: '公式',
  data: '数据',
  task: '任务',
  result: '结论',
  tool: '工具',
};

const SOURCE_LABEL = { paper: '论文', web: '网页', image: '图片', text: '笔记', paperlens: 'PaperLens' };

/**
 * 图上/左栏实际显示的知识库。
 * 两层过滤：
 *   1) 按资料筛选（只看某篇文献引出的概念）—— 不同论文混在一起时用它降噪
 *   2) 隐藏待补全（stub）—— 模型提出但还没解释的前置概念，数量常常远多于实体概念
 */
function visibleLibrary() {
  const lib = state.library;
  let concepts = lib.concepts;
  if (state.sourceFilter) {
    concepts = concepts.filter((concept) => (concept.sourceIds || []).includes(state.sourceFilter));
  }
  if (!state.showStubs) concepts = concepts.filter((concept) => !concept.stub);
  const keep = new Set(concepts.map((concept) => concept.id));
  return {
    ...lib,
    concepts: concepts.slice(),
    edges: lib.edges.filter((edge) => keep.has(edge.from) && keep.has(edge.to)),
  };
}

function applyLibrary(library, { refit = false } = {}) {
  if (!library) return;
  state.library = library;
  state.rootId = library.view?.rootId ?? state.rootId;
  if (state.selectedId && !byId(state.selectedId)) state.selectedId = '';
  // 筛选的资料被删掉了，就自动回到整张图
  if (state.sourceFilter && !library.sources.some((source) => source.id === state.sourceFilter)) {
    state.sourceFilter = '';
  }
  if (state.graph) {
    state.graph = {
      ...state.graph,
      sources: library.sources.length,
      concepts: library.concepts.length,
      edges: library.edges.length,
    };
  }
  view.setData(visibleLibrary(), { mode: state.mode, rootId: state.rootId, selectedId: state.selectedId });
  renderAll();
  renderGraphBar();
  if (refit) view.fit();
}

/* --------------------------------- 渲染 ---------------------------------- */

function renderAll() {
  renderStats();
  renderRail();
  renderDetail();
  syncToolbar();
  updateEmptyState();
  renderFilterChip();
}

/** 顶栏/工具栏上的「只看某篇资料」胶囊 */
function renderFilterChip() {
  const chip = $('#kg-filter-chip');
  if (!chip) return;
  if (!state.sourceFilter) {
    chip.hidden = true;
    chip.textContent = '';
    return;
  }
  const source = sourceById(state.sourceFilter);
  chip.hidden = false;
  chip.textContent = `只看：${source?.title || '未知资料'} ✕`;
  chip.title = '点击清除筛选，回到整张图';
}

/** 过滤条件变化后重建视图 */
function refreshView(refit = true) {
  view.setData(visibleLibrary(), { mode: state.mode, rootId: state.rootId, selectedId: state.selectedId });
  renderAll();
  if (refit) view.fit();
}

function renderStats() {
  const { concepts, edges, sources } = state.library;
  const prereq = edges.filter((edge) => edge.type === 'prereq').length;
  const stub = concepts.filter((concept) => concept.stub).length;
  $('#kg-stats').innerHTML = [
    `<span><b>${concepts.length}</b> 知识点</span>`,
    `<span><b>${prereq}</b> 前置关系</span>`,
    `<span><b>${sources.length}</b> 份资料</span>`,
    stub ? `<span title="待补全的占位知识点"><b>${stub}</b> 待补全</span>` : '',
    state.config && !state.config.ready ? '<span title="还没配置模型，抽取不可用">未配模型</span>' : '',
  ]
    .filter(Boolean)
    .join('');
}

/* -------------------------------- 图谱（工作区） -------------------------------- */

/** 一次 /api/state 的完整落地：库 + 图谱 + 存储 + 配置 */
function applyStatePayload(data, { resetSelection = false } = {}) {
  if (data.graph) {
    state.graph = data.graph;
    state.graphId = data.graph.id;
  }
  if (Array.isArray(data.graphs)) state.graphs = data.graphs;
  if (data.storage) state.storage = data.storage;
  if (data.config) state.config = data.config;
  if (resetSelection) {
    state.selectedId = '';
    state.selectedSourceId = '';
    state.editing = false;
    state.remoteSearch = null;
    state.sourceFilter = '';
    state.query = '';
    const searchBox = $('#kg-search');
    if (searchBox) searchBox.value = '';
    $('#kg-search-count').textContent = '';
    state.railQuery = '';
  }
  state.library = data.library;
  state.mode = ['dag', 'mind', 'star'].includes(data.library?.view?.mode) ? data.library.view.mode : 'dag';
  state.rootId = data.library?.view?.rootId || '';
  if (!state.selectedId) state.selectedId = data.library?.view?.selectedId || '';
  view.setData(visibleLibrary(), { mode: state.mode, rootId: state.rootId, selectedId: state.selectedId });
  renderAll();
  renderGraphBar();
  view.fit();
}

function renderGraphBar() {
  const name = state.graph?.name || '我的知识库';
  const label = $('#kg-graph-name');
  if (label) label.textContent = name;
  const button = $('#kg-graph-switch');
  if (button) {
    button.title = `当前图谱：${name}（${state.graph?.sources || 0} 份资料 / ${state.graph?.concepts || 0} 个知识点）—— 点击切换或管理`;
    button.classList.toggle('empty', !state.graph?.concepts);
  }
}

function renderGraphList() {
  const host = $('#kg-graph-list');
  if (!host) return;
  host.innerHTML = state.graphs.length
    ? state.graphs
        .map(
          (graph) => `<div class="graph-row ${graph.id === state.graphId ? 'active' : ''}">
        <button class="graph-open" data-graph="${graph.id}" type="button">
          <span class="graph-row-name">${escapeHtml(graph.name)}${
            graph.id === state.graphId ? '<span class="graph-badge">当前</span>' : ''
          }</span>
          <span class="graph-row-meta">${graph.sources} 份资料 · ${graph.concepts} 个知识点 · ${graph.edges} 条关系${
            graph.description ? ` · ${escapeHtml(graph.description)}` : ''
          }</span>
        </button>
        <button class="graph-act" data-rename="${graph.id}" type="button" title="重命名 / 改说明">✎</button>
        <button class="graph-act danger" data-delete="${graph.id}" type="button" title="删除图谱">✕</button>
      </div>`,
        )
        .join('')
    : '<p class="hint">还没有图谱，先新建一个。</p>';
}

function setGraphStatus(text, kind = '') {
  const status = $('#kg-graph-status');
  if (!status) return;
  status.textContent = text;
  status.className = `settings-status ${kind}`.trim();
}

async function switchGraph(id) {
  if (!id || id === state.graphId) {
    $('#kg-graphs-dialog')?.close();
    return;
  }
  try {
    setGraphStatus('切换中…');
    await api('/api/graphs/activate', { id }, '');
    state.graphId = id; // 后续请求带新图谱
    const data = await api('/api/state');
    applyStatePayload(data, { resetSelection: true });
    renderGraphList();
    $('#kg-graphs-dialog')?.close();
    toast(`已切换到「${state.graph?.name}」`, 'ok');
  } catch (err) {
    setGraphStatus(err.message, 'error');
  }
}

async function createGraphFromDialog() {
  const input = $('#kg-graph-new-name');
  const name = String(input?.value || '').trim();
  if (!name) {
    setGraphStatus('先给图谱起个名字', 'error');
    return;
  }
  try {
    setGraphStatus('新建中…');
    const created = await api('/api/graphs/create', { name }, '');
    state.graphId = created.graph.id;
    const data = await api('/api/state');
    applyStatePayload(data, { resetSelection: true });
    input.value = '';
    renderGraphList();
    setGraphStatus(`已新建「${created.graph.name}」，导入的资料会落到这个图谱里`, 'ok');
  } catch (err) {
    setGraphStatus(err.message, 'error');
  }
}

async function renameGraphPrompt(id) {
  const graph = state.graphs.find((item) => item.id === id);
  const name = prompt('图谱名字', graph?.name || '');
  if (name === null) return;
  const description = prompt('一句话说明（可留空）', graph?.description || '');
  if (description === null) return;
  try {
    const data = await api('/api/graphs/rename', { id, name: name.trim(), description: description.trim() }, '');
    state.graphs = data.graphs || state.graphs;
    if (id === state.graphId) state.graph = { ...state.graph, ...data.graph };
    renderGraphBar();
    renderGraphList();
    setGraphStatus('已保存', 'ok');
  } catch (err) {
    setGraphStatus(err.message, 'error');
  }
}

async function deleteGraphConfirm(id) {
  const graph = state.graphs.find((item) => item.id === id);
  const ok = confirm(
    `删除图谱「${graph?.name || id}」？\n\n会连同 ${graph?.sources || 0} 份资料、${graph?.concepts || 0} 个知识点一起删除。\n每日快照仍保留在 data/backups，必要时可以还原。`,
  );
  if (!ok) return;
  try {
    setGraphStatus('删除中…');
    const data = await api('/api/graphs/delete', { id }, '');
    if (data.graph) state.graphId = data.graph.id;
    const fresh = await api('/api/state');
    applyStatePayload(fresh, { resetSelection: true });
    renderGraphList();
    setGraphStatus(`已删除，当前图谱是「${state.graph?.name}」`, 'ok');
  } catch (err) {
    setGraphStatus(err.message, 'error');
  }
}

function renderRail() {
  const list = $('#kg-rail-list');
  const query = state.railQuery.trim().toLowerCase();
  const concepts = visibleLibrary().concepts.slice();
  const hitsHtml = renderSourceHits();

  if (state.tab === 'sources') {
    const sources = state.library.sources.slice().reverse();
    const filtered = sources.filter((source) => !query || `${source.title} ${source.url} ${(source.topics || []).join(' ')}`.toLowerCase().includes(query));
    list.innerHTML =
      hitsHtml +
      (filtered.length
        ? filtered
            .map((source) => {
              const count = state.library.concepts.filter((concept) => (concept.sourceIds || []).includes(source.id)).length;
              const flag = source.meta?.pending ? ' · 待抽取' : source.meta?.needsText ? ' · 缺正文' : '';
              return `<button class="rail-item ${state.selectedSourceId === source.id ? 'active' : ''}" data-source="${source.id}">
              <span class="dot" style="background:${source.kind === 'image' ? 'var(--warn)' : source.kind === 'web' ? 'var(--ok)' : 'var(--accent)'}"></span>
              <span class="meta"><span class="name">${escapeHtml(source.title)}</span><span class="sub">${SOURCE_LABEL[source.kind] || '资料'} · ${fmtCount(source.chars)} 字${flag}</span></span>
              <span class="count">${count}</span>
            </button>`;
            })
            .join('')
        : '<p class="hint" style="padding:10px">还没有资料，点右上角「导入资料」。</p>');
    $('#kg-rail-foot-note').textContent = `${state.library.sources.length} 份资料 · 点开看原文与出处`;
    return;
  }

  if (state.tab === 'topics') {
    const buckets = new Map();
    for (const concept of state.library.concepts) {
      for (const tag of concept.tags || []) {
        if (!buckets.has(tag)) buckets.set(tag, []);
        buckets.get(tag).push(concept);
      }
    }
    const rows = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
    const filtered = rows.filter(([tag]) => !query || tag.toLowerCase().includes(query));
    list.innerHTML =
      hitsHtml +
      (filtered.length
        ? filtered
            .map(
              ([tag, items]) =>
                `<button class="rail-item" data-tag="${escapeHtml(tag)}"><span class="dot" style="background:var(--edge-extends)"></span><span class="meta"><span class="name">${escapeHtml(tag)}</span><span class="sub">${items.slice(0, 3).map((item) => item.name).join(' · ')}</span></span><span class="count">${items.length}</span></button>`,
            )
            .join('')
        : '<p class="hint" style="padding:10px">还没有分区标签，导入资料后会自动带上主题。</p>');
    $('#kg-rail-foot-note').textContent = `${buckets.size} 个分区`;
    return;
  }

  // 概念：默认按"前置少 → 前置多"排，读起来像学习顺序
  const degree = new Map();
  for (const edge of state.library.edges) {
    if (edge.type !== 'prereq') continue;
    degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
  }
  const filtered = concepts.filter((concept) => {
    if (!query) return true;
    return [concept.name, concept.summary, ...(concept.aliases || []), ...(concept.tags || [])]
      .join(' ')
      .toLowerCase()
      .includes(query);
  });
  filtered.sort((a, b) => (degree.get(a.id) || 0) - (degree.get(b.id) || 0) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  list.innerHTML =
    hitsHtml +
    (filtered.length
      ? filtered
          .map((concept) => {
            const out = state.library.edges.filter((edge) => edge.from === concept.id && edge.type === 'prereq').length;
            return `<button class="rail-item ${state.selectedId === concept.id ? 'active' : ''}" data-concept="${concept.id}">
            <span class="dot" style="background:${kindColor(concept)}"></span>
            <span class="meta"><span class="name">${escapeHtml(concept.name)}</span><span class="sub">${concept.stub ? '待补全' : escapeHtml(concept.summary || KIND_LABEL[concept.kind] || '概念')}</span></span>
            <span class="count">${out ? `+${out}` : ''}</span>
          </button>`;
          })
          .join('')
      : `<p class="hint" style="padding:10px">${query ? '没有匹配的知识点。' : '图谱还是空的，先导入资料或加载示例。'}</p>`);
  $('#kg-rail-foot-note').textContent = `${concepts.length} 个知识点${
    state.library.concepts.length > concepts.length ? `（隐藏 ${state.library.concepts.length - concepts.length} 个待补全）` : ''
  } · 点一下定位`;
}

/** 资料正文命中（来自 /api/search）：搜索框一输入就出现在左栏顶部 */
function renderSourceHits() {
  const remote = state.remoteSearch;
  const query = state.query.trim();
  if (!remote || !query || remote.query !== query || !remote.sources?.length) return '';
  const modeTag = remote.mode === 'fts' ? ' · FTS5' : '';
  return `<div class="rail-group">资料正文命中 ${remote.sources.length}${modeTag}</div>${remote.sources
    .map(
      (hit) => `<button class="rail-item" data-source-hit="${hit.id}">
        <span class="dot" style="background:var(--warn)"></span>
        <span class="meta"><span class="name">${escapeHtml(hit.title)}</span><span class="sub">${markSnippet(hit.snippet)}</span></span>
      </button>`,
    )
    .join('')}`;
}

/** 搜索框防抖：本地即时过滤概念，250ms 后再问服务端要资料正文命中 */
function scheduleRemoteSearch(raw) {
  const query = String(raw || '').trim();
  clearTimeout(state.searchTimer);
  if (!query) {
    state.remoteSearch = null;
    state.searchSeq += 1;
    renderRail();
    return;
  }
  state.searchSeq += 1;
  const seq = state.searchSeq;
  state.searchTimer = setTimeout(async () => {
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(query)}&limit=12`);
      if (seq !== state.searchSeq) return; // 已经有更新的输入了
      state.remoteSearch = data;
      renderRail();
      const total = (data.concepts?.length || 0) + (data.sources?.length || 0);
      $('#kg-search-count').textContent = `${total} 个匹配${data.mode === 'fts' ? ' · FTS5' : ''}`;
    } catch {
      /* 检索失败不打断输入 */
    }
  }, 250);
}

function kindColor(concept) {
  if (concept.stub) return 'var(--warn)';
  return (
    {
      method: 'var(--edge-extends)',
      formula: 'var(--edge-flow)',
      data: 'var(--ok)',
      result: 'var(--warn)',
      task: '#cf6aa1',
      tool: 'var(--faint)',
    }[concept.kind] || 'var(--accent)'
  );
}

function relGroups(conceptId) {
  const edges = state.library.edges;
  const pick = (edge) => {
    const otherId = edge.from === conceptId ? edge.to : edge.from;
    return { edge, other: byId(otherId) };
  };
  const incomingPrereq = edges.filter((edge) => edge.type === 'prereq' && edge.to === conceptId).map(pick);
  const outgoingPrereq = edges.filter((edge) => edge.type === 'prereq' && edge.from === conceptId).map(pick);
  const extendsIn = edges.filter((edge) => edge.type === 'extends' && edge.to === conceptId).map(pick);
  const extendsOut = edges.filter((edge) => edge.type === 'extends' && edge.from === conceptId).map(pick);
  const related = edges.filter((edge) => edge.type === 'related' && (edge.from === conceptId || edge.to === conceptId)).map(pick);
  const flowIn = edges.filter((edge) => edge.type === 'flow' && edge.to === conceptId).map(pick);
  const flowOut = edges.filter((edge) => edge.type === 'flow' && edge.from === conceptId).map(pick);
  return { incomingPrereq, outgoingPrereq, extendsIn, extendsOut, related, flowIn, flowOut };
}

function relList(rows, { empty = '暂无', typeLabel = null } = {}) {
  const valid = rows.filter((row) => row.other);
  if (!valid.length) return `<p class="hint">${empty}</p>`;
  return `<div class="rel-list">${valid
    .map(
      ({ edge, other }) => `<div class="rel-item">
        <button class="rel-main" data-concept="${other.id}" title="${escapeHtml(other.summary || '')}">
          <span class="rel-type">${typeLabel || edgeLabel(edge.type)}</span>
          <span class="rel-name">${escapeHtml(other.name)}${other.stub ? '（待补全）' : ''}</span>
          ${edge.label ? `<span class="rel-label">${escapeHtml(edge.label)}</span>` : ''}
        </button>
        <button class="rel-del" data-edge="${edge.id}" title="删除这条关系" aria-label="删除关系">✕</button>
      </div>`,
    )
    .join('')}</div>`;
}

function renderDetail() {
  const host = $('#kg-detail');

  if (state.selectedSourceId) {
    renderSourceDetail(host, state.selectedSourceId);
    return;
  }

  const concept = byId(state.selectedId);
  if (!concept) {
    host.innerHTML = `<div class="detail-empty"><h3>知识点详情</h3><p>点任意一个知识点：它的定义、前置链路、以及每条结论对应的原文出处都会显示在这里。</p>
      <p class="hint" style="margin-top:10px">Shift + 点击两个知识点，可以看到它们之间的通路。</p></div>`;
    return;
  }

  if (state.editing) {
    host.innerHTML = `<div class="detail-head"><h2>编辑知识点</h2></div>
      <div class="detail-edit">
        <label class="field"><span>名称</span><input id="edit-name" value="${escapeHtml(concept.name)}" /></label>
        <label class="field"><span>一句话解释</span><textarea id="edit-summary" rows="4">${escapeHtml(concept.summary || '')}</textarea></label>
        <label class="field"><span>别名（英文术语 / 缩写，逗号分隔）</span><input id="edit-aliases" value="${escapeHtml((concept.aliases || []).join(', '))}" /></label>
        <label class="field"><span>标签（逗号分隔）</span><input id="edit-tags" value="${escapeHtml((concept.tags || []).join(', '))}" /></label>
        <label class="field"><span>类型</span><select id="edit-kind">
          ${Object.entries(KIND_LABEL)
            .map(([value, label]) => `<option value="${value}" ${concept.kind === value ? 'selected' : ''}>${label}</option>`)
            .join('')}
        </select></label>
        <div class="detail-actions">
          <button class="btn primary" data-act="save-edit">保存</button>
          <button class="btn ghost" data-act="cancel-edit">取消</button>
        </div>
      </div>`;
    return;
  }

  const groups = relGroups(concept.id);
  const refs = (concept.refs || []).slice().reverse();
  const refMarkup = refs.length
    ? refs
        .map((ref) => {
          const source = sourceById(ref.sourceId);
          return `<div class="ref-card">
            <div class="ref-quote">${escapeHtml(ref.quote)}</div>
            <div class="ref-foot"><span class="ref-source">${escapeHtml(source?.title || '来源已删除')}</span>
            ${source ? `<button class="link" data-source="${source.id}">看原文</button>` : ''}
            ${source && source.kind === 'paperlens'
              ? `<a class="link" href="${source.meta && source.meta.paperId ? `/?paper=${encodeURIComponent(source.meta.paperId)}&quote=${encodeURIComponent(ref.quote)}` : `/?fromSource=${encodeURIComponent(source.id)}`}">回精读</a>`
              : ''}</div>
          </div>`;
        })
        .join('')
    : '<p class="hint">这个词条还没有可核对的原文出处（手工创建或占位节点）。导入资料后出处会自动挂上。</p>';

  host.innerHTML = `
    <div class="detail-head">
      <h2>${escapeHtml(concept.name)}</h2>
      <span class="badge">${KIND_LABEL[concept.kind] || '概念'}</span>
      ${concept.stub ? '<span class="badge warn">待补全</span>' : ''}
    </div>
    ${(concept.aliases || []).length ? `<div class="chip-row" style="margin-top:8px">${concept.aliases.map((alias) => `<span class="chip">${escapeHtml(alias)}</span>`).join('')}</div>` : ''}
    <div class="detail-section">
      <h4>是什么</h4>
      <p class="detail-summary ${concept.summary ? '' : 'empty'}">${escapeHtml(concept.summary || '还没有解释，点下面的「AI 补全」或手动编辑。')}</p>
    </div>
    ${(concept.tags || []).length ? `<div class="chip-row" style="margin-top:10px">${concept.tags.map((tag) => `<button class="chip" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('')}</div>` : ''}
    <div class="detail-section">
      <h4>前置 · 学它之前 <button class="link" data-act="add-prereq">＋ 添加</button></h4>
      ${relList(groups.incomingPrereq, { empty: '它是这条链的起点' })}
    </div>
    <div class="detail-section">
      <h4>延伸 · 它撑起了</h4>
      ${relList(groups.outgoingPrereq, { empty: '还没有后继概念' })}
    </div>
    ${
      groups.extendsIn.length || groups.extendsOut.length
        ? `<div class="detail-section"><h4>延伸关系</h4>${relList([...groups.extendsIn, ...groups.extendsOut])}</div>`
        : ''
    }
    ${groups.related.length ? `<div class="detail-section"><h4>并列 · 相关概念</h4>${relList(groups.related)}</div>` : ''}
    ${
      groups.flowIn.length || groups.flowOut.length
        ? `<div class="detail-section"><h4>流程</h4>${relList([...groups.flowIn, ...groups.flowOut])}</div>`
        : ''
    }
    <div class="detail-section">
      <h4>出处 · 原文依据</h4>
      ${refMarkup}
    </div>
    <div class="detail-actions">
      <button class="btn ghost small" data-act="edit">编辑</button>
      <button class="btn ghost small" data-act="enrich" ${state.config?.ready ? '' : 'disabled title="先配置模型"'}>AI 补全</button>
      <button class="btn ghost small" data-act="mind-root">设为导图根</button>
      <button class="btn ghost small" data-act="locate">在图上定位</button>
      <button class="btn ghost small" data-act="delete" style="color:var(--danger)">删除</button>
    </div>`;
}

function renderSourceDetail(host, sourceId) {
  const source = sourceById(sourceId);
  if (!source) {
    state.selectedSourceId = '';
    renderDetail();
    return;
  }
  const concepts = state.library.concepts.filter((concept) => (concept.sourceIds || []).includes(sourceId));
  const flag = source.meta?.pending
    ? ' · <span style="color:var(--warn)">还没抽取</span>'
    : source.meta?.needsText
      ? ' · <span style="color:var(--warn)">缺正文</span>'
      : '';
  host.innerHTML = `
    <div class="detail-head"><h2>${escapeHtml(source.title)}</h2><span class="badge">${SOURCE_LABEL[source.kind] || '资料'}</span></div>
    ${source.assetUrl ? `<div class="source-image"><img src="${escapeHtml(source.assetUrl)}" alt="${escapeHtml(source.title)}" /></div>` : ''}
    <div class="detail-section">
      <h4>资料信息</h4>
      <p class="detail-summary">${fmtCount(source.chars)} 字 · ${concepts.length} 个知识点${flag}</p>
      ${source.url ? `<p class="hint" style="word-break:break-all">${escapeHtml(source.url)}</p>` : ''}
      ${(source.topics || []).length ? `<div class="chip-row" style="margin-top:8px">${source.topics.map((tag) => `<button class="chip" data-tag="${escapeHtml(tag)}">${escapeHtml(tag)}</button>`).join('')}</div>` : ''}
      ${source.meta?.needsText ? '<p class="hint">这份资料没有可抽取的文字：配置视觉模型后重新导入图片，或把图里的要点粘贴成文本资料。</p>' : ''}
    </div>
    <div class="detail-section">
      <h4>摘录</h4>
      <p class="detail-summary">${escapeHtml(source.excerpt || '（没有正文摘录）')}</p>
    </div>
    <div class="detail-section">
      <h4>来自这份资料的知识点</h4>
      ${
        concepts.length
          ? `<div class="chip-row">${concepts.map((concept) => `<button class="chip" data-concept="${concept.id}">${escapeHtml(concept.name)}</button>`).join('')}</div>`
          : '<p class="hint">这份资料还没有抽出知识点。</p>'
      }
    </div>
    <div class="detail-actions">
      ${source.chars > 0 ? '<button class="btn ghost small" data-act="read-source">阅读原文</button>' : ''}
      <button class="btn ghost small" data-act="filter-source" ${
        state.sourceFilter === source.id ? 'disabled title="已经在只看这篇了"' : 'title="图上只留这篇资料引出的概念"'
      }>只看这篇的图</button>
      <button class="btn ghost small" data-act="reextract" ${
        state.config?.ready && source.chars > 0 ? '' : 'disabled title="需要正文和已配置的模型"'
      }>重新抽取</button>
      <button class="btn ghost small" data-act="delete-source" style="color:var(--danger)">删除资料</button>
    </div>`;
}

function updateEmptyState() {
  const empty = state.library.concepts.length === 0;
  $('#kg-empty-graph').hidden = !empty;
  $('#kg-legend').hidden = empty;
}

function syncToolbar() {
  $$('[data-mode]').forEach((button) => button.classList.toggle('active', button.dataset.mode === state.mode));
  const hint = $('#kg-stage-hint');
  if (hint) {
    const actualRoot = byId(state.rootId || view.layout?.rootId)?.name || '自动选择';
    hint.textContent =
      state.mode === 'mind'
        ? `思维导图：根 = ${actualRoot} · 双击任意知识点换根 · 拖拽可微调`
        : state.mode === 'star'
          ? '星空视图：拖拽旋转 · 滚轮推近拉远 · 点击看详情 · 双击设为导图根 · 放着不动会慢慢自转'
          : '拖拽平移 · 滚轮缩放 · 点击看详情 · Shift 点两个看通路 · 双击设为根';
  }
  const exporting = state.mode !== 'star';
  $('#kg-btn-export-svg').disabled = !exporting;
  $('#kg-btn-export-png').disabled = !exporting;
  $('#kg-btn-export-svg').title = exporting ? '导出矢量图' : '星空视图暂不支持导出，切回 2D 视图再导';
  $('#kg-btn-clear-path').hidden = view.path.size === 0;
  const stubToggle = $('#kg-btn-toggle-stubs');
  if (stubToggle) {
    const hidden = state.library.concepts.filter((concept) => concept.stub).length;
    stubToggle.textContent = state.showStubs ? '隐藏待补全' : `显示待补全${hidden ? `（${hidden}）` : ''}`;
    stubToggle.disabled = hidden === 0;
  }
  syncZoomLabel();
}

function syncZoomLabel() {
  const label = $('#kg-zoom-label');
  if (label) label.textContent = state.mode === 'star' ? '3D' : `${Math.round(view.transform.k * 100)}%`;
}

/* --------------------------------- 事件 ---------------------------------- */

const view = new GraphView($('#kg-graph'), {
  onSelect: (id) => {
    state.selectedId = id;
    state.selectedSourceId = '';
    state.editing = false;
    renderRail();
    renderDetail();
    syncToolbar();
    saveView();
  },
  onMessage: (message) => toast(message),
  onRootChange: (id) => {
    state.rootId = id;
    state.selectedId = id;
    state.mode = 'mind';
    view.setMode('mind', id);
    renderAll();
    saveView();
    toast(`已把「${byId(id)?.name || ''}」设为思维导图的根`);
  },
});

/* ----------------------------- 3D 星空视图 ----------------------------- */

const starView = new StarfieldView($('#kg-star-canvas'), {
  onSelect: (id) => {
    state.selectedId = id;
    state.selectedSourceId = '';
    state.editing = false;
    view.select(id); // 同步回 SVG 视图，切回 2D 时选中状态一致
    renderRail();
    renderDetail();
    syncToolbar();
    saveView();
  },
  onMessage: (message) => toast(message),
  onRootChange: (id) => {
    state.rootId = id;
    state.mode = 'mind';
    view.setMode('mind', id);
    renderAll();
    saveView();
    toast(`已把「${byId(id)?.name || ''}」设为思维导图的根`);
  },
});

/** 把当前库与高亮状态喂给星空视图，并按模式切换画布显隐 */
function syncStar() {
  const active = state.mode === 'star';
  $('#kg-graph').style.visibility = active ? 'hidden' : '';
  $('#kg-star-canvas').hidden = !active;
  $('#kg-legend').hidden = active || state.library.concepts.length === 0;
  if (!active) {
    starView.stop();
    return;
  }
  starView.setLibrary(visibleLibrary(), {
    selectedId: state.selectedId,
    query: state.query,
    path: view.path,
  });
  starView.start();
}

// SVG 视图的常用更新方法执行后顺手同步星空，模式切换 / 搜索 / 选中全部自动生效
for (const name of ['setData', 'setMode', 'setSearch', 'select', 'togglePath', 'clearPath', 'render']) {
  const original = view[name].bind(view);
  view[name] = (...args) => {
    const result = original(...args);
    syncStar();
    return result;
  };
}

function saveView() {
  api('/api/view', { mode: state.mode, selectedId: state.selectedId, rootId: state.rootId }).catch(() => {});
}

function bindEvents() {
  // 顶部
  $('#kg-btn-import').addEventListener('click', () => openImport());
  $('#kg-btn-settings').addEventListener('click', () => openSettings());
  $('#kg-btn-theme').addEventListener('click', toggleTheme);

  // 图谱切换 / 管理
  $('#kg-graph-switch').addEventListener('click', async () => {
    $('#kg-graphs-dialog').showModal();
    renderGraphList();
    setGraphStatus('');
    try {
      const data = await api('/api/graphs');
      if (Array.isArray(data.graphs)) state.graphs = data.graphs;
      if (data.graph) state.graph = data.graph;
      state.graphId = data.graph?.id || state.graphId;
      renderGraphList();
      renderGraphBar();
    } catch {
      /* 拉不到就先用现有列表 */
    }
  });
  $('#kg-graph-list').addEventListener('click', (event) => {
    const openBtn = event.target.closest('[data-graph]');
    if (openBtn) {
      switchGraph(openBtn.dataset.graph);
      return;
    }
    const renameBtn = event.target.closest('[data-rename]');
    if (renameBtn) {
      renameGraphPrompt(renameBtn.dataset.rename);
      return;
    }
    const deleteBtn = event.target.closest('[data-delete]');
    if (deleteBtn) deleteGraphConfirm(deleteBtn.dataset.delete);
  });
  $('#kg-btn-graph-create').addEventListener('click', createGraphFromDialog);
  $('#kg-graph-new-name').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      createGraphFromDialog();
    }
  });
  $('#kg-search').addEventListener('input', (event) => {
    state.query = event.target.value;
    view.setSearch(state.query);
    const count = state.query
      ? state.library.concepts.filter((concept) =>
          [concept.name, concept.summary, ...(concept.aliases || []), ...(concept.tags || [])]
            .join(' ')
            .toLowerCase()
            .includes(state.query.trim().toLowerCase()),
        ).length
      : 0;
    $('#kg-search-count').textContent = state.query ? `${count} 个匹配` : '';
    state.railQuery = state.query;
    renderRail();
    scheduleRemoteSearch(state.query);
  });

  // 左栏
  $$('.rail-tabs .seg').forEach((button) => {
    button.addEventListener('click', () => {
      state.tab = button.dataset.tab;
      $$('.rail-tabs .seg').forEach((item) => item.classList.toggle('active', item === button));
      renderRail();
    });
  });

  $('#kg-rail-list').addEventListener('click', (event) => {
    const hitBtn = event.target.closest('[data-source-hit]');
    if (hitBtn) {
      openSourceDialog(hitBtn.dataset.sourceHit);
      return;
    }
    const conceptBtn = event.target.closest('[data-concept]');
    if (conceptBtn) {
      selectConcept(conceptBtn.dataset.concept);
      return;
    }
    const sourceBtn = event.target.closest('[data-source]');
    if (sourceBtn) {
      state.selectedSourceId = sourceBtn.dataset.source;
      state.selectedId = '';
      view.select('');
      renderRail();
      renderDetail();
      return;
    }
    const tagBtn = event.target.closest('[data-tag]');
    if (tagBtn) focusTag(tagBtn.dataset.tag);
  });

  $('#kg-btn-reextract-all').addEventListener('click', reextractPending);

  // 画布工具栏
  $$('[data-mode]').forEach((button) =>
    button.addEventListener('click', () => {
      state.mode = button.dataset.mode;
      if (state.mode === 'mind' && !state.rootId) state.rootId = state.selectedId || '';
      view.setMode(state.mode, state.rootId);
      renderAll();
      saveView();
    }),
  );
  const starZoom = (factor) => {
    starView.targetDist = null;
    starView.dist = Math.max(320, Math.min(2600, starView.dist * factor));
  };
  $('#kg-btn-zoom-in').addEventListener('click', () => {
    if (state.mode === 'star') {
      starZoom(0.8);
      return;
    }
    view.zoomBy(1.25);
    syncZoomLabel();
  });
  $('#kg-btn-zoom-out').addEventListener('click', () => {
    if (state.mode === 'star') {
      starZoom(1.25);
      return;
    }
    view.zoomBy(0.8);
    syncZoomLabel();
  });
  $('#kg-btn-fit').addEventListener('click', () => {
    if (state.mode === 'star') {
      starView.targetDist = 1150;
      starView.targetYaw = starView.targetYaw ?? starView.yaw;
      starView.targetPitch = 0.32;
      return;
    }
    // 手动「适应」允许缩到最小，先把全貌看到再说
    view.fit(48, 0.14);
    syncZoomLabel();
  });
  $('#kg-btn-toggle-stubs').addEventListener('click', () => {
    state.showStubs = !state.showStubs;
    localStorage.setItem('kg-show-stubs', state.showStubs ? '1' : '0');
    view.setData(visibleLibrary(), { mode: state.mode, rootId: state.rootId, selectedId: state.selectedId });
    renderAll();
    view.fit();
    toast(state.showStubs ? '已显示待补全的前置概念' : '已隐藏待补全的前置概念（数据没删，随时可以打开）');
  });
  $('#kg-filter-chip').addEventListener('click', () => {
    state.sourceFilter = '';
    refreshView();
    toast('已清除资料筛选，回到整张图');
  });
  $('#kg-btn-clear-path').addEventListener('click', () => {
    view.clearPath();
    syncToolbar();
  });
  $('#kg-btn-export-svg').addEventListener('click', () => download(view.exportSvg(), 'svg'));
  $('#kg-btn-export-png').addEventListener('click', exportPng);

  const wrap = $('#kg-canvas-wrap');
  const observer = new ResizeObserver(() => {
    if (state.mode === 'star') return;
    const label = $('#kg-zoom-label');
    if (label) label.textContent = `${Math.round(view.transform.k * 100)}%`;
  });
  observer.observe(wrap);
  wrap.addEventListener('wheel', () => {
    if (state.mode === 'star') return; // 星空模式的缩放是推近拉远，不走 2D 缩放比例
    $('#kg-zoom-label').textContent = `${Math.round(view.transform.k * 100)}%`;
  }, { passive: true });
  wrap.addEventListener('dblclick', () => {});

  // 空状态按钮
  $('#kg-empty-graph').addEventListener('click', (event) => {
    const action = event.target.closest('[data-action]')?.dataset.action;
    if (action === 'open-import') openImport();
    if (action === 'load-demo') loadDemo();
  });

  // 详情面板
  $('#kg-detail').addEventListener('click', (event) => {
    const actBtn = event.target.closest('[data-act]');
    if (actBtn) {
      handleDetailAction(actBtn.dataset.act);
      return;
    }
    const delEdgeBtn = event.target.closest('[data-edge]');
    if (delEdgeBtn) {
      deleteEdge(delEdgeBtn.dataset.edge);
      return;
    }
    const conceptBtn = event.target.closest('[data-concept]');
    if (conceptBtn) {
      selectConcept(conceptBtn.dataset.concept);
      return;
    }
    const tagBtn = event.target.closest('[data-tag]');
    if (tagBtn) focusTag(tagBtn.dataset.tag);
    const sourceBtn = event.target.closest('[data-source]');
    if (sourceBtn) openSourceDialog(sourceBtn.dataset.source);
  });

  // dialog 打开 / 关闭
  $$('dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target === dialog || event.target.closest('[data-close]')) dialog.close();
    });
  });

  bindImportDialog();
  bindSettingsDialog();
  bindEdgeDialog();

  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      $('#kg-search').focus();
      $('#kg-search').select();
    }
    if (event.key === 'Escape' && document.activeElement === $('#kg-search')) {
      $('#kg-search').value = '';
      state.query = '';
      $('#kg-search-count').textContent = '';
      view.setSearch('');
      state.railQuery = '';
      renderRail();
    }
  });
}

function selectConcept(id) {
  if (state.mode === 'mind' && !state.rootId) state.rootId = id;
  state.selectedId = id;
  state.selectedSourceId = '';
  state.editing = false;
  view.select(id);
  renderRail();
  renderDetail();
  syncToolbar();
  saveView();
}

function focusTag(tag) {
  state.tab = 'concepts';
  $$('.rail-tabs .seg').forEach((item) => item.classList.toggle('active', item.dataset.tab === 'concepts'));
  state.railQuery = tag;
  renderRail();
  toast(`已筛出标签「${tag}」下的知识点`);
}

function handleDetailAction(action) {
  const concept = byId(state.selectedId);
  if (action === 'edit' && concept) {
    state.editing = true;
    renderDetail();
    return;
  }
  if (action === 'cancel-edit') {
    state.editing = false;
    renderDetail();
    return;
  }
  if (action === 'save-edit') return saveConceptEdit();
  if (action === 'enrich' && concept) return enrichConcept(concept);
  if (action === 'delete' && concept) return removeConcept(concept);
  if (action === 'mind-root' && concept) {
    view.onRootChange(concept.id);
    return;
  }
  if (action === 'locate' && concept) {
    if (state.mode === 'star') {
      starView.focus(concept.id);
      return;
    }
    if (!view.centerOn(concept.id)) toast('这个知识点不在当前视图里（换到分层图看看）', 'error');
    syncZoomLabel();
    renderRail();
    return;
  }
  if (action === 'add-prereq' && concept) {
    openEdgeDialog(concept.id);
    return;
  }
  if (action === 'read-source' && state.selectedSourceId) {
    openSourceDialog(state.selectedSourceId);
    return;
  }
  if (action === 'filter-source' && state.selectedSourceId) {
    state.sourceFilter = state.selectedSourceId;
    refreshView();
    const source = sourceById(state.sourceFilter);
    toast(`图上只显示「${source?.title || ''}」引出的概念，点顶部胶囊可清除`);
    return;
  }
  if (action === 'reextract' && state.selectedSourceId) {
    reextractSource(state.selectedSourceId);
    return;
  }
  if (action === 'delete-source' && state.selectedSourceId) {
    deleteSource(state.selectedSourceId);
  }
}

/* -------------------------------- 概念操作 -------------------------------- */

async function saveConceptEdit() {
  const concept = byId(state.selectedId);
  if (!concept) return;
  const payload = {
    id: concept.id,
    name: $('#kg-edit-name').value.trim(),
    summary: $('#kg-edit-summary').value.trim(),
    aliases: $('#kg-edit-aliases').value.split(',').map((item) => item.trim()).filter(Boolean),
    tags: $('#kg-edit-tags').value.split(',').map((item) => item.trim()).filter(Boolean),
    kind: $('#kg-edit-kind').value,
  };
  try {
    const data = await api('/api/concepts', payload);
    state.editing = false;
    applyLibrary(data.library);
    toast('已保存', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function enrichConcept(concept) {
  toast(`正在补全「${concept.name}」…`);
  try {
    const data = await api('/api/concepts/enrich', { id: concept.id });
    applyLibrary(data.library);
    toast(`已补全，新增 ${data.edgesAdded} 条关系`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function removeConcept(concept) {
  if (!confirm(`删除知识点「${concept.name}」以及它的所有关系？`)) return;
  try {
    const data = await api('/api/concepts/delete', { id: concept.id });
    state.selectedId = '';
    applyLibrary(data.library);
    toast('已删除');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** 删除一条关系（手工加错的、或者模型抽错的） */
async function deleteEdge(edgeId) {
  const edge = state.library.edges.find((item) => item.id === edgeId);
  if (!edge) return;
  const from = byId(edge.from)?.name || '?';
  const to = byId(edge.to)?.name || '?';
  if (!confirm(`删除关系「${from} → ${to}（${edgeLabel(edge.type)}）」？`)) return;
  try {
    const data = await api('/api/edges/delete', { id: edgeId });
    applyLibrary(data.library);
    toast(data.ok === false ? '这条关系已经不在了' : '关系已删除', data.ok === false ? 'error' : 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function deleteSource(sourceId) {
  const source = sourceById(sourceId);
  if (!source) return;
  if (!confirm(`删除资料「${source.title}」？只属于它的知识点会一并清理。`)) return;
  try {
    const data = await api('/api/sources/delete', { id: sourceId });
    state.selectedSourceId = '';
    applyLibrary(data.library);
    toast(`已删除，清理了 ${data.removedConcepts || 0} 个孤立知识点`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* -------------------------------- 资料正文 -------------------------------- */

async function openSourceDialog(sourceId) {
  const dialog = $('#kg-source-dialog');
  const source = sourceById(sourceId);
  const query = state.query.trim();
  $('#kg-source-dialog-title').textContent = source?.title || '资料正文';
  $('#kg-source-dialog-text').textContent = '正在读取…';
  dialog.dataset.source = sourceId;
  dialog.showModal();
  try {
    const data = await api('/api/sources/text', { id: sourceId });
    const text = data.text || '（这份资料没有正文）';
    const host = $('#kg-source-dialog-text');
    // 从搜索结果点进来时，把命中的那一处标出来并滚到视野里
    host.innerHTML = query ? highlightFirst(text, query) : escapeHtml(text);
    const mark = host.querySelector('mark');
    if (mark) mark.scrollIntoView({ block: 'center' });
  } catch (err) {
    $('#kg-source-dialog-text').textContent = `读取失败：${err.message}`;
  }
}

async function reextractSource(sourceId) {
  toast('正在重新抽取…');
  try {
    const data = await api('/api/sources/reextract', { id: sourceId });
    if (data.ok === false) return toast(data.error || '抽取失败', 'error');
    applyLibrary(data.library);
    toast(`已抽取：新增 ${data.stats?.conceptsAdded || 0} 个知识点、${data.stats?.edgesAdded || 0} 条关系`, 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function reextractPending() {
  const pending = state.library.sources.filter((source) => source.meta?.pending);
  if (!pending.length) return toast('没有待抽取的资料');
  if (!state.config?.ready) return toast('先配置模型再补抽取', 'error');
  let done = 0;
  for (const source of pending) {
    try {
      const data = await api('/api/sources/reextract', { id: source.id });
      if (data.ok !== false) done += 1;
      applyLibrary(data.library);
    } catch (err) {
      toast(err.message, 'error');
      break;
    }
  }
  toast(`补抽取完成：${done}/${pending.length} 份资料`);
}

/* -------------------------------- 导入资料 -------------------------------- */

function openImport() {
  resetImportStatus();
  $('#kg-import-dialog').showModal();
}

function resetImportStatus() {
  const status = $('#kg-import-status');
  status.textContent = '';
  status.className = 'import-status';
}

function setImportStatus(text, kind = '') {
  const status = $('#kg-import-status');
  status.textContent = text;
  status.className = `import-status ${kind}`.trim();
}

function bindImportDialog() {
  $$('[data-pane-btn]').forEach((button) =>
    button.addEventListener('click', () => {
      state.pendingImportPane = button.dataset.paneBtn;
      $$('[data-pane-btn]').forEach((item) => item.classList.toggle('active', item === button));
      $$('[data-pane]').forEach((pane) => {
        pane.hidden = pane.dataset.pane !== state.pendingImportPane;
      });
    }),
  );

  $('#kg-import-image').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    state.pendingImage = null;
    const preview = $('#kg-image-preview');
    if (!file) {
      preview.hidden = true;
      preview.innerHTML = '';
      return;
    }
    if (file.size > 12 * 1024 * 1024) {
      setImportStatus('图片超过 12MB，请先压缩', 'error');
      event.target.value = '';
      return;
    }
    const dataUrl = await readFileAsDataUrl(file);
    state.pendingImage = { filename: file.name, mime: file.type || 'image/png', base64: String(dataUrl).split(',')[1] || '' };
    preview.hidden = false;
    preview.innerHTML = `<img src="${dataUrl}" alt="预览" />`;
    setImportStatus(`${file.name} · ${(file.size / 1024).toFixed(0)} KB`, '');
  });

  $('#kg-btn-import-run').addEventListener('click', runImport);
  $('#kg-btn-load-demo').addEventListener('click', () => {
    $('#kg-import-dialog').close();
    loadDemo();
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

async function runImport() {
  if (state.busy) return;
  const pane = state.pendingImportPane;
  let payload = null;
  if (pane === 'text') {
    const text = $('#kg-import-text').value.trim();
    if (text.length < 40) return setImportStatus('正文太短了，至少 40 个字符', 'error');
    payload = { kind: 'text', title: $('#kg-import-title').value.trim(), text };
  } else if (pane === 'web') {
    const url = $('#kg-import-url').value.trim();
    if (!url) return setImportStatus('请填写链接', 'error');
    payload = { kind: 'web', url };
  } else {
    if (!state.pendingImage) return setImportStatus('请先选择图片', 'error');
    payload = {
      kind: 'image',
      filename: state.pendingImage.filename,
      mime: state.pendingImage.mime,
      base64: state.pendingImage.base64,
      text: $('#kg-import-image-text').value.trim(),
      title: state.pendingImage.filename,
    };
  }

  state.busy = true;
  $('#kg-btn-import-run').disabled = true;
  setImportStatus(state.config?.ready ? '正在识别概念、连接前置关系并核对出处（通常 30–90 秒）…' : '正在入库…', 'busy');
  try {
    const data = await api('/api/import', payload);
    applyLibrary(data.library, { refit: true });
    const stats = data.stats || {};
    const summary = stats.conceptsAdded || stats.edgesAdded
      ? `新增 ${stats.conceptsAdded || 0} 个知识点、${stats.edgesAdded || 0} 条关系`
      : '资料已入库';
    if (data.warnings?.length) setImportStatus(`${summary}。注意：${data.warnings.join('；')}`, 'ok');
    else setImportStatus(`${summary}。`, 'ok');
    toast(summary, 'ok');
    $('#kg-import-text').value = '';
    $('#kg-import-title').value = '';
    $('#kg-import-url').value = '';
    state.pendingImage = null;
    $('#kg-image-preview').hidden = true;
    setTimeout(() => $('#kg-import-dialog').close(), data.warnings?.length ? 4200 : 900);
  } catch (err) {
    setImportStatus(err.message, 'error');
  } finally {
    state.busy = false;
    $('#kg-btn-import-run').disabled = false;
  }
}

async function loadDemo() {
  try {
    const data = await api('/api/demo/load', {});
    applyLibrary(data.library, { refit: true });
    toast('示例图谱已加载：点知识点看前置链路与出处', 'ok');
  } catch (err) {
    toast(err.message, 'error');
  }
}

/* -------------------------------- 设置面板 -------------------------------- */

/** 设置面板里的存储信息：SQLite 文件、体积、FTS 状态 */
function renderStorageNote() {
  const storage = state.storage;
  const note = $('#kg-storage-note');
  if (!note) return;
  if (!storage) {
    note.textContent = '存储信息读取中…';
    return;
  }
  const mb = (storage.sizeBytes / 1024 / 1024).toFixed(2);
  note.innerHTML = `存储：SQLite（<code>${escapeHtml(storage.path)}</code>）· ${mb} MB<br />
    ${storage.sources} 份资料 · ${storage.concepts} 个知识点 · ${storage.edges} 条关系 · Node ${escapeHtml(storage.node)}<br />
    全文检索：${storage.fts ? `FTS5 trigram 加速（已索引 ${storage.ftsRows} 份资料）` : 'LIKE 扫描（FTS5 加速未开启，个人库规模下足够快）'}`;
  const toggle = $('#kg-btn-toggle-fts');
  if (toggle) toggle.textContent = storage.fts ? '关闭 FTS5 加速' : '开启 FTS5 加速';
}

function openSettings() {
  const cfg = state.config || {};
  $('#kg-cfg-base-url').value = cfg.base_url || '';
  $('#kg-cfg-model').value = cfg.model || '';
  $('#kg-cfg-api-key').value = '';
  $('#kg-cfg-api-key').placeholder = cfg.locked ? '已加密（输入主密码后点「解锁」）' : cfg.has_key ? '已保存（留空表示不修改）' : 'sk-...';
  $('#kg-cfg-max-tokens').value = cfg.max_tokens ?? '';
  $('#kg-cfg-vision-model').value = cfg.vision_model || '';
  $('#kg-cfg-vision-base-url').value = cfg.vision_base_url || '';
  $('#kg-cfg-vision-key').value = '';

  const presetRow = $('#kg-preset-row');
  presetRow.innerHTML = Object.entries(state.presets || {})
    .map(([key, preset]) => `<button class="seg" data-preset="${key}">${escapeHtml(preset.label)}</button>`)
    .join('');
  presetRow.querySelectorAll('[data-preset]').forEach((button) =>
    button.addEventListener('click', () => {
      const preset = state.presets[button.dataset.preset];
      if (!preset) return;
      $('#kg-cfg-base-url').value = preset.base_url || '';
      $('#kg-cfg-model').value = preset.model || '';
      const list = $('#kg-model-options');
      list.innerHTML = (preset.models || []).map((model) => `<option value="${escapeHtml(model)}"></option>`).join('');
    }),
  );

  const note = $('#kg-config-note');
  const sourceLabel = { kgraph: '知识图谱自己的配置', paperlens: '复用的 PaperLens 配置', env: '环境变量', default: '默认值' };
  note.innerHTML = `当前生效：${sourceLabel[cfg.source] || cfg.source} · ${cfg.ready ? `<code>${escapeHtml(cfg.model)}</code>` : '未配置模型（可先用示例图谱）'}<br />
    配置文件：<code>${escapeHtml(cfg.config_path || '')}</code><br />
    PaperLens 配置（可复用）：<code>${escapeHtml(cfg.paperlens_config_path || '')}</code><br />
    数据目录：<code>${escapeHtml(cfg.data_dir || '')}</code>`;
  renderStorageNote();

  $('#kg-settings-status').textContent = '';
  $('#kg-settings-dialog').showModal();
}

function bindSettingsDialog() {
  // 备份：把整库导出成旧版 JSON（含资料全文）
  $('#kg-btn-export-library').addEventListener('click', () => {
    const link = document.createElement('a');
    link.href = '/api/kg/export/library.json';
    link.download = '';
    link.click();
    toast('已导出知识库 JSON，可作为备份或换机器迁移用', 'ok');
  });

  // FTS5 加速器开关：默认关闭（LIKE 在个人库规模下更快），库很大时再打开
  $('#kg-btn-toggle-fts').addEventListener('click', async () => {
    const status = $('#kg-settings-status');
    const enabled = !state.storage?.fts;
    status.textContent = enabled ? '正在建立 FTS5 索引…' : '正在关闭…';
    status.className = 'settings-status';
    try {
      const data = await api('/api/fts', { enabled });
      state.storage = data.storage || state.storage;
      renderStorageNote();
      status.textContent = enabled
        ? `FTS5 索引已建立：${data.rows ?? 0} 份资料，用时 ${data.ms ?? 0}ms`
        : 'FTS5 加速已关闭，检索改回 LIKE';
      status.className = 'settings-status ok';
    } catch (err) {
      status.textContent = err.message;
      status.className = 'settings-status error';
    }
  });

  $('#kg-btn-save-config').addEventListener('click', async () => {
    const status = $('#kg-settings-status');
    const payload = {
      base_url: $('#kg-cfg-base-url').value.trim(),
      model: $('#kg-cfg-model').value.trim(),
      api_key: $('#kg-cfg-api-key').value,
      passphrase: $('#kg-cfg-passphrase').value,
      max_tokens: $('#kg-cfg-max-tokens').value.trim(),
      vision_model: $('#kg-cfg-vision-model').value.trim(),
      vision_base_url: $('#kg-cfg-vision-base-url').value.trim(),
      vision_api_key: $('#kg-cfg-vision-key').value,
    };
    try {
      status.textContent = '保存中…';
      status.className = 'settings-status';
      const data = await api('/api/config', payload);
      state.config = data.config;
      status.textContent = data.config.ready ? '已保存，模型可用' : '已保存，但还缺 Key 或模型名';
      status.className = `settings-status ${data.config.ready ? 'ok' : 'error'}`;
      $('#kg-cfg-passphrase').value = '';
      $('#kg-cfg-api-key').value = '';
      toast('模型设置已保存', 'ok');
    } catch (err) {
      status.textContent = err.message;
      status.className = 'settings-status error';
    }
  });

  $('#kg-btn-test').addEventListener('click', async () => {
    const status = $('#kg-settings-status');
    status.textContent = '正在测试连接…';
    status.className = 'settings-status';
    try {
      const data = await api('/api/config/test', {
        base_url: $('#kg-cfg-base-url').value.trim(),
        model: $('#kg-cfg-model').value.trim(),
        api_key: $('#kg-cfg-api-key').value,
      });
      if (data.ok) {
        status.textContent = `连通正常：${data.model} · ${data.latency_ms}ms · 回复「${data.reply}」`;
        status.className = 'settings-status ok';
      } else {
        status.textContent = data.error || '连接失败';
        status.className = 'settings-status error';
      }
    } catch (err) {
      status.textContent = err.message;
      status.className = 'settings-status error';
    }
  });

  $('#kg-btn-unlock').addEventListener('click', async () => {
    const status = $('#kg-settings-status');
    const passphrase = $('#kg-cfg-passphrase').value.trim();
    if (!passphrase) {
      status.textContent = '先填主密码';
      status.className = 'settings-status error';
      return;
    }
    try {
      const data = await api('/api/config/unlock', { passphrase });
      if (!data.ok) {
        status.textContent = data.error || '解锁失败';
        status.className = 'settings-status error';
        return;
      }
      state.config = data.config;
      status.textContent = '已解锁，可以开始抽取了';
      status.className = 'settings-status ok';
    } catch (err) {
      status.textContent = err.message;
      status.className = 'settings-status error';
    }
  });
}


/* -------------------------------- 关系面板 -------------------------------- */

function openEdgeDialog(toId) {
  const dialog = $('#kg-edge-dialog');
  const options = state.library.concepts
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
    .map((concept) => `<option value="${concept.id}">${escapeHtml(concept.name)}</option>`)
    .join('');
  $('#kg-edge-from').innerHTML = options;
  $('#kg-edge-to').innerHTML = options;
  if (toId) $('#kg-edge-to').value = toId;
  $('#kg-edge-label').value = '';
  $('#kg-edge-type').value = 'prereq';
  const target = byId(toId);
  $('#kg-edge-dialog-note').textContent = target
    ? `给「${target.name}」补一条关系：起点是前置 / 来源，终点是它自己或后继概念。`
    : '选两个知识点连一条关系。';
  $('#kg-edge-status').textContent = '';
  dialog.showModal();
}

function bindEdgeDialog() {
  $('#kg-btn-save-edge').addEventListener('click', async () => {
    const from = $('#kg-edge-from').value;
    const to = $('#kg-edge-to').value;
    if (from === to) {
      $('#kg-edge-status').textContent = '起点和终点不能是同一个知识点';
      $('#kg-edge-status').className = 'settings-status error';
      return;
    }
    try {
      const data = await api('/api/edges', {
        from,
        to,
        type: $('#kg-edge-type').value,
        label: $('#kg-edge-label').value.trim(),
      });
      applyLibrary(data.library);
      $('#kg-edge-dialog').close();
      toast('关系已保存', 'ok');
    } catch (err) {
      $('#kg-edge-status').textContent = err.message;
      $('#kg-edge-status').className = 'settings-status error';
    }
  });
}

/* --------------------------------- 主题 ---------------------------------- */

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  // 与精读页共用主题键，单页外壳里切换视图不会闪
  localStorage.setItem('paperlens.theme', theme);
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  view.render();
}

/* --------------------------------- 导出 ---------------------------------- */

function download(content, type) {
  if (!content) return toast('图谱是空的，没有可导出的内容', 'error');
  const stamp = new Date().toISOString().slice(0, 10);
  const isSvg = type === 'svg';
  const blob = content instanceof Blob ? content : new Blob([content], { type: isSvg ? 'image/svg+xml;charset=utf-8' : 'image/png' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `knowledge-graph-${state.mode}-${stamp}.${isSvg ? 'svg' : 'png'}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  toast(`已导出 ${isSvg ? 'SVG' : 'PNG'}`, 'ok');
}

async function exportPng() {
  try {
    const blob = await view.exportPng();
    download(blob, 'png');
  } catch (err) {
    toast(`导出 PNG 失败：${err.message}`, 'error');
  }
}

/* --------------------------------- 启动 ---------------------------------- */

async function init() {
  // ?theme=light|dark 可以强制主题（分享截图或长期固定一种时用），否则记住上次选择
  const urlTheme = new URLSearchParams(location.search).get('theme');
  applyTheme(
    urlTheme === 'light' || urlTheme === 'dark'
      ? urlTheme
      : localStorage.getItem('paperlens.theme') || localStorage.getItem('kg-theme') || 'dark',
  );
  bindEvents();
  try {
    // ?graph=<id> 可以直接打开某个图谱；?source=<id> 直接从"只看这篇文献"开始
    const params = new URLSearchParams(location.search);
    const urlGraph = params.get('graph') || '';
    const data = await api('/api/state', undefined, urlGraph);
    state.presets = data.presets || {};
    state.demo = data.demo || null;
    const urlSource = params.get('source') || '';
    state.sourceFilter = data.library?.sources?.some((source) => source.id === urlSource) ? urlSource : '';
    applyStatePayload(data);

    // ?q=关键词：打开就带着搜索（也方便分享一个检索结果）
    const urlQuery = params.get('q');
    if (urlQuery) {
      const input = $('#kg-search');
      input.value = urlQuery;
      input.dispatchEvent(new Event('input'));
    }
  } catch (err) {
    toast(`连接服务失败：${err.message}`, 'error');
  }
}

window.addEventListener('resize', () => {
  // 单页外壳里图谱视图默认隐藏，切换显示后需要按真实尺寸重新适配
  try {
    view.fit();
  } catch {
    /* 还没加载完成 */
  }
});

init();
