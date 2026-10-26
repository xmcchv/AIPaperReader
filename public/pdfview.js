/**
 * PDF 原版视图：pdf.js 渲染原始页面，叠加「章节 / 段落热区」。
 * - 页面本身是原版 canvas，不做任何改写
 * - 段落热区来自 pdf.js 文本层的坐标聚合：hover 高亮整段，点击弹出该段原文卡片
 * - 章节标题额外标注，图注单独标记
 * - 双栏论文按栏切分，热区只覆盖本栏宽度（不会横跨整页）
 * 解析出的段落同时拼成纯文本，供精读/追问使用
 */
import { isSectionTitle } from './text.js';

const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.min.mjs';
const WORKER_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs';

const CAPTION_RE = /^(figure|table|algorithm|listing)\s*\d+\s*[:.]/i;
const MATH_RE = /[√∫∑∏≈≤≥≠]/;
const MIN_SCALE = 0.45;
const MAX_SCALE = 3;

let pdfjsPromise = null;
function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import(PDFJS_CDN).then((mod) => {
      mod.GlobalWorkerOptions.workerSrc = WORKER_CDN;
      return mod;
    });
  }
  return pdfjsPromise;
}

/* --------------------------------- 文本聚合 -------------------------------- */

const isCJK = (ch) => /[\u3400-\u9FFF\u3000-\u303F\uFF00-\uFFEF]/.test(ch);

/** 公式碎片行：夹杂大量单字符 token，或者带数学符号 */
function looksLikeFormula(text) {
  if (MATH_RE.test(text)) return true;
  const tokens = text.split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return false;
  return tokens.filter((t) => t.length === 1).length / tokens.length > 0.35;
}

function isHeading(text) {
  if (text.length < 4 || text.length > 90) return false;
  // 标题不会以句末标点收尾，也不会是网址
  if (/[.。;,，]\s*$/.test(text)) return false;
  if (/https?:\/\/|www\./i.test(text)) return false;
  if (!isSectionTitle(text)) return false;
  if (looksLikeFormula(text)) return false;
  // 折行的脚注/正文常以「编号 + 大写词」开头、在连字符处被切断
  if (/[-‐‑]$/.test(text)) return false;
  const words = text.split(/\s+/);
  // 纯英文「标题」超过 4 个词一般是正文，比如 "results to the base model."
  if (/^[A-Za-z]/.test(text) && words.length > 4) return false;
  if (/^\d/.test(text)) {
    if (words.length > 8) return false;
    // 去掉编号前缀再判断是不是一整句话（"3.4. Implementation" 里的句点属于编号）
    const rest = text.replace(/^\d{1,2}(?:\.\d{1,2})*\.?\s+/, '');
    if (/[.!?]\s+[A-Z]/.test(rest)) return false;
  }
  return true;
}

/** 文本项 → 页面坐标下的盒子（单位为 CSS px，scale=1）。导出供离线测试 */
export function itemBoxes(items, pageHeight) {
  const out = [];
  for (const it of items) {
    const str = (it.str || '').replace(/\u00a0/g, ' ');
    if (!str.trim() || !it.width || !it.height) continue;
    // 旋转文本（arXiv 页边印章、竖排图注）不是正文，混进来会切断段落
    if (Math.abs(it.transform[1]) > 0.01 || Math.abs(it.transform[2]) > 0.01) continue;
    const fh = Math.abs(it.transform[3]) || it.height;
    const x0 = it.transform[4];
    const baseline = pageHeight - it.transform[5];
    out.push({ str, x0, x1: x0 + it.width, baseline, fh, top: baseline - fh });
  }
  return out;
}

/** 页面横向的空白带（按 x 投影求未被文字覆盖的区间） */
export function xGaps(boxes, pageWidth) {
  const spans = boxes
    .map((b) => [Math.max(0, b.x0), Math.min(pageWidth, b.x1)])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const gaps = [];
  let cur = 0;
  for (const [s, e] of spans) {
    if (s > cur + 1) gaps.push({ from: cur, to: s, width: s - cur });
    cur = Math.max(cur, e);
  }
  if (cur < pageWidth - 1) gaps.push({ from: cur, to: pageWidth, width: pageWidth - cur });
  return gaps;
}

