/**
 * 追问上下文改造回归测试（纯函数，不启服务、不访问网络）。
 *
 *   node scripts/test-ask-context.mjs
 */
import assert from 'node:assert/strict';

import { buildAskContext, compressHistory, splitReadingCards, tokenize } from '../server/context.mjs';
import { askMessages } from '../server/prompts.mjs';
import { markAskCitations, renderBlocks } from '../public/text.js';

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

const READING = `## 一句话结论
本文提出状态空间模型 SSM，用于长序列建模。

## 要解决的问题
Transformer 的注意力机制在长序列上计算量是平方级的。

## 核心方法
把输入映射成状态空间，用 Mamba 的选择机制做门控。SSM 的状态更新是线性的。

## 关键创新
引入了输入依赖的选择机制，让参数随输入变化。

## 实验与结论
在语言建模基准上优于同规模 Transformer，吞吐提升 5 倍。

## 局限与可延伸
只在中等长度序列上验证，硬件内核仍需优化。

## 精读要点
一句话记住：选择机制让 SSM 具备内容感知能力。`;

const STRUCTURE = {
  concepts: [{ name: '状态空间模型', explain: '用状态变量建模序列', terms: ['state space model', 'SSM'] }],
  claims: [{ label: '核心贡献', text: '输入依赖的选择机制' }],
};

test('切卡：只保留 7 个固定小节', () => {
  const cards = splitReadingCards(READING);
  assert.equal(cards.length, 7);
  assert.deepEqual(
    cards.map((c) => c.title),
    ['一句话结论', '要解决的问题', '核心方法', '关键创新', '实验与结论', '局限与可延伸', '精读要点'],
  );
  assert.ok(cards.every((c) => c.source.startsWith('§')));
});

test('tokenize：英文整词 + 中文 2-gram，停用词剔除', () => {
  const tokens = tokenize('状态空间模型 SSM 是怎么做的？');
  assert.ok(tokens.includes('状态'));
  assert.ok(tokens.includes('ssm'));
  assert.ok(!tokens.includes('怎么'));
});

test('检索：问题命中的小节排在前面', () => {
  const ctx = buildAskContext({ reading: READING, question: '实验结论是什么？' });
  assert.ok(ctx.cards.includes('§实验与结论'), `cards=${ctx.cards.join(',')}`);
  assert.equal(ctx.cards[0], '§实验与结论');
});

test('检索：选中片段作为锚点，原文段被带出', () => {
  const paperText = '引言部分讲述背景。\n\n' + '本文提出的 SSM 状态更新是线性的，吞吐提升 5 倍，这一设计是关键。'.repeat(2) + '\n\n参考文献省略。';
  const ctx = buildAskContext({
    reading: READING,
    paperText,
    selection: 'SSM 状态更新是线性的',
    question: '这段在说什么？',
  });
  assert.ok(ctx.block.includes('[选中片段]'));
  assert.ok(ctx.paragraphs >= 1);
});

test('多轮：压缩历史，过滤占位与错误条目', () => {
  const history = compressHistory([
    { role: 'user', text: '核心方法是什么？' },
    { role: 'assistant', text: '用状态空间模型建模。这是第二句。' },
    { role: 'user', text: '…' },
    { role: 'assistant', text: '…' },
    { role: 'user', text: '效果呢？', error: true },
    { role: 'assistant', text: '出错了' },
    { role: 'user', text: '和 Transformer 比呢？' },
    { role: 'assistant', text: '吞吐提升 5 倍。' },
  ]);
  assert.equal(history.length, 2);
  assert.equal(history[0].answer, '用状态空间模型建模。');
  assert.ok(history[1].question.includes('Transformer'));
});

