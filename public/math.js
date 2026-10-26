/**
 * 精读正文里的数学公式渲染。
 *
 * 和 pdf.js 一样按需从 CDN 加载 KaTeX（项目本身零依赖、无构建步骤）；
 * 离线或加载失败时保留 LaTeX 原文，不影响阅读。
 * 支持 $...$ / $$...$$ / \(...\) / \[...\]，代码块里不处理。
 */

const KATEX_VERSION = '0.16.11';
const KATEX_BASE = `https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/`;

let katexPromise = null;

function loadKatex() {
  if (katexPromise) return katexPromise;
  katexPromise = (async () => {
    if (!document.querySelector('link[data-katex]')) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `${KATEX_BASE}katex.min.css`;
      link.dataset.katex = '1';
      document.head.appendChild(link);
    }
    const mod = await import(`${KATEX_BASE}katex.mjs`);
    return mod.default || mod;
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

  for (const { node, parts } of work) {
    if (!node.isConnected) continue; // 等待加载期间被下一次流式渲染替换了
    const frag = document.createDocumentFragment();
    for (const part of parts) {
      if (!part.math) {
        frag.appendChild(document.createTextNode(part.text));
        continue;
      }
      let html = '';
      try {
        html = katex.renderToString(part.math, {
          displayMode: part.display,
          throwOnError: true,
          strict: 'ignore',
          output: 'html',
        });
      } catch {
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