/** 拼接两段文字：中文直接连，其它补空格 */
function joinText(prev, next) {
  if (!prev) return next;
  const lastCh = prev.slice(-1);
  const firstCh = next.slice(0, 1);
  if (isCJK(lastCh) || isCJK(firstCh)) return prev + next;
  return `${prev} ${next}`;
}

/**
 * 视觉行：先按基线聚合（同一行的不同字号归到一行），
 * 行内再按明显的 x 间隙切成「片段」——左右两栏的文本就在这一步分开。
 * 导出供离线测试。
 */
export function visualLines(boxes) {
  const sorted = [...boxes].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  const lines = [];
  for (const b of sorted) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(b.baseline - last.baseline) < Math.max(2, Math.max(last.fh, b.fh) * 0.5)) {
      last.parts.push(b);
      last.fh = Math.max(last.fh, b.fh);
    } else {
      lines.push({ baseline: b.baseline, fh: b.fh, parts: [b] });
    }
  }

  for (const line of lines) {
    line.parts.sort((a, b) => a.x0 - b.x0);
    line.x0 = line.parts[0].x0;
    line.x1 = line.parts[line.parts.length - 1].x1;
    line.segments = [];
    let cur = null;
    let prev = null;
    for (const part of line.parts) {
      const gap = prev ? part.x0 - prev.x1 : Number.POSITIVE_INFINITY;
      // 间隙接近一个字高，说明是不相干的文本块（另一栏、图内标签、页眉页码）。
      // 阈值要小于常见栏间距（约 10pt），否则左右栏会被粘成一行。
      if (cur && gap <= Math.max(line.fh * 0.9, 6)) {
        cur.text = joinText(cur.text, part.str);
        cur.x1 = Math.max(cur.x1, part.x1);
      } else {
        if (cur) line.segments.push(cur);
        cur = { x0: part.x0, x1: part.x1, text: part.str, baseline: line.baseline, fh: line.fh };
      }
      prev = part;
    }
    if (cur) line.segments.push(cur);
    line.text = line.segments.map((s) => s.text).join(' ');
  }
  return lines;
}

/**
 * 判断本页是否双栏：看有多少「视觉行」在页面中线两侧都有文本片段。
 * 不依赖整页空白投影——跨栏大图会把中间空白带盖掉，那样就检测不到了。
 * 导出供离线测试。
 */
export function detectLayout(lines, boxes, pageWidth) {
  const spans = xGaps(boxes, pageWidth);
  const minWidth = Math.max(5, pageWidth * 0.01);
  const middle = spans
    .filter((g) => g.width >= minWidth && g.from > pageWidth * 0.2 && g.to < pageWidth * 0.82)
    .sort((a, b) => b.width - a.width)[0];

  const textLines = lines.filter((l) => l.segments.some((s) => s.text.trim().length > 1));
  const fallbackMid = textLines.length
    ? (Math.min(...textLines.map((l) => l.x0)) + Math.max(...textLines.map((l) => l.x1))) / 2
    : pageWidth / 2;
  const midX = middle ? (middle.from + middle.to) / 2 : fallbackMid;

  let twoSided = 0;
  const leftEdges = [];
  const rightEdges = [];
  for (const line of textLines) {
    if (line.segments.length < 2) continue;
    const left = line.segments.filter((s) => s.x1 <= midX + 2);
    const right = line.segments.filter((s) => s.x0 >= midX - 2);
    if (!left.length || !right.length) continue;
    twoSided += 1;
    leftEdges.push(Math.max(...left.map((s) => s.x1)));
    rightEdges.push(Math.min(...right.map((s) => s.x0)));
  }

  const median = (arr) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.floor(arr.length / 2)] : 0);
  // 左右两块之间要有稳定空隙，且大部分行都这样——否则只是图里的并排文字。
  // columnGap 过大的页面（例如正文只占左半边、右边是空白）不算双栏
  const columnGap = median(rightEdges) - median(leftEdges);
  const ratio = textLines.length ? twoSided / textLines.length : 0;
  const twoColumn = textLines.length > 6 && ratio > 0.4 && columnGap > 3 && columnGap < 90;

  return { twoColumn, midX, twoSided, lineCount: textLines.length, ratio, columnGap };
}

