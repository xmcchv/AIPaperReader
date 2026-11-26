/**
 * 追问上下文组装：把精读产物变成可检索、可引用的材料。
 *
 * 纯函数、零依赖、不落库——精读 markdown 与 structure 是唯一真相，
 * 每次追问现切现用。service/index.mjs 的 handleAsk() 调用 buildAskContext()
 * 后把结果交给 askMessages()。
 */
import { READING_SECTIONS } from './prompts.mjs';

const STOPWORDS = new Set([
  '的', '了', '和', '是', '在', '有', '这', '那', '与', '及', '或', '把', '被', '从', '对', '为',
  '什么', '怎么', '如何', '为什么', '哪些', '哪个', '吗', '呢', '啊', '吧', '呢', '的', '地', '得',
  '一个', '一些', '可以', '是否', '通过', '进行', '这个', '那个', '上面', '下面', '一下',
  'the', 'and', 'for', 'with', 'that', 'this', 'how', 'what', 'why', 'are', 'was', 'does', 'did',
]);

/** 英文整词 + 中文 2-gram，去停用词；不依赖分词库 */
export function tokenize(text) {
  const raw = String(text || '').toLowerCase();
  const out = new Set();
  for (const m of raw.matchAll(/[a-z][a-z0-9-]{1,}/g)) {
    if (!STOPWORDS.has(m[0])) out.add(m[0]);
  }
  for (const m of raw.matchAll(/[\u4e00-\u9fff]+/g)) {
    const s = m[0];
    if (s.length === 1) {
      if (!STOPWORDS.has(s)) out.add(s);
      continue;
    }
    for (let i = 0; i < s.length - 1; i += 1) {
      const gram = s.slice(i, i + 2);
      if (!STOPWORDS.has(gram)) out.add(gram);
    }
  }
  return [...out];
}

/** 精读 markdown → 7 节摘要卡（只切不摘要，超长取前 900 字） */
export function splitReadingCards(md) {
  const sections = [];
  let cur = null;
  for (const line of String(md || '').replace(/\r\n/g, '\n').split('\n')) {
    const m = line.match(/^#{1,4}\s+(.+?)\s*$/);
    if (m) {
      if (cur) sections.push(cur);
      cur = { title: m[1].replace(/^[一二三四五六七]、\s*/, '').trim(), lines: [] };
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  if (cur) sections.push(cur);

  return sections
    .filter((s) => READING_SECTIONS.includes(s.title))
    .map((s) => {
      const body = s.lines
        .join('\n')
        .replace(/^\s*[-*•]\s*/gm, '')
        .replace(/^\s*\d+[.)]\s*/gm, '')
        .trim()
        .slice(0, 900);
      return {
        title: s.title,
        body,
        source: `§${s.title}`,
        tokens: tokenize(`${s.title} ${body}`),
      };
    })
    .filter((s) => s.body);
}

function firstSentence(text, limit = 80) {
  const clean = String(text || '').trim();
  const parts = clean.split(/(?<=[。！？!?])|\n/);
  return (parts.find((s) => s.trim()) || clean).trim().slice(0, limit);
}

/** 最近 3 轮问答；过滤占位和出错条目，与 report.js qaPairs() 同口径 */
export function compressHistory(thread) {
  const list = Array.isArray(thread) ? thread : [];
  const pairs = [];
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i];
    if (!item || item.role !== 'user' || item.error) continue;
    const question = String(item.text || '').trim();
    if (!question || question === '…' || question === '思考中…') continue;
    let answer = '';
    for (let j = i + 1; j < list.length; j += 1) {
      const next = list[j];
      if (!next || next.role !== 'assistant') continue;
      const text = String(next.text || '').trim();
      if (text && text !== '…' && text !== '思考中…' && !next.error) answer = text;
      break;
    }
    if (!answer) continue;
    pairs.push({ question: question.slice(0, 120), answer: firstSentence(answer) });
  }
  return pairs.slice(-3);
}

/** query 权重表：问题 1，选中片段 3，上一轮问题 1.5（指代） */
function buildQuery(question, selection, history, extraTokens) {
  const query = new Map();
  const add = (tokens, weight) => {
    for (const t of tokens) query.set(t, (query.get(t) || 0) + weight);
  };
  add(tokenize(question), 1);
  add(tokenize(selection), 3);
  const q = String(question || '').trim();
  const anaphoric = /^(它|他|这|那|这个|那个|前者|后者|上面|上述|刚才)/.test(q) || (q.length <= 12 && /[呢吗]$/.test(q));
  if (anaphoric && history.length) add(tokenize(history[history.length - 1].question), 1.5);
  // structure 的原文检索词：命中时给卡片加权（见 scoreCard），不当作独立 query
  return { query, anaphoric, extra: new Set(extraTokens) };
}

function scoreCard(card, { query, extra }) {
  let score = 0;
  for (const t of card.tokens) score += query.get(t) || 0;
  if (!score) return 0;
  for (const t of extra) if (card.tokens.includes(t)) score += 0.6;
  for (const t of query.keys()) if (card.title.includes(t)) score += 1.2;
  return score / Math.sqrt(Math.max(1, card.body.length));
}

