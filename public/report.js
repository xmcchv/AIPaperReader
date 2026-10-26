/**
 * 导出报告：把「精读 + 核心概念 + 图解 + 追问」编排成一份可打印的 HTML。
 *
 * - buildReportHtml 是纯函数（不碰 DOM），可以在 Node 里离线测试
 * - 打印走浏览器原生的 print()（对话框里选「另存为 PDF」），保留矢量图解与 KaTeX 公式
 * - 同时可以下载同样的 HTML（CSS 已内联，只有 KaTeX 的字体/样式走 CDN）
 */
import { escapeHtml, parseReading, renderBlocks } from './text.js';

const KATEX_BASE = 'https://cdn.jsdelivr.net/npm/katex@0.16.11/dist/';

/* -------------------------------- 小工具 -------------------------------- */

function fmtTime(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function firstText(lines) {
  for (const line of lines || []) {
    const text = String(line || '')
      .replace(/^[-*•]\s*/, '')
      .replace(/^\d+[.)]\s*/, '')
      .trim();
    if (text) return text;
  }
  return '';
}

/** 安全文件名：去掉 Windows 不允许的字符 */
export function reportFilename(title, ext = 'html') {
  const base = String(title || '论文精读报告')
    .slice(0, 50)
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim();
  return `${base || '论文精读报告'}-精读报告.${ext}`;
}

/** 把追问记录按「问题 → 回答」配对，过滤占位和出错的条目 */
export function qaPairs(items) {
  const list = (Array.isArray(items) ? items : []).filter(
    (m) => m && String(m.text || '').trim() && !m.error && !['…', '思考中…'].includes(String(m.text).trim()),
  );
  const pairs = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (item.role !== 'user') continue;
    let j = i + 1;
    while (j < list.length && list[j].role !== 'assistant') j += 1;
    if (j >= list.length) continue;
    pairs.push({
      question: String(item.text).trim(),
      quote: String(item.quote || '').trim(),
      answer: String(list[j].text).trim(),
    });
    i = j;
  }
  return pairs;
}

function sectionHtml(number, title, inner, cls = '') {
  if (!inner) return '';
  return `<section class="section ${cls}">
  <h2>${number ? `<span class="num">${number}</span>` : ''}${escapeHtml(title)}</h2>
  ${inner}
</section>`;
}

/* ------------------------------ 报告主体 ------------------------------- */

/**
 * data: { paper, reading, structure, askThread, summary, diagramSvg, options, meta }
 * opts: { css }
 */