/** 出现次数足够多的取值（取众数，用于找本栏最常见的行距 / 左右边界） */
function dominantValue(values, { bucket = 1, minRatio = 0.2 } = {}) {
  if (!values.length) return null;
  const counts = new Map();
  for (const v of values) {
    const key = Math.round(v / bucket) * bucket;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let best = null;
  let bestCount = 0;
  for (const [key, count] of counts) {
    if (count > bestCount) {
      best = key;
      bestCount = count;
    }
  }
  return bestCount >= Math.max(2, values.length * minRatio) ? best : null;
}

/** 行距基准：先取众数，再在众数附近取中位数（段间距不会把基准拉大） */
function baseLeading(deltas) {
  if (!deltas.length) return 0;
  const mode = dominantValue(deltas, { bucket: 0.5, minRatio: 0.15 });
  if (mode === null) return deltas[0];
  const near = deltas.filter((d) => Math.abs(d - mode) <= 1.2).sort((a, b) => a - b);
  return near.length ? near[Math.floor(near.length / 2)] : mode;
}

/**
 * 单栏内：按行距 + 缩进 + 行尾是否排满把行片段拼成段。
 *
 * 关键点（都踩过坑）：
 * - 行距、左右边界都用「众数」而不是分位数——脚注/页眉/图注比正文宽或窄，
 *   用分位数会把本栏边界带偏，正文每行都被误判成「没排满的最后一行」
 * - 首行缩进要看「下一行是否缩回去」——列表项（hanging indent）的续行
 *   相对正文左边界同样右移，只比较左边界会把每一行都切成新段
 */
function segmentColumn(segments, pageIndex, col) {
  if (!segments.length) return [];

  const list = [...segments].sort((a, b) => a.baseline - b.baseline || a.x0 - b.x0);
  const deltas = [];
  for (let i = 1; i < list.length; i += 1) {
    const d = list[i].baseline - list[i - 1].baseline;
    if (d > 0.5) deltas.push(d);
  }
  const base = baseLeading(deltas);
  // 行内公式/上下标会让某几行的基线偏移，相邻行距偶尔比基准大 40% 左右，
  // 所以「段间距」的阈值要保守一些：真正的分段还有首行缩进和短尾行兜底
  const breakGap = base > 0 ? Math.max(base * 1.5, base + 3) : Infinity;

  const longTexts = list.filter((s) => s.text.length > 15);
  const leftEdge = dominantValue(longTexts.map((s) => Math.round(s.x0)), { bucket: 1, minRatio: 0.2 });
  const rights = list.map((s) => s.x1).sort((a, b) => a - b);
  const rightEdge =
    dominantValue(longTexts.map((s) => Math.round(s.x1)), { bucket: 1, minRatio: 0.2 }) ??
    (rights.length ? rights[Math.floor(rights.length * 0.9)] : 0);
  // 正文字高：用来排除「脚注上标 + 大写单词」被误判成章节标题（脚注字号明显更小）
  const fhs = longTexts.map((s) => s.fh).sort((a, b) => a - b);
  const bodyFh = fhs.length ? fhs[Math.floor(fhs.length / 2)] : 0;

  const lines = [];
  for (const seg of list) {
    const text = seg.text.replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (text.length < 4) continue; // 图内零散标签
    if (text.length < 6 && /^\d+$/.test(text)) continue; // 页码
    lines.push({ ...seg, text });
  }

  const paras = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.text) paras.push(cur);
    cur = null;
  };

  for (let i = 0; i < lines.length; i += 1) {
    const seg = lines[i];
    const next = lines[i + 1];

    // 上一段是标题就直接收尾——标题必须独占一段
    if (cur && cur.heading) flush();

    const heading =
      isHeading(seg.text) && (bodyFh === 0 || seg.fh >= bodyFh * 0.95);
    const caption = CAPTION_RE.test(seg.text);
    const gap = cur ? seg.baseline - cur.lastBaseline : Number.POSITIVE_INFINITY;
    // 首行缩进：本行比正文左边界右移，而且下一行又缩回左侧（段落续行）。
    // 下一行本身是标题/图注/列表项时必须停下——否则会把上一段的最后一行判成「新段首行」
    const nextStartsBlock =
      !next || BULLET_RE.test(next.text) || isHeading(next.text) || CAPTION_RE.test(next.text);
    const indented =
      Boolean(cur) &&
      base > 0 &&
      gap > base * 0.95 &&
      leftEdge !== null &&
      seg.x0 > leftEdge + seg.fh * 0.6 &&
      !nextStartsBlock &&
      next.x0 < seg.x0 - seg.fh * 0.6;
    // 上一行没排满（段落最后一行）→ 这里一定是新段
    const afterShortLine =
      Boolean(cur) && rightEdge > 0 && cur.lastX1 < rightEdge - Math.max(seg.fh * 1.8, 6);
    const startsNew = !cur || heading || caption || gap > breakGap || indented || afterShortLine;

    if (startsNew) {
      flush();
      cur = {
        page: pageIndex,
        col,
        x0: seg.x0,
        y0: seg.baseline - seg.fh,
        x1: seg.x1,
        y1: seg.baseline,
        text: seg.text,
        heading,
        caption,
        lastBaseline: seg.baseline,
        lastX1: seg.x1,
        lastFh: seg.fh,
      };
    } else {
      const prev = cur.text;
      if (/[a-z]-$/i.test(prev) && /^[a-z]/.test(seg.text)) {
        cur.text = prev.slice(0, -1) + seg.text; // 跨行断词
      } else {
        cur.text = joinText(prev, seg.text);
      }
      cur.x0 = Math.min(cur.x0, seg.x0);
      cur.x1 = Math.max(cur.x1, seg.x1);
      cur.y1 = Math.max(cur.y1, seg.baseline);
      cur.lastBaseline = seg.baseline;
      cur.lastX1 = seg.x1;
      cur.lastFh = seg.fh;
    }
  }
  flush();

  for (const para of paras) {
    // 段落最后一行是否排满：跨栏/跨页续接时用来判断「这句话确实没写完」
    para.fullLastLine = rightEdge > 0 && para.lastX1 >= rightEdge - Math.max(para.lastFh * 1.5, 4);
    para.rects = [{ page: para.page, col: para.col, x0: para.x0, y0: para.y0, x1: para.x1, y1: para.y1 }];
  }
  return paras;
}

