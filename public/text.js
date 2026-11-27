/**
 * 纯文本工具：原文分段、精读 markdown 解析与渲染。
 * 抽成独立模块便于单测（不依赖 DOM）。
 */

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * 极简内联 markdown：**粗体**、*斜体*、`code`。
 * 难点：A* / RRT* / Theta* / D* Lite 这类算法名里的星号不是强调标记，
 * 直接 replace 会把 A* … A* 配成一对斜体，把星号吃掉。
 * 策略：先把行内 code、转义星号、算法名星号换成占位符，再处理粗体/斜体，最后还原。
 */
export function inlineMd(text) {
  const escaped = escapeHtml(String(text ?? ''));
  const holds = [];
  const hold = (html) => {
    const key = `\u0000${holds.length}\u0000`;
    holds.push(html);
    return key;
  };

  let out = escaped.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${code}</code>`));
  // 转义的 \* 是字面星号
  out = out.replace(/\\\*/g, () => hold('*'));
  // 算法名 + 粗体结束连写：RRT*** = RRT* + **（后接标点或行尾）
  out = out.replace(/([A-Za-z])\*\*\*(?=$|[，。、：；）\s])/g, (_, ch) => `${ch}${hold('*')}**`);
  // 算法名星号：字母后跟单个 *（A* / RRT* / D* Lite），保护起来
  out = out.replace(/([A-Za-z])\*(?![A-Za-z*])/g, (_, ch) => `${ch}${hold('*')}`);

  out = out.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');

  return out.replace(/\u0000(\d+)\u0000/g, (_, i) => holds[Number(i)] ?? '');
}

/**
 * 把回答里的来源标记转成角标 HTML。输入是已渲染的 HTML 字符串。
 * 模型可能输出英文 [] 或中文【】，两种都认；网络来源加 .web 类。
 */
export function markAskCitations(html) {
  return String(html || '').replace(
    /(?:\[|【)(§[^\]【】\[]{1,24}|原文段落[^\]【】\[]{0,12}|选中片段|网络)(?:\]|】)/g,
    (whole, label) =>
      `<span class="ask-cite${label === '网络' ? ' web' : ''}" title="来源：${escapeHtml(label)}">${escapeHtml(label)}</span>`,
  );
}

// 章节标题识别。中文标题后面没有 \b 边界（\w 不含中文），所以关键字分支用显式后向断言；
// 数字编号分支要求「编号 1-2 位 + 大写字母或中文」，避免把「1 512 512」表格行、
// 「2015 classification」年份开头的正文、脚注行当成标题
// 编号支持阿拉伯数字(1 / 2.1)与罗马数字(I / II / IV)，学术论文常见罗马数字章节
const ROMAN = 'IVXLCDM';
const SECTION_RE = new RegExp(
  `^(?:(?:\\d{1,2}(?:\\.\\d{1,2})*\\.?|[${ROMAN}]{1,5}\\.|[A-Z]\\.)\\s+[A-Z\\u4e00-\\u9fff]` +
    `|(?:摘要|abstract|引言|introduction|相关工作|related work|方法|methodology|method|实验|experiments?|结果|results|讨论|discussion|结论|conclusions?|局限|limitations?|参考文献|references)(?=$|[\\s:：、.．,，)）—–-]))`,
  'i',
);

/** 判断某一段是否是章节标题（用于原文区的视觉分层） */
export function isSectionTitle(para) {
  if (!para || para.length >= 90) return false;
  if (!SECTION_RE.test(para) && !/^[一二三四五六七八九十]+[、.]/.test(para)) return false;
  // SECTION_RE 带 i 标志，表格行（"18 layers 27.94"）和 "method error" 之类也会命中，这里收紧：
  // 编号标题后面必须紧跟大写字母或中文；非编号标题必须以大写字母或中文开头
  const romanNum = /^[IVXLCDM]{1,5}\.\s/;
  if (/^\d/.test(para)) {
    if (!/^\d{1,2}(?:\.\d{1,2})*\.?\s*[A-Z\u4e00-\u9fff]/.test(para)) return false;
  } else if (romanNum.test(para)) {
    if (!new RegExp(`^[${ROMAN}]{1,5}\\.\\s+(?:[A-Z\\u4e00-\\u9fff]|\\d)`).test(para)) return false;
  } else if (!/^[\u4e00-\u9fff]/.test(para) && !/^[A-Z]/.test(para)) {
    return false;
  }
  // 折行的脚注/正文常在连字符处被切断，不是标题
  if (/[-‐‑]$/.test(para)) return false;
  // 纯英文的「标题」超过 4 个词，基本都是正文句子
  if (/^[A-Za-z]/.test(para) && para.split(/\s+/).length > 4) return false;
  if (/^\d/.test(para)) {
    const words = para.trim().split(/\s+/);
    if (words.length > 8) return false;
    // 去掉编号前缀再判断是不是一整句话（"3.4. Implementation" 里的句点属于编号）
    const rest = para.replace(/^\d{1,2}(?:\.\d{1,2})*\.?\s+/, '');
    if (/[.!?]\s+[A-Z]/.test(rest)) return false;
  }
  return true;
}

/** 块内多行合并成段落：章节标题独占一段，完整句子后断段，其余按软换行拼接 */
function mergeLines(lines) {
  const out = [];
  let buffer = '';
  let bufferIsTitle = false;
  const flush = () => {
    if (buffer) out.push(buffer);
    buffer = '';
    bufferIsTitle = false;
  };

  for (const line of lines) {
    const t = line.trim().replace(/^#{1,6}\s+/, '');
    if (!t) {
      flush();
      continue;
    }
    if (SECTION_RE.test(t) && t.length < 90) {
      flush();
      buffer = t;
      bufferIsTitle = true;
      continue;
    }
    if (!buffer) {
      buffer = t;
      continue;
    }
    if (bufferIsTitle) {
      out.push(buffer);
      buffer = t;
      bufferIsTitle = false;
      continue;
    }
    if (/[。！？.!?]$/.test(buffer) && buffer.length > 15) {
      out.push(buffer);
      buffer = t;
      continue;
    }
    buffer += /[a-z0-9]$/i.test(buffer) && /^[A-Za-z]/.test(t) ? ` ${t}` : t;
  }
  flush();
  return out;
}

/**
 * 把论文正文切成段落。
 * 先按空行分块，再在块内合并软换行（PDF 提取的文本常见一行一句）。
 */
export function splitParagraphs(raw) {
  const text = String(raw || '')
    .replace(/\r\n/g, '\n')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .trim();
  if (!text) return [];

  const parts = [];
  for (const block of text.split(/\n\s*\n+/)) {
    const lines = block.split('\n').map((s) => s.trim()).filter(Boolean);
    if (!lines.length) continue;
    parts.push(...mergeLines(lines));
  }
  return parts;
}

/** 把精读 markdown 按 ## 标题切成 section 数组 */
export function parseReading(md) {
  const sections = [];
  let current = { title: '', lines: [] };
  for (const line of String(md || '').split('\n')) {
    const m = line.match(/^#{1,4}\s+(.+?)\s*$/);
    if (m) {
      if (current.title || current.lines.some((l) => l.trim())) sections.push(current);
      current = { title: m[1].replace(/^[一二三四五六七]、\s*/, ''), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.title || current.lines.some((l) => l.trim())) sections.push(current);
  return sections.filter((s) => s.title || s.lines.some((l) => l.trim()));
}

/** section 的若干行 → HTML（段落 / 有序列表 / 无序列表） */
export function renderBlocks(lines) {
  const out = [];
  let list = [];
  let para = [];

  const flushList = () => {
    if (!list.length) return;
    const ordered = list.every((l) => /^\d+[.)]/.test(l));
    const items = list
      .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim())
      .filter(Boolean)
      .map((l) => `<li>${inlineMd(l)}</li>`)
      .join('');
    out.push(`<${ordered ? 'ol' : 'ul'}>${items}</${ordered ? 'ol' : 'ul'}>`);
    list = [];
  };
  const flushPara = () => {
    if (!para.length) return;
    // 保留行间换行：普通段落渲染时会被折叠成空格，多行公式（$$...$$）则需要它来分隔
    out.push(`<p>${para.map(inlineMd).join('\n')}</p>`);
    para = [];
  };

  let inFence = false;
  let fence = [];
  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (/^\s*```/.test(line)) {
      flushPara();
      flushList();
      if (inFence) {
        out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
        fence = [];
      }
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      fence.push(rawLine);
      continue;
    }
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flushPara();
      flushList();
      const level = Math.min(heading[1].length + 1, 6); // # → h2，给正文标题留 h1
      out.push(`<h${level}>${inlineMd(heading[2])}</h${level}>`);
      continue;
    }
    if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(line)) {
      flushPara();
      list.push(line.trim());
      continue;
    }
    if (line.startsWith('>')) {
      flushList();
      flushPara();
      out.push(`<p>${inlineMd(line.replace(/^>\s?/, ''))}</p>`);
      continue;
    }
    flushList();
    para.push(line.trim());
  }
  if (inFence && fence.length) out.push(`<pre><code>${escapeHtml(fence.join('\n'))}</code></pre>`);
  flushList();
  flushPara();
  return out.join('');
}
