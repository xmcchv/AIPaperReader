/**
 * 知识图谱 API 路由。
 * 由 server/index.mjs 挂在 /api/kg/* 下；旧版 /api/state、/api/import 等路径继续作为别名。
 */
import path from 'node:path';

import { DATA_DIR, loadConfig, publicConfig, saveConfig, unlockConfig, PRESETS } from '../shared/config.mjs';
import { completeChat, extractJson } from '../shared/llm.mjs';
import { HttpError, sendJson, readBody, serveFile } from '../shared/http.mjs';
import {
  activateGraph,
  addEdge,
  addSource,
  clearLibrary,
  createGraph,
  deleteConcept,
  deleteEdge,
  deleteGraph,
  deleteSource,
  exportLibraryJson,
  getActiveGraphId,
  getConcept,
  getCurrentGraph,
  getSourceText,
  getStorageInfo,
  importLibrary,
  isFtsEnabled,
  listGraphs,
  loadLibrary,
  mergeGraph,
  patchSourceMeta,
  publicLibrary,
  renameGraph,
  saveAsset,
  saveConcept,
  saveLayout,
  saveView,
  searchAll,
  setFtsEnabled,
  upsertConcept,
} from './store.mjs';
import { describeImage, enrichPrereqs, extractGraph, paperlensExtraction } from './extract.mjs';
import { fetchWeb } from './web.mjs';
import { DEMO_GRAPH, DEMO_SOURCE } from './demo.mjs';

/** 库里已有的概念名（喂给模型，让它优先复用而不是另造近义名） */
function knownConceptNames() {
  return loadLibrary()
    .concepts.filter((concept) => !concept.stub)
    .map((concept) => concept.name)
    .slice(0, 200);
}

function requireText(text, label = '资料正文') {
  const value = String(text || '').trim();
  if (value.length < 40) throw new HttpError(400, `${label}太短了，至少需要 40 个字符才能抽概念`);
  if (value.length > 400000) throw new HttpError(400, `${label}超过 40 万字符，请拆成几份分别导入`);
  return value;
}

/* -------------------------------- 导入流程 -------------------------------- */

/**
 * 一次导入：拿到正文（必要时先抓网页/识别图片）→ 存资料 → 抽概念 → 并进图谱。
 * 没配模型时不报错，资料照样入库（meta.pending = true），配好模型后可以「重新抽取」。
 */
async function importPayload(body = {}) {
  const cfg = loadConfig();
  const kind = ['paper', 'web', 'image', 'text', 'paperlens'].includes(body.kind) ? body.kind : 'text';
  const warnings = [];
  let title = String(body.title || '').trim().slice(0, 200);
  let text = String(body.text || '').trim();
  let url = String(body.url || '').trim();
  let assetPath = '';
  let structure = body.structure && typeof body.structure === 'object' ? body.structure : null;
  let reading = String(body.reading || '');

  if (kind === 'web') {
    const page = await fetchWeb(url);
    title = title || page.title;
    text = page.text;
    url = page.url;
  }

  if (kind === 'image') {
    const base64 = String(body.base64 || '');
    if (!base64) throw new HttpError(400, '没有收到图片数据');
    assetPath = saveAsset(body.filename, base64);
    title = title || String(body.filename || '图片资料');
    if (text) {
      // 前端已经贴了图里的文字，直接用
    } else if (cfg.vision_ready) {
      try {
        text = await describeImage(cfg, {
          base64,
          mime: String(body.mime || 'image/png'),
          filename: body.filename,
        });
      } catch (err) {
        warnings.push(`图片识别失败：${err.message}`);
      }
    } else {
      warnings.push('没有配置视觉模型，图片已归档为素材（可在设置里填视觉模型，或把图里的文字粘贴进来）');
    }
  }

  if (kind !== 'image' || text) {
    if (!text) throw new HttpError(400, '没有正文可以抽概念');
    text = requireText(text, kind === 'web' ? '网页正文' : '资料正文');
  }

  const source = addSource({
    kind,
    title: title || '未命名资料',
    url,
    text,
    assetPath,
    meta: {
      reading: reading.slice(0, 200),
      structure: Boolean(structure),
      paperId: String(body.paperId || '').slice(0, 40),
    },
  });

  let extraction = null;
  if (kind === 'paperlens' && structure) {
    extraction = paperlensExtraction({ structure, paperText: text, reading });
  } else if (text && cfg.ready) {
    const result = await extractGraph(cfg, { title: source.title, text, knownConcepts: knownConceptNames() });
    if (result.ok) extraction = result.extraction;
    else warnings.push(result.error);
  } else if (text) {
    warnings.push('还没有配置模型，资料已入库但没抽概念（配好模型后点「重新抽取」）');
  }

  if (extraction && !extraction.concepts.length) warnings.push('这份资料里没有抽到概念，可以换一段更完整的正文');

  let stats = null;
  if (extraction && extraction.concepts.length) {
    // PaperLens 的结构里没有前置关系：配了模型就补齐，失败也不挡导入
    if (kind === 'paperlens' && cfg.ready && body.enrich !== false) {
      const enriched = await enrichPrereqs(cfg, {
        title: source.title,
        reading,
        text,
        concepts: extraction.concepts,
      });
      if (enriched) {
        const byName = new Map(extraction.concepts.map((concept) => [concept.name, concept]));
        for (const item of enriched.prereqs) {
          const hit = byName.get(item.name);
          if (hit) hit.prereqs = [...new Set([...(hit.prereqs || []), ...item.prereqs])];
        }
        extraction.edges.push(...enriched.edges);
      }
    }
    stats = mergeGraph(source, extraction);
    patchSourceMeta(source.id, { extracted: true });
  } else if (!text) {
    // 图片没正文（没配视觉模型）：标成"缺正文"，不是"待抽取"，否则补抽取一定失败
    patchSourceMeta(source.id, { needsText: true });
  } else {
    patchSourceMeta(source.id, { pending: true });
  }

  const fresh = getSourceText(source.id)?.source || source;
  return {
    ok: true,
    source: {
      id: fresh.id,
      kind: fresh.kind,
      title: fresh.title,
      url: fresh.url,
      chars: fresh.chars,
      assetPath: fresh.assetPath,
      pending: Boolean(fresh.meta.pending),
      needsText: Boolean(fresh.meta.needsText),
    },
    stats,
    warnings,
    concepts: extraction?.concepts?.map((concept) => concept.name) || [],
  };
}

