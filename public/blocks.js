/**
 * 把 pdf.js 的 textContent 切成「可点击的阅读块」。
 * 所有坐标都在 PDF 用户空间（单位 pts，原点左下），渲染时再用 viewport 转换。
 *
 * 流水线：
 *   1. 收集字形 → 2. 检测分栏 → 3. 聚成行 → 4. 按页主字号分类（正文 / 小字标注）
 *   5. 小字聚成「图表文字」区域，不参与段落合并 → 6. 正文按稳健边距合并成段
 *   7. 碎片后处理（续行、断词、公式夹断）→ 8. 排阅读顺序
 */

const LIGATURES = {
  'ﬁ': 'fi', 'ﬂ': 'fl', 'ﬀ': 'ff', 'ﬃ': 'ffi', 'ﬄ': 'ffl', 'ﬅ': 'ft', 'ﬆ': 'st',
};
const LIG_RE = new RegExp(Object.keys(LIGATURES).join('|'), 'g');

function cleanText(s) {
  return s
    .replace(LIG_RE, (c) => LIGATURES[c])
    .replace(/\u00ad/g, '')
    .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
    .replace(/[ \t]{2,}/g, ' ');
}

const median = (arr) => {
  if (!arr.length) return 0;
  const a = [...arr].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

/** 按字符数加权的众数，用来估计"正文左边界 / 右边界"这类稳定值 */
function weightedMode(values, weights, bucket = 1.5) {
  const map = new Map();
  for (let i = 0; i < values.length; i++) {
    if (!isFinite(values[i])) continue;
    const k = Math.round(values[i] / bucket) * bucket;
    map.set(k, (map.get(k) || 0) + (weights[i] || 1));
  }
  let best = null;
  let bestW = -1;
  for (const [k, w] of map) {
    if (w > bestW) {
      bestW = w;
      best = k;
    }
  }
  return best;
}

/**
 * 收集文本 item，统一成带包围盒的结构。
 *
 * 包围盒用变换矩阵算：文字的书写方向是 (cosθ, sinθ)，字形从基线往上是 0.78h、
 * 往下是 0.24h，四个角投影到页面坐标就得到真正的矩形。
 * 水平文字化简后与「x0 = e，x1 = e + width」完全一致，所以对正文没有任何影响。
 *
 * 顺带标出旋转文字（arXiv 左侧竖排编号、竖排表头、旋转的坐标轴标签）：
 * 这些文字的 pdf.js width 是沿书写方向的长度，直接当水平宽度用会横跨大半个页面，
 * 一被框进去就会把段落文字搅乱、把框撑变形。
 */
function collectItems(textContent) {
  const items = [];
  for (const raw of textContent.items) {
    if (!raw || typeof raw.str !== 'string') continue;
    const str = cleanText(raw.str);
    if (!str.trim()) continue;
    const tr = raw.transform;
    if (!tr || !isFinite(tr[4]) || !isFinite(tr[5])) continue;

    const size = Math.hypot(tr[2], tr[3]) || raw.height || 10;
    if (size < 1.5) continue;

    const w = raw.width > 0 ? raw.width : str.length * size * 0.5;
    const h = raw.height > 0 ? raw.height : size;

    const ax = Math.hypot(tr[0], tr[1]) || 1;
    const cos = tr[0] / ax;
    const sin = tr[1] / ax;
    const up = 0.78 * h;
    const down = 0.24 * h;

    let x0 = Infinity, x1 = -Infinity, top = -Infinity, bottom = Infinity;
    for (const t of [0, w]) {
      for (const u of [-down, up]) {
        const px = tr[4] + t * cos - u * sin;
        const py = tr[5] + t * sin + u * cos;
        if (px < x0) x0 = px;
        if (px > x1) x1 = px;
        if (py > top) top = py;
        if (py < bottom) bottom = py;
      }
    }

    items.push({
      str,
      x0,
      x1,
      base: tr[5],
      top,
      bottom,
      size,
      font: raw.fontName || '',
      rot: Math.abs(sin) > 0.09, // 基线偏离水平 > 5°
    });
  }

  // 整页都是旋转文字（横放的整页图表）时不能过滤，否则整页空白
  const turned = items.reduce((n, it) => n + (it.rot ? 1 : 0), 0);
  if (turned > items.length * 0.5) for (const it of items) it.rot = false;
  return items;
}

/** 检测分栏：返回栏间空白带的中线 x（无分栏返回 null） */
function detectGutter(items, pageWidth, pageHeight) {
  const centerX = pageWidth / 2;
  const headerTop = pageHeight ? pageHeight * 0.72 : Infinity;
  /**
   * 页眉装饰（标题、作者、单位、邮箱、致谢）：整页居中、位于页面顶部。
   * 它们天生横跨栏间空白，算进"跨栏噪音"会让双栏首页被判成单栏。
   */
  const isHeaderFurniture = (it) =>
    it.base > headerTop &&
    Math.abs((it.x0 + it.x1) / 2 - centerX) < pageWidth * 0.07 &&
    it.str.trim().length < 90;

  // 通栏元素（摘要、跨栏图表）不参与分栏判定，否则会被当成“跨栏噪音”
  const narrow = items.filter((it) => it.x1 - it.x0 < pageWidth * 0.62);
  if (narrow.length < 12) return null;
  const total = narrow.length;
  const maxStraddle = Math.max(3, Math.round(total * 0.06));
  let best = null;

  for (let i = 6; i < 55; i++) {
    const x = (pageWidth * i) / 60;
    let left = 0, right = 0, straddle = 0;
    let leftMax = 0, rightMin = Infinity;
    for (const it of narrow) {
      if (it.x1 <= x) {
        left++;
        if (it.x1 > leftMax) leftMax = it.x1;
      } else if (it.x0 >= x) {
        right++;
        if (it.x0 < rightMin) rightMin = it.x0;
      } else if (!isHeaderFurniture(it)) straddle++;
    }
    if (left < total * 0.15 || right < total * 0.15) continue;
    if (straddle > maxStraddle) continue;
    const band = rightMin - leftMax;
    if (band < 6) continue;
    const score = band + Math.min(left, right) * 0.15;
    if (!best || score > best.score) best = { score, x: (leftMax + rightMin) / 2 };
  }
  return best ? best.x : null;
}

/** 把同一栏的 item 聚成行 */
function buildLines(items) {
  const sorted = [...items].sort((a, b) => (Math.abs(a.base - b.base) > 0.1 ? b.base - a.base : a.x0 - b.x0));
  const lines = [];
  let cur = null;

  for (const it of sorted) {
    if (cur) {
      const tol = Math.max(0.45 * Math.max(cur.size, it.size), 1.1);
      // 同一行内的字距不会超过约 2 个字宽；再大就是图上标签/表格列，不能并进同一行
      const notFarX = it.x0 < cur.x1 + 2.4 * Math.max(cur.size, it.size);
      if (Math.abs(it.base - cur.base) <= tol && notFarX) {
        cur.items.push(it);
        cur.base = Math.max(cur.base, it.base);
        cur.size = Math.max(cur.size, it.size);
        cur.x0 = Math.min(cur.x0, it.x0);
        cur.x1 = Math.max(cur.x1, it.x1);
        cur.top = Math.max(cur.top, it.top);
        cur.bottom = Math.min(cur.bottom, it.bottom);
        continue;
      }
    }
    cur = {
      items: [it],
      base: it.base,
      size: it.size,
      x0: it.x0,
      x1: it.x1,
      top: it.top,
      bottom: it.bottom,
    };
    lines.push(cur);
  }

  for (const ln of lines) {
    ln.items.sort((a, b) => a.x0 - b.x0);
    let text = '';
    let prev = null;
    for (const it of ln.items) {
      if (prev) {
        const gap = it.x0 - prev.x1;
        const needSpace =
          gap > 0.22 * Math.max(prev.size, it.size) &&
          !/\s$/.test(text) &&
          !/^\s/.test(it.str);
        if (needSpace) text += ' ';
      }
      text += it.str;
      prev = it;
    }
    ln.text = text.replace(/\s+/g, ' ').trim();
    ln.size = median(ln.items.map((i) => i.size)) || ln.size;
    ln.font = dominantFont(ln.items);
    // 上标/下标会把 base 抬高，用"文字最多的那一段"作为该行的基线锚点
    const anchor = ln.items.reduce(
      (a, b) => (b.str.trim().length > a.str.trim().length ? b : a),
      ln.items[0]
    );
    ln.base = anchor.base;
    ln.gaps = countBigGaps(ln.items);
  }

  // 同一基线上可能并排放着图注、图内标签与正文：按大间隙切成独立片段，
  // 否则「图里的 34-layer plain」会被拼进右栏正文。
  const out = [];
  for (const ln of lines) {
    if (!ln.text) continue;
    const segs = splitByBigGaps(ln);
    if (segs.length === 1) out.push(ln);
    else out.push(...segs);
  }
  return out;
}

/** 按行内大间隙切段：只有两侧字号明显不同（图注 vs 图内标签）或隔得极远时才切 */
function splitByBigGaps(line) {
  const segs = [];
  let cur = [];
  for (const it of line.items) {
    if (!cur.length) {
      cur.push(it);
      continue;
    }
    const prev = cur[cur.length - 1];
    const gap = it.x0 - prev.x1;
    const refSize = Math.max(prev.size, it.size);
    const sizeDiff = Math.abs(prev.size - it.size) / refSize;
    const tooFar = gap > 6 * refSize;
    if (gap > 1.8 * refSize && (sizeDiff > 0.08 || tooFar)) {
      segs.push(cur);
      cur = [it];
    } else {
      cur.push(it);
    }
  }
  if (cur.length) segs.push(cur);
  if (segs.length <= 1) return [line];

  return segs.map((items) => {
    let text = '';
    let prev = null;
    for (const it of items) {
      if (prev) {
        const gap = it.x0 - prev.x1;
        if (gap > 0.22 * Math.max(prev.size, it.size) && !/\s$/.test(text) && !/^\s/.test(it.str)) text += ' ';
      }
      text += it.str;
      prev = it;
    }
    const seg = {
      items,
      text: text.replace(/\s+/g, ' ').trim(),
      base: line.base,
      size: median(items.map((i) => i.size)) || line.size,
      font: dominantFont(items),
      x0: items[0].x0,
      x1: items[items.length - 1].x1,
      top: Math.max(...items.map((i) => i.top)),
      bottom: Math.min(...items.map((i) => i.bottom)),
    };
    seg.gaps = countBigGaps(items);
    return seg;
  }).filter((s) => s.text);
}

/** 行内的大空白（表格列分隔会形成多个） */
function countBigGaps(items) {
  let n = 0;
  for (let i = 1; i < items.length; i++) {
    const gap = items[i].x0 - items[i - 1].x1;
    if (gap > 2.5 * Math.max(items[i].size, items[i - 1].size)) n++;
  }
  return n;
}

/** 行内出现次数最多的字体，用于识别标题/图表说明 */
function dominantFont(items) {
  const counts = new Map();
  for (const it of items) {
    if (!it.font) continue;
    const w = it.str.trim().length;
    counts.set(it.font, (counts.get(it.font) || 0) + w);
  }
  let best = '';
  let bestN = -1;
  for (const [f, n] of counts) {
    if (n > bestN) {
      bestN = n;
      best = f;
    }
  }
  return best;
}

/** 本页主字号（按字符数加权的中位数） */
function dominantSize(items) {
  const pairs = items
    .map((it) => ({ v: Math.round(it.size * 10) / 10, w: Math.max(1, it.str.trim().length) }))
    .sort((a, b) => a.v - b.v);
  const total = pairs.reduce((s, p) => s + p.w, 0);
  let acc = 0;
  for (const p of pairs) {
    acc += p.w;
    if (acc >= total / 2) return p.v;
  }
  return 10;
}

/** 全部为正文行时估计「行距 / 字号」比，兼容 1.0 / 1.5 / 2.0 倍行距 */
function estimateLeadRatio(groups) {
  const ratios = [];
  for (const g of groups) {
    const lines = g.lines;
    for (let i = 1; i < lines.length; i++) {
      const d = lines[i - 1].base - lines[i].base;
      const s = Math.max(lines[i - 1].size, lines[i].size, 1);
      if (d > 0 && d < s * 4) ratios.push(d / s);
    }
  }
  const m = median(ratios);
  return m > 0.85 && m < 3 ? m : 1.28;
}

/** 把小字（图表标注 / 表格小字）聚成区域，避免图里每个标签都变成一个段落 */
function clusterSmallLines(lines, dominant) {
  const SMALL_RATIO = 0.78;
  const small = [];
  const rest = [];
  for (const ln of lines) {
    if (ln.size / dominant < SMALL_RATIO) small.push(ln);
    else rest.push(ln);
  }
  if (small.length < 3) return { small: [], rest: lines };

  small.sort((a, b) => b.base - a.base);
  const used = new Array(small.length).fill(false);
  const clusters = [];

  for (let i = 0; i < small.length; i++) {
    if (used[i]) continue;
    const queue = [i];
    used[i] = true;
    const members = [];
    while (queue.length) {
      const idx = queue.pop();
      const a = small[idx];
      members.push(a);
      for (let j = 0; j < small.length; j++) {
        if (used[j]) continue;
        const b = small[j];
        const vGap = Math.min(Math.abs(a.base - b.base), Math.abs(a.top - b.bottom), Math.abs(b.top - a.bottom));
        // 图里的标注本身就散，横向容差按字号放大
        const hTol = 5 * Math.max(a.size, b.size);
        const hNear = b.x0 < a.x1 + hTol && b.x1 > a.x0 - hTol;
        if (vGap < 3.2 * Math.max(a.size, b.size) && hNear) {
          used[j] = true;
          queue.push(j);
        }
      }
    }
    clusters.push(members);
  }

  // 成片的算图表文字；零散的要区分：极小的仍是图表标注，接近正文的（脚注）放回正文
  const isolated = [];
  const regions = [];
  for (const c of clusters) {
    if (c.length >= 3) regions.push(c);
    else if (c.length && c[0].size / dominant < 0.7) regions.push(c);
    else isolated.push(...c);
  }
  return { regions, rest: rest.concat(isolated).sort((a, b) => b.base - a.base) };
}

/** 小字区域 → 一个块 */
function regionToBlock(members) {
  const sorted = [...members].sort((a, b) => b.base - a.base || a.x0 - b.x0);
  const text = sorted.map((m) => m.text).join(' ').replace(/\s+/g, ' ').trim();
  return {
    text,
    x0: Math.min(...members.map((m) => m.x0)),
    x1: Math.max(...members.map((m) => m.x1)),
    yTop: Math.max(...members.map((m) => m.top)),
    yBottom: Math.min(...members.map((m) => m.bottom)),
    size: median(members.map((m) => m.size)) || 8,
    font: '',
    kind: 'annotation',
  };
}

const TERMINAL = /[.!?。！？:：;；,，)\]）】"'"'”’]$/;