/** 片段 → 段落（按栏分别聚合，返回按阅读顺序排列的段落）。导出供离线测试 */
export function groupParagraphs(segments, pageIndex) {
  const byCol = new Map();
  for (const seg of segments) {
    if (!byCol.has(seg.col)) byCol.set(seg.col, []);
    byCol.get(seg.col).push(seg);
  }
  const paras = [];
  for (const [col, list] of [...byCol.entries()].sort((a, b) => a[0] - b[0])) {
    paras.push(...segmentColumn(list, pageIndex, col));
  }
  return paras;
}

/**
 * 页面内的阅读顺序：通栏元素（跨中线的标题/图注）把页面切成若干横带，
 * 带内先左栏后右栏。按栏号排序会把页尾的图注排到整页正文前面。
 */
function readingOrder(paras, segments) {
  const spans = segments.filter((s) => s.col === 2).map((s) => s.baseline);
  const bandOf = (para) => {
    let band = 0;
    for (const y of spans) if (y < para.y0 - 0.5) band += 1;
    return band;
  };
  return paras.sort((a, b) => bandOf(a) - bandOf(b) || a.col - b.col || a.y0 - b.y0);
}

/** 一页的完整解析：文本项 → 段落（含坐标、栏号、类型） */
export function buildPageParagraphs(items, pageWidth, pageHeight, pageIndex = 0) {
  const boxes = itemBoxes(items, pageHeight);
  const lines = visualLines(boxes);
  const { twoColumn, midX } = detectLayout(lines, boxes, pageWidth);

  const segments = [];
  for (const line of lines) {
    if (!twoColumn) {
      // 单栏：把行内片段合回一整行
      const text = line.segments.map((s) => s.text).join(' ');
      if (!text.trim()) continue;
      segments.push({ col: 0, x0: line.x0, x1: line.x1, baseline: line.baseline, fh: line.fh, text });
      continue;
    }
    for (const seg of line.segments) {
      // 跨中线的片段（通栏标题、宽图注）单独归为第 2 类，不和左右栏混
      const col = seg.x1 <= midX + 2 ? 0 : seg.x0 >= midX - 2 ? 1 : 2;
      segments.push({ ...seg, col });
    }
  }

  // 同一栏、同一基线的片段并回去：防止一行内的大词距被误切
  const merged = new Map();
  for (const seg of segments) {
    const key = `${seg.col}@${Math.round(seg.baseline * 2)}`;
    const hit = merged.get(key);
    if (hit) {
      hit.text = joinText(hit.text, seg.text);
      hit.x0 = Math.min(hit.x0, seg.x0);
      hit.x1 = Math.max(hit.x1, seg.x1);
    } else {
      merged.set(key, { ...seg });
    }
  }

  const allSegments = [...merged.values()];
  return {
    paras: readingOrder(groupParagraphs(allSegments, pageIndex), allSegments),
    twoColumn,
    midX,
    segments: allSegments,
  };
}

