/**
 * usage 归一化：各家 OpenAI 兼容接口返回的 token 字段不完全一致，
 * 这里统一成 { prompt, completion, cached, total }，并容忍字段缺失。
 */

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

/**
 * @param {object|null|undefined} raw 服务商返回的 usage 对象
 * @returns {{prompt:number, completion:number, cached:number, total:number}|null}
 */
export function normalizeUsage(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const prompt = num(raw.prompt_tokens ?? raw.input_tokens);
  const completion = num(raw.completion_tokens ?? raw.output_tokens);
  if (!prompt && !completion) return null;

  // 缓存命中：OpenAI 用 prompt_tokens_details.cached_tokens，
  // DeepSeek 也会给 prompt_cache_hit_tokens / prompt_cache_miss_tokens
  const details = raw.prompt_tokens_details && typeof raw.prompt_tokens_details === 'object' ? raw.prompt_tokens_details : {};
  let cached = num(details.cached_tokens ?? raw.prompt_cache_hit_tokens);
  // 若只有 miss 字段，也能反推：cached = prompt - miss
  if (!cached && num(raw.prompt_cache_miss_tokens) && prompt) {
    cached = Math.max(0, prompt - num(raw.prompt_cache_miss_tokens));
  }
  cached = Math.min(cached, prompt);

  const total = num(raw.total_tokens) || prompt + completion;
  return { prompt, completion, cached, total };
}

/** 短格式：1.2k / 12.3k，状态栏用 */
export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(v);
}
