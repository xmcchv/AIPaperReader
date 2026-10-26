/**
 * 纯文本工具：原文分段、精读 markdown 解析与渲染。
 * 抽成独立模块便于单测（不依赖 DOM）。
 */

export const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** 极简内联 markdown：**粗体**、*斜体*、`code`（输入已转义） */
export function inlineMd(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

// 章节标题识别。中文标题后面没有 \b 边界（\w 不含中文），所以关键字分支用显式后向断言；
// 数字编号分支要求「编号 1-2 位 + 大写字母或中文」，避免把「1 512 512」表格行、
// 「2015 classification」年份开头的正文、脚注行当成标题
const SECTION_RE =
  /^(?:\d{1,2}(?:\.\d{1,2})*\s*\.?\s+[A-Z\u4e00-\u9fff]|(?:摘要|abstract|引言|introduction|相关工作|related work|方法|methodology|method|实验|experiments?|结果|results|讨论|discussion|结论|conclusions?|局限|limitations?|参考文献|references)(?=$|[\s:：、.．,，)）]))/i;

/** 判断某一段是否是章节标题（用于原文区的视觉分层） */
export function isSectionTitle(para) {
  if (!para || para.length >= 90) return false;
  if (!SECTION_RE.test(para) && !/^[一二三四五六七八九十]+[、.]/.test(para)) return false;
  // SECTION_RE 带 i 标志，表格行（"18 layers 27.94"）和 "method error" 之类也会命中，这里收紧：
  // 编号标题后面必须紧跟大写字母或中文；非编号标题必须以大写字母或中文开头
  if (/^\d/.test(para)) {
    if (!/^\d{1,2}(?:\.\d{1,2})*\.?\s*[A-Z\u4e00-\u9fff]/.test(para)) return false;
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
    out.push(`<p>${para.map(inlineMd).join('')}</p>`);
    para = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (!line.trim()) {
      flushPara();
      flushList();
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
  flushList();
  flushPara();
  return out.join('');
}
