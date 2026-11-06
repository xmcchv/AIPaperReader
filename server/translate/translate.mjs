/**
 * 翻译调度层：把统一的 {texts, config} 分发到各家协议适配器。
 * - 统一 sha1 文本缓存（按 服务/地址/模型 分桶）
 * - 免费服务自动回退链 + 冷却
 * - 大模型走「JSON 数组」批量协议，解析失败自动二分降级
 *
 * 各接口的端点与参数按公开协议实现，未复制第三方项目代码。
 */

import crypto from 'node:crypto';

import * as store from './cache.mjs';
import { getProvider, PROVIDERS } from './providers.mjs';

/* ------------------------------------------------------------------ */
/* 缓存：统一落在 SQLite 的 translations 表，跨文档复用，不再写 JSON 文件  */
/* ------------------------------------------------------------------ */
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const stripSlash = (u) => (u || '').replace(/\/+$/, '');

/* ------------------------------------------------------------------ */
/* 配置归一化                                                          */
/* ------------------------------------------------------------------ */
function normalizeConfig(raw = {}) {
  const key = PROVIDERS[raw.provider] ? raw.provider : 'free';
  const meta = getProvider(key);
  const def = meta.defaults || {};

  return {
    provider: key,
    kind: meta.kind,
    label: meta.label,
    apiKey: str(raw.apiKey) || envKeyFor(key),
    appId: str(raw.appId) || str(process.env.BAIDU_APP_ID),
    baseUrl: stripSlash(str(raw.baseUrl) || def.baseUrl || ''),
    model: str(raw.model) || def.model || '',
  };
}

function envKeyFor(provider) {
  if (provider === 'deepseek') return str(process.env.DEEPSEEK_API_KEY) || str(process.env.OPENAI_API_KEY);
  if (provider === 'openai' || provider === 'custom') return str(process.env.OPENAI_API_KEY);
  if (provider === 'gemini') return str(process.env.GEMINI_API_KEY);
  if (provider === 'claude') return str(process.env.ANTHROPIC_API_KEY);
  if (provider === 'deepl') return str(process.env.DEEPL_API_KEY);
  return '';
}

function cacheTag(cfg) {
  return `${cfg.kind === 'chain' ? 'chain' : cfg.provider}|${cfg.baseUrl}|${cfg.model}`;
}

