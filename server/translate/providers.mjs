'use strict';

/**
 * 翻译服务目录（前后端共用同一份定义）。
 * kind 决定服务端用哪个协议适配器；fields 决定设置弹窗里渲染哪些输入框。
 *
 * 协议来源参考了 FluentRead 等开源阅读器公开使用的接口，
 * 但这里全部按协议重新实现，未复制其代码。
 */

const F = {
  baseUrl: (label, placeholder) => ({ key: 'baseUrl', label, placeholder, type: 'text' }),
  apiKey: (label = 'API Key', placeholder = 'sk-...') => ({ key: 'apiKey', label, placeholder, type: 'password' }),
  appId: (label = 'APP ID') => ({ key: 'appId', label, placeholder: '', type: 'text' }),
  model: (label = '模型', placeholder = '') => ({ key: 'model', label, placeholder, type: 'text' }),
};

const PROVIDERS = {
  /* ---------------------------- 免费、无需 Key ---------------------------- */
  free: {
    label: '免费自动（推荐零配置）',
    group: '免费',
    kind: 'chain',
    chain: ['microsoft', 'tencent', 'volc', 'yandex', 'google'],
    fields: [],
    hint: '依次尝试 微软 → 腾讯 → 火山 → Yandex → 谷歌；某个接口失败会自动换下一个，并在 60 秒内跳过它。全部免费、无需 Key。',
  },
  microsoft: {
    label: '微软翻译（Edge 免费）',
    group: '免费',
    kind: 'microsoft',
    fields: [],
    hint: 'Edge 浏览器内置的免费接口，学术文本质量好、支持批量，国内可直连。',
  },
  google: {
    label: '谷歌翻译（免费）',
    group: '免费',
    kind: 'google',
    fields: [],
    hint: '经典 gtx 接口，无需 Key；国内网络通常需要代理。',
  },
  yandex: {
    label: 'Yandex 翻译（免费）',
    group: '免费',
    kind: 'yandex',
    fields: [],
    hint: 'Yandex 网页翻译接口，无需 Key；中文只支持简体。',
  },
  tencent: {
    label: '腾讯交互翻译（免费）',
    group: '免费',
    kind: 'tencent',
    fields: [],
    hint: '腾讯交互翻译的网页接口，无需 Key，国内直连。',
  },
  volc: {
    label: '火山翻译（免费网页版）',
    group: '免费',
    kind: 'volc',
    fields: [],
    hint: '火山引擎浏览器扩展使用的免费接口，无需 Key，国内直连。',
  },
  deeplx: {
    label: 'DeepLX（自建 / 公共）',
    group: '免费',
    kind: 'deeplx',
    needsKey: false,
    defaults: { baseUrl: 'http://127.0.0.1:1188/translate' },
    fields: [
      F.baseUrl('DeepLX 地址', 'http://127.0.0.1:1188/translate'),
      F.apiKey('Token（可选，留空表示无鉴权）', ''),
    ],
    hint: '需要先在本地或服务器跑一个 DeepLX（Docker 默认 1188 端口），译文接近 DeepL 官方质量。',
  },

  /* ------------------------------- 官方机器翻译 ------------------------------- */
  deepl: {
    label: 'DeepL 官方（Free / Pro）',
    group: '官方 API',
    kind: 'deepl',
    defaults: { baseUrl: 'https://api-free.deepl.com', model: 'ZH' },
    fields: [
      F.apiKey('DeepL Auth Key', 'xxxxxxxx-xxxx-...:fx'),
      F.baseUrl('接口地址', 'https://api-free.deepl.com'),
      { key: 'model', label: '目标语言（ZH / ZH-HANS / JA …）', placeholder: 'ZH', type: 'text' },
    ],
    hint: 'Free 套餐用 api-free.deepl.com，Pro 套餐改成 api.deepl.com。密钥后缀 :fx 一般代表 Free。',
  },
  baidu: {
    label: '百度翻译开放平台',
    group: '官方 API',
    kind: 'baidu',
    fields: [F.appId('APP ID'), F.apiKey('密钥', '')],
    hint: '在百度翻译开放平台申请「通用文本翻译」，标准版每月有免费额度。',
  },

  /* ---------------------------------- AI ---------------------------------- */
  deepseek: {
    label: 'DeepSeek',
    group: 'AI 大模型',
    kind: 'openai',
    defaults: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
    fields: [F.apiKey(), F.model('模型', 'deepseek-chat'), F.baseUrl('接口地址', 'https://api.deepseek.com/v1')],
    hint: '中文质量好、价格低，适合整篇论文翻译。',
  },
  gemini: {
    label: 'Google Gemini',
    group: 'AI 大模型',
    kind: 'gemini',
    defaults: { model: 'gemini-2.0-flash' },
    fields: [F.apiKey('API Key', 'AIza...'), F.model('模型', 'gemini-2.0-flash'), F.baseUrl('代理地址（可选）', '')],
    hint: '免费额度较大，长段落表现不错。代理地址留空即走官方接口。',
  },
  claude: {
    label: 'Anthropic Claude',
    group: 'AI 大模型',
    kind: 'claude',
    defaults: { model: 'claude-3-5-haiku-latest' },
    fields: [F.apiKey('API Key', 'sk-ant-...'), F.model('模型', 'claude-3-5-haiku-latest'), F.baseUrl('代理地址（可选）', '')],
  },
  openai: {
    label: 'OpenAI',
    group: 'AI 大模型',
    kind: 'openai',
    defaults: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    fields: [F.apiKey(), F.model('模型', 'gpt-4o-mini'), F.baseUrl('接口地址', 'https://api.openai.com/v1')],
  },
  zhipu: {
    label: '智谱 GLM',
    group: 'AI 大模型',
    kind: 'openai',
    defaults: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    fields: [F.apiKey(), F.model('模型', 'glm-4-flash'), F.baseUrl('接口地址', 'https://open.bigmodel.cn/api/paas/v4')],
  },
  moonshot: {
    label: '月之暗面 Kimi',
    group: 'AI 大模型',
    kind: 'openai',
    defaults: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    fields: [F.apiKey(), F.model('模型', 'moonshot-v1-8k'), F.baseUrl('接口地址', 'https://api.moonshot.cn/v1')],
  },
  siliconflow: {
    label: '硅基流动 SiliconFlow',
    group: 'AI 大模型',
    kind: 'openai',
    defaults: { baseUrl: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
    fields: [F.apiKey(), F.model('模型', 'Qwen/Qwen2.5-7B-Instruct'), F.baseUrl('接口地址', 'https://api.siliconflow.cn/v1')],
  },
  ollama: {
    label: 'Ollama（本地模型）',
    group: 'AI 大模型',
    kind: 'openai',
    needsKey: false,
    defaults: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
    fields: [F.baseUrl('接口地址', 'http://127.0.0.1:11434/v1'), F.model('模型', 'qwen2.5:7b')],
    hint: '需要先 ollama pull 一个模型。完全本地，不上传论文内容。',
  },
  custom: {
    label: '自定义（OpenAI 兼容）',
    group: 'AI 大模型',
    kind: 'openai',
    fields: [F.apiKey(), F.model('模型', ''), F.baseUrl('接口地址', 'https://example.com/v1')],
    hint: '任何兼容 /chat/completions 的服务：vLLM、OneAPI、Kimi、通义、Azure OpenAI 代理等。',
  },

  /* --------------------------------- 其它 --------------------------------- */
  mymemory: {
    label: 'MyMemory（免费）',
    group: '其它',
    kind: 'mymemory',
    needsKey: false,
    fields: [{ key: 'apiKey', label: '联系邮箱（可选，能提高额度）', placeholder: '', type: 'text' }],
    hint: '公开记忆库，每日有字符限额，长段落会被截断，仅作应急。',
  },
};

/** 给前端用的精简元信息（不含任何密钥） */
function publicCatalog() {
  return Object.entries(PROVIDERS).map(([key, p]) => {
    const fields = p.fields || [];
    const derivedKey = fields.some((f) => f.key === 'apiKey' || f.key === 'appId');
    return {
      key,
      label: p.label,
      group: p.group,
      kind: p.kind,
      needsKey: p.needsKey === undefined ? derivedKey : p.needsKey,
      fields,
      defaults: p.defaults || {},
      hint: p.hint || '',
    };
  });
}

function getProvider(key) {
  return PROVIDERS[key] || null;
}

export { PROVIDERS, publicCatalog, getProvider };
