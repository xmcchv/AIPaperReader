/**
 * PDF 原版视图：pdf.js 渲染原始页面，叠加「章节 / 段落热区」。
 * - 页面本身是原版 canvas，不做任何改写
 * - 段落热区来自 pdf.js 文本层的坐标聚合：hover 高亮整段，点击弹出该段原文卡片
 * - 章节标题额外标注，图注单独标记
 * - 双栏论文按栏切分，热区只覆盖本栏宽度（不会横跨整页）
 * 解析出的段落同时拼成纯文本，供精读/追问使用
 */
import { isSectionTitle } from './text.js';

const PDFJS_LOCAL = '/vendor/pdfjs/pdf.min.mjs';
const WORKER_LOCAL = '/vendor/pdfjs/pdf.worker.min.mjs';
const ASSETS_LOCAL = '/vendor/pdfjs/';
const PDFJS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.min.mjs';
const WORKER_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/build/pdf.worker.min.mjs';
const ASSETS_CDN = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.8.69/';

const CAPTION_RE = /^(figure|table|algorithm|listing)\s*\d+\s*[:.]/i;
const MATH_RE = /[√∫∑∏≈≤≥≠]/;
const MIN_SCALE = 0.45;

/**
 * 把术语在段落文本里的命中位置，近似映射到 PDF 上「一行」的横向区间。
 *
 * para 的 rects 是段落整体的包围盒（一个 rect 可能跨多行），直接拿它当高亮框
 * 会画出一条贯穿整段的竖条——所以必须按行高 fh 把它切成行，只高亮命中那一行。
 * 做法：先按各 rect 的宽度比例把文本字符分摊到 rect，再在 rect 内按行高切行，
 * 用「每行字符数」估算术语落在第几行、行内横向位置。
 *
 * @returns {{page:number,x0:number,y0:number,x1:number,y1:number}|null}
 */
export function termRectFor(para, pattern) {
  const text = String(para?.text || '');
  const rects = Array.isArray(para?.rects) ? para.rects : [];
  if (!text || !rects.length) return null;
  const m = pattern.exec(text);
  if (!m) return null;

  const fh = Math.max(6, Number(para.fh || para.lastFh) || 12);
  const widths = rects.map((r) => Math.max(1, r.x1 - r.x0));
  const totalWidth = widths.reduce((a, b) => a + b, 0);

  // 第 1 步：命中落在哪个 rect（按宽度比例分摊字符）
  let acc = 0;
  let idx = rects.length - 1;
  for (let i = 0; i < rects.length; i += 1) {
    const share = (widths[i] / totalWidth) * text.length;
    if (m.index < acc + share) { idx = i; break; }
    acc += share;
  }
  const rect = rects[idx];

  // 第 2 步：该 rect 内按行高切行，估算命中在第几行
  const rectHeight = Math.max(fh, rect.y1 - rect.y0);
  const lineCount = Math.max(1, Math.round(rectHeight / fh));
  const rectChars = Math.max(1, Math.round((widths[idx] / totalWidth) * text.length));
  const charsPerLine = Math.max(1, rectChars / lineCount);
  const withinRect = m.index - acc;
  const lineIdx = Math.max(0, Math.min(lineCount - 1, Math.floor(withinRect / charsPerLine)));

  // 第 3 步：行内横向位置（用该行起始字符偏移）
  const lineStart = lineIdx * charsPerLine;
  const withinLine = Math.max(0, Math.min(1, (withinRect - lineStart) / charsPerLine));
  const span = Math.max(0.03, Math.min(1 - withinLine, m[0].length / charsPerLine));
  const lineWidth = rect.x1 - rect.x0;
  // 行高方向：第一行贴 rect.y0，后续按 fh 递进；只取一行高度，不再贯穿整段
  const y0 = rect.y0 + lineIdx * fh;

  return {
    page: rect.page,
    x0: rect.x0 + lineWidth * withinLine,
    x1: rect.x0 + lineWidth * (withinLine + span),
    y0,
    y1: Math.min(rect.y1, y0 + fh),
  };
}
/** 标题归一化：去编号前缀、折叠空白、去尾部句点，便于章节标题 ↔ PDF heading 段匹配 */
export function normalizeHeading(text) {
  const s = String(text || '').trim();
  // 剥掉章节编号：阿拉伯数字（1 / 2.1）后需句点或空格；罗马数字（I / VII）后需句点。
  // "3D Sliding" 的 "3D" 紧跟字母，不是编号，保留。
  const stripped = s
    .replace(/^\d{1,2}(?:\.\d{1,2})*\.?\s+(?=[A-Z\u4e00-\u9fff])/, '')
    .replace(/^[IVXLCDM]{1,5}\.\s+(?=\S)/, '');
  return stripped.replace(/\s+/g, ' ').replace(/[.．:：]+$/, '').toLowerCase();
}