/* ------------------------------------------------------------------ */
/* 通用 HTTP                                                           */
/* ------------------------------------------------------------------ */
async function httpJson(url, init, { timeout = 60000, what = '翻译服务' } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  let resp;
  try {
    resp = await fetch(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error(
      e.name === 'AbortError' ? `${what}请求超时（${timeout / 1000}s）` : `无法连接${what}：${e.message}`
    );
    err.status = 502;
    err.code = 'network';
    throw err;
  }
  clearTimeout(timer);

  const raw = await resp.text();
  if (!resp.ok) {
    let detail = raw.slice(0, 300).replace(/\s+/g, ' ');
    try {
      const j = JSON.parse(raw);
      detail = j.error?.message || j.message || j.base_resp?.status_msg || detail;
    } catch {}
    const err = new Error(`${what}返回 ${resp.status}${detail ? `：${detail}` : ''}`);
    err.status = resp.status === 401 || resp.status === 403 ? 401 : 502;
    err.code = 'upstream_error';
    throw err;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw Object.assign(new Error(`${what}返回的不是 JSON（可能被拦截或接口已变更）`), {
      status: 502,
      code: 'bad_format',
      retryable: true,
    });
  }
}

function timeoutFor(kind) {
  return kind === 'openai' || kind === 'gemini' || kind === 'claude' ? 180000 : 30000;
}

/* ------------------------------------------------------------------ */
/* 语言代码                                                            */
/* ------------------------------------------------------------------ */
const LANG = {
  microsoft: { from: 'en', to: 'zh-Hans' },
  google: { from: 'en', to: 'zh-CN' },
  yandex: { from: 'en', to: 'zh' },
  tencent: { from: 'en', to: 'zh' },
  volc: { from: 'en', to: 'zh' },
  deeplx: { from: 'EN', to: 'ZH' },
  baidu: { from: 'en', to: 'zh' },
};

/* ------------------------------------------------------------------ */
/* 大模型：OpenAI 兼容                                                  */
/* ------------------------------------------------------------------ */
const SYSTEM_PROMPT = [
  '你是一名专业的学术论文翻译。将用户给出的英文段落逐条翻译成流畅、准确的简体中文。',
  '要求：',
  '1. 保持学术语体，术语准确且全文统一；',
  '2. 保留公式、变量名、数字、引用标记（如 [12]、(1)）原样；',
  '3. 不要解释、不要总结、不要合并或拆分条目；',
  '4. 只输出 JSON。',
].join('\n');

function buildUserPrompt(texts) {
  const body = texts
    .map((t, i) => `<<<SEG ${i + 1}>>>\n${t.replace(/\s+\n/g, '\n').trim()}`)
    .join('\n\n');
  return [
    `下面是 ${texts.length} 段英文，请逐段翻译。`,
    `输出格式：{"translations": ["第1段译文", "第2段译文", ...]}，数组长度必须严格等于 ${texts.length}。`,
    '',
    body,
  ].join('\n');
}

async function callOpenAI(texts, cfg) {
  if (!cfg.baseUrl) throw Object.assign(new Error('缺少接口地址（Base URL）'), { status: 400, code: 'missing_base_url' });
  const meta = getProvider(cfg.provider);
  if (meta?.needsKey !== false && !cfg.apiKey) {
    throw Object.assign(new Error('缺少 API Key，请在右上角「设置」里填写。'), { status: 400, code: 'missing_api_key' });
  }

  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  const what = cfg.provider === 'ollama' ? '本地 Ollama（请确认已执行 ollama serve）' : '大模型服务';

  const j = await httpJson(
    `${cfg.baseUrl}/chat/completions`,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: cfg.model,
        temperature: 0.2,
        stream: false,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(texts) },
        ],
      }),
    },
    { timeout: timeoutFor('openai'), what }
  );

  const content = j.choices?.[0]?.message?.content || '';
  const parsed = parseTranslations(content, texts.length);
  if (!parsed) {
    throw Object.assign(new Error('模型输出格式不符合预期'), { status: 502, code: 'bad_format', retryable: true });
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* 大模型：Gemini                                                      */
/* ------------------------------------------------------------------ */
async function callGemini(texts, cfg) {
  if (!cfg.apiKey) throw Object.assign(new Error('缺少 Gemini API Key'), { status: 400, code: 'missing_api_key' });
  const model = cfg.model || 'gemini-2.0-flash';
  const base = cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';

  let url;
  if (base.includes('{model}') || base.includes('{key}')) {
    url = base.replace(/\{model\}/g, encodeURIComponent(model)).replace(/\{key\}/g, encodeURIComponent(cfg.apiKey));
    if (!base.includes('{key}')) url += (url.includes('?') ? '&' : '?') + 'key=' + encodeURIComponent(cfg.apiKey);
  } else {
    url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  }

  const j = await httpJson(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents: [{ role: 'user', parts: [{ text: buildUserPrompt(texts) }] }],
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
      }),
    },
    { timeout: timeoutFor('gemini'), what: 'Gemini' }
  );

  const content = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  const parsed = parseTranslations(content, texts.length);
  if (!parsed) {
    throw Object.assign(new Error('Gemini 输出格式不符合预期'), { status: 502, code: 'bad_format', retryable: true });
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* 大模型：Claude                                                      */
/* ------------------------------------------------------------------ */
async function callClaude(texts, cfg) {
  if (!cfg.apiKey) throw Object.assign(new Error('缺少 Claude API Key'), { status: 400, code: 'missing_api_key' });
  const base = cfg.baseUrl || 'https://api.anthropic.com';
  const j = await httpJson(
    `${base}/v1/messages`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: cfg.model || 'claude-3-5-haiku-latest',
        max_tokens: 8192,
        temperature: 0.2,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserPrompt(texts) }],
      }),
    },
    { timeout: timeoutFor('claude'), what: 'Claude' }
  );

  const content = (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  const parsed = parseTranslations(content, texts.length);
  if (!parsed) {
    throw Object.assign(new Error('Claude 输出格式不符合预期'), { status: 502, code: 'bad_format', retryable: true });
  }
  return parsed;
}

