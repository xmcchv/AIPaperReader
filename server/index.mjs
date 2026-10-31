/**
 * PaperLens 统一服务端入口：零依赖 Node HTTP 服务。
 * 精读（/api/*）与知识图谱（/api/kg/*）共用一个进程、一份模型配置。
 * 只监听 127.0.0.1，API Key 不出本机。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DATA_DIR, loadConfig, publicConfig, saveConfig, unlockConfig, PRESETS } from './shared/config.mjs';
import { streamChat, completeChat, extractJson, testConnection, LlmError } from './shared/llm.mjs';
import { HttpError, sendJson, readBody, openSse, sleep, serveStatic } from './shared/http.mjs';
import { handleKgApi } from './kg/routes.mjs';
import { handlePaperApi } from './paper/routes.mjs';
import { readingMessages, structureMessages, askMessages, summaryMessages } from './prompts.mjs';
import { fetchArxivPaper } from './paper.mjs';
import { SAMPLE_PAPER, DEMO_READING, DEMO_STRUCTURE, DEMO_ASK } from './samples.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const KG_PUBLIC_DIR = path.join(PUBLIC_DIR, 'kg');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';

/** 知识图谱旧路径：同源后前端改用 /api/kg/*，这些只用于兼容旧脚本与旧书签 */
const KG_LEGACY_EXACT = new Set([
  '/api/state',
  '/api/health',
  '/api/search',
  '/api/storage',
  '/api/import',
  '/api/import/paperlens',
  '/api/import/library.json',
  '/api/export/library.json',
  '/api/layout',
  '/api/view',
  '/api/fts',
  '/api/library/clear',
  '/api/demo/load',
]);
const KG_LEGACY_PREFIX = ['/api/graphs', '/api/sources', '/api/concepts', '/api/edges'];

function isKgLegacyPath(pathname) {
  return (
    KG_LEGACY_EXACT.has(pathname) ||
    KG_LEGACY_PREFIX.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))
  );
}

/** demo 模式：把固定文本切片后模拟流式，让前端交互与真实调用完全一致 */
async function streamDemo(sse, text, { chunkSize = 14, delay = 14 } = {}) {
  for (let i = 0; i < text.length; i += chunkSize) {
    if (!sse.event('delta', { text: text.slice(i, i + chunkSize) })) return;
    await sleep(delay);
  }
  sse.event('done', { demo: true });
  sse.end();
}

function paperOf(body) {
  const paper = body?.paper || {};
  const text = String(paper.text || '').trim();
  return { title: String(paper.title || '').trim(), text };
}

function requirePaper(paper) {
  if (!paper.text) throw new HttpError(400, '没有论文内容，请先粘贴正文或上传文件');
  if (paper.text.length < 60) throw new HttpError(400, '论文内容太短，至少需要 60 个字符才能精读');
}

/* -------------------------------- 路由处理 -------------------------------- */

async function handleAnalyze(req, res) {
  const body = await readBody(req);
  const paper = paperOf(body);
  requirePaper(paper);

  const cfg = loadConfig();
  const sse = openSse(res);
  const demo = !cfg.api_key || body.demo === true;

  if (demo) {
    await streamDemo(sse, DEMO_READING);
    return;
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    sse.event('meta', { mode: 'live', model: cfg.model, provider: cfg.provider });
    const messages = readingMessages(paper.text, { title: paper.title });
    let thinkingChars = 0;
    let lastPush = 0;

    for await (const chunk of streamChat(cfg, messages, { signal: controller.signal })) {
      if (chunk.channel === 'reasoning') {
        // 思维链不混进正文，只在状态栏给个「推理中」的进度
        thinkingChars += chunk.text.length;
        const now = Date.now();
        if (now - lastPush > 220) {
          lastPush = now;
          if (!sse.event('thinking', { chars: thinkingChars })) break;
        }
        continue;
      }
      if (chunk.channel === 'content') {
        if (!sse.event('delta', { text: chunk.text })) break;
        continue;
      }
      if (chunk.channel === 'end' && chunk.finishReason === 'length') {
        sse.event('notice', {
          code: 'truncated',
          message: '输出达到 max_tokens 上限，精读可能被截断，可在「模型设置」里调大 max_tokens',
        });
      }
    }
    sse.event('done', { mode: 'live' });
  } catch (err) {
    sse.event('error', { message: err.message || '精读失败' });
  } finally {
    sse.end();
  }
}