const SENTENCE_END_RE = /[.!?。！？:：;；)】」”"']$/;
/** 列表项/编号行：这些行天然带悬挂缩进，不能当作「首行缩进」 */
const BULLET_RE = /^(?:[•·▪◦‣∙]\s*|[-–—]\s+|\d{1,2}[.)]\s+|[A-Za-z][.)]\s+)/;

/** 句子没写完：结尾没有句末标点，或者停在断词连字符上 */
function endsMidSentence(text) {
  const t = String(text || '').trimEnd();
  if (!t) return false;
  if (/[-‐‑]$/.test(t)) return true;
  return !SENTENCE_END_RE.test(t);
}

/** 下一段以字母 / 数字 / 中文开头，才像是同一句的续写 */
function startsContinued(text) {
  const t = String(text || '').trimStart();
  if (!t) return false;
  return /^[A-Za-z0-9,;:)\]]/.test(t) || /^[\u4e00-\u9fff]/.test(t);
}

/**
 * 跨栏 / 跨页的段落续接：双栏论文里一段话常从上一栏底部接到下一栏顶部，
 * 不接起来会让同一句话被切成两段（顺带让侧栏文本可读）。
 * 只在栏/页边界处判断，且要求上一段最后一行排满、没有句末标点。
 */
function continuesNext(prev, next) {
  if (!prev || !next) return false;
  if (prev.heading || next.heading || next.caption) return false;
  if (isLikelyNoise(prev) || isLikelyNoise(next)) return false;
  if (prev.page === next.page && prev.col === next.col) return false;
  if (prev.page !== next.page) {
    if (next.col !== 0) return false; // 只接「本页最后一栏 → 下一页第一栏」
  } else if (prev.col === 2) {
    if (next.col !== 0) return false; // 通栏图注的剩余文字落在下一横带的左栏
  } else if (!(prev.col < next.col)) {
    return false;
  }
  const hyphenated = /[-‐‑]$/.test(prev.text.trimEnd());
  // 图注也可能跨栏/跨页续写：只认断词连字符这种硬证据，免得把正文吸进图注
  if (prev.caption) return hyphenated && prev.fullLastLine && startsContinued(next.text);
  if (!prev.fullLastLine && !hyphenated) return false;
  return endsMidSentence(prev.text) && startsContinued(next.text);
}