/** 行 → 段落块。marginX0 / marginX1 是该栏正文的稳健左右边界 */
function mergeIntoBlocks(lines, bounds, leadRatio, opts = {}) {
  const blocks = [];
  if (!lines.length) return blocks;

  const gapRatio = leadRatio * 1.2;
  const marginX0 = opts.marginX0 ?? Math.min(...lines.map((l) => l.x0));
  const marginX1 = opts.marginX1 ?? Math.max(...lines.map((l) => l.x1));

  let cur = null;
  let prev = null;

  const flush = () => {
    if (!cur) return;
    const text = cur.text.replace(/\s+/g, ' ').trim();
    if (text.length >= 2) {
      blocks.push({
        text,
        x0: cur.x0,
        x1: cur.x1,
        yTop: cur.yTop,
        yBottom: cur.yBottom,
        size: cur.size,
        kind: 'body',
        gaps: cur.gaps,
        from: cur.gis.length ? Math.min(...cur.gis) : undefined,
        to: cur.gis.length ? Math.max(...cur.gis) : undefined,
      });
    }
    cur = null;
  };

  for (const ln of lines) {
    if (!cur) {
      cur = { text: ln.text, x0: ln.x0, x1: ln.x1, yTop: ln.top, yBottom: ln.bottom, size: ln.size, font: ln.font, gaps: ln.gaps, lines: 1, gis: [ln.gi] };
      prev = ln;
      continue;
    }

    const baseGap = prev.base - ln.base;
    const indent = ln.x0 - marginX0;
    const prevFilled = Math.abs(prev.x1 - marginX1) < Math.max(4, 0.6 * ln.size);
    const sizeDiff = Math.abs(ln.size - prev.size);
    const sizeJump = sizeDiff > 1.0 && sizeDiff / Math.max(ln.size, prev.size, 1) > 0.1;
    const fontJump = Boolean(ln.font && prev.font && ln.font !== prev.font);
    const startsNew =
      /^([•·▪◦‣\-–—*]|\(?\d{1,2}[.)]|[ivxIVX]{1,4}[.)]|[A-Z][.)])\s/.test(ln.text) ||
      /^(Abstract|ABSTRACT|Introduction|INTRODUCTION|References|REFERENCES|Acknowledg|Appendix|APPENDIX)\b/.test(ln.text);

    const refSize = Math.max(prev.size, ln.size, 1);
    const bigLeading = baseGap > gapRatio * refSize;
    // 只在一句话结束时断段是不够的：正文里句号后面本来就跟下一句。
    // 必须同时看到"行距比平时更大"，才认为换了段落（无缩进的排版靠这个切）
    const sentenceBreak =
      TERMINAL.test(prev.text) && /^[A-Z0-9(]/.test(ln.text) && baseGap > leadRatio * refSize * 1.12;
    const indented = indent > 0.55 * ln.size && prevFilled && !/-$/.test(prev.text);

    let newBlock = false;
    if (sizeJump || fontJump) newBlock = true;
    else if (bigLeading) newBlock = true;
    else if (indented) newBlock = true;
    else if (sentenceBreak) newBlock = true;
    else if (startsNew && baseGap > leadRatio * refSize) newBlock = true;

    if (newBlock) {
      flush();
      cur = { text: ln.text, x0: ln.x0, x1: ln.x1, yTop: ln.top, yBottom: ln.bottom, size: ln.size, font: ln.font, gaps: ln.gaps, lines: 1, gis: [ln.gi] };
    } else {
      const ptext = cur.text;
      if (/-$/.test(ptext) && /^[a-z]/.test(ln.text)) {
        cur.text = ptext.slice(0, -1) + ln.text;
      } else if (/[A-Za-z,;:]$/.test(ptext) || /^[A-Za-z0-9(]/.test(ln.text)) {
        cur.text = ptext + ' ' + ln.text;
      } else {
        cur.text = ptext + ln.text;
      }
      cur.x0 = Math.min(cur.x0, ln.x0);
      cur.x1 = Math.max(cur.x1, ln.x1);
      cur.yTop = Math.max(cur.yTop, ln.top);
      cur.yBottom = Math.min(cur.yBottom, ln.bottom);
      cur.size = Math.max(cur.size, ln.size);
      cur.gaps = Math.max(cur.gaps || 0, ln.gaps || 0);
      if (ln.gi) cur.gis.push(ln.gi);
      cur.lines++;
    }
    prev = ln;
  }
  flush();

  return blocks.filter((b) => {
    const t = b.text.trim();
    if (t.length < 3) return false;
    if (/^[\d\s.\-–—|/]+$/.test(t)) return false;
    if (!/[A-Za-z\u4e00-\u9fa5]/.test(t)) return false;
    return true;
  });
}