/* --------------------------------- 路由 ---------------------------------- */

async function handleImport(req, res) {
  const body = await readBody(req);
  const result = await importPayload(body);
  sendJson(res, 200, { ...result, library: publicLibrary() });
}

/** PaperLens 一键推送：paper + reading + structure */
async function handlePaperlensImport(req, res) {
  const body = await readBody(req);
  const paper = body.paper && typeof body.paper === 'object' ? body.paper : {};
  const text = String(paper.text || body.text || '');
  if (!String(text).trim() && !body.structure) {
    throw new HttpError(400, 'PaperLens 没有传来论文正文或结构化结果');
  }
  const result = await importPayload({
    kind: 'paperlens',
    title: String(paper.title || body.title || 'PaperLens 论文'),
    url: String(paper.source || body.url || ''),
    text,
    reading: String(body.reading || ''),
    structure: body.structure || null,
    paperId: String(paper.id || body.paperId || ''),
    enrich: body.enrich,
  });
  sendJson(res, 200, { ...result, library: publicLibrary() });
}

/** 对某份资料重新抽取（配好模型后补跑，或第一次失败后重试） */
async function handleReextract(req, res) {
  const body = await readBody(req);
  const found = getSourceText(String(body.id || ''));
  if (!found) throw new HttpError(404, '没有这份资料');
  const cfg = loadConfig();
  if (!cfg.ready) throw new HttpError(400, '还没有配置模型，先在设置里填好 Base URL / Key / 模型名');

  const { source, text } = found;
  if (!String(text || '').trim()) throw new HttpError(400, '这份资料没有正文（图片素材需要先配置视觉模型）');
  const result = await extractGraph(cfg, { title: source.title, text, knownConcepts: knownConceptNames() });
  if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error, library: publicLibrary() });

  const stats = mergeGraph(source, result.extraction);
  patchSourceMeta(source.id, { pending: false, extracted: true, needsText: false });
  return sendJson(res, 200, { ok: true, stats, library: publicLibrary() });
}