function splitPaperParagraphs(text) {
  return String(text || '')
    .replace(/\r\n/g, '\n')
    .split(/\n\s*\n+|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 40);
}

function clip(text, limit) {
  const s = String(text || '').trim();
  return s.length > limit ? `${s.slice(0, limit)}…` : s;
}

function scoreParagraph(text, { query, extra }, selectionTokens) {
  const tokens = tokenize(text);
  let score = 0;
  for (const t of tokens) score += query.get(t) || 0;
  for (const t of extra) if (tokens.includes(t)) score += 0.6;
  // 选中片段的 token 与段落重叠越多越靠前（选中片段即检索锚点）
  for (const t of selectionTokens) if (tokens.includes(t)) score += 1;
  return score / Math.sqrt(Math.max(1, text.length));
}

/**
 * 按预算裁剪：正文段 → 历史摘要 → 概念 → 选中片段。
 * 裁剪顺序与展示顺序分开——展示仍是「标题 / 选中片段 / 精读卡 / 原文 / 概念 / 对话 / 问题」。
 */
function fitBudget(head, tail, flex, max) {
  const trimOrder = ['paragraph', 'history', 'concept', 'selection'];
  const total = () =>
    [...head, ...tail, ...flex.map((b) => b.text).filter(Boolean)].reduce((n, s) => n + s.length + 2, 0);

  for (const key of trimOrder) {
    if (total() <= max) break;
    for (const item of flex) {
      if (item.key !== key || !item.text) continue;
      item.text = item.text.length > 200 ? `${item.text.slice(0, Math.floor(item.text.length / 2))}…` : '';
    }
  }
  for (const key of trimOrder) {
    if (total() <= max) break;
    for (const item of flex) if (item.key === key) item.text = '';
  }

  return [...head, ...flex.map((b) => b.text).filter(Boolean), ...tail].join('\n\n');
}

/**
 * 组装追问上下文。
 * @returns {{ block: string, cards: string[], paragraphs: number, history: number, chars: number }}
 */
export function buildAskContext({
  title = '',
  paperText = '',
  selection = '',
  reading = '',
  structure = null,
  question = '',
  askThread = [],
} = {}) {
  const cards = splitReadingCards(reading);
  const history = compressHistory(askThread);
  const cleanQuestion = String(question || '').trim();

  const extraTokens = [];
  for (const concept of Array.isArray(structure?.concepts) ? structure.concepts : []) {
    if (Array.isArray(concept?.terms)) extraTokens.push(...concept.terms);
    if (concept?.name) extraTokens.push(concept.name);
  }
  for (const claim of Array.isArray(structure?.claims) ? structure.claims : []) {
    if (claim?.text) extraTokens.push(claim.text);
  }
  const extra = new Set(tokenize(extraTokens.join(' ')).slice(0, 24));

  const q = buildQuery(cleanQuestion, selection, history, extra);
  const selectionTokens = tokenize(selection);
  const ranked = cards
    .map((card) => ({ card, score: scoreCard(card, q) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map((x) => x.card);

  const chosen = ranked.length
    ? ranked
    : ['一句话结论', '核心方法', '精读要点'].map((t) => cards.find((c) => c.title === t)).filter(Boolean);

  const rankedParagraphs = splitPaperParagraphs(paperText)
    .map((text) => ({ text, score: scoreParagraph(text, q, selectionTokens) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 2)
    .map((x) => clip(x.text, 700));

  const head = [];
  if (title) head.push(`论文标题：${clip(title, 100)}`);
  const tail = [`用户问题：${cleanQuestion}`];
  const cardsText = chosen.map((card) => `[${card.source}] ${clip(card.body, 900)}`);

  const flex = [
    { key: 'selection', text: selection ? `[选中片段] ${clip(selection, 1200)}` : '', order: 1 },
    ...cardsText.map((text) => ({ key: 'card', text, order: 2 })),
    {
      key: 'history',
      text: history.length
        ? `最近对话：\n${history.map((h) => `用户：${h.question} → AI：${h.answer}`).join('\n')}`
        : '',
      order: 5,
    },
    ...rankedParagraphs.map((text) => ({ key: 'paragraph', text: `[原文段落] ${text}`, order: 3 })),
  ];

  const concepts = Array.isArray(structure?.concepts) ? structure.concepts.slice(0, 6) : [];
  const claims = Array.isArray(structure?.claims) ? structure.claims.slice(0, 3) : [];
  const conceptText = concepts
    .map((c) => `${c.name || ''}：${c.explain || ''}`)
    .filter((s) => s.trim().length > 2)
    .join('；');
  const claimText = claims.map((c) => c.text || '').filter(Boolean).join('；');
  if (conceptText || claimText) {
    flex.push({ key: 'concept', text: `[概念] ${clip([conceptText, claimText].filter(Boolean).join(' | '), 600)}`, order: 4 });
  }
  flex.sort((a, b) => a.order - b.order);

  const block = fitBudget(head, tail, flex, 6900);

  return {
    block,
    cards: chosen.map((c) => c.source),
    paragraphs: rankedParagraphs.length,
    history: history.length,
    chars: block.length,
  };
}