async function handleStructure(req, res) {
  const body = await readBody(req);
  const paper = paperOf(body);
  requirePaper(paper);

  const cfg = loadConfig();
  if (!cfg.api_key || body.demo === true) {
    await sleep(120);
    return sendJson(res, 200, { ok: true, demo: true, data: DEMO_STRUCTURE });
  }

  try {
    const messages = structureMessages(paper.text, String(body.reading || ''), { title: paper.title });
    // 模型偶尔会吐坏 JSON 或网络抖动，自动重试一次
    let failure = { message: '结构化抽取失败' };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { content, finishReason } = await completeChat(cfg, messages, {
          maxTokens: cfg.max_tokens,
          temperature: 0.2,
        });
        const data = extractJson(content);
        if (data && typeof data === 'object') {
          return sendJson(res, 200, { ok: true, data: normalizeStructure(data) });
        }
        failure =
          finishReason === 'length'
            ? { message: '模型输出被 max_tokens 截断，JSON 没写完，请在「模型设置」里调大 max_tokens', raw: content.slice(0, 1200) }
            : { message: '模型没有返回可解析的 JSON，可点「重跑」再试一次', raw: content.slice(0, 1200) };
      } catch (err) {
        failure = { message: err.message || '结构化抽取失败' };
      }
    }
    sendJson(res, 200, { ok: false, ...failure });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: err.message || '结构化抽取失败' });
  }
}

/** 容错：模型偶尔会漏字段、给错类型、edge 引用不存在的节点 */
function normalizeStructure(data) {
  const out = { ...data };
  out.tags = Array.isArray(out.tags) ? out.tags.map(String).slice(0, 6) : [];
  out.concepts = Array.isArray(out.concepts)
    ? out.concepts
        .filter((c) => c && (c.name || c.explain))
        .map((c) => ({
          name: String(c.name || ''),
          explain: String(c.explain || ''),
          // 原文检索词：模型可能给字符串/数组，统一成去重后的数组
          terms: Array.isArray(c.terms)
            ? [...new Set(c.terms.map((t) => String(t || '').trim()).filter(Boolean))].slice(0, 4)
            : [],
        }))
        .slice(0, 10)
    : [];
  out.claims = Array.isArray(out.claims)
    ? out.claims.filter((c) => c && c.text).map((c) => ({ label: String(c.label || '要点'), text: String(c.text) })).slice(0, 6)
    : [];

  const diagram = data?.diagram && typeof data.diagram === 'object' ? data.diagram : {};
  const nodes = Array.isArray(diagram.nodes)
    ? diagram.nodes
        .filter((n) => n && (n.id || n.label))
        .map((n, i) => ({
          id: String(n.id || `n${i + 1}`),
          label: String(n.label || n.name || `节点 ${i + 1}`),
          detail: String(n.detail || n.description || ''),
          kind: ['input', 'process', 'data', 'output'].includes(String(n.kind)) ? String(n.kind) : 'process',
        }))
        .slice(0, 14)
    : [];

  const ids = new Set(nodes.map((n) => n.id));
  const edges = Array.isArray(diagram.edges)
    ? diagram.edges
        .filter((e) => e && ids.has(String(e.from)) && ids.has(String(e.to)) && String(e.from) !== String(e.to))
        .map((e) => ({ from: String(e.from), to: String(e.to), label: String(e.label || '') }))
        .slice(0, 30)
    : [];

  out.diagram = { title: String(diagram.title || '方法总览'), nodes, edges };
  return out;
}