export function buildReportHtml(data = {}, { css = '' } = {}) {
  const { paper = {}, reading = '', structure = null, askThread = [], summary = null, diagramSvg = '', options = {}, meta = {} } = data;
  const opt = {
    reading: true,
    structure: true,
    diagram: true,
    ask: true,
    appendix: false,
    askLimit: 0, // 0 = 全部
    ...options,
  };

  const sections = parseReading(reading);
  const title = String(structure?.title || paper.title || '未命名论文').trim();

  const oneSection = sections.find((s) => /一句话|结论|摘要/.test(s.title));
  const oneLiner = String(structure?.one_liner || '').trim() || firstText(oneSection?.lines);

  const tags = Array.isArray(structure?.tags) ? structure.tags.filter(Boolean).slice(0, 8) : [];
  const concepts = Array.isArray(structure?.concepts) ? structure.concepts.filter((c) => c && (c.name || c.explain)) : [];
  const claims = Array.isArray(structure?.claims) ? structure.claims.filter((c) => c && c.text) : [];

  const digest = String(summary?.digest || '').trim();
  const digestHtml = digest ? `<div class="digest">${renderBlocks(digest.split('\n'))}</div>` : '';

  const readingHtml = sections
    .map((section) => {
      const body = renderBlocks(section.lines);
      if (!body && !section.title) return '';
      return `<article class="card"><h3>${escapeHtml(section.title || '精读')}</h3>${body}</article>`;
    })
    .join('');

  const conceptsHtml = concepts.length
    ? `<table class="concept-table">
  <thead><tr><th scope="col">概念</th><th scope="col">一句话解释</th></tr></thead>
  <tbody>${concepts
    .map((c) => `<tr><th scope="row">${escapeHtml(c.name)}</th><td>${escapeHtml(c.explain)}</td></tr>`)
    .join('')}</tbody>
</table>`
    : '';

  const claimsHtml = claims.length
    ? `<ul class="claims">${claims
        .map((c) => `<li><span class="claim-label">${escapeHtml(c.label || '要点')}</span>${escapeHtml(c.text)}</li>`)
        .join('')}</ul>`
    : '';

  const structureHtml = [conceptsHtml, claimsHtml].filter(Boolean).join('\n');

  const diagramHtml = diagramSvg
    ? `<div class="diagram-frame">${diagramSvg}</div><p class="caption">${escapeHtml(structure?.diagram?.title || '方法链路图')}</p>`
    : '';

  const pairs = qaPairs(askThread);
  const limitedPairs = opt.askLimit > 0 ? pairs.slice(-opt.askLimit) : pairs;
  const highlights = (Array.isArray(summary?.qa_highlights) ? summary.qa_highlights : [])
    .filter((x) => x && (x.question || x.takeaway))
    .map((x) => `<li><b>${escapeHtml(x.question || '追问')}</b>${escapeHtml(x.takeaway || '')}</li>`)
    .join('');
  const qaHtml = [
    highlights ? `<ul class="qa-highlights">${highlights}</ul>` : '',
    limitedPairs
      .map(
        (p) => `<div class="qa-item">
  <div class="qa-q">${escapeHtml(p.question)}</div>
  ${p.quote ? `<div class="quote">${escapeHtml(p.quote.length > 160 ? `${p.quote.slice(0, 160)}…` : p.quote)}</div>` : ''}
  <div class="qa-a">${renderBlocks(p.answer.split('\n'))}</div>
</div>`,
      )
      .join(''),
  ]
    .filter(Boolean)
    .join('\n');

  const appendixText = String(paper.text || '').trim();
  const appendixHtml = appendixText
    ? `<pre class="appendix-text">${escapeHtml(appendixText.slice(0, 14000))}${
        appendixText.length > 14000 ? '\n\n…（原文过长，此处为节选）' : ''
      }</pre>`
    : '';

  const summaryNote = summary
    ? summary.demo
      ? '<p class="note">demo 模式：执行摘要由本地规则归纳，未调用模型。</p>'
      : summary.fallback
        ? `<p class="note warn">模型摘要不可用（${escapeHtml(summary.error || '调用失败')}），以下为本地归纳。</p>`
        : ''
    : '';

  const metaBits = [
    meta.source ? `来源 ${escapeHtml(meta.source)}` : '',
    meta.model ? `模型 ${escapeHtml(meta.model)}` : '',
    `生成于 ${escapeHtml(meta.generatedAt || fmtTime(new Date()))}`,
  ].filter(Boolean);

  const parts = [];
  if (opt.reading && readingHtml) parts.push(sectionHtml('01', '精读正文', readingHtml));
  if (opt.structure && structureHtml) parts.push(sectionHtml('02', '核心概念与关键论断', structureHtml));
  if (opt.diagram && diagramHtml) parts.push(sectionHtml('03', '方法链路图', diagramHtml, 'section-diagram'));
  if (opt.ask && qaHtml) parts.push(sectionHtml('04', '追问记录', qaHtml));
  if (opt.appendix && appendixHtml) parts.push(sectionHtml('05', '原文节选', appendixHtml));

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)} · 精读报告</title>
<link rel="stylesheet" href="${KATEX_BASE}katex.min.css" />
<style>
${css}
</style>
</head>
<body>
<div class="report-toolbar">
  <button type="button" onclick="window.print()">打印 / 保存为 PDF</button>
  <span>在打印对话框里选择「另存为 PDF」，纸张 A4、边距默认即可；图解与公式会保持矢量。</span>
  <button type="button" onclick="window.close()" style="background:#fff;color:#2f6fdb;border-color:#d7dde8">关闭</button>
