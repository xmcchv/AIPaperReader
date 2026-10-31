/**
 * 统一模型配置存取（PaperLens 精读 + 知识图谱共用）。
 *
 * 读取顺序：
 *   1) ~/.paperlens/config.json（规范位置，自己保存的配置）
 *   2) $PAPERLENS_DATA_DIR/config.json（旧版数据目录写法）
 *   3) 仓库内 data/config.json（更早的版本，首次启动自动迁移）
 *   4) ~/.kgraph/config.json（知识图谱旧配置，只读回退，不覆盖）
 *   5) 环境变量（PAPERLENS_* 优先，KGRAPH_* 作为别名）
 *
 * api_key 只存在于服务端内存，回传给前端时永远是被掩码的。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decryptSecret, encryptSecret } from './secret.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 配置与数据的根目录（默认 ~/.paperlens） */
export const HOME_DIR = path.resolve(process.env.PAPERLENS_HOME || path.join(os.homedir(), '.paperlens'));
/** 知识库 / 论文库 / 素材的落盘位置：默认 ~/.paperlens/data */
export const DATA_DIR = path.resolve(process.env.PAPERLENS_DATA_DIR || path.join(HOME_DIR, 'data'));
/** 规范配置文件 */
const CONFIG_PATH = process.env.PAPERLENS_CONFIG
  ? path.resolve(process.env.PAPERLENS_CONFIG)
  : path.join(HOME_DIR, 'config.json');
/** 旧版把配置放在数据目录下，继续兼容读取 */
const LEGACY_DATA_CONFIG_PATH = path.join(DATA_DIR, 'config.json');
/** 更早的版本把配置放在仓库内，首次启动会自动迁移 */
const LEGACY_CONFIG_PATH = path.join(ROOT, 'data', 'config.json');
/** 知识图谱旧配置：只读回退 */
const KGRAPH_CONFIG_PATH = process.env.KGRAPH_CONFIG
  ? path.resolve(process.env.KGRAPH_CONFIG)
  : path.join(os.homedir(), '.kgraph', 'config.json');

/** readFileConfig() 之后记录这份配置来自哪里 */
let configOrigin = 'default';

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
  /** 视觉模型（可选）：留空表示图片只归档、不做识别 */
  vision_model: '',
  vision_base_url: '',
  vision_api_key: '',
};

const MAX_TOKENS_CAP = 131072;
/** 配置结构版本：用于把旧配置迁移到更合理的默认值 */
const CONFIG_VERSION = 4;

const MASK = '••••••••';

/** 运行时解锁状态：明文 Key 只在内存里，不写盘 */
let unlockedKey = '';
let unlockedVisionKey = '';

function envKey() {
  return String(
    process.env.PAPERLENS_API_KEY || process.env.KGRAPH_API_KEY || process.env.OPENAI_API_KEY || '',
  ).trim();
}

/** 从进程内存或主密码环境变量解出密文里的 Key（都不可用时返回空） */
function passphraseFromEnv() {
  return String(process.env.PAPERLENS_PASSPHRASE || process.env.KGRAPH_PASSPHRASE || '');
}

function resolveEncryptedSecret(file, field, cache) {
  if (!file?.[field]) return '';
  if (cache.value) return cache.value;
  const pass = passphraseFromEnv();
  if (!pass) return '';
  const key = decryptSecret(file[field], pass) || '';
  if (key) cache.value = key;
  return key;
}

const keyCache = { get value() { return unlockedKey; }, set value(v) { unlockedKey = v; } };
const visionCache = { get value() { return unlockedVisionKey; }, set value(v) { unlockedVisionKey = v; } };

function resolveEncryptedKey(file) {
  return resolveEncryptedSecret(file, 'api_key_enc', keyCache);
}

function resolveEncryptedVisionKey(file) {
  return resolveEncryptedSecret(file, 'vision_api_key_enc', visionCache);
}

/** 用主密码解锁（验证通过后只缓存在内存） */
export function unlockConfig(passphrase) {
  const file = readFileConfig();
  const pass = String(passphrase || '').trim();
  if (!pass) return { ok: false, error: '请输入主密码' };
  const hasKey = Boolean(file?.api_key_enc);
  const hasVision = Boolean(file?.vision_api_key_enc);
  if (!hasKey && !hasVision) return { ok: false, error: '当前没有加密的 API Key' };

  let hit = false;
  if (hasKey) {
    const key = decryptSecret(file.api_key_enc, pass);
    if (key) {
      unlockedKey = key;
      hit = true;
    }
  }
  if (hasVision) {
    const vkey = decryptSecret(file.vision_api_key_enc, pass);
    if (vkey) {
      unlockedVisionKey = vkey;
      hit = true;
    }
  }
  if (!hit) return { ok: false, error: '主密码不正确' };
  return { ok: true, config: publicConfig() };
}