/** 让模型补全某个概念（占位节点变实体，同时补上它的前置） */
async function handleEnrichConcept(req, res) {
  const body = await readBody(req);
  const cfg = loadConfig();
  if (!cfg.ready) throw new HttpError(400, '还没有配置模型，先在设置里填好 Base URL / Key / 模型名');

  const concept = getConcept(String(body.id || ''));
  if (!concept) throw new HttpError(404, '没有这个知识点');

  const lib = loadLibrary();
  const byId = new Map(lib.concepts.map((item) => [item.id, item]));
  const neighbors = lib.edges
    .filter((edge) => edge.from === concept.id || edge.to === concept.id)
    .map((edge) => {
      const other = byId.get(edge.from === concept.id ? edge.to : edge.from);
      return other ? `${other.name}（${edge.type === 'prereq' ? '前置/后继' : edge.type}）` : '';
    })
    .filter(Boolean)
    .slice(0, 12);

  const messages = [
    {
      role: 'system',
      content: '你是一个严谨的知识图谱补全器，只输出合法 JSON，绝不输出 JSON 之外的任何字符。',
    },
    {
      role: 'user',
      content: `知识点：${concept.name}
已有解释：${concept.summary || '（暂无）'}
它当前的邻居：${neighbors.join('；') || '（暂无）'}

请补全这个知识点，输出严格 JSON：
{
  "summary": "一句话解释（不超过 60 字，只讲通用知识，不要编造具体论文数字）",
  "aliases": ["英文术语或缩写"],
  "prereqs": ["要理解它必须先掌握的概念名，最多 4 个"],
  "related": ["与它并列或相关的重要概念，最多 3 个"]
}`,
    },
  ];

  const { content } = await completeChat(cfg, messages, { temperature: 0.2 });
  const parsed = extractJson(content) || {};
  const summary = String(parsed.summary || '').trim().slice(0, 400);
  const aliases = Array.isArray(parsed.aliases) ? parsed.aliases.map((alias) => String(alias).trim()).filter(Boolean) : [];

  saveConcept({
    id: concept.id,
    name: concept.name,
    summary: summary || concept.summary,
    aliases: [...new Set([...(concept.aliases || []), ...aliases])],
    tags: concept.tags || [],
    kind: concept.kind,
  });

  const ensure = (name) => upsertConcept({ name: String(name).trim(), summary: `待补全：${concept.name} 的相关概念` }, null, { stub: true }).concept;

  let added = 0;
  for (const name of Array.isArray(parsed.prereqs) ? parsed.prereqs : []) {
    const prereq = ensure(name);
    if (!prereq || prereq.id === concept.id) continue;
    if (addEdge(prereq.id, concept.id, 'prereq', { manual: true })) added += 1;
  }
  for (const name of Array.isArray(parsed.related) ? parsed.related : []) {
    const other = ensure(name);
    if (!other || other.id === concept.id) continue;
    if (addEdge(concept.id, other.id, 'related', { manual: true })) added += 1;
  }

  return sendJson(res, 200, { ok: true, edgesAdded: added, library: publicLibrary() });
}

function handleSaveConcept(req, res, body) {
  try {
    saveConcept(body || {});
  } catch (err) {
    throw new HttpError(err.message?.includes('同名') ? 409 : 400, err.message || '保存失败');
  }
  return sendJson(res, 200, { ok: true, library: publicLibrary() });
}

function handleSaveEdge(req, res, body) {
  const from = getConcept(String(body.from || ''));
  const to = getConcept(String(body.to || ''));
  if (!from || !to) throw new HttpError(400, '关系的两端知识点不存在');
  if (from.id === to.id) throw new HttpError(400, '不能连到自己');
  addEdge(from.id, to.id, body.type, { label: body.label, manual: true });
  return sendJson(res, 200, { ok: true, library: publicLibrary() });
}

function handleDeleteEdge(req, res, body) {
  const result = deleteEdge(String(body.id || ''));
  return sendJson(res, 200, { ...result, library: publicLibrary() });
}

async function handleConfigSave(req, res) {
  try {
    const config = saveConfig(await readBody(req));
    sendJson(res, 200, { ok: true, config });
  } catch (err) {
    sendJson(res, 400, { ok: false, error: err.message || '配置保存失败' });
  }
}

async function handleConfigTest(req, res) {
  const body = await readBody(req);
  const current = loadConfig();
  const draft = {
    ...current,
    base_url: String(body.base_url ?? current.base_url).trim(),
    model: String(body.model ?? current.model).trim(),
    api_key: (() => {
      const incoming = String(body.api_key ?? '').trim();
      if (!incoming || incoming.includes('•')) return current.api_key;
      return incoming;
    })(),
    max_tokens: 64,
  };
  if (!draft.api_key) {
    return sendJson(res, 200, {
      ok: false,
      error: current.locked ? 'API Key 已加密，请先输入主密码解锁' : '还没有填 API Key',
    });
  }
  try {
    const result = await testConnection(draft);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: err.message });
  }
}

async function handleUnlock(req, res) {
  const body = await readBody(req);
  sendJson(res, 200, unlockConfig(body.passphrase));
}