</div>
<main class="report">
  <header class="cover">
    <p class="eyebrow">PaperLens · 论文精读报告</p>
    <h1>${escapeHtml(title)}</h1>
    <div class="meta">${metaBits.map((b) => `<span>${b}</span>`).join('')}</div>
    ${oneLiner ? `<p class="one-liner">${escapeHtml(oneLiner)}</p>` : ''}
    ${tags.length ? `<div class="tags">${tags.map((t) => `<span class="tag">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
  </header>

  ${
    digestHtml
      ? `<section class="section section-digest">
    <h2><span class="num">00</span>执行摘要</h2>
    ${digestHtml}
    ${summaryNote}
  </section>`
      : ''
  }

  ${parts.join('\n\n  ')}

  <footer class="report-footer">PaperLens · 原文 · AI 精读 · 交互图解 · 报告生成于 ${escapeHtml(
    meta.generatedAt || fmtTime(new Date()),
  )}</footer>
</main>
<script defer src="${KATEX_BASE}katex.min.js"></script>
<script defer src="${KATEX_BASE}contrib/auto-render.min.js"></script>
<script>
(function () {
  function markReady() {
    window.__paperlensMathReady = true;
  }
  function tryRender() {
    if (typeof renderMathInElement !== 'function') return false;
    try {
      renderMathInElement(document.body, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\\\[', right: '\\\\]', display: true },
          { left: '\\\\(', right: '\\\\)', display: false },
          { left: '$', right: '$', display: false }
        ],
        throwOnError: false,
        strict: 'ignore',
        ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code']
      });
    } catch (err) {
      /* 公式写坏时保留原文，不影响打印 */
    }
    markReady();
    return true;
  }
  document.addEventListener('DOMContentLoaded', function () {
    if (tryRender()) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries += 1;
      if (tryRender() || tries >= 12) {
        clearInterval(timer);
        markReady();
      }
    }, 150);
  });
})();
</script>
</body>
</html>`;
}

/* ------------------------------ 浏览器动作 ------------------------------ */

async function loadReportCss() {
  try {
    const res = await fetch('/report.css');
    return res.ok ? await res.text() : '';
  } catch {
    return '';
  }
}

/** 构建完整报告 HTML（自动内联 report.css） */
export async function getReportHtml(data) {
  const css = await loadReportCss();
  return buildReportHtml(data, { css });
}

function waitForReportReady(win, timeoutMs = 2600) {
  return new Promise((resolve) => {
    const started = Date.now();
    const tick = () => {
      if (!win || win.__paperlensMathReady || Date.now() - started > timeoutMs) resolve();
      else setTimeout(tick, 120);
    };
    tick();
  });
}

/**
 * 用隐藏 iframe 打印：不依赖弹窗权限，打印完再移除。
 * 公式和 SVG 都在 iframe 内渲染好后才调用 print()。
 */
export async function printReport(data) {
  const html = await getReportHtml(data);
  const frame = document.createElement('iframe');
  frame.className = 'report-print-frame';
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:1px;height:1px;border:0;opacity:0;pointer-events:none';
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  doc.open();
  doc.write(html);
  doc.close();

  await waitForReportReady(frame.contentWindow);

  const previousTitle = document.title;
  document.title = `${data.structure?.title || data.paper?.title || '论文'} · 精读报告`;
  try {
    // 无头自动化环境里 window.print() 会阻塞主线程；真实浏览器（navigator.webdriver=false）正常打印
    if (!navigator.webdriver) {
      frame.contentWindow.focus();
      frame.contentWindow.print();
    }
  } finally {
    setTimeout(() => {
      document.title = previousTitle;
    }, 1200);
    setTimeout(() => frame.remove(), 20000);
  }
  return frame;
}

/** 下载已构建好的报告 HTML */
export function saveReportHtml(html, filename) {
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