/* ------------------------------------------------------------------ */
/* 微软 Edge 免费接口（原生批量）                                       */
/* ------------------------------------------------------------------ */
const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

function unescapeHtml(s) {
  return s
    .replace(/&#(?:0*39|x0*27);/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&gt;/gi, '>')
    .replace(/&lt;/gi, '<')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&');
}

async function callMicrosoft(texts, cfg) {
  const lang = LANG.microsoft;
  const url = `https://edge.microsoft.com/translate/translatetext?from=${lang.from}&to=${lang.to}&isEnterpriseClient=false`;
  const j = await httpJson(
    url,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(texts.map(escapeHtml)),
    },
    { timeout: timeoutFor('microsoft'), what: '微软翻译' }
  );

  if (!Array.isArray(j) || j.length !== texts.length) {
    throw Object.assign(new Error('微软翻译返回条数与请求不一致'), { status: 502, code: 'bad_format', retryable: true });
  }
  return j.map((item, i) => {
    const t = item?.translations?.[0]?.text;
    if (typeof t !== 'string' || !t.trim()) {
      throw Object.assign(new Error(`微软翻译第 ${i + 1} 条无译文`), { status: 502, code: 'bad_format' });
    }
    return unescapeHtml(t).trim();
  });
}

/* ------------------------------------------------------------------ */
/* 谷歌免费                                                            */
/* ------------------------------------------------------------------ */
async function oneGoogle(text) {
  const lang = LANG.google;
  const url =
    'https://translate.googleapis.com/translate_a/single?client=gtx&sl=' +
    lang.from +
    '&tl=' +
    lang.to +
    '&dt=t&q=' +
    encodeURIComponent(text);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  let resp;
  try {
    resp = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0' } });
  } catch (e) {
    clearTimeout(timer);
    throw Object.assign(new Error(e.name === 'AbortError' ? '谷歌翻译请求超时' : '谷歌翻译连接失败（可能被网络屏蔽）'), {
      status: 502,
      code: 'network',
    });
  }
  clearTimeout(timer);
  if (!resp.ok) {
    throw Object.assign(new Error(`谷歌翻译返回 ${resp.status}`), { status: 502, code: 'upstream_error' });
  }
  let j;
  try {
    j = await resp.json();
  } catch {
    throw Object.assign(new Error('谷歌翻译返回的不是 JSON'), { status: 502, code: 'bad_format', retryable: true });
  }
  const zh = (j?.[0] || []).map((seg) => seg?.[0] || '').join('');
  if (!zh.trim()) throw Object.assign(new Error('谷歌翻译返回空结果'), { status: 502, code: 'empty' });
  return zh;
}

/* ------------------------------------------------------------------ */
/* Yandex 免费                                                         */
/* ------------------------------------------------------------------ */
async function oneYandex(text) {
  const lang = LANG.yandex;
  const params = new URLSearchParams({
    id: `${crypto.randomUUID().replace(/-/g, '')}-0-0`,
    srv: 'android',
    target_lang: lang.to,
    source_lang: lang.from,
    text,
  });
  const j = await httpJson(
    `https://translate.yandex.net/api/v1/tr.json/translate?${params}`,
    { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '' },
    { timeout: timeoutFor('yandex'), what: 'Yandex 翻译' }
  );
  if (j?.code !== 200) {
    throw Object.assign(new Error(`Yandex 返回 ${j?.code ?? '未知'}${j?.message ? '：' + j.message : ''}`), {
      status: 502,
      code: 'upstream_error',
    });
  }
  const out = Array.isArray(j.text) ? j.text.join('') : '';
  if (!out.trim()) throw Object.assign(new Error('Yandex 返回空结果'), { status: 502, code: 'empty' });
  return out;
}