/** 后处理：把被公式 / 分栏 / 字号抖动切开的段落接回去 */
function mergeFragments(blocks, leadRatio) {
  const out = [];
  for (const b of blocks) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(b);
      continue;
    }
    const sizeOk = Math.abs(prev.size - b.size) / Math.max(prev.size, b.size, 1) < 0.12;
    const gap = prev.yBottom - b.yTop; // 上一块底部与下一块顶部的垂直距离
    const near = gap > -1.2 * b.size && gap < leadRatio * b.size * 1.7;
    const prevOpen = !TERMINAL.test(prev.text.trim());
    // 上一块没写完一句、下一块既没缩进也不是编号列表，且明显是"接着上一句"（小写或 1st/2nd 这类）
    const continues = /^[a-z(]/.test(b.text) || /^\d{1,2}(?:st|nd|rd|th)\b/i.test(b.text);
    // 以标点开头的块，百分百是上一块被切掉的后半截
    const orphanPunct = /^[.,;:!?)\]]/.test(b.text);
    const listLike = /^([•·▪◦‣\-–—*]|\(?\d{1,2}[.)])\s/.test(b.text);
    const nextCont = (prevOpen && continues && !listLike && sizeOk && near) || (orphanPunct && sizeOk && near);
    const hyphenJoin = /-$/.test(prev.text) && /^[a-z]/.test(b.text) && near;

    if ((nextCont || hyphenJoin) && prev.text.length + b.text.length < 5000) {
      prev.text = hyphenJoin
        ? prev.text.slice(0, -1) + b.text
        : `${prev.text} ${b.text}`.replace(/\s+/g, ' ');
      prev.x0 = Math.min(prev.x0, b.x0);
      prev.x1 = Math.max(prev.x1, b.x1);
      prev.yTop = Math.max(prev.yTop, b.yTop);
      prev.yBottom = Math.min(prev.yBottom, b.yBottom);
      continue;
    }
    out.push(b);
  }
  return out;
}

