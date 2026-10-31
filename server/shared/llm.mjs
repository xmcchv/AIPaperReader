/**
 * OpenAI 兼容协议客户端：只要服务商提供 /chat/completions 就能用。
 * 不引任何 SDK，纯 fetch + SSE 手写解析，Node 18+ 内置即可运行。
 */

/** 把用户填的 base_url 归一化成 chat/completions 完整地址 */
export function chatCompletionsUrl(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new LlmError('缺少 Base URL，请先在「模型设置」里填写。');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

export class LlmError extends Error {
  constructor(message, { status = 0, detail = '' } = {}) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
    this.detail = detail;
  }
}

function headers(cfg) {
  const h = { 'Content-Type': 'application/json' };
  if (cfg.api_key) h.Authorization = `Bearer ${cfg.api_key}`;
  return h;
}

/** fetch 的网络层异常（DNS/拒绝连接/超时）转成人能看懂的话 */
async function safeFetch(url, init) {
  try {
    return await fetch(url, init);
  } catch (err) {
    if (err?.name === 'AbortError') throw err;
    const code = err?.cause?.code || err?.code || err?.cause?.message || err?.message || 'unknown';
    const hint = /ENOTFOUND|EAI_AGAIN/.test(code)
      ? '域名解析失败，检查 Base URL 拼写或网络'
      : /ECONNREFUSED/.test(code)
        ? '目标端口拒绝连接，本地模型请确认服务已启动'
        : /CERT|TLS|SSL/.test(code)
          ? 'HTTPS 证书校验失败，可能被代理拦截'
          : '检查 Base URL、网络或代理设置';
    throw new LlmError(`无法连接 ${url}（${code}）：${hint}`);
  }
}

async function toLlmError(res) {
  let detail = '';
  try {
    detail = await res.text();
  } catch {
    /* ignore */
  }
  let message = `模型接口返回 ${res.status}`;
  try {
    const parsed = JSON.parse(detail);
    const apiMsg = parsed?.error?.message || parsed?.message;
    if (apiMsg) message = `模型接口返回 ${res.status}：${apiMsg}`;
  } catch {
    if (detail) message = `模型接口返回 ${res.status}：${detail.slice(0, 300)}`;
  }
  if (res.status === 401 || res.status === 403) message += '（API Key 无效或没有权限）';
  if (res.status === 404) message += '（Base URL 可能不对，检查是否需要以 /v1 结尾）';
  if (res.status === 429) message += '（触发限流，请稍后重试或换模型）';
  return new LlmError(message, { status: res.status, detail });
}

/** 组装请求体：extra_body 先合并，核心字段后置以免被覆盖；max_tokens 为空则不发送 */
function buildBody(cfg, { messages, stream, maxTokens, temperature }) {
  const extra = cfg.extra_body && typeof cfg.extra_body === 'object' && !Array.isArray(cfg.extra_body) ? cfg.extra_body : {};
  const body = { ...extra, model: cfg.model, messages, stream };

  const mt = maxTokens ?? cfg.max_tokens;
  if (mt !== null && mt !== undefined && Number(mt) > 0) body.max_tokens = Number(mt);

  const tp = temperature ?? cfg.temperature;
  if (tp !== null && tp !== undefined && Number.isFinite(Number(tp))) body.temperature = Number(tp);

  return JSON.stringify(body);
}

/**
 * 流式对话：返回异步生成器。
 * 每帧形如 { channel: 'content' | 'reasoning' | 'end', text?, finishReason? }
 * —— reasoning 是部分模型（DeepSeek 等）的思维链增量，不能混进正文。
 */
export async function* streamChat(cfg, messages, { maxTokens, temperature, signal } = {}) {
  const res = await safeFetch(chatCompletionsUrl(cfg.base_url), {
    method: 'POST',
    headers: headers(cfg),
    signal,
    body: buildBody(cfg, { messages, stream: true, maxTokens, temperature }),
  });
  if (!res.ok || !res.body) throw await toLlmError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let finishReason = null;

  outer: while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let lineEnd;
    while ((lineEnd = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, lineEnd).trim();
      buffer = buffer.slice(lineEnd + 1);
      if (!line || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') break outer;
      try {
        const json = JSON.parse(payload);
        const choice = json?.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta || {};
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string' && reasoning) yield { channel: 'reasoning', text: reasoning };
        const text = delta.content;
        if (typeof text === 'string' && text) yield { channel: 'content', text };
        const err = json?.error?.message;
        if (err) throw new LlmError(String(err));
      } catch (err) {
        if (err instanceof LlmError) throw err;
        /* 跳过无法解析的心跳/片段 */
      }
    }
  }
  yield { channel: 'end', finishReason };
}

/** 一次性返回完整文本（用于结构化 JSON、连通性测试） */
export async function completeChat(cfg, messages, { maxTokens, temperature, signal } = {}) {
  const res = await safeFetch(chatCompletionsUrl(cfg.base_url), {
    method: 'POST',
    headers: headers(cfg),
    signal,
    body: buildBody(cfg, { messages, stream: false, maxTokens, temperature }),
  });
  if (!res.ok) throw await toLlmError(res);
  const json = await res.json();
  const choice = json?.choices?.[0];
  const content = choice?.message?.content;
  const finishReason = choice?.finish_reason || null;
  if (typeof content !== 'string' || !content.trim()) {
    const reasoning = choice?.message?.reasoning_content;
    if (typeof reasoning === 'string' && reasoning.trim()) {
      throw new LlmError(
        '模型只输出了思维链、没有正文：思考型模型会把推理计入 max_tokens，请在「模型设置」把 max_tokens 调大（建议 ≥ 8192），或在额外参数里关闭深度思考',
      );
    }
    throw new LlmError(
      finishReason === 'length' ? '模型输出被 max_tokens 截断，请调大 max_tokens' : '模型返回了空内容',
    );
  }
  return { content, finishReason };
}

/** 从可能带 ```json 围栏的文本里抠出第一个 JSON 对象 */
export function extractJson(text) {
  if (!text) return null;
  const cleaned = String(text)
    .replace(/^\uFEFF/, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    /* 继续尝试截取 */
  }
  const start = cleaned.search(/[[{]/);
  if (start < 0) return null;
  const open = cleaned[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 连通性测试：发一个极短的请求，验证 base_url / key / model 三件套 */
export async function testConnection(cfg) {
  const started = Date.now();
  const { content } = await completeChat(
    cfg,
    [
      { role: 'system', content: '你是连通性测试助手，只输出 OK。' },
      { role: 'user', content: 'ping' },
    ],
    { maxTokens: 64, temperature: 0 },
  );
  return { ok: true, latency_ms: Date.now() - started, model: cfg.model, reply: content.trim().slice(0, 60) };
}