/* ------------------------------------------------------------------ */
/* 腾讯交互翻译（免费）                                                 */
/* ------------------------------------------------------------------ */
async function oneTencent(text) {
  const lang = LANG.tencent;
  const j = await httpJson(
    'https://transmart.qq.com/api/imt',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: 'https://transmart.qq.com' },
      body: JSON.stringify({
        header: {
          fn: 'auto_translation',
          client_key: `browser-chrome-120.0.0-Win32-${crypto.randomUUID()}-${Date.now()}`,
        },
        type: 'plain',
        model_category: 'normal',
        source: { text_list: [text], lang: lang.from },
        target: { lang: lang.to },
      }),
    },
    { timeout: timeoutFor('tencent'), what: '腾讯交互翻译' }
  );
  if (j?.header?.ret_code !== 'succ') {
    throw Object.assign(new Error(`腾讯翻译返回 ${j?.header?.ret_code ?? '未知'}`), {
      status: j?.header?.ret_code === 'Auth-Failed' ? 403 : 502,
      code: 'upstream_error',
    });
  }
  const out = Array.isArray(j.auto_translation) ? j.auto_translation.join('') : '';
  if (!out.trim()) throw Object.assign(new Error('腾讯翻译返回空结果'), { status: 502, code: 'empty' });
  return out;
}

/* ------------------------------------------------------------------ */
/* 火山翻译（免费网页版）                                               */
/* ------------------------------------------------------------------ */
async function oneVolc(text) {
  const lang = LANG.volc;
  const j = await httpJson(
    'https://translate.volcengine.com/crx/translate/v1/',
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'https://translate.volcengine.com',
        referer: 'https://translate.volcengine.com/',
      },
      body: JSON.stringify({ source_language: lang.from, target_language: lang.to, text }),
    },
    { timeout: timeoutFor('volc'), what: '火山翻译' }
  );
  if (j?.base_resp?.status_code !== 0) {
    throw Object.assign(new Error(`火山翻译返回 ${j?.base_resp?.status_code ?? '未知'}`), {
      status: 502,
      code: 'upstream_error',
    });
  }
  if (typeof j.translation !== 'string' || !j.translation.trim()) {
    throw Object.assign(new Error('火山翻译返回空结果'), { status: 502, code: 'empty' });
  }
  return j.translation;
}

/* ------------------------------------------------------------------ */
/* DeepLX                                                              */
/* ------------------------------------------------------------------ */
async function oneDeepLX(text, cfg) {
  const lang = LANG.deeplx;
  const url = cfg.baseUrl || 'http://127.0.0.1:1188/translate';
  const headers = { 'content-type': 'application/json' };
  if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;

  const j = await httpJson(
    url,
    {
      method: 'POST',
      headers,
      body: JSON.stringify({ text, source_lang: lang.from, target_lang: lang.to }),
    },
    { timeout: timeoutFor('deeplx'), what: 'DeepLX' }
  );
  if (j?.code !== undefined && j.code !== 200) {
    throw Object.assign(new Error(`DeepLX 返回 ${j.code}${j.message ? '：' + j.message : ''}`), {
      status: 502,
      code: 'upstream_error',
    });
  }
  if (typeof j?.data !== 'string' || !j.data.trim()) {
    throw Object.assign(new Error('DeepLX 返回格式异常：缺少译文'), { status: 502, code: 'bad_format' });
  }
  return j.data;
}

/* ------------------------------------------------------------------ */
/* DeepL 官方（原生批量）                                               */
/* ------------------------------------------------------------------ */
async function callDeepL(texts, cfg) {
  if (!cfg.apiKey) throw Object.assign(new Error('缺少 DeepL Auth Key'), { status: 400, code: 'missing_api_key' });
  const base = cfg.baseUrl || 'https://api-free.deepl.com';
  const j = await httpJson(
    `${base}/v2/translate`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `DeepL-Auth-Key ${cfg.apiKey}` },
      body: JSON.stringify({ text: texts, source_lang: 'EN', target_lang: cfg.model || 'ZH' }),
    },
    { timeout: timeoutFor('deepl'), what: 'DeepL' }
  );
  if (!Array.isArray(j?.translations) || j.translations.length !== texts.length) {
    throw Object.assign(new Error('DeepL 返回条数与请求不一致'), { status: 502, code: 'bad_format', retryable: true });
  }
  return j.translations.map((t) => String(t.text || '').trim());
}