/** 页面分析：字形 → 分栏 → 行 → 小字区域。两种切分模式（规则 / AI）共用 */
function analyzePage(textContent, pageWidth, pageHeight) {
  const all = collectItems(textContent);
  if (!all.length) return null;

  // 旋转文字不进正文流水线（否则会混进段落、撑坏框），单独留给「按区域」兜底
  const items = [];
  const turnedItems = [];
  for (const it of all) (it.rot ? turnedItems : items).push(it);
  if (!items.length) return null;

  const dominant = dominantSize(items);
  const gutter = detectGutter(items, pageWidth, pageHeight);
  const edgeTop = pageHeight * 0.945;
  const edgeBottom = pageHeight * 0.055;

  const inEdgeNoise = (it) => {
    if (it.top < edgeBottom && it.str.trim().length < 60) return true;
    if (it.bottom > edgeTop && it.str.trim().length < 60) return true;
    return false;
  };

  const usable = items.filter((it) => !inEdgeNoise(it));
  if (!usable.length) return null;

  const groups = [];
  if (!gutter) {
    groups.push({ lines: buildLines(usable), col: 0, wide: false });
  } else {
    const left = usable.filter((it) => it.x1 <= gutter);
    const right = usable.filter((it) => it.x0 >= gutter);
    const wide = usable.filter((it) => it.x1 > gutter && it.x0 < gutter);
    for (const [idx, group] of [left, right].entries()) {
      if (!group.length) continue;
      groups.push({ lines: buildLines(group), col: idx, wide: false });
    }
    if (wide.length) groups.push({ lines: buildLines(wide), col: -1, wide: true });
  }

  // 小字区域（图表文字）单独拎出来，不参与段落合并，也不送给模型
  const annotationBlocks = [];
  for (const g of groups) {
    const { regions, rest } = clusterSmallLines(g.lines, dominant);
    g.lines = rest;
    if (regions) {
      for (const members of regions) {
        annotationBlocks.push({ ...regionToBlock(members), col: g.col });
      }
    }
  }

  return { dominant, gutter, groups, leadRatio: estimateLeadRatio(groups), annotationBlocks, items: usable, turnedItems };
}