/** 导出报告前的一次性总结：一页执行摘要 + 追问要点（模型不可用时退回本地摘要） */
async function handleExportSummary(req, res) {
  const body = await readBody(req);
  const paper = paperOf(body);
  const reading = String(body.reading || '').trim();
  const askThread = Array.isArray(body.askThread) ? body.askThread : [];
  if (!reading) throw new HttpError(400, '还没有精读结果，先生成精读再导出');

  const cfg = loadConfig();
  if (!cfg.api_key || body.demo === true) {
    await sleep(120);
    return sendJson(res, 200, { ok: true, demo: true, data: localSummary(reading, askThread) });
  }

  try {
    const messages = summaryMessages(paper, { title: paper.title, reading, askThread });
    let failure = { message: '摘要生成失败' };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { content } = await completeChat(cfg, messages, {
          maxTokens: Math.min(cfg.max_tokens || 2048, 2400),
          temperature: 0.3,
        });
        const data = extractJson(content);
        if (data && typeof data === 'object') {
          const summary = normalizeSummary(data);
          if (summary.digest) return sendJson(res, 200, { ok: true, data: summary });
        }
        failure = { message: '模型没有返回可解析的摘要 JSON' };
      } catch (err) {
        failure = { message: err.message || '摘要生成失败' };
      }
    }
    // 总结失败不挡住导出：用本地摘要兜底，前端会提示
    return sendJson(res, 200, {
      ok: true,
      fallback: true,
      error: failure.message,
      data: localSummary(reading, askThread),
    });
  } catch (err) {
    return sendJson(res, 200, {
      ok: true,
      fallback: true,
      error: err.message || '摘要生成失败',
      data: localSummary(reading, askThread),
    });
  }
}

function normalizeSummary(data) {
  const qa = Array.isArray(data?.qa_highlights) ? data.qa_highlights : [];
  return {
    digest: String(data?.digest || '').trim(),
    qa_highlights: qa
      .filter((x) => x && (x.question || x.takeaway))
      .map((x) => ({ question: String(x.question || '').trim(), takeaway: String(x.takeaway || '').trim() }))
      .slice(0, 8),
  };
}

/** 本地摘要：取每个小节的第一个非空行 + 每条追问的回答首句 */
function localSummary(reading, askThread) {
  const sections = [];
  let cur = null;
  for (const line of String(reading || '').split('\n')) {
    const m = line.match(/^#{1,4}\s+(.+?)\s*$/);
    if (m) {
      cur = { title: m[1].replace(/^[一二三四五六七]、\s*/, ''), lines: [] };
      sections.push(cur);
    } else if (cur) {
      cur.lines.push(line);
    }
  }

  const digestLines = [];
  for (const section of sections) {
    const first = section.lines.map((l) => l.trim()).find(Boolean);
    if (!first) continue;
    const clean = first.replace(/^[-*•]\s*/, '').replace(/[。.!?]\s*$/, '');
    digestLines.push(`- ${section.title}：${clean.slice(0, 80)}`);
  }
  const digest = digestLines.join('\n') || String(reading || '').slice(0, 200);

  const qa = [];
  const list = Array.isArray(askThread) ? askThread : [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item || item.role !== 'user' || !String(item.text || '').trim()) continue;
    const answer = list
      .slice(i + 1)
      .find((m) => m && m.role === 'assistant' && String(m.text || '').trim() && String(m.text).trim() !== '…');
    if (!answer) continue;
    const firstSentence =
      String(answer.text)
        .trim()
        .split(/[\n。.!?]/)
        .map((s) => s.trim())
        .find(Boolean) || '';
    qa.push({ question: String(item.text).trim().slice(0, 120), takeaway: firstSentence.slice(0, 80) });
  }

  return { digest, qa_highlights: qa.slice(-8) };
}

async function handleAsk(req, res) {
  const body = await readBody(req);
  const paper = paperOf(body);
  const question = String(body.question || '').trim();
  if (!question) throw new HttpError(400, '问题不能为空');

  const cfg = loadConfig();
  const sse = openSse(res);
  if (!cfg.api_key || body.demo === true) {
    await streamDemo(sse, DEMO_ASK, { chunkSize: 8, delay: 10 });
    return;
  }

  const controller = new AbortController();
  req.on('close', () => controller.abort());

  try {
    const messages = askMessages(paper.text, {
      title: paper.title,
      selection: String(body.selection || ''),
      reading: String(body.reading || ''),
      question,
    });
    let thinkingChars = 0;
    let lastPush = 0;
    for await (const chunk of streamChat(cfg, messages, { signal: controller.signal })) {
      if (chunk.channel === 'reasoning') {
        thinkingChars += chunk.text.length;
        const now = Date.now();
        if (now - lastPush > 300) {
          lastPush = now;
          if (!sse.event('thinking', { chars: thinkingChars })) break;
        }
        continue;
      }
      if (chunk.channel === 'content' && !sse.event('delta', { text: chunk.text })) break;
    }
    sse.event('done', {});
  } catch (err) {
    sse.event('error', { message: err.message || '追问失败' });
  } finally {
    sse.end();
  }
}

