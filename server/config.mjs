/**
 * 模型配置存取。
 * 优先读取 data/config.json；没有落盘配置时回退到环境变量（适合部署场景）。
 * api_key 只存在于服务端，回传给前端时永远是被掩码的。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptSecret, encryptSecret } from './secret.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/** 运行时配置默认放在用户目录，避免 API Key 被误提交进仓库；可用环境变量覆盖 */
export const DATA_DIR = path.resolve(
  process.env.PAPERLENS_DATA_DIR || path.join(os.homedir(), '.paperlens'),
);
const CONFIG_PATH = process.env.PAPERLENS_CONFIG
  ? path.resolve(process.env.PAPERLENS_CONFIG)
  : path.join(DATA_DIR, 'config.json');
/** 旧版本把配置放在仓库内，首次启动会自动迁移到上面的位置 */
const LEGACY_CONFIG_PATH = path.join(ROOT, 'data', 'config.json');

/** 常用服务商预设：都是 OpenAI 兼容端点，切模型只改三个字段 */
export const PRESETS = {
  deepseek: {
    label: 'DeepSeek',
    base_url: 'https://api.deepseek.com/v1',
    model: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-flash', 'deepseek-v4-pro', 'deepseek-chat', 'deepseek-reasoner'],
    temperature: 0.3,
    note: 'deepseek-v4-flash 是 Flash 线路的兼容名，官方新名 deepseek-flash 指向同一模型',
  },
  kimi: {
    label: 'Kimi / Moonshot',
    base_url: 'https://api.moonshot.cn/v1',
    model: 'kimi-k2-0905-preview',
    models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview', 'moonshot-v1-128k'],
    temperature: 0.3,
  },
  openai: {
    label: 'OpenAI',
    base_url: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'o4-mini'],
    temperature: 0.3,
  },
  zhipu: {
    label: '智谱 GLM',
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-plus',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    temperature: 0.3,
  },
  ollama: {
    label: 'Ollama 本地',
    base_url: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    models: ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.1:8b'],
    temperature: 0.3,
  },
  custom: {
    label: '自定义 OpenAI 兼容',
    base_url: '',
    model: '',
    models: [],
    temperature: 0.3,
  },
};

export const DEFAULT_CONFIG = {
  provider: 'deepseek',
  base_url: PRESETS.deepseek.base_url,
  model: PRESETS.deepseek.model,
  api_key: '',
  /** null = 请求里不发送 max_tokens，由模型/服务商自行决定上限 */
  max_tokens: null,
  temperature: PRESETS.deepseek.temperature,
  /** 原样合并进请求体，用于服务商私有开关（例如关闭深度思考） */
  extra_body: null,
};

const MAX_TOKENS_CAP = 131072;
/** 配置结构版本：用于把旧配置迁移到更合理的默认值 */
const CONFIG_VERSION = 3;

const MASK = '••••••••';

/** 运行时解锁状态：明文 Key 只在内存里，不写盘 */
let unlockedKey = '';

function envKey() {
  return String(process.env.PAPERLENS_API_KEY || process.env.OPENAI_API_KEY || '').trim();
}

/** 从进程内存或 PAPERLENS_PASSPHRASE 解出密文里的 Key（都不可用时返回空） */
function resolveEncryptedKey(file) {
  if (!file?.api_key_enc) return '';
  if (unlockedKey) return unlockedKey;
  const pass = String(process.env.PAPERLENS_PASSPHRASE || '');
  if (!pass) return '';
  const key = decryptSecret(file.api_key_enc, pass) || '';
  if (key) unlockedKey = key;
  return key;
}

/** 用主密码解锁（验证通过后只缓存在内存） */
export function unlockConfig(passphrase) {
  const file = readFileConfig();
  if (!file?.api_key_enc) return { ok: false, error: '当前没有加密的 API Key' };
  const key = decryptSecret(file.api_key_enc, passphrase);
  if (!key) return { ok: false, error: '主密码不正确' };
  unlockedKey = key;
  return { ok: true, config: publicConfig() };
}

