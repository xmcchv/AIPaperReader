/**
 * 用量归一化与费用计算回归测试（纯函数 + mock SSE，不访问真实服务）。
 *
 *   node scripts/test-usage-pricing.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';

import { normalizeUsage, formatTokens } from '../server/shared/usage.mjs';
import { estimateCost, formatCost, isPeakHour, resolvePrice } from '../server/shared/pricing.mjs';
import { streamChat } from '../server/shared/llm.mjs';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}`);
    console.error(`      ${err.message}`);
    process.exitCode = 1;
  }
}

/* ---------------------------- usage 归一化 ---------------------------- */

test('usage：OpenAI 标准字段', () => {
  const u = normalizeUsage({ prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200 });
  assert.deepEqual(u, { prompt: 1000, completion: 200, cached: 0, total: 1200 });
});

test('usage：OpenAI 缓存命中字段', () => {
  const u = normalizeUsage({
    prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200,
    prompt_tokens_details: { cached_tokens: 400 },
  });
  assert.equal(u.cached, 400);
});

test('usage：DeepSeek 缓存命中字段', () => {
  const u = normalizeUsage({
    prompt_tokens: 1000, completion_tokens: 200,
    prompt_cache_hit_tokens: 300, prompt_cache_miss_tokens: 700,
  });
  assert.equal(u.cached, 300);
  assert.equal(u.total, 1200); // total 缺省时本地相加
});

test('usage：Anthropic 风格字段别名', () => {
  const u = normalizeUsage({ input_tokens: 500, output_tokens: 100 });
  assert.equal(u.prompt, 500);
  assert.equal(u.completion, 100);
});

test('usage：空对象 / 全 0 返回 null', () => {
  assert.equal(normalizeUsage(null), null);
  assert.equal(normalizeUsage({}), null);
  assert.equal(normalizeUsage({ prompt_tokens: 0, completion_tokens: 0 }), null);
});

test('usage：缓存数被钳制到 prompt 上限', () => {
  const u = normalizeUsage({ prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 500 });
  assert.equal(u.cached, 100);
});

test('formatTokens：k / M 格式', () => {
  assert.equal(formatTokens(999), '999');
  assert.equal(formatTokens(12345), '12.3k');
  assert.equal(formatTokens(1500000), '1.5M');
});

/* ---------------------------- 峰谷与价格 ---------------------------- */

test('峰谷：北京时间 10 点高峰、13 点空闲', () => {
  // 10:00 UTC+8 = 02:00 UTC
  assert.equal(isPeakHour(Date.UTC(2026, 10, 26, 2, 0)), true);
  // 13:00 UTC+8 = 05:00 UTC
  assert.equal(isPeakHour(Date.UTC(2026, 10, 26, 5, 0)), false);
});

test('峰谷：跨 UTC 日界正确（北京时间 0 点 = 前一天 UTC 16 点）', () => {
  assert.equal(isPeakHour(Date.UTC(2026, 10, 25, 16, 0)), false);
});

test('价格：未知模型返回 null', () => {
  assert.equal(resolvePrice('custom', 'some-random-model'), null);
});

test('价格：本地模型视为免费', () => {
  const p = resolvePrice('ollama', 'qwen2.5:7b');
  assert.deepEqual({ cached: p.cached, input: p.input, output: p.output }, { cached: 0, input: 0, output: 0 });
});

test('价格：用户覆盖优先于内置', () => {
  const p = resolvePrice('deepseek', 'deepseek-v4-flash', { 'deepseek-v4-flash': { input: 99, output: 88, cached: 1 } });
  assert.equal(p.input, 99);
  assert.equal(p.output, 88);
});

/* ---------------------------- 费用计算 ---------------------------- */

const PEAK = Date.UTC(2026, 10, 26, 2, 0);   // 北京时间 10:00 高峰
const OFF = Date.UTC(2026, 10, 26, 5, 0);    // 北京时间 13:00 空闲