async function handleFetchPaper(req, res) {
  const body = await readBody(req);
  const input = String(body.input || '').trim();
  if (!input) throw new HttpError(400, '请填写 arXiv 编号或链接');
  try {
    const paper = await fetchArxivPaper(input);
    sendJson(res, 200, { ok: true, paper });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: err.message || '抓取失败（需要能访问 arxiv.org）' });
  }
}

/** 用主密码解锁已加密的 API Key（明文只在服务端内存里） */
async function handleUnlockConfig(req, res) {
  const body = await readBody(req);
  const passphrase = String(body.passphrase || '').trim();
  if (!passphrase) return sendJson(res, 400, { ok: false, error: '请输入主密码' });
  const result = unlockConfig(passphrase);
  if (!result.ok) return sendJson(res, 200, { ok: false, error: result.error });
  return sendJson(res, 200, { ok: true, config: result.config });
}

async function handleTestConfig(req, res) {
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

/* ---------------------------------- 主循环 --------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
    // 知识图谱：新前缀 /api/kg/*、旧路径别名、图片素材 /assets/*
    if (pathname.startsWith('/api/kg/') || isKgLegacyPath(pathname) || pathname.startsWith('/assets/')) {
      if (await handleKgApi(req, res, url)) return;
    }

    // 旧的图谱地址统一收口到单页外壳；/kg/* 仍用于加载图谱自己的资源
    if (pathname === '/kg' || pathname === '/kg/' || pathname === '/kg/index.html') {
      const extra = url.search ? `&${url.search.slice(1)}` : '';
      res.writeHead(302, { Location: `/?view=kg${extra}` });
      return res.end();
    }
    if (pathname.startsWith('/kg/')) {
      return serveStatic(res, KG_PUBLIC_DIR, pathname.slice('/kg'.length));
    }

    if (pathname.startsWith('/api/paper/') && pathname !== '/api/paper/fetch') {
      if (await handlePaperApi(req, res, url)) return;
    }

    if (pathname.startsWith('/api/')) {
      const key = `${req.method} ${pathname}`;
      switch (key) {
        case 'GET /api/config':
          return sendJson(res, 200, { config: publicConfig(), presets: PRESETS, sample: { title: SAMPLE_PAPER.title } });
        case 'POST /api/config':
          try {
            return sendJson(res, 200, { ok: true, config: saveConfig(await readBody(req)) });
          } catch (err) {
            return sendJson(res, 400, { ok: false, error: err.message || '配置保存失败' });
          }
        case 'POST /api/config/test':
          return await handleTestConfig(req, res);
        case 'POST /api/config/unlock':
          return await handleUnlockConfig(req, res);
        case 'POST /api/analyze':
          return await handleAnalyze(req, res);
        case 'POST /api/structure':
          return await handleStructure(req, res);
        case 'POST /api/ask':
          return await handleAsk(req, res);
        case 'POST /api/export/summary':
          return await handleExportSummary(req, res);
        case 'POST /api/paper/fetch':
          return await handleFetchPaper(req, res);
        case 'GET /api/sample':
          return sendJson(res, 200, { paper: SAMPLE_PAPER });
        default:
          return sendJson(res, 404, { ok: false, error: `未知接口 ${key}` });
      }
    }
    serveStatic(res, PUBLIC_DIR, pathname);
  } catch (err) {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    const status = err instanceof HttpError ? err.status : err instanceof LlmError ? 502 : 500;
    sendJson(res, status, { ok: false, error: err.message || '服务端异常' });
  }
});

server.listen(PORT, HOST, () => {
  const cfg = publicConfig();
  console.log(`\n  PaperLens · 论文精读 + 知识图谱`);
  console.log(`  ➜  精读工作台：http://${HOST}:${PORT}/`);
  console.log(`  ➜  知识图谱：  http://${HOST}:${PORT}/kg/`);
  const modelLine = cfg.locked
    ? 'API Key 已加密（未解锁）—— 在「模型设置」输入主密码，或设置 PAPERLENS_PASSPHRASE'
    : cfg.has_key
      ? `${cfg.model} (${cfg.provider})${cfg.vision_ready ? ' + 视觉模型' : ''}`
      : '未配置 API Key —— 当前为 demo 模式（内置示例数据）';
  console.log(`  ➜  模型：${modelLine}`);
  console.log(`  ➜  数据目录：${DATA_DIR}`);
  console.log(`  ➜  配置文件：${cfg.config_path}\n`);
});