/** 加载内置示例：走与真实导入相同的合并流程 */
async function handleDemoLoad(req, res) {
  const source = addSource(DEMO_SOURCE);
  const stats = mergeGraph(source, DEMO_GRAPH);
  patchSourceMeta(source.id, { extracted: true });
  sendJson(res, 200, { ok: true, stats, library: publicLibrary() });
}

/* ------------------------------- 图谱（工作区） ------------------------------- */

async function handleGraphCreate(req, res) {
  const body = await readBody(req);
  const name = String(body.name || '').trim() || '未命名图谱';
  const graph = createGraph({ name, description: String(body.description || '') });
  sendJson(res, 200, { ok: true, graph, graphs: listGraphs(), library: publicLibrary() });
}

async function handleGraphRename(req, res) {
  const body = await readBody(req);
  const updated = renameGraph(String(body.id || getActiveGraphId()), {
    name: body.name,
    description: body.description,
  });
  sendJson(res, 200, { ok: true, graph: updated, current: getCurrentGraph(), graphs: listGraphs() });
}

async function handleGraphDelete(req, res) {
  const body = await readBody(req);
  const graphs = deleteGraph(String(body.id || ''));
  sendJson(res, 200, { ok: true, graphs, graph: getCurrentGraph(), library: publicLibrary() });
}

async function handleGraphActivate(req, res) {
  const body = await readBody(req);
  const graph = activateGraph(String(body.id || ''));
  sendJson(res, 200, { ok: true, graph, graphs: listGraphs(), library: publicLibrary() });
}

/** 全文检索：概念 + 资料正文 */
function handleSearch(req, res, url) {
  const query = url.searchParams.get('q') || '';
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 20));
  sendJson(res, 200, { ok: true, ...searchAll(query, { limit }) });
}