test('费用：DeepSeek V4-Flash 高峰，缓存/未命中/输出分档', () => {
  // 1000 输入（400 缓存命中 + 600 未命中）+ 200 输出
  const usage = { prompt: 1000, completion: 200, cached: 400 };
  const cost = estimateCost(usage, 'deepseek', 'deepseek-v4-flash', { at: PEAK });
  // 400/1e6*0.1 + 600/1e6*3 + 200/1e6*9 = 0.00004 + 0.0018 + 0.0018 = 0.00364
  assert.ok(Math.abs(cost - 0.00364) < 1e-9, `cost=${cost}`);
});

test('费用：空闲时段恰好半价', () => {
  const usage = { prompt: 1000, completion: 200, cached: 400 };
  const peak = estimateCost(usage, 'deepseek', 'deepseek-v4-flash', { at: PEAK });
  const off = estimateCost(usage, 'deepseek', 'deepseek-v4-flash', { at: OFF });
  assert.ok(Math.abs(off - peak / 2) < 1e-9, `peak=${peak} off=${off}`);
});

test('费用：无缓存字段时全按未命中算（保守上限）', () => {
  const usage = { prompt: 1000, completion: 200, cached: 0 };
  const cost = estimateCost(usage, 'deepseek', 'deepseek-v4-flash', { at: PEAK });
  // 1000/1e6*3 + 200/1e6*9 = 0.003 + 0.0018 = 0.0048
  assert.ok(Math.abs(cost - 0.0048) < 1e-9, `cost=${cost}`);
});

test('费用：单价缺失返回 null', () => {
  const usage = { prompt: 1000, completion: 200, cached: 0 };
  assert.equal(estimateCost(usage, 'custom', 'unknown-model'), null);
  assert.equal(estimateCost(null, 'deepseek', 'deepseek-v4-flash'), null);
});

test('费用：OpenAI 美元价按汇率换算成人民币', () => {
  const usage = { prompt: 1000000, completion: 1000000, cached: 0 };
  const cost = estimateCost(usage, 'openai', 'gpt-4o-mini');
  // 0.15*7.2 + 0.6*7.2 = 1.08 + 4.32 = 5.4
  assert.ok(Math.abs(cost - 5.4) < 1e-6, `cost=${cost}`);
});

test('formatCost：小额与未知单价', () => {
  assert.equal(formatCost(0.00364), '¥0.00364');
  assert.equal(formatCost(0.0000001), '<¥0.000001');
  assert.equal(formatCost(null), '未配置单价');
  assert.equal(formatCost(0), '¥0');
});

/* ---------------------------- mock SSE：streamChat 接 usage ---------------------------- */

async function sseTest() {
  const bodies = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      try { bodies.push(JSON.parse(raw)); } catch { /* ignore */ }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const chunks = [
      { choices: [{ delta: { content: '你' }, finish_reason: null }] },
      { choices: [{ delta: { content: '好' }, finish_reason: 'stop' }] },
      // 独立的 usage 块：choices 为空，只有 usage
      {
        choices: [],
        usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102, prompt_tokens_details: { cached_tokens: 40 } },
      },
    ];
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const cfg = { base_url: `http://127.0.0.1:${port}/v1`, model: 'test', provider: 'openai', api_key: '' };
    let text = '';
    let endUsage = null;
    for await (const chunk of streamChat(cfg, [{ role: 'user', content: 'hi' }])) {
      if (chunk.channel === 'content') text += chunk.text;
      if (chunk.channel === 'end') endUsage = chunk.usage;
    }
    assert.equal(text, '你好');
    assert.ok(endUsage, 'end 帧应带 usage');
    assert.deepEqual(endUsage, { prompt: 100, completion: 2, cached: 40, total: 102 });
    passed += 1;
    console.log('  ok  mock SSE：streamChat 接住独立 usage 块且正文完整');

    // 内置 provider 发 stream_options，custom/ollama 不发
    assert.deepEqual(bodies[0].stream_options, { include_usage: true });
    const localCfg = { ...cfg, provider: 'ollama' };
    for await (const _ of streamChat(localCfg, [{ role: 'user', content: 'hi' }])) { /* drain */ }
    assert.equal(bodies[1].stream_options, undefined);
    passed += 1;
    console.log('  ok  stream_options：内置 provider 发送、ollama 不发送');
  } finally {
    server.close();
  }
}

await sseTest();
console.log(`\n${passed} tests passed`);