/** 图内零散标签：短、没有句末标点，跨页/跨栏接续时可以直接跳过 */
function isLikelyNoise(para) {
  if (!para || para.heading || para.caption) return false;
  const text = para.text.trim();
  return text.length < 60 && !SENTENCE_END_RE.test(text);
}

/** 脚注：以 1-2 位脚注编号开头，排版上夹在正文段落中间 */
function isFootnoteLike(para) {
  if (!para || para.heading || para.caption) return false;
  return /^\d{1,2}\s/.test(para.text.trim());
}

/** 跨页/跨栏时，上一段和本段之间常隔着图注/图内标签，往回找真正的续接对象 */
function findMergeTarget(out, para) {
  for (let i = out.length - 1; i >= 0 && out.length - i <= 32; i -= 1) {
    const cand = out[i];
    if (continuesNext(cand, para)) return cand;
    // 中间隔着图注、图内标签或脚注 → 继续往回找；遇到真正的正文段落就停
    if (!cand.caption && !isLikelyNoise(cand) && !isFootnoteLike(cand)) break;
  }
  return null;
}

/** 文档级：把跨栏 / 跨页断开的同一段接回来（保留多块热区坐标）。导出供离线测试 */
export function mergeFlowingParagraphs(paras) {
  const out = [];
  for (const para of paras) {
    const prev = findMergeTarget(out, para);
    if (prev) {
      const nextText = para.text.trim();
      if (/[-‐‑]$/.test(prev.text.trimEnd()) && /^[a-z]/.test(nextText)) {
        prev.text = prev.text.trimEnd().slice(0, -1) + nextText;
      } else {
        prev.text = joinText(prev.text, nextText);
      }
      prev.rects.push(...para.rects);
      prev.x1 = Math.max(prev.x1, para.x1);
      prev.y1 = Math.max(prev.y1, para.y1);
      prev.lastX1 = para.lastX1;
      prev.lastFh = para.lastFh;
      prev.fullLastLine = para.fullLastLine;
      continue;
    }
    out.push(para);
  }
  return out;
}
/* -------------------------------- 视图 -------------------------------- */