/** 对外暴露的行结构（AI 分段与手动分段都用它） */
function toPublicLines(seq) {
  return seq.map((s, i) => ({
    i: i + 1,
    text: s.ln.text,
    size: Math.round(s.ln.size * 10) / 10,
    col: s.col === -1 ? 'W' : s.col === 0 ? 'L' : 'R',
    x0: s.ln.x0,
    x1: s.ln.x1,
    yTop: s.ln.top,
    yBottom: s.ln.bottom,
    font: s.ln.font,
  }));
}

/** 把每栏的行按阅读顺序拉平（左栏 → 右栏，通栏行按 y 插回） */
function flattenLines(A) {
  const narrow = [];
  const wide = [];
  for (const g of A.groups) {
    const sorted = [...g.lines].sort((a, b) => b.base - a.base);
    for (const ln of sorted) {
      if (g.col === -1) wide.push(ln);
      else narrow.push({ ln, col: g.col });
    }
  }
  const seq = narrow.slice();
  for (const ln of wide) {
    let idx = seq.findIndex((s) => s.ln.base < ln.base);
    if (idx === -1) idx = seq.length;
    seq.splice(idx, 0, { ln, col: -1 });
  }
  return seq;
}

/**
 * 主入口：规则切分
 * @returns {{blocks: Array, columns: number, stats: object}}
 */
function extractPageBlocks(textContent, pageWidth, pageHeight) {
  const A = analyzePage(textContent, pageWidth, pageHeight);
  if (!A) return { blocks: [], columns: 1, stats: { annotations: 0 } };

  const { groups, dominant, gutter, leadRatio, annotationBlocks } = A;

  // 压平行 + 打上页内阅读序号：块的 from/to 都基于这套序号，手动分段也用它
  const seq = flattenLines(A);
  seq.forEach((s, i) => {
    s.ln.gi = i + 1;
  });
  const lines = toPublicLines(seq);

  // 每栏用稳健边距合并成段
  const colBlocks = [];
  for (const g of groups) {
    if (!g.lines.length) continue;
    const weights = g.lines.map((l) => Math.max(1, l.text.length));
    const opts = {
      marginX0: weightedMode(g.lines.map((l) => l.x0), weights, 1.5),
      marginX1: weightedMode(g.lines.map((l) => l.x1), weights, 2),
    };
    const bounds = {
      x0: Math.min(...g.lines.map((l) => l.x0)),
      x1: Math.max(...g.lines.map((l) => l.x1)),
    };
    let bs = mergeIntoBlocks(g.lines, bounds, leadRatio, opts);
    bs = mergeFragments(bs, leadRatio);
    for (const b of bs) {
      b.col = g.col;
      b.kind = classifyBlock(b, dominant);
      colBlocks.push(b);
    }
  }

  markFloatingLabels(colBlocks, leadRatio, dominant);

  let ordered;
  if (!gutter) {
    ordered = colBlocks;
  } else {
    const narrow = colBlocks.filter((b) => b.col !== -1).sort((a, b) => (a.col === b.col ? b.yTop - a.yTop : a.col - b.col));
    const wide = colBlocks.filter((b) => b.col === -1).sort((a, b) => b.yTop - a.yTop);
    ordered = narrow;
    for (const wb of wide) {
      let idx = ordered.findIndex((b) => b.yTop < wb.yTop);
      if (idx === -1) idx = ordered.length;
      ordered.splice(idx, 0, wb);
    }
  }

  const blocks = toPublicBlocks(ordered, annotationBlocks);

  return {
    blocks,
    columns: gutter ? 2 : 1,
    stats: { annotations: annotationBlocks.length, dominant },
    lines,
    preBlocks: annotationBlocks,
    items: A.items || [],
    turnedItems: A.turnedItems || [],
    gutter,
  };
}

