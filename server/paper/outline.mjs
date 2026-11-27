/**
 * 论文章节结构解析（规则层 + LLM 整理层的混合入口）。
 *
 * 设计要点：
 * - 规则层负责切段落、识别标题候选、算段落区间——索引在这里算准，LLM 不碰数字。
 * - LLM 层只接收标题候选（带稳定 id h0/h1/...），返回层级/规范化标题/一句话小结，
 *   再用 id 映射回规则层已有的区间。LLM 输出有偏差也不会破坏锚点坐标。
 * - 无 API Key / demo 时降级为纯规则，source='rules'。
 */
import { isSectionTitle, splitParagraphs } from '../../public/text.js';
import { completeChat, LlmError } from '../shared/llm.mjs';

/** 从 "3.2.1" / 罗马数字 "IV" / 子节字母 "C." 里取层级与展示用编号 */
function parseNumber(text) {
  const raw = String(text || '').trim();
  // 单字母编号（A. / B. / C.）是子节，level=2。必须先于罗马数字判断——
  // C/D/L/M 也是罗马数字字符，但单个 C(=100)/D(=500) 不可能是章节号，
  // 否则会混进一级章节（SCAN-Planner 的 C/D 子节就是这样被误判的）。
  // 例外：I / V / X 作为单字母时是合法的罗马数字一级节。
  const sub = raw.match(/^([A-Z])\.\s+(.+)$/);
  if (sub && !['I', 'V', 'X'].includes(sub[1])) {
    return { number: sub[1], level: 2, rest: sub[2].trim() };
  }
  // 阿拉伯数字：多级（3.2.1）；罗马数字一级节：I / II / IV（单级）
  const m = raw.match(/^(\d{1,2}(?:\.\d{1,2}){0,3}\.?|[IVXLCDM]{1,5}\.)\s+(.+)$/);
  if (m) {
    const clean = m[1].replace(/\.+$/, '');
    return { number: clean, level: clean.split('.').length, rest: m[2].trim() };
  }
  return null;
}

/** 去掉标题里的编号与 markdown 前缀，得到纯标题文字 */
function cleanTitle(text, parsed) {
  let t = String(text || '').trim().replace(/^#{1,6}\s+/, '').trim();
  if (parsed) t = parsed.rest;
  return t.replace(/\s*[:：]\s*$/, '').trim();
}

/**
 * 规则层：从正文解析章节候选。纯函数，不调用模型。
 * @returns {{ sections: Array, sectionOf: number[], headings: Array, paragraphCount: number, source: 'rules' }}
 */
export function parseOutlineRules(rawText) {
  const paras = splitParagraphs(rawText);
  const sections = [];
  const headings = [];
  const sectionOf = new Array(paras.length).fill(-1);

  for (let i = 0; i < paras.length; i += 1) {
    const para = paras[i];
    const parsed = parseNumber(para);
    const titled = isSectionTitle(para);
    if (!titled && !parsed) continue;

    // 收紧编号标题：中文论文常见「2.4 自适应融合：两个分数经…」这种整句，
    // isSectionTitle 对中文长句判断偏松，这里按标题特征再筛一次。
    if (parsed) {
      const rest = parsed.rest;
      if (!rest || rest.length > 40) continue;
      // 含句子级标点（逗号/顿号/分号/句号）的是正文，不是标题
      if (/[，、；。！？,;.!?]/.test(rest)) continue;
      // 中文 rest 超过 16 字基本是描述句；英文按词数判断
      if (/[\u4e00-\u9fff]/.test(rest) ? rest.length > 16 : rest.split(/\s+/).length > 6) continue;
    }

    const level = parsed?.level ?? 1;
    const id = `s${sections.length + 1}`;
    const heading = {
      id: `h${headings.length}`,
      sectionId: id,
      index: i,
      number: parsed?.number || '',
      title: cleanTitle(para, parsed),
      level,
    };
    headings.push(heading);
    sections.push({
      id,
      number: heading.number,
      title: heading.title,
      level,
      headingIndex: i,
      start: i + 1, // 标题之后才是正文
      end: i + 1,
      summary: '',
    });
  }

  // 回填每节的 end（到下一节标题前）与 sectionOf（含标题本身归到该节）
  for (let s = 0; s < sections.length; s += 1) {
    const sec = sections[s];
    const next = sections[s + 1];
    sec.end = next ? next.headingIndex : paras.length;
    for (let i = sec.headingIndex; i < sec.end; i += 1) sectionOf[i] = s;
  }

  return { sections, sectionOf, headings, paragraphCount: paras.length, source: 'rules' };
}

/**
 * 把 LLM 整理结果映射回规则层 outline。
 * LLM 只返回 { id, level?, title?, summary? }，用 id 定位，不信任它给的任何索引。
 */
export function applyOutlineHints(outline, hints) {
  if (!Array.isArray(hints)) return outline;
  const byId = new Map(outline.headings.map((h) => [h.id, h]));
  for (const hint of hints) {
    if (!hint || typeof hint !== 'object') continue;
    const h = byId.get(String(hint.id || ''));
    if (!h) continue;
    const sec = outline.sections.find((s) => s.id === h.sectionId);
    if (!sec) continue;
    if (typeof hint.title === 'string' && hint.title.trim()) {
      sec.title = hint.title.trim().slice(0, 80);
      h.title = sec.title;
    }
    if (Number.isInteger(hint.level) && hint.level >= 1 && hint.level <= 6) {
      sec.level = hint.level;
      h.level = hint.level;
    }
    if (typeof hint.summary === 'string') sec.summary = hint.summary.trim().slice(0, 200);
  }
  outline.source = 'hybrid';
  return outline;
}

/**
 * 混合入口：规则层必做，LLM 层可选。
 * @param {object} cfg 模型配置
 * @param {string} text 论文正文
 * @param {{signal?: AbortSignal, demo?: boolean}} opts
 */
export async function parseOutline(cfg, text, { signal, demo = false } = {}) {
  const outline = parseOutlineRules(text);
  if (demo || !cfg?.api_key || !outline.headings.length) return outline;

  try {
    const { outlineMessages } = await import('../prompts.mjs');
    const hintsJson = await completeChat(
      cfg,
      outlineMessages(outline.headings.map((h) => ({ id: h.id, number: h.number, title: h.title }))),
      { maxTokens: 1200, temperature: 0.1, signal },
    );
    let hints = null;
    try {
      hints = JSON.parse(String(hintsJson.content || '').replace(/^```(?:json)?\s*|\s*```$/g, '').trim());
    } catch {
      /* LLM 输出坏 JSON：保留规则层结果 */
    }
    if (Array.isArray(hints)) applyOutlineHints(outline, hints);
  } catch (err) {
    // LLM 失败不打断主流程；LlmError 与网络异常都降级为规则层
    if (err?.name === 'AbortError') throw err;
  }
  return outline;
}

/** 供 UI / 下游使用的扁平目录：只保留有实质内容的节 */
export function outlineSummary(outline) {
  if (!outline?.sections) return [];
  return outline.sections.map((s) => ({
    id: s.id,
    number: s.number,
    title: s.title,
    level: s.level,
    start: s.start,
    end: s.end,
    summary: s.summary,
  }));
}