/* ------------------------------------------------------------------ */
/* 百度翻译开放平台                                                    */
/* ------------------------------------------------------------------ */
async function oneBaidu(text, cfg) {
  if (!cfg.appId || !cfg.apiKey) {
    throw Object.assign(new Error('百度翻译需要 APP ID 与密钥'), { status: 400, code: 'missing_api_key' });
  }
  const lang = LANG.baidu;
  const salt = String(Date.now());
  const sign = crypto.createHash('md5').update(cfg.appId + text + salt + cfg.apiKey).digest('hex');
  const body = new URLSearchParams({ q: text, from: lang.from, to: lang.to, appid: cfg.appId, salt, sign });

  const j = await httpJson(
    'https://fanyi-api.baidu.com/api/trans/vip/translate',
    {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    },
    { timeout: timeoutFor('baidu'), what: '百度翻译' }
  );
  if (j?.error_code) {
    throw Object.assign(new Error(`百度翻译错误 ${j.error_code}：${j.error_msg || ''}`), {
      status: j.error_code === '54003' ? 429 : 502,
      code: 'upstream_error',
    });
  }
  const out = (j?.trans_result || []).map((r) => r.dst).join('\n');
  if (!out.trim()) throw Object.assign(new Error('百度翻译返回空结果'), { status: 502, code: 'empty' });
  return out;
}

/* ------------------------------------------------------------------ */
/* MyMemory                                                            */
/* ------------------------------------------------------------------ */
async function oneMyMemory(text, cfg) {
  const url =
    'https://api.mymemory.translated.net/get?langpair=en|zh-CN&q=' + encodeURIComponent(text.slice(0, 480)) +
    (cfg.apiKey ? '&de=' + encodeURIComponent(cfg.apiKey) : '');
  const j = await httpJson(url, { method: 'GET' }, { timeout: timeoutFor('mymemory'), what: 'MyMemory' });
  const out = j?.responseData?.translatedText || '';
  if (!out.trim()) throw Object.assign(new Error('MyMemory 返回空结果'), { status: 502, code: 'empty' });
  return out;
}

/* ------------------------------------------------------------------ */
/* 批量 / 单条分发                                                      */
/* ------------------------------------------------------------------ */
const ONE_BY_ONE = {
  google: oneGoogle,
  yandex: oneYandex,
  tencent: oneTencent,
  volc: oneVolc,
  deeplx: oneDeepLX,
  baidu: oneBaidu,
  mymemory: oneMyMemory,
};