/** 章节 → PDF heading 段的匹配分：编号一致加权，标题包含/相等加权 */
export function headingMatchScore(para, number, title) {
  const raw = String(para?.text || '').trim();
  if (!raw || raw.length > 90) return -1;
  // 标题文本要像标题：短、以编号开头或以关键词开头。不能只依赖 para.heading——
  // 很多 PDF 的章节标题块被抽成 kind=body（实测 SCAN-Planner 只有结论节是 heading）。
  const numbered = /^([\dIVXLCDM]{1,5}(?:\.\d{1,2})*)\.\s+\S/.test(raw) || /^\d{1,2}(?:\.\d{1,2})*\.?\s+[A-Z\u4e00-\u9fff]/.test(raw);
  const keyword = /^(abstract|摘要|introduction|引言|related work|method|实验|experiment|conclusion|结论|discussion|references)/i.test(raw);
  if (!numbered && !keyword && !para?.heading && para?.kind !== 'heading') return -1;

  const norm = normalizeHeading(raw);
  const wantTitle = normalizeHeading(title);
  if (!norm) return -1;
  let score = 0;
  if (wantTitle) {
    if (norm === wantTitle) score += 10;
    else if (norm.includes(wantTitle) || wantTitle.includes(norm)) score += 5;
  }
  const num = String(number || '').trim().replace(/\.+$/, '').toLowerCase();
  if (num) {
    const prefix = raw.match(/^([\dIVXLCDM]{1,5}(?:\.\d{1,2})*)\.?\s/);
    if (prefix && prefix[1].toLowerCase() === num) score += 8;
  }
  // 纯标题（编号 + 短标题）比正文里顺带提到的段落优先
  if (numbered && raw.split(/\s+/).length <= 8) score += 2;
  return score;
}

const MAX_SCALE = 3;

let pdfjsPromise = null;
let pdfAssetBase = ASSETS_LOCAL;

async function loadPdfjsModule(moduleUrl, workerUrl, assetsBase) {
  const mod = await import(moduleUrl);
  mod.GlobalWorkerOptions.workerSrc = workerUrl;
  pdfAssetBase = assetsBase;
  return mod;
}

export function getPdfjs() {
  if (!pdfjsPromise) {
    // 本地优先；文件缺失时回退 CDN。cmaps / 标准字体也跟着走同一来源。
    pdfjsPromise = loadPdfjsModule(PDFJS_LOCAL, WORKER_LOCAL, ASSETS_LOCAL).catch(() =>
      loadPdfjsModule(PDFJS_CDN, WORKER_CDN, ASSETS_CDN),
    );
  }
  return pdfjsPromise;
}

/** 单独打开一份 PDF（精读页上传时先抽分块用）；调用方负责 destroy() */
export async function openPdfDocument(bytes) {
  const pdfjs = await getPdfjs();
  return pdfjs.getDocument({
    data: bytes,
    cMapUrl: `${pdfAssetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${pdfAssetBase}standard_fonts/`,
    isEvalSupported: false,
  }).promise;
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
function segmentColumn(segments, pageIndex, col, pageHeight = 0) {
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
    para.fh = para.lastFh;
    para.bodyFh = bodyFh;
    para.kind = para.heading ? 'heading' : para.caption ? 'caption' : 'body';
  }
  return classifyColumn(paras, { base, bodyFh, pageHeight, pageIndex, col });
}

/** 短行候选：图内标签、表格行、公式碎片通常短、没有句末标点、也不是列表项 */
function isShortCandidate(para) {
  const text = String(para.text || '').trim();
  if (!text || text.length >= 60) return false;
  if (/[.!?。！？]$/.test(text)) return false;
  if (BULLET_RE.test(text)) return false;
  if (/^\[\d+\]/.test(text)) return false;
  return !para.heading && !para.caption;
}

