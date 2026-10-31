/**
 * 知识抽取：资料正文 → 概念 + 前置关系 + 出处引用。
 *
 * 三件事：
 *   1) 提示词（要求严格 JSON，名字尽量复用库里已有概念）
 *   2) 容错归一化（字段缺失、类型错、边悬空都兜住）
 *   3) PaperLens 结构直传的映射（不花额外的模型调用，也能把精读结果变成图）
 */
import { completeChat, extractJson } from '../shared/llm.mjs';
import { CONCEPT_KINDS, EDGE_TYPES, nameKey, sentenceAround } from './store.mjs';

export const MAX_SOURCE_TEXT = 18000;

/** 长文截断：留头 70% + 尾 30%，比只留头部更容易抓到结论 */
export function trimText(text, limit = MAX_SOURCE_TEXT) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (body.length <= limit) return body;
  const head = body.slice(0, Math.floor(limit * 0.7));
  const tail = body.slice(-Math.floor(limit * 0.3));
  return `${head}\n\n...（中间内容因长度限制省略）...\n\n${tail}`;
}

function dedupeStrings(list, max = 6, maxLen = 120) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const value = String(item || '').trim().slice(0, maxLen);
    if (!value) continue;
    const key = nameKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

/* --------------------------------- 提示词 --------------------------------- */

const SYSTEM = `你是一位严谨的知识图谱抽取器，只输出合法 JSON，绝不输出 JSON 之外的任何字符。
你的任务：从资料中抽出「概念」和「概念之间的前置关系」，让读者能沿着"学它之前要先学什么"一路查下去。`;

