/**
 * 章节结构解析测试：规则层边界 + 混合层 id 映射（mock LLM）。
 *
 *   node scripts/test-outline.mjs
 */
import assert from 'node:assert/strict';

import { parseOutlineRules, applyOutlineHints } from '../server/paper/outline.mjs';

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

/* ---------------------------- 规则层 ---------------------------- */

test('规则层：标准编号章节，段落区间正确', () => {
  const text = `1. Introduction

这是引言第一段，包含足够多的文字让段落能被正确识别出来。
这是引言第二段，继续说明研究背景和意义所在。

2. Method

2.1 Overview

这里是方法总览段落，描述整体框架和主要组成部分。

2.2 Details

这里是方法细节段落，描述每一步的具体实现过程。

3. Conclusion

结论段落总结全文贡献。`;
  const o = parseOutlineRules(text);
  assert.equal(o.source, 'rules');
  assert.ok(o.sections.length >= 4, `sections=${o.sections.length}`);
  assert.equal(o.sections[0].number, '1');
  assert.equal(o.sections[0].title, 'Introduction');
  assert.equal(o.sections[0].level, 1);
  assert.ok(o.sections[0].start <= o.sections[0].end);
  assert.ok(o.sections[0].end <= o.sections[1].headingIndex);
  // sectionOf 覆盖所有段落
  assert.equal(o.sectionOf.length, o.paragraphCount);
  assert.ok(o.sectionOf.every((s) => s >= 0 && s < o.sections.length));
});

test('规则层：无编号关键词标题也能识别', () => {
  const text = `Abstract

本文研究论文结构解析的问题并提出一种混合方法。

Introduction

这是引言正文，说明为什么章节结构对精读系统很重要。

Method

这是方法正文，描述规则层与模型层如何配合。`;
  const o = parseOutlineRules(text);
  assert.ok(o.sections.length >= 3, `sections=${o.sections.length}`);
  assert.ok(o.sections.some((s) => /Abstract/i.test(s.title)));
  assert.ok(o.sections.some((s) => /Method/i.test(s.title)));
});

test('规则层：抗噪——表格行/年份/长英文句不当标题', () => {
  const text = `1. Introduction

2015 classification results are reported in this section with detailed numbers.
18 layers 27.94
This is a very long English sentence that should not be treated as a section title because it has more than four words.

2. Method

这里是方法正文。`;
  const o = parseOutlineRules(text);
  const titles = o.sections.map((s) => s.title.toLowerCase());
  assert.ok(!titles.some((t) => t.includes('27.94')), titles.join('|'));
  assert.ok(!titles.some((t) => t.includes('2015')), titles.join('|'));
  assert.ok(o.sections.some((s) => s.number === '1'));
  assert.ok(o.sections.some((s) => s.number === '2'));
});

test('规则层：层级从编号点数推导', () => {
  const text = `1 Introduction

引言正文。

1.1 Background

背景正文。

1.1.1 Prior Work

前人工作正文。`;
  const o = parseOutlineRules(text);
  const levels = o.sections.map((s) => s.level);
  assert.deepEqual(levels, [1, 2, 3]);
});

test('规则层：空文本返回空 outline', () => {
  const o = parseOutlineRules('');
  assert.equal(o.sections.length, 0);
  assert.equal(o.paragraphCount, 0);
  assert.deepEqual(o.sectionOf, []);
});

test('规则层：纯正文无标题时 sectionOf 全为 -1', () => {
  const o = parseOutlineRules('这是一段普通正文没有任何章节标题出现在这里。');
  assert.equal(o.sections.length, 0);
  assert.ok(o.sectionOf.every((s) => s === -1));
});

/* ---------------------------- 混合层 ---------------------------- */

test('混合层：LLM 用 id 映射回标题、层级、小结，不动索引', () => {
  const o = parseOutlineRules(`1. Introduction

引言正文。

2. Method

方法正文。`);
  const originalStart = o.sections[0].start;
  const originalEnd = o.sections[0].end;
  applyOutlineHints(o, [
    { id: 'h0', level: 1, title: '引言', summary: '介绍研究背景' },
    { id: 'h1', level: 2, title: '方法', summary: '描述技术方案' },
  ]);
  assert.equal(o.source, 'hybrid');
  assert.equal(o.sections[0].title, '引言');
  assert.equal(o.sections[0].summary, '介绍研究背景');
  assert.equal(o.sections[1].level, 2);
  // 关键：段落区间没被 LLM 输出改动
  assert.equal(o.sections[0].start, originalStart);
  assert.equal(o.sections[0].end, originalEnd);
});

test('混合层：忽略无效 id 与非法字段，不破坏原数据', () => {
  const o = parseOutlineRules(`1 Introduction

引言正文。`);
  const before = JSON.stringify(o.sections[0]);
  applyOutlineHints(o, [
    { id: 'h999', title: '不存在' },
    { id: 'h0', level: 99, summary: 12345 },
  ]);
  assert.equal(o.sections[0].title, 'Introduction');
  assert.equal(o.sections[0].level, 1);
  assert.equal(o.sections[0].summary, '');
  assert.equal(JSON.stringify(o.sections[0]), before);
});