/** 把连续短行合并成一个图/表/公式块，避免逐行成段 */
function mergeShortGroup(group, pageIndex, col) {
  const text = group.map((p) => p.text.trim()).join('\n');
  const mathChars = (text.match(/[=^_\\√∫∑∏≈≤≥≠]/g) || []).length;
  const digits = (text.match(/[0-9]/g) || []).length;
  const x0s = new Set(group.map((p) => Math.round(p.x0)));

  let kind = 'figure';
  const mathSignal = /[=^_\\√∫∑∏≈≤≥≠]/.test(text);
  if (mathSignal && (mathChars / Math.max(1, text.length) > 0.03 || /[\\^_√∫∑∏]/.test(text) || /=/.test(text))) {
    kind = 'formula';
  } else if (digits / Math.max(1, text.length) > 0.2 || x0s.size >= 2) {
    // 每行很短、行数少的更像图内标签；行数足够且列对齐的才归为表格
    kind = group.length >= 6 && text.length / group.length >= 22 ? 'table' : 'figure';
  }

  const x0 = Math.min(...group.map((p) => p.x0));
  const x1 = Math.max(...group.map((p) => p.x1));
  const y0 = Math.min(...group.map((p) => p.y0));
  const y1 = Math.max(...group.map((p) => p.y1));
  const last = group[group.length - 1];
  return {
    ...group[0],
    x0,
    x1,
    y0,
    y1,
    text,
    kind,
    rects: [{ page: pageIndex, col, x0, y0, x1, y1 }],
    lastX1: last.lastX1,
    lastFh: last.lastFh,
    fullLastLine: last.fullLastLine,
    mergedLines: group.length,
  };
}