/**
 * 取矩形区域内的文字，重排成一段。
 * 不依赖"行"和"栏"的判定：区域里有什么文字就是什么文字。
 * - 区域跨栏时：先读完整左栏，再读完整右栏（论文的正常阅读顺序）
 * - 同一栏内：按视觉行自上而下，行内从左到右
 * @param {Array} items  页面字符项（含 x0/x1/top/bottom/base/size）
 * @param {{x0:number,x1:number,yTop:number,yBottom:number}} rect  PDF 坐标，y 向上
 * @param {{gutter?:number, allowTurned?:boolean}} opts  页面栏间空白位置；allowTurned 时才取旋转文字
 */
function textInRect(items, rect, opts = {}) {
  const gutter = opts.gutter;
  const allowTurned = Boolean(opts.allowTurned);
  const picked = [];
  for (const it of items || []) {
    if (!it.str || !it.str.trim()) continue;
    if (it.rot && !allowTurned) continue;
    const cx = (it.x0 + it.x1) / 2;
    const cy = (it.top + it.bottom) / 2;
    if (cx >= rect.x0 && cx <= rect.x1 && cy >= rect.yBottom && cy <= rect.yTop) picked.push(it);
  }
  if (!picked.length) return null;

  /** 把一组字符项按 视觉行 → 片段 的顺序拼成文本 */
  const assemble = (list) => {
    const sorted = list.slice().sort((a, b) => b.base - a.base || a.x0 - b.x0);
    const bands = [];
    for (const it of sorted) {
      const last = bands[bands.length - 1];
      if (last && Math.abs(last.base - it.base) < 0.55 * Math.max(last.size, it.size)) last.items.push(it);
      else bands.push({ base: it.base, size: it.size, items: [it] });
    }

    const parts = [];
    for (const band of bands) {
      const arr = band.items.slice().sort((a, b) => a.x0 - b.x0);
      let cur = [];
      for (const it of arr) {
        const prev = cur[cur.length - 1];
        if (prev && it.x0 - prev.x1 > 2.2 * Math.max(prev.size, it.size)) {
          parts.push(cur);
          cur = [];
        }
        cur.push(it);
      }
      if (cur.length) parts.push(cur);
    }

    let out = '';
    for (const part of parts) {
      let seg = '';
      let prev = null;
      for (const it of part) {
        if (prev) {
          const gap = it.x0 - prev.x1;
          if (gap > 0.22 * Math.max(prev.size, it.size) && !/\s$/.test(seg) && !/^\s/.test(it.str)) seg += ' ';
        }
        seg += it.str;
        prev = it;
      }
      seg = seg.replace(/\s+/g, ' ').trim();
      if (!seg) continue;
      if (!out) out = seg;
      else if (/-$/.test(out) && /^[a-z]/.test(seg)) {
        // 复合词断行（existence-and- + label）保留连字符，普通断词（informa- + tion）去掉
        const compound = /[A-Za-z]-[A-Za-z]+-$/.test(out);
        out = (compound ? out : out.slice(0, -1)) + seg;
      } else out += ' ' + seg;
    }
    return out;
  };

  // 区域横跨两栏：按栏切开，左栏读完再读右栏
  let text;
  if (gutter && rect.x0 < gutter && rect.x1 > gutter) {
    const left = picked.filter((it) => (it.x0 + it.x1) / 2 < gutter);
    const right = picked.filter((it) => (it.x0 + it.x1) / 2 >= gutter);
    text = [assemble(left), assemble(right)].filter(Boolean).join(' ');
  } else {
    text = assemble(picked);
  }
  if (!text) return null;

  const box = {
    x0: Math.min(...picked.map((i) => i.x0)),
    x1: Math.max(...picked.map((i) => i.x1)),
    yTop: Math.max(...picked.map((i) => i.top)),
    yBottom: Math.min(...picked.map((i) => i.bottom)),
    size: median(picked.map((i) => i.size)) || 10,
  };
  return { text, ...box, count: picked.length };
}

/** 公共块结构 + 把图表文字按纵向位置并回顺序 */
function toPublicBlocks(ordered, annotationBlocks = []) {
  const list = ordered.slice();
  for (const ab of [...annotationBlocks].sort((a, b) => b.yTop - a.yTop)) {
    let idx = list.findIndex((b) => b.yTop < ab.yTop);
    if (idx === -1) idx = list.length;
    list.splice(idx, 0, ab);
  }
  return list.map((b, i) => ({
    order: i,
    text: b.text,
    x: b.x0,
    y: b.yTop,
    w: Math.max(b.x1 - b.x0, 1),
    h: Math.max(b.yTop - b.yBottom, 1),
    col: b.col,
    size: b.size,
    kind: b.kind || 'body',
    from: b.from,
    to: b.to,
    groupIndex: b.groupIndex,
    areaIndex: b.areaIndex,
    gIndex: b.gIndex,
    // 合并过的段落会留下多个行区间；翻译页用它判断要不要显示「顺序」入口
    spans: Array.isArray(b.spans) ? b.spans.map((sp) => [...sp]) : null,
    isArea: Boolean(b.isArea),
    canFit: Boolean(b.canFit),
    pages: b.pages,
    extraBoxes: b.extraBoxes,
  }));
}

/**
 * 供 AI 分段使用：只吐「行」，由模型决定怎么合并
 * @returns {{lines: Array, columns: number, preBlocks: Array, dominant: number}}
 */
function extractPageLines(textContent, pageWidth, pageHeight) {
  const A = analyzePage(textContent, pageWidth, pageHeight);
  if (!A) return { lines: [], columns: 1, preBlocks: [], dominant: 10 };

  const seq = flattenLines(A);
  seq.forEach((s, i) => {
    s.ln.gi = i + 1;
  });
  return {
    lines: toPublicLines(seq),
    columns: A.gutter ? 2 : 1,
    preBlocks: A.annotationBlocks,
    dominant: A.dominant,
    items: A.items || [],
    turnedItems: A.turnedItems || [],
    gutter: A.gutter,
  };
}