async function callProvider(texts, cfg) {
  switch (cfg.kind) {
    case 'openai':
      return callOpenAI(texts, cfg);
    case 'gemini':
      return callGemini(texts, cfg);
    case 'claude':
      return callClaude(texts, cfg);
    case 'microsoft':
      return callMicrosoft(texts, cfg);
    case 'deepl':
      return callDeepL(texts, cfg);
    case 'chain':
      return callChain(texts, cfg);
    default: {
      const one = ONE_BY_ONE[cfg.kind];
      if (!one) throw Object.assign(new Error(`未知的翻译服务：${cfg.provider}`), { status: 400 });
      const out = [];
      for (const t of texts) out.push(await one(t, cfg));
      return out;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 免费服务自动回退链                                                   */
/* ------------------------------------------------------------------ */
const cooldown = new Map(); // provider -> 到期时间戳
const COOLDOWN_MS = 60000;

async function callChain(texts, cfg) {
  const members = getProvider('free').chain.slice();
  const now = Date.now();
  const alive = members.filter((m) => (cooldown.get(m) || 0) <= now);
  const order = alive.length ? alive : members; // 全部冷却中也硬着头皮试一遍

  const errors = [];
  for (const m of order) {
    try {
      const sub = normalizeConfig({ provider: m });
      return await callProvider(texts, sub);
    } catch (e) {
      cooldown.set(m, Date.now() + COOLDOWN_MS);
      errors.push(`${getProvider(m).label}: ${e.message}`);
      if (e.status === 400) break; // 配置类错误，换一家也没用
    }
  }
  throw Object.assign(new Error(`免费翻译全部失败 —— ${errors.join('；')}`), { status: 502, code: 'chain_failed' });
}

/* ------------------------------------------------------------------ */
/* JSON 解析（含二分降级）                                              */
/* ------------------------------------------------------------------ */
function parseTranslations(content, n) {
  let s = String(content || '').trim();
  if (!s) return null;

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) s = fence[1].trim();

  const tryArray = (arr) => {
    if (!Array.isArray(arr) || arr.length !== n) return null;
    const out = arr.map((x) => (typeof x === 'string' ? x.trim() : String(x ?? '').trim()));
    return out.some((x) => x) ? out : null;
  };

  const oS = s.indexOf('{');
  const oE = s.lastIndexOf('}');
  if (oS >= 0 && oE > oS) {
    try {
      const obj = JSON.parse(s.slice(oS, oE + 1));
      if (Array.isArray(obj)) {
        const r = tryArray(obj);
        if (r) return r;
      } else if (obj && typeof obj === 'object') {
        for (const key of ['translations', 'result', 'results', 'data', 'output']) {
          const r = tryArray(obj[key]);
          if (r) return r;
        }
        for (const v of Object.values(obj)) {
          const r = tryArray(v);
          if (r) return r;
        }
      }
    } catch {}
  }

  const aS = s.indexOf('[');
  const aE = s.lastIndexOf(']');
  if (aS >= 0 && aE > aS) {
    try {
      const r = tryArray(JSON.parse(s.slice(aS, aE + 1)));
      if (r) return r;
    } catch {}
  }

  const parts = s
    .split(/\n\s*(?:<<<SEG\s*\d+>>>|\d+\s*[.、)])\s*/g)
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === n) return parts;
  return null;
}

async function callWithRecovery(texts, cfg, depth = 0) {
  try {
    return await callProvider(texts, cfg);
  } catch (e) {
    const canSplit = texts.length > 1 && depth < 3 && (e.retryable || e.code === 'bad_format');
    if (!canSplit) throw e;
    const mid = Math.ceil(texts.length / 2);
    const a = await callWithRecovery(texts.slice(0, mid), cfg, depth + 1);
    const b = await callWithRecovery(texts.slice(mid), cfg, depth + 1);
    return [...a, ...b];
  }
}

/* ------------------------------------------------------------------ */
/* 对外入口                                                            */
/* ------------------------------------------------------------------ */
async function translateTexts(texts, rawCfg, opts = {}) {
  const cfg = normalizeConfig(rawCfg);
  const tag = cacheTag(cfg);
  const fresh = Boolean(opts.fresh);
  const results = new Array(texts.length).fill(null);
  const todo = [];
  let cached = 0;

  texts.forEach((t, i) => {
    const key = sha1(tag + '\u0000' + t);
    // fresh：跳过缓存重新调用模型，成功后用新译文覆盖缓存
    const hit = fresh ? null : store.getTranslation(key);
    if (hit) {
      results[i] = hit;
      cached++;
    } else {
      todo.push({ i, t, key });
    }
  });

  let failed = 0;
  if (todo.length) {
    const BATCH = cfg.kind === 'openai' || cfg.kind === 'gemini' || cfg.kind === 'claude' ? 8 : 6;

    for (let s = 0; s < todo.length; s += BATCH) {
      const slice = todo.slice(s, s + BATCH);
      try {
        const zh = await callWithRecovery(slice.map((x) => x.t), cfg);
        slice.forEach((item, k) => {
          const val = (zh[k] || '').trim();
          if (val) {
            results[item.i] = val;
            store.setTranslation(item.key, val);
          } else failed++;
        });
      } catch (e) {
        if (slice.length === 1) throw e;
        // 整批失败：逐条再试，避免一条坏数据拖垮整批
        for (const item of slice) {
          try {
            const [one] = await callWithRecovery([item.t], cfg, 3);
            if (one?.trim()) {
              results[item.i] = one.trim();
              store.setTranslation(item.key, one.trim());
            } else failed++;
          } catch (e2) {
            if (e2.status === 400 || e2.status === 401) throw e2;
            failed++;
          }
        }
      }
    }
  }

  const stats = { cached, fresh: results.filter(Boolean).length - cached, failed };
  if (!results.some(Boolean) && todo.length) {
    throw Object.assign(new Error('全部段落翻译失败'), { status: 502, code: 'all_failed' });
  }
  return { translations: results, stats };
}