/** 同栏正文续接：上一段末尾没写完、下一段以小写/数字/中文开头，且间距是段内行距 */
function continueSameColumn(prev, next, base) {
  if (!prev || !next || prev.kind !== 'body' || next.kind !== 'body') return false;
  const tail = String(prev.text || '').trim();
  if (tail.length < 60) return false;
  if (/[.!?。！？:：;；)】」”"']$/.test(tail) && !/[-‐‑]$/.test(tail)) return false;
  if (!/^[a-z0-9\u4e00-\u9fff]/.test(String(next.text || '').trim())) return false;
  return next.y0 - prev.y1 <= base * 2.2;
}

/** 合并两段的文本与坐标（供同栏/跨栏续接共用） */
function mergeParagraph(target, source) {
  const nextText = String(source.text || '').trim();
  if (/[-‐‑]$/.test(target.text.trimEnd()) && /^[a-z]/.test(nextText)) {
    target.text = target.text.trimEnd().slice(0, -1) + nextText;
  } else {
    target.text = joinText(target.text, nextText);
  }
  target.x0 = Math.min(target.x0, source.x0);
  target.x1 = Math.max(target.x1, source.x1);
  target.y1 = Math.max(target.y1, source.y1);
  target.lastX1 = source.lastX1;
  target.lastFh = source.lastFh;
  target.fullLastLine = source.fullLastLine;
  target.rects.push(...source.rects);
  return target;
}

/** 图内文字块：像 "3x3 conv, 64 / pool, /2" 这种无句末标点、标签词和数字都多的块 */
function isFigureLike(para) {
  const text = String(para.text || '').trim();
  if (text.length < 40 || /[.!?。！？]$/.test(text)) return false;
  const labels = (text.match(/\b(conv|pool|fc|layer|output|size|input|stride)\b/gi) || []).length;
  const digits = (text.match(/[0-9]/g) || []).length;
  return labels >= 2 && digits / text.length > 0.08;
}

/**
 * 页面/栏内分类：
 * - 页边/页眉、脚注先标记，不参与正文
 * - 连续短行合并成 figure/table/formula 块（图内标签、表格行、公式碎片）
 * - 同栏正文被误切时接回去
 */
function classifyColumn(paras, { base, bodyFh, pageHeight, pageIndex, col }) {
  if (!paras.length) return paras;
  const topLimit = pageHeight ? pageHeight * 0.1 : -Infinity;
  const bottomLimit = pageHeight ? pageHeight * 0.88 : Infinity;

  for (const para of paras) {
    if (para.kind !== 'body') continue;
    if (para.y1 < topLimit && para.text.trim().length < 120) {
      para.kind = 'margin';
    } else if (para.y0 > bottomLimit && (para.fh < bodyFh * 0.95 || /^\d{1,2}\s/.test(para.text.trim()))) {
      para.kind = 'footnote';
    } else if (isFigureLike(para)) {
      para.kind = 'figure';
    }
  }

  const grouped = [];
  for (let i = 0; i < paras.length; i += 1) {
    const para = paras[i];
    if (para.kind !== 'body' || !isShortCandidate(para)) {
      grouped.push(para);
      continue;
    }
    const group = [para];
    let j = i + 1;
    while (j < paras.length) {
      const next = paras[j];
      if (next.kind !== 'body' || !isShortCandidate(next)) break;
      if (next.y0 - group[group.length - 1].y1 > base * 2.2) break;
      group.push(next);
      j += 1;
    }
    if (group.length >= 2) {
      grouped.push(mergeShortGroup(group, pageIndex, col));
      i = j - 1;
    } else {
      // 单个孤立短行（图内标签/公式碎片）也归类，避免进入正文文本
      const text = para.text.trim();
      if (bodyFh > 0 && para.fh < bodyFh * 1.05 && text.length < 40) {
        para.kind = /[=^_\\√∫∑∏≈≤≥≠]/.test(text) ? 'formula' : 'figure';
      }
      grouped.push(para);
    }
  }

  const out = [];
  for (const para of grouped) {
    const prev = out[out.length - 1];
    if (prev && continueSameColumn(prev, para, base)) {
      mergeParagraph(prev, para);
      continue;
    }
    out.push(para);
  }
  return out;
}

/** 首页摘要/Introduction 之前的作者、单位、邮箱、版权声明（保留大字号论文标题） */
function markFrontMatter(paras) {
  const firstPage = paras.filter((p) => p.page === 0);
  if (!firstPage.length) return;
  const abstract = firstPage.find(
    (p) => p.kind === 'heading' && /^(abstract|摘要|1\.?\s+introduction|introduction)$/i.test(p.text.trim()),
  );
  if (!abstract) return;
  const candidates = firstPage.filter(
    (p) => p.y0 < abstract.y0 && !['heading', 'caption', 'margin', 'footnote', 'reference'].includes(p.kind),
  );
  if (!candidates.length) return;
  // 论文标题通常是字号最大的那段；字号相同则取第一段，其余（作者/单位/邮箱/版权）标为首页信息
  const maxFh = Math.max(...candidates.map((p) => p.fh || 0));
  const title = candidates.find((p) => (p.fh || 0) === maxFh) || candidates[0];
  for (const para of candidates) {
    if (para !== title) para.kind = 'front-matter';
  }
}

/** 参考文献：References 标题之后的正文段落单独归类，方便精读/导出过滤 */
function markReferences(paras) {
  let inRefs = false;
  for (const para of paras) {
    if (para.heading && /^(references?|bibliography|参考文献)$/i.test(para.text.trim())) {
      inRefs = true;
    } else if (inRefs && para.kind !== 'heading' && para.kind !== 'caption') {
      para.kind = 'reference';
    }
  }
  return paras;
}

/** 片段 → 段落（按栏分别聚合，返回按阅读顺序排列的段落）。导出供离线测试 */
export function groupParagraphs(segments, pageIndex, pageHeight = 0) {
  const byCol = new Map();
  for (const seg of segments) {
    if (!byCol.has(seg.col)) byCol.set(seg.col, []);
    byCol.get(seg.col).push(seg);
  }
  const paras = [];
  for (const [col, list] of [...byCol.entries()].sort((a, b) => a[0] - b[0])) {
    paras.push(...segmentColumn(list, pageIndex, col, pageHeight));
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
    paras: readingOrder(groupParagraphs(allSegments, pageIndex, pageHeight), allSegments),
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
  // 图/表/公式/脚注/参考文献块不参与正文续接
  if (prev.kind && !['body', 'caption'].includes(prev.kind)) return false;
  if (next.kind && next.kind !== 'body') return false;
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
  markFrontMatter(paras);
  markReferences(paras);
  const out = [];
  for (const para of paras) {
    const prev = findMergeTarget(out, para);
    if (prev) {
      mergeParagraph(prev, para);
      continue;
    }
    out.push(para);
  }
  return out;
}
/* -------------------------------- 视图 -------------------------------- */

/**
 * 翻译页的分块 → 精读页的段落。
 * 块坐标是 PDF 用户空间（原点左下、y 向上），这里的 rect 用「距页面顶部」（y 向下），
 * 转换只做一次减法，两边框出来的矩形才会完全重合。
 */
export function blocksToParas(blocks, pages) {
  const out = [];
  const maxPage = Math.max(0, pages.length - 1);
  const clampPage = (n) => Math.min(Math.max(0, Number(n) || 0), maxPage);

  /** 一块（PDF 空间、原点左下）→ 热区矩形（距页面顶部） */
  const rectOf = (pageNo, x0, yTop, w, h) => {
    const meta = pages[clampPage(pageNo)];
    if (!meta) return null;
    const top = meta.height - (Number(yTop) || 0);
    return {
      page: clampPage(pageNo),
      x0: Number(x0) || 0,
      y0: top,
      x1: (Number(x0) || 0) + Math.max(1, w),
      y1: top + Math.max(1, h),
    };
  };

  const list = blocks
    .slice()
    .sort((a, b) => Number(a.order ?? 0) - Number(b.order ?? 0));
  list.forEach((b, i) => {
    const page = clampPage(b.page);
    const text = String(b.text || '').replace(/\s+/g, ' ').trim();
    if (!pages[page] || !text) return;

    const rects = [];
    const main = rectOf(page, b.x, b.y, Number(b.w) || 1, Number(b.h) || 1);
    if (main) rects.push(main);
    // 翻译页合并出来的段落会在好几处各占一块，这里同样画几个框
    for (const eb of Array.isArray(b.extraBoxes) ? b.extraBoxes : []) {
      const extra = rectOf(
        eb.page ?? page,
        eb.x0,
        eb.yTop,
        (Number(eb.x1) || 0) - (Number(eb.x0) || 0),
        (Number(eb.yTop) || 0) - (Number(eb.yBottom) || 0),
      );
      if (extra) rects.push(extra);
    }
    if (!rects.length) return;

    out.push({
      id: `b${i}`,
      page,
      text,
      kind: b.kind || 'body',
      heading: b.kind === 'heading',
      caption: b.kind === 'caption',
      rects,
    });
  });
  return out;
}

export function createPdfView(host, { onAsk, onNotice } = {}) {
  const state = {
    doc: null,
    pdfjs: null,
    pages: [],
    paras: [],
    paraById: new Map(),
    zhByText: new Map(),
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

  /** 在 PDF 页面上画一个近似覆盖术语的矩形（词级高亮），2 秒后淡出 */
  function flashTermRect(para, pattern) {
    const rect = termRectFor(para, pattern);
    if (!rect) return;
    const page = host.querySelector(`.pdf-page[data-page="${rect.page}"]`);
    if (!page) return;
    host.querySelectorAll('.pdf-term-highlight').forEach((n) => n.remove());
    const mark = el('div', 'pdf-term-highlight');
    mark.style.left = `${rect.x0 * state.scale}px`;
    mark.style.top = `${rect.y0 * state.scale}px`;
    mark.style.width = `${Math.max(6, (rect.x1 - rect.x0) * state.scale)}px`;
    mark.style.height = `${Math.max(8, (rect.y1 - rect.y0) * state.scale)}px`;
    page.appendChild(mark);
    setTimeout(() => mark.remove(), 2400);
  }

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
    const kindLabels = {
      heading: '章节标题',
      caption: '图表说明',
      figure: '图内文字',
      table: '表格',
      formula: '公式',
      footnote: '脚注',
      reference: '参考文献',
      margin: '页边/页眉',
      'front-matter': '首页信息',
    };
    head.appendChild(el('span', 'pdf-card-tag', kindLabels[para.kind] || `第 ${para.page + 1} 页`));
    const close = el('button', 'pdf-card-close', '✕');
    close.type = 'button';
    close.onclick = clearCard;
    head.appendChild(close);
    card.appendChild(head);

    card.appendChild(el('div', 'pdf-card-text', para.text));

    // 翻译页翻过的段落直接给中文对照：两边用的是同一份分块，所以按原文文本就能命中
    const zh = lookupZh(para.text);
    if (zh) {
      const zhBox = el('div', 'pdf-card-zh');
      zhBox.appendChild(el('span', 'pdf-card-zh-label', '中文对照'));
      zhBox.appendChild(el('div', 'pdf-card-zh-text', zh));
      card.appendChild(zhBox);
    }

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

  const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

  function lookupZh(text) {
    if (!state.zhByText.size) return '';
    const key = normText(text);
    if (!key) return '';
    const hit = state.zhByText.get(key);
    if (hit) return hit;
    const head = key.slice(0, 40);
    for (const [en, zh] of state.zhByText) {
      if (en.length > 20 && (en.startsWith(head) || key.startsWith(en.slice(0, 40)))) return zh;
    }
    return '';
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
      pageEl.dataset.page = String(pageData.index);
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
          `pdf-para${para.heading ? ' is-heading' : ''}${para.caption ? ' is-caption' : ''}${
            para.kind && !['body', 'heading', 'caption'].includes(para.kind) ? ` is-${para.kind}` : ''
          }`,
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
    async load(bytes, { blocks = null } = {}) {
      const pdfjs = await getPdfjs();
      const doc = await pdfjs.getDocument({
        data: new Uint8Array(bytes),
        cMapUrl: `${pdfAssetBase}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${pdfAssetBase}standard_fonts/`,
      }).promise;
      const pages = [];
      const allParas = [];
      let columns = 1;
      // 翻译页已经抽过块就用它：同一份分块，两个视图的框才会重合
      const sharedBlocks = Array.isArray(blocks) && blocks.length ? blocks : null;

      for (let i = 1; i <= doc.numPages; i += 1) {
        const proxy = await doc.getPage(i);
        const viewport = proxy.getViewport({ scale: 1 });
        pages.push({ index: i - 1, proxy, width: viewport.width, height: viewport.height, boxes: [] });
        if (sharedBlocks) continue;
        const content = await proxy.getTextContent();
        const { paras, twoColumn } = buildPageParagraphs(content.items, viewport.width, viewport.height, i - 1);
        if (twoColumn) columns = 2;
        allParas.push(...paras);
      }

      let paras;
      if (sharedBlocks) {
        paras = blocksToParas(sharedBlocks, pages);
        // 粗判分栏：块同时落在左半页与右半页就算双栏
        const mid = pages.map((p) => p.width * 0.45);
        const hasLeft = paras.some((p) => p.rects[0].x0 < (mid[p.page] || 0));
        const hasRight = paras.some((p) => p.rects[0].x0 >= (mid[p.page] || 0));
        columns = hasLeft && hasRight ? 2 : 1;
      } else {
        // 跨栏 / 跨页把同一段接回来，再按页分配热区
        paras = mergeFlowingParagraphs(allParas);
        paras.forEach((para, i) => {
          para.id = `p${i}`;
        });
      }
      for (const para of paras) {
        for (const rect of para.rects) {
          const pageData = pages[rect.page];
          if (pageData) pageData.boxes.push({ para, rect });
        }
      }
      const textParts = paras
        .filter((para) => !['margin', 'footnote', 'reference', 'figure', 'front-matter'].includes(para.kind))
        .map((para) => (para.heading ? `\n${para.text}\n` : para.text));

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

    /** 这里传进来的是 [{text, zh}]：论文库里存的译文，key 是原文文本 */
    setTranslations(list) {
      state.zhByText = new Map();
      for (const item of Array.isArray(list) ? list : []) {
        const en = normText(item?.text);
        const zh = String(item?.zh || '').trim();
        if (en && zh) state.zhByText.set(en, zh);
      }
    },

    /** 当前页里有译文的段落数，给工具栏显示覆盖率用 */
    translatedCount() {
      let n = 0;
      for (const para of state.paras) if (lookupZh(para.text)) n += 1;
      return n;
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
        flashTermRect(para, pattern);
        showCard(para, node);
        return true;
      }
      return false;
    },

    /**
     * 章节定位：只在 heading 段里匹配章节号/标题，滚到该标题热区并闪烁。
     * 不弹卡片（区别于 locate），供目录/章节地图跳 PDF 使用。
     * @returns {{page:number, id:string}|null} 是否命中及页码（0-based）
     */
    locateSection(number, title) {
      if (!state.paras.length) return null;
      let best = null;
      let bestScore = 0;
      for (const para of state.paras) {
        const score = headingMatchScore(para, number, title);
        if (score > bestScore) { best = para; bestScore = score; }
      }
      if (!best || bestScore < 8) return null;
      const node = host.querySelector(`.pdf-para[data-pid="${best.id}"]`);
      if (!node) return null;
      node.scrollIntoView({ block: 'start', behavior: 'smooth' });
      node.classList.add('flash');
      setTimeout(() => node.classList.remove('flash'), 1800);
      const page = best.rects?.[0]?.page ?? best.page ?? 0;
      return { page, id: best.id };
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