const KINDS = new Set(['body', 'heading', 'caption', 'formula', 'annotation']);

/**
 * 按模型返回的分组构造块（模型只给行号区间，原文由这里拼，保证不被改写）
 * @param {Array} lines extractPageLines 的结果
 * @param {Array<{from:number,to:number,type:string}>} groups
 */
function buildBlocksFromGroups(lines, groups, dominant = 10, opts = {}) {
  const out = [];
  for (const g of groups) {
    const from = Math.max(1, Math.min(Number(g.from) || 0, lines.length));
    const to = Math.max(1, Math.min(Number(g.to) || 0, lines.length));
    if (!from || !to || to < from) continue;
    const part = lines.slice(from - 1, to);
    if (!part.length) continue;

    // 模型偶尔会把标题和正文并成一段：按字号/栏位不连续处再切开，避免"过度合并"。
    // 手动编辑时 trust=true，改成严格按用户给的区间走。
    const runs = [];
    let run = [part[0]];
    for (let k = 1; k < part.length; k++) {
      const a = part[k - 1];
      const b = part[k];
      const sizeJump = Math.abs(a.size - b.size) / Math.max(a.size, b.size, 1) > 0.08;
      const colJump = a.col !== b.col;
      if (!opts.trust && (sizeJump || colJump)) {
        runs.push(run);
        run = [b];
      } else {
        run.push(b);
      }
    }
    runs.push(run);

    for (const seg of runs) {
      const block = blockFromLines(seg, g.type, dominant);
      if (block) out.push(block);
    }
  }
  return out;
}

function blockFromLines(part, type, dominant, opts = {}) {
  let text = '';
  for (let k = 0; k < part.length; k++) {
    const ln = part[k];
    if (k === 0) {
      text = ln.text;
      continue;
    }
    if (/-$/.test(text) && /^[a-z]/.test(ln.text)) text = text.slice(0, -1) + ln.text;
    else if (/[A-Za-z,;:]$/.test(text) || /^[A-Za-z0-9(]/.test(ln.text)) text = text + ' ' + ln.text;
    else text = text + ln.text;
  }

  const kind = KINDS.has(type) ? type : 'body';
  const size = median(part.map((l) => l.size));
  const b = {
    text: text.replace(/\s+/g, ' ').trim(),
    x0: Math.min(...part.map((l) => l.x0)),
    x1: Math.max(...part.map((l) => l.x1)),
    yTop: Math.max(...part.map((l) => l.yTop)),
    yBottom: Math.min(...part.map((l) => l.yBottom)),
    size,
    // opts.reclassify === false：沿用分组时记下的类型。
    // 手动编辑重建必须这样做，否则同一个段落每次重建都可能被重新判成公式/标题，块数忽多忽少。
    kind: kind === 'body' && opts.reclassify !== false ? classifyBlock({ text, size }, dominant) : kind,
    col: part[0].col === 'W' ? -1 : part[0].col === 'L' ? 0 : 1,
    from: part[0].i,
    to: part[part.length - 1].i,
  };
  return b.text.length >= 2 ? b : null;
}

/**
 * 按"多段行区间"构造块：手动合并时，一个段落可以由不连续的几段行组成
 * （比如被公式隔开的两半），这样合并不必把公式吞进来。
 * @param {Array} lines 页内行
 * @param {Array<{spans: Array<[number,number]>, type: string}>} groups
 */
function buildBlocksFromSpans(lines, groups, dominant = 10) {
  const out = [];
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];

    // 区域块：文本是框内字符的直接重排，不由行拼装
    if (g.area) {
      const a = g.area;
      const text = String(a.text || '').trim();
      if (text.length < 2) continue;
      out.push({
        text,
        x0: a.x0,
        x1: a.x1,
        yTop: a.yTop,
        yBottom: a.yBottom,
        size: a.size || 10,
        kind: g.type || 'body',
        col: -2,
        gIndex: gi,
        isArea: true,
        pages: g.pages,
        canFit: true,
        // 合并来的段落会在多个位置各留一个框
        extraBoxes: Array.isArray(a.extraBoxes) ? a.extraBoxes : null,
      });
      continue;
    }

    const parts = [];
    for (const [a, b] of g.spans || []) {
      for (let i = a; i <= b; i++) {
        const ln = lines[i - 1];
        if (ln) parts.push(ln);
      }
    }
    if (!parts.length) continue;
    const b = blockFromLines(parts, g.type || 'body', dominant, { reclassify: false });
    if (b) {
      b.from = Math.min(...g.spans.map((s) => s[0]));
      b.to = Math.max(...g.spans.map((s) => s[1]));
      b.spans = (g.spans || []).map((s) => [...s]);
      b.gIndex = gi;
      // 用户手动拖过的框：坐标以它为准，不再自动贴合文字
      if (g.box) {
        b.x0 = g.box.x0;
        b.x1 = g.box.x1;
        b.yTop = g.box.yTop;
        b.yBottom = g.box.yBottom;
        b.canFit = true;
      }
      out.push(b);
    }
  }
  return out;
}

/** 块级分类：只影响展示样式与"是否值得翻译"，不影响切分 */
function classifyBlock(b, dominant) {
  const t = b.text.trim();
  if (/^(figure|fig\.|table|tab\.|algorithm)\s*\d/i.test(t)) return 'caption';
  if (b.size > dominant * 1.12 && t.length < 90) return 'heading';
  if (b.size > dominant * 1.05 && /^\d+(\.\d+)*\s+\S/.test(t) && t.length < 120) return 'heading';
  if (isFormulaLike(t)) return 'formula';
  return 'body';
}