/** 忘记主密码时只能清除 Key 后重设 */
export function lockConfig() {
  unlockedKey = '';
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function readFileConfig() {
  const current = readJson(CONFIG_PATH);
  if (current) return current;
  // 兼容旧版本：把仓库内的 data/config.json 自动迁移到用户目录
  if (CONFIG_PATH === LEGACY_CONFIG_PATH) return null;
  const legacy = readJson(LEGACY_CONFIG_PATH);
  if (!legacy) return null;
  try {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
    console.log(`  ➜  已把旧配置迁移到 ${CONFIG_PATH}（仓库内的 data/config.json 可以删除）`);
  } catch {
    /* 迁移失败也先用旧配置启动，不阻塞 */
  }
  return legacy;
}

function fromEnv() {
  const env = process.env;
  if (!env.PAPERLENS_API_KEY && !env.OPENAI_API_KEY) return null;
  const preset = DEFAULT_CONFIG;
  return {
    provider: env.PAPERLENS_PROVIDER || preset.provider,
    base_url: env.PAPERLENS_BASE_URL || env.OPENAI_BASE_URL || preset.base_url,
    model: env.PAPERLENS_MODEL || env.OPENAI_MODEL || preset.model,
    api_key: env.PAPERLENS_API_KEY || env.OPENAI_API_KEY,
    max_tokens: Number(env.PAPERLENS_MAX_TOKENS || preset.max_tokens),
    temperature: Number(env.PAPERLENS_TEMPERATURE || preset.temperature),
  };
}

/** 按 base_url 反查预设，避免改了地址但 provider 还停在旧值 */
export function detectProvider(baseUrl) {
  const raw = String(baseUrl || '').trim();
  if (!raw) return null;
  let host;
  try {
    host = new URL(raw).host.toLowerCase();
  } catch {
    return null;
  }
  for (const [key, preset] of Object.entries(PRESETS)) {
    if (key === 'custom' || !preset.base_url) continue;
    try {
      if (new URL(preset.base_url).host.toLowerCase() === host) return key;
    } catch {
      /* 预设地址非法就跳过 */
    }
  }
  return null;
}

/** extra_body 允许传对象或 JSON 字符串；空值表示清空 */
function normalizeExtraBody(value) {
  if (value === null || value === undefined || value === '') return null;
  let obj = value;
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value);
    } catch {
      throw new Error('「额外请求参数」不是合法 JSON');
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('「额外请求参数」必须是 JSON 对象，例如 {"thinking": {"type": "disabled"}}');
  }
  return obj;
}

/** 内部用：含明文 key */
export function loadConfig() {
  const file = readFileConfig();
  const base = file || fromEnv() || DEFAULT_CONFIG;
  const cfg = { ...DEFAULT_CONFIG, ...base };
  cfg.max_tokens = normalizeMaxTokens(cfg.max_tokens, DEFAULT_CONFIG.max_tokens);
  cfg.temperature = clampNum(cfg.temperature, 0, 2, DEFAULT_CONFIG.temperature);
  cfg.base_url = String(cfg.base_url || '').trim();
  cfg.model = String(cfg.model || '').trim();
  if (file?.api_key_enc) {
    // 密文：优先用内存里已解锁的 Key，其次 PAPERLENS_PASSPHRASE，最后环境变量
    const key = resolveEncryptedKey(file) || envKey();
    cfg.api_key = key;
    cfg.locked = !key;
  } else {
    cfg.api_key = String(cfg.api_key || '').trim();
    cfg.locked = false;
  }
  delete cfg.api_key_enc;
  cfg.provider = String(cfg.provider || DEFAULT_CONFIG.provider).trim();

  // 地址和服务商对不上时以地址为准（改地址忘了换 provider 是最常见的配置错误）
  const detected = detectProvider(cfg.base_url);
  if (detected) cfg.provider = detected;

  try {
    cfg.extra_body = normalizeExtraBody(cfg.extra_body);
  } catch {
    cfg.extra_body = null;
  }

  if (file) migrateInPlace(cfg);
  return cfg;
}

/**
 * 旧版本把 max_tokens 硬编码成 4096 / 8192，会截断长精读。
 * v3 起默认不发送该字段（由模型决定），这里把历史默认值清掉。
 */
function migrateInPlace(cfg) {
  const version = Number(cfg.config_version || 1);
  if (version >= CONFIG_VERSION) return;
  if (version < 3) {
    const current = Number(cfg.max_tokens);
    if (!Number.isFinite(current) || current === 0 || current === 4096 || current === 8192) {
      cfg.max_tokens = null;
    }
  }
  cfg.config_version = CONFIG_VERSION;
  try {
    // 基于磁盘上的原始内容写回，避免把内存里的解密 Key 落成明文
    const raw = readJson(CONFIG_PATH) || {};
    const next = { ...raw, max_tokens: cfg.max_tokens, config_version: CONFIG_VERSION };
    if (next.api_key_enc) delete next.api_key;
    fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  } catch {
    /* 写不进去也不影响本次读取 */
  }
}

