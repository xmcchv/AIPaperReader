/**
 * 费用估算：按内置参考价计算，单位统一为「元 / 百万 tokens」。
 * 数据来源见 docs/用量统计与费用估算方案.md；价格会变，结果仅供估算，
 * 界面需注明「以服务商账单为准」。用户可在 config.json 的 pricing 里覆盖单价。
 */

// 1 USD ≈ 7.2 CNY（估算用固定汇率，避免引入实时汇率依赖）
const USD = 7.2;
const usd = (inPrice, outPrice) => ({
  cached: 0,
  input: Math.round(inPrice * USD * 1000) / 1000,
  output: Math.round(outPrice * USD * 1000) / 1000,
});

/**
 * 内置价格表。精确匹配优先，前缀匹配兜底（如 deepseek-v4-flash-xxx）。
 * peak: true 表示该价格是高峰价，空闲时段乘 0.5（仅 DeepSeek V4 系列）。
 */
const BUILTIN = {
  // DeepSeek V4 系列：高峰价，北京时间 9-12 / 14-18 高峰，其余空闲半价
  'deepseek-v4-flash': { cached: 0.1, input: 3, output: 9, peak: true },
  'deepseek-flash': { cached: 0.1, input: 3, output: 9, peak: true },
  'deepseek-v4-pro': { cached: 0.3, input: 9, output: 27, peak: true },
  // 旧线路兼容名（2026-07-24 后指向 v4-flash，但价格单列）
  'deepseek-chat': { cached: 0.02, input: 1, output: 2 },
  'deepseek-reasoner': { cached: 0.02, input: 1, output: 2 },
  // OpenAI（美元价换算成人民币）
  'gpt-4o-mini': usd(0.15, 0.6),
  'gpt-4o': usd(2.5, 10),
  'gpt-4.1-mini': usd(0.4, 1.6),
  'o4-mini': usd(1.1, 4.4),
  // Kimi（官方人民币价）
  'kimi-k2-0905-preview': { cached: 0, input: 4.32, output: 18 },
  'kimi-k2-turbo-preview': { cached: 0, input: 4.32, output: 18 },
  'moonshot-v1-128k': { cached: 0, input: 2.16, output: 8.64 },
  // 智谱 GLM（人民币价）
  'glm-4-plus': { cached: 0, input: 0.5, output: 1 },
  'glm-4-air': { cached: 0, input: 0.15, output: 0.3 },
  'glm-4-flash': { cached: 0, input: 0, output: 0 },
};

/** 本地模型：视为免费。custom 端点可能接任何服务，不给默认价，走「未配置单价」 */
const FREE_PROVIDERS = new Set(['ollama']);

/**
 * 峰谷判定：DeepSeek V4 系列，北京时间 9-12 / 14-18 为高峰。
 * @param {number} atMs 调用时刻的时间戳（毫秒）
 */
export function isPeakHour(atMs = Date.now()) {
  const d = new Date(atMs);
  const beijingHour = (d.getUTCHours() + 8) % 24;
  return (beijingHour >= 9 && beijingHour < 12) || (beijingHour >= 14 && beijingHour < 18);
}

/** 取价格：用户自定义 > 内置精确 > 内置前缀 > null */
export function resolvePrice(provider, model, overrides = {}) {
  if (FREE_PROVIDERS.has(String(provider || '').toLowerCase())) {
    return { cached: 0, input: 0, output: 0, peak: false };
  }
  const name = String(model || '').toLowerCase();
  const custom = overrides?.[name] || overrides?.[model];
  if (custom && typeof custom === 'object') {
    return {
      cached: Number(custom.cached) || 0,
      input: Number(custom.input) || 0,
      output: Number(custom.output) || 0,
      peak: Boolean(custom.peak),
    };
  }
  if (BUILTIN[name]) return { ...BUILTIN[name] };
  const prefix = Object.keys(BUILTIN).find((k) => name.startsWith(k));
  return prefix ? { ...BUILTIN[prefix] } : null;
}

/**
 * 计算费用（元）。
 * @returns {number|null} 单价缺失时返回 null；否则返回金额
 */
export function estimateCost(usage, provider, model, { overrides = {}, at = Date.now() } = {}) {
  if (!usage) return null;
  const price = resolvePrice(provider, model, overrides);
  if (!price) return null;

  const scale = price.peak && !isPeakHour(at) ? 0.5 : 1;
  const prompt = Number(usage.prompt) || 0;
  const cached = Math.min(Number(usage.cached) || 0, prompt);
  const completion = Number(usage.completion) || 0;

  const cost =
    (cached / 1e6) * price.cached * scale +
    ((prompt - cached) / 1e6) * price.input * scale +
    (completion / 1e6) * price.output * scale;

  return Math.round(cost * 1e6) / 1e6;
}

/** 金额格式化：小额也可见，保留到 6 位小数再去掉尾零 */
export function formatCost(cost) {
  if (cost === null || cost === undefined || !Number.isFinite(Number(cost))) return '未配置单价';
  const v = Number(cost);
  if (v <= 0) return '¥0';
  if (v < 0.000001) return '<¥0.000001';
  return `¥${v.toFixed(6).replace(/0+$/, '').replace(/\.$/, '')}`;
}