/**
 * 独立成行的公式：几乎没有完整英文单词，却由单字母变量和数学符号堆起来。
 * 这类块送进翻译只会得到 `[z]`、`{z}` 这种垃圾，直接跳过。
 */
function isFormulaLike(t) {
  if (t.length > 110) return false;
  const words = t.match(/[A-Za-z]{4,}/g) || [];
  if (words.length >= 2) return false; // 有两个以上英文单词，基本是句子
  const singleLetters = (t.match(/\b[A-Za-z]\b/g) || []).length;
  const math = (t.match(/[=+\-−×÷<>≤≥∈∉∑√±·⋅⁄|^_{}()[\]]/g) || []).length;
  if (words.length === 0) return singleLetters >= 1 || math >= 2;
  return singleLetters >= 3 && math >= 2;
}

/**
 * 图 / 表内部的短标注：上下都是大片空白，且不像一句完整的话。
 * 这类文本逐条翻译毫无意义，标成 annotation 后不进右栏。
 */
function markFloatingLabels(blocks, leadRatio, dominant) {
  const byCol = new Map();
  for (const b of blocks) {
    if (!byCol.has(b.col)) byCol.set(b.col, []);
    byCol.get(b.col).push(b);
  }

  for (const list of byCol.values()) {
    list.sort((a, b) => b.yTop - a.yTop);
    for (let i = 0; i < list.length; i++) {
      const b = list[i];
      if (b.kind !== 'body') continue;
      const t = b.text.trim();
      if (t.length >= 70) continue;
      if (TERMINAL.test(t)) continue;
      if (b.size > dominant * 1.02) continue; // 可能是标题
      // 章节标签（Abstract / References…）本来就孤零零一行，不能当图内标注
      if (/^(abstract|introduction|related work|method|methods|approach|experiment|experiments|result|results|discussion|conclusion|conclusions|references|acknowledg|appendix|keywords|index terms)\b/i.test(t)) continue;

      const above = i > 0 ? list[i - 1].yBottom - b.yTop : Infinity;
      const below = i < list.length - 1 ? b.yBottom - list[i + 1].yTop : Infinity;
      const isolated = above > leadRatio * b.size * 1.9 && below > leadRatio * b.size * 1.9;
      if (isolated) b.kind = 'annotation';
    }
  }
  return blocks;
}

/** 去掉跨页重复的页眉页脚 */
function dropRunningHeaders(pages) {
  const counts = new Map();
  const norm = (t) => t.replace(/\d+/g, '#').slice(0, 80);
  for (const p of pages) {
    const visible = p.blocks.filter((b) => b.kind !== 'annotation');
    const cands = [visible[0], visible[visible.length - 1]].filter(Boolean);
    for (const b of cands) {
      if (!b || b.text.length > 90) continue;
      const key = norm(b.text);
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  const threshold = Math.max(2, Math.min(3, Math.ceil(pages.length * 0.5)));
  const repeated = new Set();
  for (const [k, v] of counts) if (v >= threshold) repeated.add(k);

  for (const p of pages) {
    const visible = p.blocks.filter((b) => b.kind !== 'annotation');
    const first = visible[0];
    const last = visible[visible.length - 1];
    p.blocks = p.blocks.filter((b) => {
      if (b !== first && b !== last) return true;
      if (b.text.length > 90) return true;
      return !repeated.has(norm(b.text));
    });
    p.blocks.forEach((b, i) => (b.order = i));
  }
}

export { extractPageBlocks, extractPageLines, buildBlocksFromGroups, buildBlocksFromSpans, toPublicBlocks, dropRunningHeaders, textInRect };

/**
 * 整篇 PDF → 论文库里的分块格式（精读页上传 PDF 时用）。
 *
 * 和翻译页写进 papers.blocks_json 的结构完全一致：
 * { page: 0 基, order: 全局阅读顺序, text, x, y, w, h, kind }
 * 坐标是 PDF 用户空间（原点左下），所以 y 是"从页面底部往上量"的 top。
 *
 * @param {object} doc pdf.js 的 PDFDocumentProxy
 * @param {{onProgress?: (done:number,total:number)=>void}} opts
 */
export async function extractDocumentBlocks(doc, { onProgress } = {}) {
  const total = doc.numPages;
  const pages = [];
  for (let i = 1; i <= total; i += 1) {
    if (onProgress) onProgress(i, total);
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    let res = { blocks: [] };
    try {
      res = extractPageBlocks(content, viewport.width, viewport.height);
    } catch {
      res = { blocks: [] };
    }
    pages.push({ num: i, w: viewport.width, h: viewport.height, blocks: res.blocks || [] });
    if (page.cleanup) page.cleanup();
  }

  // 跨页重复的页眉页脚先被去掉，再把每页的块压平成全局顺序
  dropRunningHeaders(pages);

  const out = [];
  for (const p of pages) {
    for (const b of p.blocks) {
      const text = String(b.text || '').replace(/\s+/g, ' ').trim();
      if (!text) continue;
      // 与翻译页保持一致：图内标注、独立公式不进论文库
      if (b.kind === 'annotation' || b.kind === 'formula') continue;
      out.push({
        page: p.num - 1,
        order: out.length,
        text,
        x: b.x0,
        y: b.yTop,
        w: Math.max(1, b.x1 - b.x0),
        h: Math.max(1, b.yTop - b.yBottom),
        kind: b.kind || 'body',
      });
    }
  }
  return out;
}