/** 回传给前端：key 打码 */
export function publicConfig() {
  const cfg = loadConfig();
  return {
    provider: cfg.provider,
    base_url: cfg.base_url,
    model: cfg.model,
    max_tokens: cfg.max_tokens,
    temperature: cfg.temperature,
    extra_body: cfg.extra_body,
    has_key: Boolean(cfg.api_key),
    api_key_masked: cfg.api_key ? MASK : '',
    locked: Boolean(cfg.locked),
    ready: Boolean(cfg.base_url && cfg.model && cfg.api_key),
    source: readFileConfig() ? 'file' : fromEnv() ? 'env' : 'default',
    encrypted: Boolean(readFileConfig()?.api_key_enc),
    config_path: CONFIG_PATH,
  };
}

/**
 * 保存配置。前端传来的 api_key 若是掩码或空串，表示"不修改"，沿用已有明文 key。
 */
export function saveConfig(patch = {}) {
  const file = readFileConfig() || {};
  const current = loadConfig();
  const next = { ...file, ...current };
  const passphrase = String(patch.passphrase || '').trim();

  if (typeof patch.provider === 'string' && patch.provider) next.provider = patch.provider.trim();
  if (typeof patch.base_url === 'string') next.base_url = patch.base_url.trim().replace(/\/+$/, '');
  if (typeof patch.model === 'string') next.model = patch.model.trim();
  if (patch.max_tokens !== undefined) next.max_tokens = normalizeMaxTokens(patch.max_tokens, next.max_tokens);
  if (patch.temperature !== undefined) next.temperature = clampNum(patch.temperature, 0, 2, current.temperature);
  if (patch.extra_body !== undefined) next.extra_body = normalizeExtraBody(patch.extra_body);

  // 地址一变就重新识别服务商，顺手补上该服务商的默认模型名
  const detected = detectProvider(next.base_url);
  if (detected) {
    next.provider = detected;
    if (!next.model) next.model = PRESETS[detected].model;
  } else if (next.base_url) {
    next.provider = 'custom';
  }

  let savedNewKey = false;
  if (patch.clear_key) {
    next.api_key = '';
    delete next.api_key_enc;
    unlockedKey = '';
  } else if (typeof patch.api_key === 'string') {
    const incoming = patch.api_key.trim();
    const isMasked = incoming.includes('•') || /^\*+$/.test(incoming);
    if (incoming && !isMasked) {
      if (!passphrase) throw new Error('保存 API Key 需要同时设置主密码（用于加密存储）');
      next.api_key_enc = encryptSecret(incoming, passphrase);
      next.api_key = '';
      unlockedKey = incoming;
      savedNewKey = true;
    }
  }

  // 没有提交新 Key，但提供了主密码：解锁已有密文，或把历史明文迁移成密文
  if (!savedNewKey && passphrase) {
    if (next.api_key_enc) {
      const key = decryptSecret(next.api_key_enc, passphrase);
      if (!key) throw new Error('主密码不正确');
      unlockedKey = key;
    } else if (next.api_key) {
      const plain = String(next.api_key);
      next.api_key_enc = encryptSecret(plain, passphrase);
      next.api_key = '';
      unlockedKey = plain;
    }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const toWrite = { ...next, config_version: CONFIG_VERSION };
  delete toWrite.locked;
  // 有密文时绝不写明文；Key 为空也不保留字段
  if (toWrite.api_key_enc) delete toWrite.api_key;
  if (!toWrite.api_key || !String(toWrite.api_key).trim()) delete toWrite.api_key;
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(toWrite, null, 2)}\n`, 'utf8');
  return publicConfig();
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** max_tokens：空 / 0 / 非法 → null（不发送，由模型决定），否则夹到合理区间 */
function normalizeMaxTokens(value, fallback = null) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(MAX_TOKENS_CAP, Math.max(256, n)) || fallback;
}

function clampNum(v, min, max, fallback) {
  const n = Number.parseFloat(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
