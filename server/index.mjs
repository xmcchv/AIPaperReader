/**
 * PaperLens 服务端入口：零依赖 Node HTTP 服务。
 * 只监听 127.0.0.1，API Key 不出本机。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadConfig, publicConfig, saveConfig, PRESETS } from './config.mjs';
import { streamChat, completeChat, extractJson, testConnection, LlmError } from './llm.mjs';
import { readingMessages, structureMessages, askMessages, summaryMessages } from './prompts.mjs';
import { fetchArxivPaper } from './paper.mjs';
import { SAMPLE_PAPER, DEMO_READING, DEMO_STRUCTURE, DEMO_ASK } from './samples.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT || 5173);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY = 12 * 1024 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

/* ---------------------------------- 工具 ---------------------------------- */

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('请求体过大（上限 12MB）'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function openSse(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  return {
    event(type, data) {
      if (res.writableEnded) return false;
      res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
      return true;
    },
    end() {
      if (res.writableEnded) return;
      res.write('event: end\ndata: [DONE]\n\n');
      res.end();
    },
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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
        .map((c) => ({ name: String(c.name || ''), explain: String(c.explain || '') }))
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
  if (!draft.api_key) return sendJson(res, 200, { ok: false, error: '还没有填 API Key' });
  try {
    const result = await testConnection(draft);
    sendJson(res, 200, { ok: true, ...result });
  } catch (err) {
    sendJson(res, 200, { ok: false, error: err.message });
  }
}

/* --------------------------------- 静态文件 -------------------------------- */

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

/* ---------------------------------- 主循环 --------------------------------- */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const { pathname } = url;

  try {
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
    serveStatic(req, res, pathname);
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
  console.log(`\n  PaperLens · 论文精读工作台`);
  console.log(`  ➜  http://${HOST}:${PORT}`);
  console.log(`  ➜  模型：${cfg.has_key ? `${cfg.model} (${cfg.provider})` : '未配置 API Key —— 当前为 demo 模式（内置示例数据）'}`);
  console.log(`  ➜  配置文件：${cfg.config_path}\n`);
});