test('混合层：hints 非数组时保持规则层结果', () => {
  const o = parseOutlineRules(`1 Introduction

引言正文。`);
  applyOutlineHints(o, { id: 'h0', title: '坏数据' });
  assert.equal(o.source, 'rules');
  assert.equal(o.sections[0].title, 'Introduction');
});

/* ---------------------------- anchors ---------------------------- */

const { conceptAnchors, resolveSectionRef, enrichStructureWithOutline } = await import('../server/paper/anchors.mjs');
const ANCHOR_TEXT = `1. Introduction

This paper studies state space models for long sequences. We introduce the theory here.

2. Method

The state space layer uses a structured state space model (SSM) to process sequences efficiently.
Our method combines convolution and recurrent forms for parallel training.

3. Experiment

We evaluate on long range benchmarks and report accuracy.`;
const { splitParagraphs } = await import('../public/text.js');
const anchorOutline = parseOutlineRules(ANCHOR_TEXT);
const anchorParas = splitParagraphs(ANCHOR_TEXT);

test('anchors：命中段落、节、偏移与引用正确', () => {
  const anchors = conceptAnchors({ terms: ['state space model'] }, anchorOutline, anchorParas);
  assert.ok(anchors.length >= 1, '应命中');
  assert.ok(anchors[0].paragraph >= 0);
  assert.ok(anchors[0].offset >= 0);
  assert.ok(anchors[0].quote.includes('state space'));
  assert.ok(anchors[0].section, '应归属某节');
});

test('anchors：术语密度高的段落优先', () => {
  const anchors = conceptAnchors({ terms: ['state space', 'state space layer', 'SSM'] }, anchorOutline, anchorParas);
  // 方法节那段同时含 SSM 与 state space，应排第一
  assert.ok(anchors.length >= 2);
  assert.ok(anchors[0].terms.length >= 2, `top anchor terms=${anchors[0].terms.join(',')}`);
});

test('anchors：无 terms 返回空', () => {
  assert.deepEqual(conceptAnchors({ terms: [] }, anchorOutline, anchorParas), []);
});

test('anchors：不可解析的章节引用返回空', () => {
  assert.equal(resolveSectionRef('不存在的章节', anchorOutline), '');
});

test('anchors：章节号解析', () => {
  assert.equal(resolveSectionRef('2', anchorOutline), anchorOutline.sections.find((s) => s.number === '2')?.id);
});

test('结构增强：concepts 带 anchors、nodes 带 sectionRef', () => {
  const structure = {
    concepts: [{ name: '状态空间', terms: ['state space'] }],
    diagram: { nodes: [{ id: 'n1', label: '状态空间层', sectionRef: '2' }], edges: [] },
  };
  const out = enrichStructureWithOutline(JSON.parse(JSON.stringify(structure)), anchorOutline, ANCHOR_TEXT);
  assert.ok(out.concepts[0].anchors.length >= 1);
  assert.ok(out.diagram.nodes[0].sectionRef, '应解析出 sectionRef');
});

/* ---------------------------- PDF 词级矩形 ---------------------------- */

const { termRectFor, normalizeHeading, headingMatchScore } = await import('../public/pdfview.js');

test('PDF 词级高亮：单行段落术语映射到矩形内的子区间', () => {
  const para = {
    text: 'We use state space models for long sequences.',
    rects: [{ page: 0, x0: 100, y0: 200, x1: 500, y1: 220 }],
    fh: 12,
  };
  const r = termRectFor(para, /state space/i);
  assert.ok(r, '应命中');
  assert.equal(r.page, 0);
  assert.ok(r.x0 > 100 && r.x1 <= 500, `x0=${r.x0} x1=${r.x1}`);
  assert.ok(r.x1 > r.x0, '应有宽度');
  assert.equal(r.y0, 200);
  assert.ok(r.y1 - r.y0 <= 12, `只高亮一行，不应贯穿整段：height=${r.y1 - r.y0}`);
});

test('PDF 词级高亮：术语在段落开头时 x0 接近行首', () => {
  const para = { text: 'state space is here', rects: [{ page: 1, x0: 0, y0: 0, x1: 300, y1: 20 }] };
  const r = termRectFor(para, /state space/i);
  assert.ok(r.x0 < 40, `x0=${r.x0}`);
  assert.equal(r.page, 1);
});

test('PDF 词级高亮：多行段落按文本顺序命中第二行的矩形', () => {
  const para = {
    text: 'First line text here. Second line state space model.',
    rects: [
      { page: 0, x0: 0, y0: 0, x1: 300, y1: 20 },
      { page: 0, x0: 0, y0: 24, x1: 300, y1: 44 },
    ],
  };
  const r = termRectFor(para, /state space/i);
  assert.ok(r, '应命中');
  assert.ok(r.y0 >= 24, `应落在第二行 y0=${r.y0}`);
});

