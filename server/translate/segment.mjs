/**
 * AI 分段：把一页的「行」交给大模型，让它返回段落分组（只返回行号区间）。
 * 原文由前端按行号拼装，模型无法改写内容；输出不合法就整页回退到规则切分。
 */

import crypto from 'node:crypto';

import * as store from './cache.mjs';
import { chatComplete, normalizeConfig } from './translate.mjs';

/* AI 分段结果按页缓存在 SQLite 的 segments 表 */
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const KINDS = new Set(['body', 'heading', 'caption', 'formula', 'annotation']);

const SYSTEM_PROMPT = `你在做 PDF 版面还原：把一页论文的文本行合并成段落，并给每段标类型。

输入每行格式为：序号|栏|字号|文本
- 栏：L=左栏，R=右栏，W=通栏
- 字号是相对值，正文通常在 9~11 之间

类型只能是：body（正文段落）、heading（章节标题，如 "3.2 Method"）、caption（图表标题，以 Figure/Table/Algorithm 开头）、formula（独立成行的公式）、annotation（图表内部的标注文字）。

规则：
1. 只能合并相邻行，且不能跨栏（L 与 R 不能并成一段）；
2. 正文段落之间通常有更大的行距或首行缩进；一句话没说完就应继续合并；
3. 公式行单独成组，不要并进正文；
4. 必须覆盖全部行，不漏、不重、不越界；
5. 只输出 JSON，不要解释。

输出格式：{"groups":[{"from":1,"to":3,"type":"body"},{"from":4,"to":4,"type":"formula"}]}`;

function buildUserPrompt(lines, columns) {
  const body = lines
    .map((l) => `${l.i}|${l.col || (columns === 1 ? 'W' : 'L')}|${l.size}|${String(l.text).slice(0, 160)}`)
    .join('\n');
  return `共 ${lines.length} 行，${columns === 2 ? '双栏' : '单栏'}。\n\n${body}`;
}

/** 从模型输出里抠出分组，并补齐缝隙、裁剪越界 */
function normalizeGroups(text, n) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // 模型可能返回 {"groups":[...]}、裸数组、或被 ``` 包起来，逐个试
  const candidates = [];
  const tryParse = (str) => {
    if (!str) return;
    try {
      candidates.push(JSON.parse(str));
    } catch {}
  };

  tryParse(raw);
  const fence = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tryParse(fence[1].trim());

  const aS = raw.indexOf('[');
  const aE = raw.lastIndexOf(']');
  if (aS >= 0 && aE > aS) tryParse(raw.slice(aS, aE + 1));

  const oS = raw.indexOf('{');
  const oE = raw.lastIndexOf('}');
  if (oS >= 0 && oE > oS) tryParse(raw.slice(oS, oE + 1));

  // 最后的兜底：把每个 {...} 单独抠出来拼成数组
  const objs = raw.match(/\{[^{}]*?"from"[^{}]*?\}/g);
  if (objs && objs.length) {
    const arr = [];
    for (const o of objs) {
      try {
        arr.push(JSON.parse(o));
      } catch {}
    }
    if (arr.length) candidates.push(arr);
  }

  for (const c of candidates) {
    const arr = Array.isArray(c) ? c : c && Array.isArray(c.groups) ? c.groups : null;
    if (!arr || !arr.length) continue;
    const groups = normalizeRanges(arr, n);
    if (groups) return groups;
  }
  return null;
}

/** 把 from/to 裁剪到合法区间，补齐缝隙 */
function normalizeRanges(arr, n) {
  const valid = [];
  for (const g of arr) {
    const from = Math.round(Number(g?.from));
    const to = Math.round(Number(g?.to));
    if (!isFinite(from) || !isFinite(to)) continue;
    const a = Math.max(1, Math.min(from, n));
    const b = Math.max(1, Math.min(to, n));
    if (b < a) continue;
    valid.push({ from: a, to: b, type: KINDS.has(g.type) ? g.type : 'body' });
  }
  if (!valid.length) return null;

  valid.sort((x, y) => x.from - y.from);

  // 补齐缝隙、丢弃重叠
  const groups = [];
  let cursor = 1;
  for (const g of valid) {
    if (g.to < cursor) continue;
    if (g.from > cursor) groups.push({ from: cursor, to: g.from - 1, type: 'body' });
    groups.push({ from: Math.max(g.from, cursor), to: g.to, type: g.type });
    cursor = g.to + 1;
  }
  if (cursor <= n) groups.push({ from: cursor, to: n, type: 'body' });

  // 明显不合理的输出（比如一行一段、或整页一段）判为失败，交给前端回退
  const huge = groups.some((g) => g.to - g.from > 60);
  if (huge && n > 20) return null;

  return groups;
}

async function segmentPage({ lines, columns = 2 }, rawCfg) {
  if (!Array.isArray(lines) || !lines.length) {
    throw Object.assign(new Error('缺少待分段的文本行'), { status: 400, code: 'no_lines' });
  }
  if (lines.length > 400) {
    throw Object.assign(new Error('单页行数异常（>400），已跳过 AI 分段'), { status: 400, code: 'too_many_lines' });
  }

  const cfg = normalizeConfig(rawCfg);
  const key = sha1(`${cfg.provider}|${cfg.model}|${lines.length}|${lines.map((l) => l.text).join('\u0001')}`);

  const hit = store.getSegment(key);
  if (hit) return { groups: hit, cached: true };

  const raw = await chatComplete({
    system: SYSTEM_PROMPT,
    user: buildUserPrompt(lines, columns),
    cfg,
    maxTokens: 2048,
  });

  const groups = normalizeGroups(raw, lines.length);
  if (!groups) {
    const peek = String(raw || '').replace(/\s+/g, ' ').slice(0, 160);
    throw Object.assign(new Error(`模型返回的分段结果无法解析：${peek || '(空响应)'}`), {
      status: 502,
      code: 'bad_segments',
    });
  }

  store.setSegment(key, groups);
  return { groups, cached: false };
}

export { segmentPage, normalizeGroups };