export function extractionMessages({ title = '', text = '', knownConcepts = [] }) {
  const known = knownConcepts.length
    ? knownConcepts.slice(0, 200).map((name) => `- ${name}`).join('\n')
    : '（知识库目前是空的）';

  const user = `资料标题：${title || '（未提供）'}

知识库里已有的概念（**必须优先复用**，名称要逐字一致，不要另造近义名）：
${known}

请抽取这份资料的知识图谱，输出严格 JSON（第一个字符就是 {）：

{
  "concepts": [
    {
      "name": "概念名（中文优先，专有名词保留英文原文）",
      "aliases": ["资料里出现的英文术语", "缩写"],
      "summary": "一句话解释它是什么、解决什么问题（不超过 60 字）",
      "kind": "concept | method | formula | data | result | task | tool",
      "tags": ["所属主题/分区"],
      "prereqs": ["要理解它，必须先掌握的概念名"],
      "quotes": ["资料原文里逐字出现的句子，用来做出处定位"]
    }
  ],
  "edges": [
    { "from": "概念名A", "to": "概念名B", "type": "prereq | extends | related | flow", "label": "关系说明，不超过 10 字" }
  ],
  "topics": ["这份资料的主题"]
}

约束：
- concepts 给 6-12 个，宁少不滥：只收资料里真正讲清楚的概念。
- prereqs 只写真前置（不学它就读不懂当前概念），不要堆同主题词；可以写本次 concepts 里没出现、但确实是前置的概念名（系统会建"待补全"节点）。
- 关系方向：prereq 表示 from 是 to 的前置；extends 表示 to 在 from 的基础上延伸；related 表示并列相关；flow 表示处理流程的先后。
- quotes 必须**逐字**摘自资料原文，不要改写、不要拼接两句、不要加省略号；每个概念 1-2 句，每句不超过 200 字；找不到合适原句就给空数组。
- 所有文案用中文（术语保留英文）；不要编造资料里没有的数字、结论。
- 不要输出 markdown 代码块、注释或任何解释。

资料正文：
"""
${trimText(text)}
"""`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

/** 给已有概念补前置关系（PaperLens 结构直传时用：它的结构里没有前置信息） */
export function prereqMessages({ title = '', reading = '', concepts = [], text = '' }) {
  const names = concepts.map((concept) => `- ${concept.name}${concept.summary ? `：${concept.summary}` : ''}`).join('\n');
  const user = `下面是一篇论文的精读笔记和已经抽好的概念列表。请补齐这些概念之间的**前置关系**，输出严格 JSON：

{
  "prereqs": [
    { "name": "概念名（必须来自下面的列表，逐字一致）", "prereqs": ["先学什么才能懂它"] }
  ],
  "edges": [
    { "from": "概念名", "to": "概念名", "type": "prereq | extends | related | flow", "label": "关系说明，不超过 10 字" }
  ]
}

约束：
- name 只能用下面列表里的概念名；前置概念可以是列表之外的通用基础概念（例如"线性代数""梯度下降"）。
- 只写真正的前置：不掌握它就理解不了当前概念。
- 关系方向：from 是 to 的前置（prereq），或 to 在 from 上延伸（extends）。
- 不要输出 JSON 之外的任何字符。

概念列表：
${names}

精读笔记（节选）：
"""
${String(reading || '').slice(0, 8000)}
"""

论文正文（节选，用于核对）：
"""
${trimText(text, 5000)}
"""`;

  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

/* -------------------------------- 归一化 -------------------------------- */

export function normalizeExtraction(data) {
  const concepts = [];
  const seen = new Set();
  for (const raw of Array.isArray(data?.concepts) ? data.concepts : []) {
    if (!raw || typeof raw !== 'object') continue;
    const name = String(raw.name || raw.label || '').trim().slice(0, 80);
    const key = nameKey(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    concepts.push({
      name,
      aliases: dedupeStrings(raw.aliases || raw.terms, 6, 60),
      summary: String(raw.summary || raw.explain || raw.detail || '').trim().slice(0, 400),
      kind: CONCEPT_KINDS.includes(String(raw.kind)) ? String(raw.kind) : 'concept',
      tags: dedupeStrings(raw.tags, 6, 40),
      prereqs: dedupeStrings(raw.prereqs || raw.prerequisites, 8, 80).filter((item) => nameKey(item) !== key),
      quotes: dedupeStrings(raw.quotes || (raw.quote ? [raw.quote] : []), 3, 400),
    });
    if (concepts.length >= 18) break;
  }

  const edges = [];
  const seenEdge = new Set();
  for (const raw of Array.isArray(data?.edges) ? data.edges : []) {
    if (!raw || typeof raw !== 'object') continue;
    const from = String(raw.from || raw.source || '').trim().slice(0, 80);
    const to = String(raw.to || raw.target || '').trim().slice(0, 80);
    const type = EDGE_TYPES.includes(String(raw.type)) ? String(raw.type) : 'related';
    if (!nameKey(from) || !nameKey(to) || nameKey(from) === nameKey(to)) continue;
    const key = `${nameKey(from)}>${nameKey(to)}:${type}`;
    if (seenEdge.has(key)) continue;
    seenEdge.add(key);
    edges.push({ from, to, type, label: String(raw.label || '').slice(0, 40) });
  }

  return { concepts, edges, topics: dedupeStrings(data?.topics || data?.tags, 6, 40) };
}

/** 调模型抽取；坏 JSON / 网络抖动自动重试一次 */
export async function extractGraph(cfg, { title = '', text = '', knownConcepts = [] } = {}) {
  const messages = extractionMessages({ title, text, knownConcepts });
  let lastError = '抽取失败';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { content, finishReason } = await completeChat(cfg, messages, { temperature: 0.2 });
      const parsed = extractJson(content);
      if (parsed && typeof parsed === 'object') {
        const normalized = normalizeExtraction(parsed);
        if (normalized.concepts.length) return { ok: true, extraction: normalized };
        lastError = '模型没有抽出任何概念，可以换一段更完整的正文再试';
      } else {
        lastError =
          finishReason === 'length'
            ? '模型输出被 max_tokens 截断，JSON 没写完，请在设置里调大 max_tokens'
            : '模型没有返回可解析的 JSON，已自动重试一次';
      }
    } catch (err) {
      lastError = err.message || '抽取失败';
      if (/无法连接|401|403|404/.test(lastError)) break; // 配置问题，重试没意义
    }
  }
  return { ok: false, error: lastError };
}

/** 用模型补前置关系（失败就安静跳过，不影响已有图谱） */
export async function enrichPrereqs(cfg, { title = '', reading = '', text = '', concepts = [] } = {}) {
  if (!concepts.length) return null;
  try {
    const { content } = await completeChat(cfg, prereqMessages({ title, reading, concepts, text }), {
      temperature: 0.2,
    });
    const parsed = extractJson(content);
    if (!parsed || typeof parsed !== 'object') return null;
    const byName = new Map(concepts.map((concept) => [nameKey(concept.name), concept]));
    const prereqs = [];
    for (const raw of Array.isArray(parsed.prereqs) ? parsed.prereqs : []) {
      const hit = byName.get(nameKey(raw?.name));
      if (!hit) continue;
      prereqs.push({ name: hit.name, prereqs: dedupeStrings(raw.prereqs, 8, 80) });
    }
    const edges = normalizeExtraction({ edges: parsed.edges }).edges;
    return { prereqs, edges };
  } catch {
    return null;
  }
}

/**
 * PaperLens 的结构直传映射。
 * 输入：{ structure: {concepts, claims, diagram, tags}, paper: {text}, reading }
 * 输出：与 LLM 抽取同形的 extraction，交给 mergeGraph 合并。
 *
 * 出处这样来：PaperLens 给每个概念一组"论文原文里逐字出现"的 terms，
 * 用它在正文里取整句 —— 这就是可核对的原句，而不是模型复述。
 */
export function paperlensExtraction({ structure = null, paperText = '', reading = '' } = {}) {
  const concepts = [];
  const edges = [];
  const topics = [];

  const termsOf = (raw) => dedupeStrings(raw?.terms, 4, 60);

  for (const raw of Array.isArray(structure?.concepts) ? structure.concepts : []) {
    const name = String(raw?.name || '').trim().slice(0, 80);
    if (!name) continue;
    const terms = termsOf(raw);
    const quotes = [];
    for (const term of terms) {
      const sentence = sentenceAround(paperText, term);
      if (sentence) quotes.push(sentence);
    }
    if (!quotes.length && paperText) {
      // 没有 terms 时退回概念名本身（中文名偶尔也能在中文论文里命中）
      const sentence = sentenceAround(paperText, name);
      if (sentence) quotes.push(sentence);
    }
    concepts.push({
      name,
      aliases: terms,
      summary: String(raw?.explain || '').trim().slice(0, 400),
      kind: 'concept',
      tags: Array.isArray(structure?.tags) ? structure.tags.slice(0, 5) : [],
      prereqs: [],
      quotes: quotes.slice(0, 2),
    });
  }

  // 方法链路图（diagram）→ 方法节点 + flow 边
  const diagram = structure?.diagram && typeof structure.diagram === 'object' ? structure.diagram : null;
  const idMap = new Map();
  for (const node of Array.isArray(diagram?.nodes) ? diagram.nodes : []) {
    const label = String(node?.label || node?.name || '').trim().slice(0, 80);
    if (!label) continue;
    const quote = node?.detail ? sentenceAround(paperText, String(node.detail).slice(0, 20)) : '';
    concepts.push({
      name: label,
      aliases: [],
      summary: String(node?.detail || '').trim().slice(0, 400),
      kind: 'method',
      tags: ['方法链路'],
      prereqs: [],
      quotes: quote ? [quote] : [],
    });
    idMap.set(String(node.id || label), label);
  }
  for (const edge of Array.isArray(diagram?.edges) ? diagram.edges : []) {
    const from = idMap.get(String(edge?.from));
    const to = idMap.get(String(edge?.to));
    if (!from || !to || from === to) continue;
    edges.push({ from, to, type: 'flow', label: String(edge?.label || '').slice(0, 40) });
  }

  if (Array.isArray(structure?.tags)) topics.push(...structure.tags);

  // 图里没东西时，至少把精读小节标题留成主题，避免"导入成功但图谱空白"
  if (!concepts.length && reading) {
    for (const line of String(reading).split('\n')) {
      const m = line.match(/^#{2,4}\s+(.+?)\s*$/);
      if (m) topics.push(m[1]);
    }
  }

  return { concepts, edges, topics: dedupeStrings(topics, 6, 40) };
}

/* -------------------------------- 图片识别 -------------------------------- */

export async function describeImage(cfg, { base64, mime = 'image/png', filename = '' } = {}) {
  const model = String(cfg.vision_model || '').trim();
  if (!model) throw new Error('没有配置视觉模型');
  const visionKey = cfg.vision_api_key || cfg.api_key;
  const visionCfg = {
    ...cfg,
    base_url: cfg.vision_base_url || cfg.base_url,
    model,
    api_key: visionKey,
    max_tokens: null,
    temperature: 0.2,
  };
  const { content } = await completeChat(
    visionCfg,
    [
      {
        role: 'system',
        content:
          '你把图片里的知识内容完整转写成可检索的中文文字：标题、要点、公式、图表说明都要保留，不要评论、不要编造。',
      },
      {
        role: 'user',
        content: [
          { type: 'text', text: `请转写这张图片（${filename || '未命名'}）里的全部知识性文字与结构，用分段的纯文本输出。` },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
    { maxTokens: 2400, temperature: 0.1 },
  );
  return content.trim();
}