/** 导出成旧版 JSON（备份 / 换机器 / 退回 JSON 版本） */
function handleExport(req, res) {
  const lib = exportLibraryJson();
  const stamp = new Date().toISOString().slice(0, 10);
  const body = `${JSON.stringify(lib, null, 2)}\n`;
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Content-Disposition': `attachment; filename="knowledge-graph-${stamp}.json"`,
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function handleFtsToggle(req, res) {
  const body = await readBody(req);
  const result = setFtsEnabled(body.enabled !== false);
  sendJson(res, 200, { ok: true, ...result, storage: getStorageInfo() });
}

/** 用导出的 JSON 恢复知识库（导入到现有库，不覆盖） */
async function handleImportLibrary(req, res) {
  const body = await readBody(req);
  const lib = body && typeof body === 'object' && body.library && typeof body.library === 'object' ? body.library : body;
  if (!lib || !Array.isArray(lib.sources)) throw new HttpError(400, '这不是一个有效的知识库 JSON（缺少 sources 数组）');
  const counts = importLibrary(lib);
  sendJson(res, 200, { ok: true, counts, library: publicLibrary() });
}

function serveAsset(res, relPath) {
  const base = path.join(DATA_DIR, 'assets');
  const target = path.join(base, path.basename(relPath));
  if (target !== base && !target.startsWith(base + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Forbidden');
    return;
  }
  serveFile(res, target);
}

/**
 * 处理图谱 API。返回 true 表示已响应。
 * 同时兼容旧路径（/api/state、/api/import/paperlens ...）。
 */
export async function handleKgApi(req, res, url) {
  const raw = url.pathname;
  // /api/kg/state → /api/state；/api/kg/assets/x → /assets/x
  const pathname = raw.startsWith('/api/kg/assets/')
    ? raw.slice('/api/kg'.length)
    : raw.startsWith('/api/kg/')
      ? `/api${raw.slice('/api/kg'.length)}`
      : raw;

  if (req.method === 'GET' && pathname.startsWith('/assets/')) {
    serveAsset(res, pathname.slice('/assets/'.length));
    return true;
  }
  if (!pathname.startsWith('/api/')) return false;

  // 每个请求都可以用 ?graph=<id> 指定操作哪个图谱；不带就用当前激活的那个
  const requestedGraph = url.searchParams.get('graph') || '';
  if (requestedGraph && requestedGraph !== getActiveGraphId()) {
    try {
      activateGraph(requestedGraph);
    } catch {
      /* 无效 id 就继续用当前图谱，不因为一个参数让整个请求失败 */
    }
  }

  const key = `${req.method} ${pathname}`;
  switch (key) {
    case 'GET /api/state':
      return sendJson(res, 200, {
        library: publicLibrary(),
        config: publicConfig(),
        presets: PRESETS,
        storage: getStorageInfo(),
        graph: getCurrentGraph(),
        graphs: listGraphs(),
        demo: { title: DEMO_SOURCE.title, concepts: DEMO_GRAPH.concepts.length },
      }), true;
    case 'GET /api/graphs':
      return sendJson(res, 200, {
        ok: true,
        graphs: listGraphs(),
        graph: getCurrentGraph(),
        library: publicLibrary(),
      }), true;
    case 'GET /api/health':
      return sendJson(res, 200, { ok: true, service: 'paperlens', kg: true, version: 4, storage: 'sqlite' }), true;
    case 'GET /api/config':
      return sendJson(res, 200, { config: publicConfig(), presets: PRESETS }), true;
    case 'GET /api/search':
      return handleSearch(req, res, url), true;
    case 'GET /api/export/library.json':
      return handleExport(req, res), true;
    case 'GET /api/storage':
      return sendJson(res, 200, { ok: true, ...getStorageInfo() }), true;
    case 'POST /api/graphs/create':
      return await handleGraphCreate(req, res), true;
    case 'POST /api/graphs/rename':
      return await handleGraphRename(req, res), true;
    case 'POST /api/graphs/delete':
      return await handleGraphDelete(req, res), true;
    case 'POST /api/graphs/activate':
      return await handleGraphActivate(req, res), true;
    case 'POST /api/config':
      return await handleConfigSave(req, res), true;
    case 'POST /api/config/test':
      return await handleConfigTest(req, res), true;
    case 'POST /api/config/unlock':
      return await handleUnlock(req, res), true;
    case 'POST /api/import':
      return await handleImport(req, res), true;
    case 'POST /api/import/paperlens':
      return await handlePaperlensImport(req, res), true;
    case 'POST /api/import/paper':
      // 精读页的「→ 知识图谱」走这个语义化别名
      return await handlePaperlensImport(req, res), true;
    case 'POST /api/sources/reextract':
      return await handleReextract(req, res), true;
    case 'POST /api/concepts':
      return handleSaveConcept(req, res, await readBody(req)), true;
    case 'POST /api/concepts/enrich':
      return await handleEnrichConcept(req, res), true;
    case 'POST /api/edges':
      return handleSaveEdge(req, res, await readBody(req)), true;
    case 'POST /api/fts':
      return await handleFtsToggle(req, res), true;
    case 'POST /api/import/library.json':
      return await handleImportLibrary(req, res), true;
    case 'POST /api/demo/load':
      return await handleDemoLoad(req, res), true;
    default:
      break;
  }

  if (req.method === 'POST' && pathname === '/api/sources/delete') {
    const body = await readBody(req);
    return sendJson(res, 200, { ...deleteSource(String(body.id || '')), library: publicLibrary() }), true;
  }
  if (req.method === 'POST' && pathname === '/api/sources/text') {
    const body = await readBody(req);
    const found = getSourceText(String(body.id || ''));
    if (!found) return sendJson(res, 404, { ok: false, error: '没有这份资料' }), true;
    return sendJson(res, 200, {
      ok: true,
      source: { id: found.source.id, title: found.source.title, url: found.source.url, kind: found.source.kind },
      text: found.text.slice(0, 200000),
    }), true;
  }
  if (req.method === 'POST' && pathname === '/api/concepts/delete') {
    const body = await readBody(req);
    return sendJson(res, 200, { ...deleteConcept(String(body.id || '')), library: publicLibrary() }), true;
  }
  if (req.method === 'POST' && pathname === '/api/edges/delete') {
    return handleDeleteEdge(req, res, await readBody(req)), true;
  }
  if (req.method === 'POST' && pathname === '/api/layout') {
    const body = await readBody(req);
    saveLayout(body.mode === 'mind' ? 'mind' : 'dag', body.positions || {});
    return sendJson(res, 200, { ok: true }), true;
  }
  if (req.method === 'POST' && pathname === '/api/view') {
    const body = await readBody(req);
    saveView(body);
    return sendJson(res, 200, { ok: true }), true;
  }
  if (req.method === 'POST' && pathname === '/api/library/clear') {
    const body = await readBody(req);
    if (body.confirm !== 'clear') throw new HttpError(400, '需要 confirm=clear 才能清空知识库');
    clearLibrary();
    return sendJson(res, 200, { ok: true, library: publicLibrary() }), true;
  }

  sendJson(res, 404, { ok: false, error: `未知接口 ${key}` });
  return true;
}