export function createPdfView(host, { onAsk, onNotice } = {}) {
  const state = {
    doc: null,
    pdfjs: null,
    pages: [],
    paras: [],
    paraById: new Map(),
    text: '',
    scale: 1,
    renderedScale: 0,
    renderToken: 0,
    activePara: null,
  };

  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  function clearCard() {
    host.querySelectorAll('.pdf-card').forEach((n) => n.remove());
    state.activePara = null;
  }

  /** 只清页面容器，别动工具栏 */
  function clearPages() {
    clearCard();
    host.querySelectorAll('.pdf-pages').forEach((n) => n.remove());
  }

  function showCard(para, target) {
    clearCard();
    state.activePara = para;
    const card = el('div', 'pdf-card');
    const head = el('div', 'pdf-card-head');
    head.appendChild(el('span', 'pdf-card-tag', para.heading ? '章节标题' : para.caption ? '图表说明' : `第 ${para.page + 1} 页`));
    const close = el('button', 'pdf-card-close', '✕');
    close.type = 'button';
    close.onclick = clearCard;
    head.appendChild(close);
    card.appendChild(head);

    card.appendChild(el('div', 'pdf-card-text', para.text));

    const actions = el('div', 'pdf-card-actions');
    const askBtn = el('button', 'btn tiny primary', '针对这段问 AI');
    askBtn.type = 'button';
    askBtn.onclick = () => {
      clearCard();
      onAsk?.(para.text);
    };
    const copyBtn = el('button', 'btn tiny', '复制');
    copyBtn.type = 'button';
    copyBtn.onclick = async () => {
      try {
        await navigator.clipboard.writeText(para.text);
        onNotice?.('已复制这一段');
      } catch {
        onNotice?.('复制失败，请手动选择文本');
      }
    };
    actions.appendChild(askBtn);
    actions.appendChild(copyBtn);
    card.appendChild(actions);

    // 贴着段落块放，超出右侧就贴边
    const rect = target.getBoundingClientRect();
    const hostRect = host.getBoundingClientRect();
    const left = rect.left - hostRect.left + host.scrollLeft - 14;
    card.style.left = `${Math.min(Math.max(8, left), Math.max(8, host.clientWidth - 340))}px`;
    card.style.top = `${rect.bottom - hostRect.top + host.scrollTop + 6}px`;
    host.appendChild(card);
  }

  function highlightPara(node, on) {
    const pid = node?.dataset.pid;
    if (pid === undefined) return;
    host.querySelectorAll(`.pdf-para[data-pid="${pid}"]`).forEach((n) => n.classList.toggle('hl', on));
  }

  async function renderAll() {
    if (!state.doc) return;
    const token = ++state.renderToken;
    const pagesEl = host.querySelector('.pdf-pages');
    if (!pagesEl) return;
    pagesEl.innerHTML = '';
    clearCard();

    const ratio = Math.min(window.devicePixelRatio || 1, 2);

    for (const pageData of state.pages) {
      if (token !== state.renderToken) return;
      const viewport = pageData.proxy.getViewport({ scale: state.scale });
      const pageEl = el('div', 'pdf-page');
      pageEl.style.width = `${Math.floor(viewport.width)}px`;
      pageEl.style.height = `${Math.floor(viewport.height)}px`;

      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      pageEl.appendChild(canvas);

      const hot = el('div', 'pdf-hot');
      for (const { para, rect } of pageData.boxes) {
        const box = el(
          'div',
          `pdf-para${para.heading ? ' is-heading' : ''}${para.caption ? ' is-caption' : ''}`,
        );
        box.dataset.pid = para.id;
        box.style.left = `${rect.x0 * state.scale}px`;
        box.style.top = `${rect.y0 * state.scale}px`;
        box.style.width = `${Math.max(8, (rect.x1 - rect.x0) * state.scale)}px`;
        box.style.height = `${Math.max(8, (rect.y1 - rect.y0) * state.scale)}px`;
        if (para.heading) box.appendChild(el('span', 'pdf-heading-tag', para.text));
        hot.appendChild(box);
      }
      pageEl.appendChild(hot);
      pageEl.appendChild(el('div', 'pdf-page-no', String(pageData.index + 1)));

      pagesEl.appendChild(pageEl);

      const ctx = canvas.getContext('2d', { alpha: false });
      try {
        await pageData.proxy.render({
          canvasContext: ctx,
          viewport,
          transform: ratio !== 1 ? [ratio, 0, 0, ratio, 0, 0] : undefined,
        }).promise;
      } catch {
        /* 单页渲染失败不影响其它页 */
      }
    }
  }

  let eventsBound = false;
  function bindHostEvents() {
    if (eventsBound) return;
    eventsBound = true;

    host.addEventListener('mouseover', (ev) => {
      const para = ev.target.closest?.('.pdf-para');
      if (para) highlightPara(para, true);
    });
    host.addEventListener('mouseout', (ev) => {
      const para = ev.target.closest?.('.pdf-para');
      if (para && !para.contains(ev.relatedTarget)) highlightPara(para, false);
    });
    host.addEventListener('click', (ev) => {
      const para = ev.target.closest?.('.pdf-para');
      if (para) {
        const data = state.paraById.get(para.dataset.pid || '');
        if (data) showCard(data, para);
        return;
      }
      if (!ev.target.closest?.('.pdf-card')) clearCard();
    });
  }

  function currentScaleForFit() {
    const first = state.pages[0];
    if (!first) return 1;
    const available = (host.clientWidth || 520) - 28;
    return Math.max(MIN_SCALE, Math.min(MAX_SCALE, available / first.width));
  }

  return {
    /** 解析 PDF：聚合段落并缓存，暂不渲染（等视图真正显示时再画，避免隐藏容器宽度为 0） */
    async load(bytes) {
      const pdfjs = await getPdfjs();
      const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes) }).promise;
      const pages = [];
      const allParas = [];
      let columns = 1;

      for (let i = 1; i <= doc.numPages; i += 1) {
        const proxy = await doc.getPage(i);
        const viewport = proxy.getViewport({ scale: 1 });
        const content = await proxy.getTextContent();
        const { paras, twoColumn } = buildPageParagraphs(content.items, viewport.width, viewport.height, i - 1);
        if (twoColumn) columns = 2;
        pages.push({ index: i - 1, proxy, width: viewport.width, height: viewport.height, boxes: [] });
        allParas.push(...paras);
      }

      // 跨栏 / 跨页把同一段接回来，再按页分配热区
      const paras = mergeFlowingParagraphs(allParas);
      paras.forEach((para, i) => {
        para.id = `p${i}`;
      });
      for (const para of paras) {
        for (const rect of para.rects) {
          const pageData = pages[rect.page];
          if (pageData) pageData.boxes.push({ para, rect });
        }
      }
      const textParts = paras.map((para) => (para.heading ? `\n${para.text}\n` : para.text));

      state.doc = doc;
      state.pdfjs = pdfjs;
      state.pages = pages;
      state.paras = paras;
      state.paraById = new Map(paras.map((para) => [para.id, para]));
      state.text = textParts.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
      state.renderedScale = 0;

      clearPages();
      host.appendChild(el('div', 'pdf-pages'));
      bindHostEvents();

      return { text: state.text, numPages: doc.numPages, columns };
    },

    /** 真正显示时调用：按当前容器宽度适配并渲染（切回来时宽度变了也会重新适配） */
    async mount() {
      if (!state.doc) return;
      if (!host.querySelector('.pdf-pages')) host.appendChild(el('div', 'pdf-pages'));
      const target = currentScaleForFit();
      if (Math.abs(target - state.scale) > 0.001) {
        state.scale = target;
        await renderAll();
        state.renderedScale = state.scale;
        return;
      }
      if (Math.abs(state.renderedScale - state.scale) > 0.001) {
        await renderAll();
        state.renderedScale = state.scale;
      }
    },

    getText() {
      return state.text;
    },

    isLoaded() {
      return Boolean(state.doc);
    },

    async zoom(delta) {
      const next = Math.max(MIN_SCALE, Math.min(MAX_SCALE, state.scale * (delta > 0 ? 1.15 : 1 / 1.15)));
      if (Math.abs(next - state.scale) < 0.001) return state.scale;
      state.scale = next;
      await renderAll();
      state.renderedScale = state.scale;
      return state.scale;
    },

    async fit() {
      if (!state.doc) return state.scale;
      const next = currentScaleForFit();
      if (Math.abs(next - state.scale) < 0.001) return state.scale;
      state.scale = next;
      await renderAll();
      state.renderedScale = state.scale;
      return state.scale;
    },

    getScale() {
      return state.scale;
    },

    /** 概念定位：找到含该词的段落，滚动 + 闪烁 + 弹卡片 */
    locate(term) {
      const needle = String(term || '').trim();
      if (!needle) return false;
      // 空格/连字符视为可选分隔，兼容 "state space" 与 "state-space"、跨行断词
      const parts = needle
        .split(/[\s\-‐‑]+/)
        .filter(Boolean)
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      if (!parts.length) return false;
      const pattern = new RegExp(parts.join('[\\s\\-‐‑]*'), 'i');
      for (const para of state.paras) {
        if (!pattern.test(para.text)) continue;
        const node = host.querySelector(`.pdf-para[data-pid="${para.id}"]`);
        if (!node) continue;
        node.scrollIntoView({ block: 'center', behavior: 'smooth' });
        node.classList.add('flash');
        setTimeout(() => node.classList.remove('flash'), 1800);
        showCard(para, node);
        return true;
      }
      return false;
    },

    destroy() {
      state.renderToken += 1;
      state.doc = null;
      state.pages = [];
      state.paras = [];
      state.paraById = new Map();
      state.text = '';
      state.renderedScale = 0;
      clearPages();
    },
  };
}