/** 忘记主密码时只能清除 Key 后重设 */
export function lockConfig() {
  unlockedKey = '';
  unlockedVisionKey = '';
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
  if (current) {
    configOrigin = 'file';
    return current;
  }
  // 旧版把配置放在数据目录下
  if (LEGACY_DATA_CONFIG_PATH !== CONFIG_PATH) {
    const dataCfg = readJson(LEGACY_DATA_CONFIG_PATH);
    if (dataCfg) {
      configOrigin = 'file';
      return dataCfg;
    }
  }
  // 更早的版本放在仓库内：自动迁移到用户目录
  if (CONFIG_PATH !== LEGACY_CONFIG_PATH) {
    const legacy = readJson(LEGACY_CONFIG_PATH);
    if (legacy) {
      try {
        fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
        fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(legacy, null, 2)}\n`, 'utf8');
        console.log(`  ➜  已把旧配置迁移到 ${CONFIG_PATH}（仓库内的 data/config.json 可以删除）`);
      } catch {
        /* 迁移失败也先用旧配置启动，不阻塞 */
      }
      configOrigin = 'file';
      return legacy;
    }
  }
  // 知识图谱的旧配置：只读回退，不覆盖
  const kg = readJson(KGRAPH_CONFIG_PATH);
  if (kg && (kg.api_key_enc || kg.api_key || kg.vision_api_key_enc || kg.vision_api_key)) {
    configOrigin = 'kgraph';
    return kg;
  }
  return null;
}

function envVisionKey() {
  return String(
    process.env.PAPERLENS_VISION_API_KEY || process.env.KGRAPH_VISION_API_KEY || '',
  ).trim();
}

function fromEnv() {
  const env = process.env;
  const apiKey = env.PAPERLENS_API_KEY || env.KGRAPH_API_KEY || env.OPENAI_API_KEY;
  if (!apiKey) return null;
  const preset = DEFAULT_CONFIG;
  return {
    provider: env.PAPERLENS_PROVIDER || env.KGRAPH_PROVIDER || preset.provider,
    base_url: env.PAPERLENS_BASE_URL || env.KGRAPH_BASE_URL || env.OPENAI_BASE_URL || preset.base_url,
    model: env.PAPERLENS_MODEL || env.KGRAPH_MODEL || env.OPENAI_MODEL || preset.model,
    api_key: apiKey,
    max_tokens: Number(env.PAPERLENS_MAX_TOKENS || env.KGRAPH_MAX_TOKENS || preset.max_tokens),
    temperature: Number(env.PAPERLENS_TEMPERATURE || env.KGRAPH_TEMPERATURE || preset.temperature),
    vision_model: env.PAPERLENS_VISION_MODEL || env.KGRAPH_VISION_MODEL || '',
    vision_base_url: env.PAPERLENS_VISION_BASE_URL || env.KGRAPH_VISION_BASE_URL || '',
    vision_api_key: envVisionKey(),
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
  const env = fromEnv();
  const base = file || env || DEFAULT_CONFIG;
  const cfg = { ...DEFAULT_CONFIG, ...base };
  cfg.max_tokens = normalizeMaxTokens(cfg.max_tokens, DEFAULT_CONFIG.max_tokens);
  cfg.temperature = clampNum(cfg.temperature, 0, 2, DEFAULT_CONFIG.temperature);
  cfg.base_url = String(cfg.base_url || '').trim();
  cfg.model = String(cfg.model || '').trim();
  cfg.vision_model = String(cfg.vision_model || '').trim();
  cfg.vision_base_url = String(cfg.vision_base_url || '').trim();

  if (file) {
    // 密文：优先用内存里已解锁的 Key，其次主密码环境变量，最后环境变量
    cfg.api_key =
      (file.api_key_enc ? resolveEncryptedKey(file) : String(file.api_key || '').trim()) || envKey();
    cfg.locked = Boolean(file.api_key_enc) && !cfg.api_key;
    cfg.vision_api_key =
      (file.vision_api_key_enc
        ? resolveEncryptedVisionKey(file)
        : String(file.vision_api_key || '').trim()) || envVisionKey();
    cfg.vision_locked = Boolean(file.vision_api_key_enc) && !cfg.vision_api_key;
  } else {
    cfg.api_key = String(cfg.api_key || '').trim();
    cfg.vision_api_key = String(cfg.vision_api_key || '').trim();
    cfg.locked = false;
    cfg.vision_locked = false;
  }
  delete cfg.api_key_enc;
  delete cfg.vision_api_key_enc;
  cfg.provider = String(cfg.provider || DEFAULT_CONFIG.provider).trim();

  // 地址和服务商对不上时以地址为准（改地址忘了换 provider 是最常见的配置错误）
  const detected = detectProvider(cfg.base_url);
  if (detected) cfg.provider = detected;

  try {
    cfg.extra_body = normalizeExtraBody(cfg.extra_body);
  } catch {
    cfg.extra_body = null;
  }

  cfg.ready = Boolean(cfg.base_url && cfg.model && cfg.api_key);
  cfg.vision_ready = Boolean(
    (cfg.vision_base_url || cfg.base_url) && cfg.vision_model && (cfg.vision_api_key || cfg.api_key),
  );
  cfg.source = file ? configOrigin : env ? 'env' : 'default';
  cfg.encrypted = Boolean(file?.api_key_enc);
  cfg.config_path = CONFIG_PATH;
  cfg.data_dir = DATA_DIR;

  if (file) migrateInPlace(cfg, file);
  return cfg;
}

/**
 * 旧版本把 max_tokens 硬编码成 4096 / 8192，会截断长精读。
 * v3 起默认不发送该字段（由模型决定），这里把历史默认值清掉。
 */
function migrateInPlace(cfg, file) {
  const version = Number(cfg.config_version || file?.config_version || 1);
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
    const raw = file ? { ...file } : readJson(CONFIG_PATH) || {};
    const next = { ...raw, max_tokens: cfg.max_tokens, config_version: CONFIG_VERSION };
    if (next.api_key_enc) delete next.api_key;
    if (next.vision_api_key_enc) delete next.vision_api_key;
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
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
    vision_model: cfg.vision_model,
    vision_base_url: cfg.vision_base_url,
    has_key: Boolean(cfg.api_key),
    has_vision_key: Boolean(cfg.vision_api_key),
    api_key_masked: cfg.api_key ? MASK : '',
    locked: Boolean(cfg.locked),
    vision_locked: Boolean(cfg.vision_locked),
    ready: Boolean(cfg.ready),
    vision_ready: Boolean(cfg.vision_ready),
    source: cfg.source,
    encrypted: Boolean(cfg.encrypted),
    config_path: CONFIG_PATH,
    data_dir: DATA_DIR,
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
  if (typeof patch.vision_model === 'string') next.vision_model = patch.vision_model.trim();
  if (typeof patch.vision_base_url === 'string') {
    next.vision_base_url = patch.vision_base_url.trim().replace(/\/+$/, '');
  }

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

  // 视觉模型 Key：空串表示清除（与知识图谱侧原有语义一致）
  if (patch.clear_vision_key) {
    delete next.vision_api_key_enc;
    delete next.vision_api_key;
    unlockedVisionKey = '';
  } else if (typeof patch.vision_api_key === 'string') {
    const incoming = patch.vision_api_key.trim();
    const isMasked = incoming.includes('•') || /^\*+$/.test(incoming);
    if (incoming && !isMasked) {
      if (!passphrase) throw new Error('保存视觉模型 Key 需要同时设置主密码（用于加密存储）');
      next.vision_api_key_enc = encryptSecret(incoming, passphrase);
      delete next.vision_api_key;
      unlockedVisionKey = incoming;
    } else if (!incoming) {
      delete next.vision_api_key_enc;
      delete next.vision_api_key;
      unlockedVisionKey = '';
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
  if (passphrase) {
    if (next.vision_api_key_enc && !unlockedVisionKey) {
      const vkey = decryptSecret(next.vision_api_key_enc, passphrase);
      if (!vkey) throw new Error('主密码不正确');
      unlockedVisionKey = vkey;
    } else if (!next.vision_api_key_enc && next.vision_api_key) {
      const plain = String(next.vision_api_key);
      next.vision_api_key_enc = encryptSecret(plain, passphrase);
      delete next.vision_api_key;
      unlockedVisionKey = plain;
    }
  }

  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  const toWrite = { ...next, config_version: CONFIG_VERSION };
  // 运行时字段不落盘
  for (const key of [
    'locked',
    'vision_locked',
    'ready',
    'vision_ready',
    'source',
    'encrypted',
    'config_path',
    'data_dir',
    'has_key',
    'has_vision_key',
    'api_key_masked',
  ]) {
    delete toWrite[key];
  }
  // 有密文时绝不写明文；Key 为空也不保留字段
  if (toWrite.api_key_enc) delete toWrite.api_key;
  if (toWrite.vision_api_key_enc) delete toWrite.vision_api_key;
  if (!toWrite.api_key || !String(toWrite.api_key).trim()) delete toWrite.api_key;
  if (!toWrite.vision_api_key || !String(toWrite.vision_api_key).trim()) delete toWrite.vision_api_key;
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