test('指代：短追问带上上一轮问题作为检索词', () => {
  const askThread = [
    { role: 'user', text: '实验与结论说了什么？' },
    { role: 'assistant', text: '在语言建模基准上优于 Transformer。' },
    { role: 'user', text: '它和基线比呢？' },
    { role: 'assistant', text: '…' },
  ];
  const ctx = buildAskContext({ reading: READING, question: '它和基线比呢？', askThread });
  assert.ok(ctx.block.includes('最近对话：'));
  assert.ok(ctx.cards.some((c) => c.includes('实验与结论')), `cards=${ctx.cards.join(',')}`);
});

test('无精读时：不报错，问题仍在块内', () => {
  const ctx = buildAskContext({ title: '测试论文', paperText: '一段足够长的正文内容用于检索，至少四十个字符以上才能在段落切分里保留下来。', question: '这篇论文讲了什么？' });
  assert.ok(ctx.block.includes('用户问题：这篇论文讲了什么？'));
  assert.ok(ctx.block.length < 6900);
});

test('structure：concepts 的 terms 参与打分', () => {
  const a = buildAskContext({ reading: READING, question: 'SSM 是什么？' });
  const b = buildAskContext({ reading: READING, question: 'SSM 是什么？', structure: STRUCTURE });
  assert.ok(b.block.includes('[概念]'));
  assert.ok(b.cards.indexOf('§核心方法') <= a.cards.indexOf('§核心方法') || a.cards.indexOf('§核心方法') === -1);
});

test('预算：超长输入被裁剪到 6900 字符内', () => {
  const ctx = buildAskContext({
    title: 'T'.repeat(500),
    paperText: '正文。'.repeat(20000),
    reading: READING + '\n## 核心方法\n' + '很长的精读内容。'.repeat(2000),
    selection: '选中的很长内容。'.repeat(1000),
    structure: STRUCTURE,
    question: '核心方法是什么？',
    askThread: Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `第${i}轮很长的对话内容。`.repeat(30) })),
  });
  assert.ok(ctx.chars <= 6900, `chars=${ctx.chars}`);
  assert.ok(ctx.block.endsWith('核心方法是什么？'), '问题必须保留在末尾');
});

test('prompt：联网开关切换两类来源约束', () => {
  const offline = askMessages('材料', { question: 'Q', webSearch: false });
  const online = askMessages('材料', { question: 'Q', webSearch: true });
  assert.ok(offline[0].content.includes('只依据'));
  assert.ok(online[0].content.includes('[网络]'));
  assert.ok(!offline[0].content.includes('[网络]'));
  assert.ok(offline[0].content.includes('不要用中文【】'));
});

test('渲染：markdown 标题转成 h4（## → h3，### → h4）', () => {
  const html = renderBlocks(['### 1. 梯度差分怎么算的？', '正文一段。']);
  assert.ok(html.includes('<h4>1. 梯度差分怎么算的？</h4>'), html);
});

test('渲染：fenced 代码块转成 pre/code', () => {
  const html = renderBlocks(['```python', 'diff_x_sq = cp.maximum(a, b)', '```']);
  assert.ok(html.includes('<pre><code>'), html);
  assert.ok(html.includes('diff_x_sq = cp.maximum(a, b)'), html);
  assert.ok(!html.includes('```'), html);
});

test('渲染：代码块里的尖括号被转义', () => {
  const html = renderBlocks(['```cpp', 'if (a < b) { return; }', '```']);
  assert.ok(html.includes('a &lt; b'), html);
});

test('角标：英文方括号来源标记转成 span', () => {
  const html = markAskCitations('<p>结论 [§核心方法] 成立。</p>');
  assert.ok(html.includes('<span class="ask-cite"'), html);
  assert.ok(html.includes('§核心方法'), html);
});

test('角标：中文方括号来源标记也转成 span', () => {
  const html = markAskCitations('<p>结论【§核心方法】成立。</p>');
  assert.ok(html.includes('<span class="ask-cite"'), html);
  assert.ok(!html.includes('【§核心方法】'), html);
});

test('角标：网络来源加 web 类', () => {
  const html = markAskCitations('<p>最新结果 [网络] 如下。</p>');
  assert.ok(html.includes('ask-cite web'), html);
});

console.log(`\n${passed} tests passed`);
