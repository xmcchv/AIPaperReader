/**
 * 用 outline 坐标系为 concept 定位原文锚点、为图解节点关联章节。
 * 纯函数：输入段落数组与 outline，输出带 anchors 的 concepts / 带 sectionRef 的 nodes。
 *
 * 与前端 findTerm 保持一致的匹配规则：空格/连字符视为可选分隔、忽略大小写、子串匹配。
 * 打分让"术语密度高 + 靠前 + 标题后首段"的段落胜出，避免宽泛缩写（RL）抢先命中。
 */
import { splitParagraphs } from '../../public/text.js';

function termPattern(term) {
  const parts = String(term || '')
    .trim()
    .split(/[\s\-‐‑]+/)
    .filter(Boolean)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!parts.length) return null;
  return new RegExp(parts.join('[\\s\\-‐‑]*'), 'i');
}

/** 取命中位置所在的完整句子，作为可核对的原文引用 */
function sentenceAt(text, index, length) {
  const head = text.lastIndexOf('。', index);
  const headEn = text.lastIndexOf('. ', index);
  const tailZh = text.indexOf('。', index + length);
  const tailEn = text.indexOf('. ', index + length);
  let start = Math.max(head, headEn) + 1;
  let end = Math.min(
    tailZh < 0 ? text.length : tailZh + 1,
    tailEn < 0 ? text.length : tailEn + 2,
  );
  const quote = text.slice(start, end).trim();
  return quote.length > 100 ? `${quote.slice(0, 100)}…` : quote;
}

/**
 * 为单个 concept 计算 anchors。
 * @returns {Array<{section:string, paragraph:number, offset:number, quote:string, score:number, term:string}>}
 */
export function conceptAnchors(concept, outline, paragraphs, { limit = 3 } = {}) {
  const terms = Array.isArray(concept?.terms) ? concept.terms : [];
  if (!terms.length || !paragraphs?.length) return [];

  const sectionOf = outline?.sectionOf || [];
  const sections = outline?.sections || [];
  const headingSet = new Set(sections.map((s) => s.headingIndex));
  const afterHeading = new Set(sections.map((s) => s.headingIndex + 1));
  // 摘要只是概述，不是概念定义处；定义性章节（overview/method/system/architecture）优先。
  const sectionWeight = new Map();
  for (const s of sections) {
    const t = `${s.title} ${s.summary || ''}`;
    let w = 1;
    if (/abstract|摘要|summary|总结|引言|introduction/i.test(t)) w = 0.35;
    else if (/overview|system|architecture|method|方法|框架|模型|model|design|设计|approach/i.test(t)) w = 1.5;
    sectionWeight.set(s.id, w);
  }
  const DEFINE_RE = /\b(we\s+(propose|introduce|present|define|design)|is\s+(a|an|the|defined|designed|called|termed|known)|are\s+(defined|called|known)|defined\s+as|refers?\s+to|consists?\s+of|comprises?|called|named|termed|定义为|提出|指的是|由.{0,12}组成)\b/i;
  const hits = new Map();

  for (const term of terms) {
    const pattern = termPattern(term);
    if (!pattern) continue;
    for (let i = 0; i < paragraphs.length; i += 1) {
      const text = paragraphs[i];
      const m = pattern.exec(text);
      if (!m) continue;
      const secIdx = sectionOf[i];
      const sec = secIdx >= 0 ? sections[secIdx] : null;
      // 宽泛缩写惩罚：短 term 命中长段落时降权，避免 RL → CTRL 抢先
      const bare = String(term).trim();
      const shortPenalty = bare.length <= 3 ? 0.45 : 1;
      const positionBonus = afterHeading.has(i) ? 0.2 : 0;
      const titlePenalty = headingSet.has(i) ? 0.2 : 0;
      // 定义句加权：术语附近出现定义动词，说明这里是概念的解释处而非顺带提及
      const around = text.slice(Math.max(0, m.index - 80), m.index + m[0].length + 80);
      const defineBonus = DEFINE_RE.test(around) ? 0.9 : 0;
      const secWeight = sec ? sectionWeight.get(sec.id) || 1 : 0.6;
      const score = (1 + positionBonus + defineBonus - titlePenalty) * shortPenalty * secWeight;

      const key = i;
      const prev = hits.get(key);
      if (prev) {
        prev.score += score;
        prev.terms.push(bare);
      } else {
        hits.set(key, {
          section: sec ? sec.id : '',
          paragraph: i,
          offset: m.index,
          quote: sentenceAt(text, m.index, m[0].length),
          term: bare,
          terms: [bare],
          score,
        });
      }
    }
  }

  return [...hits.values()]
    .sort((a, b) => b.score - a.score || a.paragraph - b.paragraph)
    .slice(0, limit)
    .map((hit) => ({ ...hit, score: Math.round(hit.score * 100) / 100 }));
}

/** 把章节号/标题解析成 outline 里的 section id */
export function resolveSectionRef(ref, outline) {
  const key = String(ref || '').trim().toLowerCase();
  if (!key) return '';
  const sections = outline?.sections || [];
  const exact = sections.find(
    (s) => s.number === key || s.id.toLowerCase() === key || String(s.title || '').toLowerCase() === key,
  );
  if (exact) return exact.id;
  // 编号包含关系：LLM 给 "2" 而 outline 有 "2.1"，取第一个匹配
  const prefixed = sections.find((s) => s.number && (s.number === key || s.number.startsWith(`${key}.`)));
  return prefixed ? prefixed.id : '';
}

/**
 * 用 outline 坐标系增强 structure：
 * - concepts[].anchors：原文锚点（节 + 段 + 偏移 + 引用）
 * - diagram.nodes[].sectionRef：从 LLM 给的 ref 解析，失败则用节点文字在原文里反查
 */
export function enrichStructureWithOutline(structure, outline, rawText) {
  if (!structure || !outline?.sections?.length) return structure;
  const paragraphs = splitParagraphs(rawText);

  structure.concepts = (structure.concepts || []).map((c) => ({
    ...c,
    anchors: conceptAnchors(c, outline, paragraphs),
  }));

  const sections = outline.sections;
  structure.diagram = {
    ...(structure.diagram || {}),
    nodes: (structure.diagram?.nodes || []).map((n) => {
      let sectionRef = resolveSectionRef(n.sectionRef ?? n.section, outline);
      if (!sectionRef) {
        // 兜底：用节点 label/detail 里的术语在原文反查
        const fake = { terms: [n.label, n.detail].filter(Boolean).slice(0, 2) };
        const anchor = conceptAnchors(fake, outline, paragraphs, { limit: 1 })[0];
        if (anchor?.section) sectionRef = anchor.section;
      }
      return { ...n, sectionRef };
    }),
  };
  return structure;
}