async function testConnection(rawCfg) {
  const cfg = normalizeConfig(rawCfg);
  const t0 = Date.now();
  const [out] = await callWithRecovery(['The proposed method significantly improves retrieval accuracy.'], cfg);
  return { ok: true, sample: out, ms: Date.now() - t0, provider: cfg.provider, model: cfg.model };
}

/* ------------------------------------------------------------------ */
/* 通用对话（AI 分段用）：只支持大模型类服务                             */
/* ------------------------------------------------------------------ */
async function chatComplete({ system, user, cfg: rawCfg, maxTokens = 4096 }) {
  const cfg = normalizeConfig(rawCfg);

  if (cfg.kind === 'openai') {
    if (!cfg.baseUrl) throw Object.assign(new Error('缺少接口地址（Base URL）'), { status: 400, code: 'missing_base_url' });
    const meta = getProvider(cfg.provider);
    if (meta?.needsKey !== false && !cfg.apiKey) {
      throw Object.assign(new Error('缺少 API Key，请在「设置」里填写。'), { status: 400, code: 'missing_api_key' });
    }
    const headers = { 'content-type': 'application/json' };
    if (cfg.apiKey) headers.authorization = `Bearer ${cfg.apiKey}`;
    const j = await httpJson(
      `${cfg.baseUrl}/chat/completions`,
      {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0,
          stream: false,
          max_tokens: maxTokens,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      },
      { timeout: 180000, what: '大模型服务' }
    );
    return j.choices?.[0]?.message?.content || '';
  }

  if (cfg.kind === 'gemini') {
    if (!cfg.apiKey) throw Object.assign(new Error('缺少 Gemini API Key'), { status: 400, code: 'missing_api_key' });
    const model = cfg.model || 'gemini-2.0-flash';
    const base = cfg.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
    const url = base.includes('{model}')
      ? base.replace(/\{model\}/g, encodeURIComponent(model)).replace(/\{key\}/g, encodeURIComponent(cfg.apiKey))
      : `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
    const j = await httpJson(
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: maxTokens },
        }),
      },
      { timeout: 180000, what: 'Gemini' }
    );
    return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  }

  if (cfg.kind === 'claude') {
    if (!cfg.apiKey) throw Object.assign(new Error('缺少 Claude API Key'), { status: 400, code: 'missing_api_key' });
    const base = cfg.baseUrl || 'https://api.anthropic.com';
    const j = await httpJson(
      `${base}/v1/messages`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: cfg.model || 'claude-3-5-haiku-latest',
          max_tokens: Math.min(maxTokens, 8192),
          temperature: 0,
          system,
          messages: [{ role: 'user', content: user }],
        }),
      },
      { timeout: 180000, what: 'Claude' }
    );
    return (j.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
  }

  throw Object.assign(new Error('AI 分段需要大模型服务（DeepSeek / Gemini / Claude / OpenAI 等），当前选的是机器翻译接口。'), {
    status: 400,
    code: 'unsupported_provider',
  });
}

export { translateTexts, testConnection, normalizeConfig, chatComplete };