test('PDF 词级高亮：未命中或无 rects 返回 null', () => {
  const para = { text: 'hello world', rects: [{ page: 0, x0: 0, y0: 0, x1: 100, y1: 20 }] };
  assert.equal(termRectFor(para, /notfound/i), null);
  assert.equal(termRectFor({ text: 'hello', rects: [] }, /hello/i), null);
});

test('anchors：定义性章节(System Overview)优先于摘要顺带提及', () => {
  const text = `Abstract

This paper presents SCANB, a framework for state space navigation. We use state space models in the overview.

1 System Overview

The state space layer (SSM) is a core component that we propose for modeling long-horizon sequences. The state space layer is defined here in detail.

2 Experiments

We evaluate the state space approach on benchmarks.`;
  const outline = parseOutlineRules(text);
  const paras = splitParagraphs(text);
  const anchors = conceptAnchors({ terms: ['state space', 'SSM'] }, outline, paras);
  assert.ok(anchors.length >= 1);
  const top = anchors[0];
  const topSec = outline.sections.find((s) => s.id === top.section);
  assert.ok(/overview|system/i.test(topSec?.title || ''), `应定位到 System Overview，实际=${topSec?.title}`);
});

test('anchors：定义句加权（we propose / is defined）', () => {
  const text = `1 Method

We apply the state space module to the task and report results.

2 System Overview

The state space module is defined as a learned operator that maps inputs to latent states.`;
  const outline = parseOutlineRules(text);
  const paras = splitParagraphs(text);
  const anchors = conceptAnchors({ terms: ['state space module'] }, outline, paras, { limit: 2 });
  const top = anchors[0];
  const topSec = outline.sections.find((s) => s.id === top.section);
  assert.ok(/overview/i.test(topSec?.title || ''), `定义句所在节应优先，实际=${topSec?.title}`);
});

test('PDF 词级高亮：长段落多行时只高亮一行（不贯穿整段）', () => {
  const para = {
    text: 'First line of the paragraph. Second line with state space models here. Third line ends the paragraph.',
    rects: [{ page: 0, x0: 50, y0: 100, x1: 450, y1: 160 }],
    fh: 12,
  };
  const r = termRectFor(para, /state space/i);
  assert.ok(r);
  assert.ok(r.y1 - r.y0 <= 12, `高亮高度应≤一行(12)，实际=${r.y1 - r.y0}`);
  assert.ok(r.y1 <= 160, '不应超出段落 rect');
});

test('规则层：罗马数字章节（I. / II. / VII.）可识别', () => {
  const text = `I. Introduction

Legged robots face challenges.

II. Related Work

Prior work studied planning.

IV. Yaw-Aware Local Planning

We propose a footprint representation.

VII. Conclusion

We conclude the work.`;
  const o = parseOutlineRules(text);
  assert.ok(o.sections.length >= 4, `sections=${o.sections.length}`);
  assert.ok(o.sections.some((s) => s.number === 'I' && s.title === 'Introduction'));
  assert.ok(o.sections.some((s) => s.number === 'VII' && s.title === 'Conclusion'));
});

test('规则层：单字母子节（C. Objective）不当作罗马数字一级章节', () => {
  const o = parseOutlineRules('A Method\n\nSome text here.');
  assert.equal(o.sections.length, 0, `sections=${o.sections.map((s) => s.title).join(',')}`);
});

test('PDF 章节跳转：标题归一化去编号/空白/句点', () => {
  assert.equal(normalizeHeading('I. Introduction'), 'introduction');
  assert.equal(normalizeHeading('2. System Overview'), 'system overview');
  assert.equal(normalizeHeading('III.  Related Work.'), 'related work');
});

test('PDF 章节跳转：编号+标题匹配得分高，不匹配低于命中阈值', () => {
  const para = { heading: true, text: 'II. Related Work', page: 1, rects: [{ page: 1 }] };
  assert.ok(headingMatchScore(para, 'II', 'Related Work') >= 10);
  assert.ok(headingMatchScore(para, 'III', 'Conclusion') < 8, '错误章节不应达到命中阈值');
});

test('PDF 章节跳转：正文里顺带提到章节名不应达到命中阈值', () => {
  const para = { heading: false, kind: 'body', text: 'Introduction to our method', page: 0 };
  assert.ok(headingMatchScore(para, '', 'Introduction') < 8);
});

test('规则层：单字母子节 A./B./C./D. 识别为 level 2，罗马数字为 level 1', () => {
  const text = `I. Introduction

Intro text.

A. Local Trajectory Planning

Sub text.

B. Quadruped Robot Navigation

More text.

C. Objective Functions

More text.

II. System Overview

Next text.`;
  const o = parseOutlineRules(text);
  assert.ok(o.sections.length >= 5, `sections=${o.sections.length}`);
  assert.equal(o.sections[0].level, 1);
  assert.equal(o.sections[1].number, 'A');
  assert.equal(o.sections[1].level, 2);
  assert.equal(o.sections[2].number, 'B');
  assert.equal(o.sections[2].level, 2);
  assert.equal(o.sections[3].number, 'C');
  assert.equal(o.sections[3].level, 2);
  assert.ok(o.sections.some((s) => s.number === 'II' && s.level === 1));
});

console.log(`\n${passed} tests passed`);
