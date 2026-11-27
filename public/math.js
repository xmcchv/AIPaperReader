/**
 * 精读正文里的数学公式渲染。
 *
 * 优先使用仓库内置的 KaTeX（public/vendor/katex，随仓库分发），离线可用；
 * 本地文件缺失时回退 CDN。加载失败则保留 LaTeX 原文，不影响阅读。
 * 支持 $...$ / $$...$$ / \(...\) / \[...\]，代码块里不处理。
 */

const KATEX_VERSION = '0.16.11';
const KATEX_LOCAL = '/vendor/katex/';
const KATEX_CDN = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/`;

let katexPromise = null;

function ensureKatexCss(base) {
  const old = document.querySelector('link[data-katex]');
  if (old) old.remove();
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `${base}katex.min.css`;
  link.dataset.katex = '1';
  document.head.appendChild(link);
}

async function importKatex(base) {
  const mod = await import(`${base}katex.mjs`);
  return mod.default || mod;
}

function loadKatex() {
  if (katexPromise) return katexPromise;
  katexPromise = (async () => {
    try {
      const mod = await importKatex(KATEX_LOCAL);
      ensureKatexCss(KATEX_LOCAL);
      return mod;
    } catch {
      const mod = await importKatex(KATEX_CDN);
      ensureKatexCss(KATEX_CDN);
      return mod;
    }
  })().catch(() => null);
  return katexPromise;
}

// 独立公式的分支必须在行内之前，否则 $$ 会被当成两个空的 $...$
const MATH_SPLIT_RE =
  /(\$\$[\s\S]+?\$\$|\\\[[\s\S]+?\\\]|\\\([\s\S]+?\\\)|(?<![\\$])\$(?!\s)[^$\n]+?(?<![\s\\])\$)/g;

/** "$5" / "$1,200" 这类价格不是公式 */
function looksLikeMoney(tex) {
  return /^[\d\s.,]+$/.test(tex);
}

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * 模型偶尔会写出缺参数的上下标（如 `Q^=`、`\breve Q^ Z`），KaTeX 会整块报错。
 * 这里只做保守修复：^ / _ 后面不是 {、字母数字或反斜杠命令时，补一个空组。
 */
export function repairLatex(tex) {
  return String(tex || '').replace(/([\^_])(?![{])(?=\s|$|[=,;:)\]}])/g, '$1{}');
}

/** 按顶层换行 / \\ 拆分独立公式，避免一处语法错误拖垮整块 */
export function splitTopLevel(tex) {
  const parts = [];
  let buf = '';
  let depth = 0;
  let envDepth = 0;
  for (let i = 0; i < tex.length; i += 1) {
    const ch = tex[i];
    if (ch === '\\') {
      const rest = tex.slice(i);
      if (rest.startsWith('\\begin{')) envDepth += 1;
      else if (rest.startsWith('\\end{')) envDepth = Math.max(0, envDepth - 1);
      if (rest.startsWith('\\\\') && depth === 0 && envDepth === 0) {
        parts.push(buf);
        buf = '';
        i += 1;
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === '{' || ch === '[' || ch === '(') depth += 1;
    else if (ch === '}' || ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
    if (ch === '\n' && depth === 0 && envDepth === 0) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  parts.push(buf);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/**
 * 渲染一个公式片段：原样 → 保守修复 → （独立公式）拆成多段逐个渲染。
 * 只要有一部分成功，就返回拼接后的 HTML；全部失败返回 null（调用方保留原文）。
 */
export function renderMathPart(katex, tex, displayMode) {
  const renderOne = (value) => {
    try {
      return katex.renderToString(value, {
        displayMode,
        throwOnError: true,
        strict: 'ignore',
        output: 'html',
      });
    } catch {
      return null;
    }
  };

  const direct = renderOne(tex);
  if (direct) return direct;
  // 精读文本里常见双反斜杠（模型输出/JSON 二次转义），如 "\\sum" 应为 "\sum"。
  // KaTeX 会把 \\ 解释为换行命令，导致整块公式渲染失败、原文残留。
  const unescaped = tex.replace(/\\\\/g, '\\');
  if (unescaped !== tex) {
    const fixed = renderOne(unescaped);
    if (fixed) return fixed;
  }
  const repaired = repairLatex(tex);
  if (repaired !== tex) {
    const fixed = renderOne(repaired);
    if (fixed) return fixed;
  }
  // 严格模式失败时降级：KaTeX 用 throwOnError:false 仍能渲染出可读的公式结构，
  // 比把整段 LaTeX 原样丢给用户强（模型常写出语义怪但可容忍的写法）
  const lenient = (value) => {
    try {
      return katex.renderToString(value, {
        displayMode,
        throwOnError: false,
        strict: 'ignore',
        output: 'html',
      });
    } catch {
      return null;
    }
  };
  const loose = lenient(tex) || (repaired !== tex && lenient(repaired));
  if (loose) return loose;

  if (!displayMode) return null;
  const chunks = splitTopLevel(tex);
  if (chunks.length < 2) return null;
  const rendered = chunks.map((chunk) => {
    const html = renderOne(chunk) || renderOne(repairLatex(chunk));
    return html || `<span class="math-raw">${escapeHtml(chunk)}</span>`;
  });
  const hasRendered = rendered.some((html) => !html.startsWith('<span class="math-raw">'));
  return hasRendered ? rendered.join('<br>') : null;
}

/** 把一段文本切成「普通文本 / 公式」片段 */
export function splitMath(text) {
  const parts = [];
  let last = 0;
  MATH_SPLIT_RE.lastIndex = 0;
  let match;
  while ((match = MATH_SPLIT_RE.exec(text))) {
    if (match.index > last) parts.push({ text: text.slice(last, match.index) });
    const raw = match[0];
    const display = raw.startsWith('$$') || raw.startsWith('\\[');
    const body = raw.startsWith('\\(') || raw.startsWith('\\[') || raw.startsWith('$$')
      ? raw.slice(2, -2)
      : raw.slice(1, -1);
    if (looksLikeMoney(body)) parts.push({ text: raw });
    else parts.push({ math: body, display, raw });
    last = match.index + raw.length;
  }
  if (last < text.length) parts.push({ text: text.slice(last) });
  return parts;
}

const SKIP_TAGS = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'SVG']);

function collectTextNodes(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue || '';
      if (!value.includes('$') && !value.includes('\\(') && !value.includes('\\[')) {
        return NodeFilter.FILTER_REJECT;
      }
      const parent = node.parentElement;
      if (!parent || SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest('.katex, [data-no-math]')) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  return nodes;
}

/**
 * 渲染 root 里的公式（就地替换文本节点）。
 * 流式输出时公式可能还没写完：解析失败就保留原文，下一次渲染再试。
 */
export async function renderMathIn(root) {
  if (!root) return;
  const nodes = collectTextNodes(root);
  if (!nodes.length) return;

  const work = [];
  for (const node of nodes) {
    const parts = splitMath(node.nodeValue);
    if (parts.some((part) => part.math)) work.push({ node, parts });
  }
  if (!work.length) return;

  const katex = await loadKatex();
  if (!katex) return; // 离线：保留 LaTeX 原文

  // 首次加载 KaTeX 期间，流式渲染可能已把文本节点换掉；若全部失效，
  // 对当前 DOM 重新扫描一次，否则这批公式会永远停在 LaTeX 原文。
  if (work.every((w) => !w.node.isConnected)) {
    if ((root.__mathRetries || 0) < 3) {
      root.__mathRetries = (root.__mathRetries || 0) + 1;
      await renderMathIn(root);
    }
    return;
  }

  for (const { node, parts } of work) {
    if (!node.isConnected) continue; // 等待加载期间被下一次流式渲染替换了
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (!part.math) {
        frag.appendChild(document.createTextNode(part.text));
        continue;
      }
      const html = renderMathPart(katex, part.math, part.display);
      if (!html) {
        frag.appendChild(document.createTextNode(part.raw));
        continue;
      }
      const holder = document.createElement(part.display ? 'div' : 'span');
      holder.className = part.display ? 'math-display' : 'math-inline';
      holder.innerHTML = html;
      frag.appendChild(holder);
    }
    node.parentNode.replaceChild(frag, node);
  }
}
