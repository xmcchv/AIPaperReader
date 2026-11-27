/**
 * 提示词集中管理。
 * 精读产出两阶段：
 *   1) 流式 Markdown 精读（给人看的正文，小节标题固定，前端按 ## 切成卡片）
 *   2) 结构化 JSON（给图解与概念卡用的机读数据）
 */

export const READING_SECTIONS = [
  '一句话结论',
  '要解决的问题',
  '核心方法',
  '关键创新',
  '实验与结论',
  '局限与可延伸',
  '精读要点',
];

const SYSTEM = `你是一位顶级论文精读导师，擅长把晦涩的论文讲成"每一步为什么这么做"。
要求：
- 中文输出，术语保留英文原文并在首次出现时用一句话解释。
- 只依据给定论文内容，不要编造论文里没有的实验数字、数据集或结论；不确定就说"论文未明确说明"。
- 先给结论再给推理，避免空话套话，不要复述摘要。
- 数学公式用 LaTeX：行内 $...$，独立公式 $$...$$（界面会用 KaTeX 渲染），不要用纯 Unicode 拼公式；上下标必须带花括号（如 Q^{*}、x_{i}），矩阵用 \begin{bmatrix}...\end{bmatrix} 并保证 \begin/\end 配对。`;

/** 论文正文截断，控制 token */
export function trimPaper(text, limit = 26000) {
  const body = String(text || '').replace(/\r\n/g, '\n').trim();
  if (body.length <= limit) return body;
  const head = body.slice(0, Math.floor(limit * 0.7));
  const tail = body.slice(-Math.floor(limit * 0.3));
  return `${head}\n\n...（中间内容因长度限制省略）...\n\n${tail}`;
}

export function readingMessages(paper, { title = '' } = {}) {
  const user = `论文标题：${title || '（未提供）'}

请按下面的固定小节精读这篇论文。**必须**使用以下 7 个二级标题，顺序不要变，标题文字与下面完全一致：

## 一句话结论
（1-2 句，说清这篇论文做了什么、凭什么是它）

## 要解决的问题
（它针对的具体痛点，以及已有方案为什么不够）

## 核心方法
（逐步拆解方法的每一环：输入是什么、每一步在做什么、为什么这样做。可以用有序列表）

## 关键创新
（相对已有工作的真正差异点，2-4 条；不要写成"提出了一个框架"这种空话）

## 实验与结论
（数据集/基线/关键指标，只写论文里出现的数字；若论文没给就说明）

## 局限与可延伸
（作者承认的与你看出的局限各列几条，再给 2-3 个可以接着做的方向）

## 精读要点
（3-6 条要点，每条一句话，是读者合上论文后应该记住的东西）

论文正文：
"""
${trimPaper(paper)}
"""`;
  return [
    { role: 'system', content: SYSTEM },
    { role: 'user', content: user },
  ];
}

export function structureMessages(paper, reading = '', { title = '', sections = [] } = {}) {
  const user = `下面是一篇论文的正文与已有的精读笔记。请输出**严格 JSON**（第一个字符就是 {，不要 markdown 代码块，不要注释）：

{
  "title": "论文标题的简洁版本",
  "one_liner": "一句话结论",
  "tags": ["领域/方法标签", "..."],
  "concepts": [
    { "name": "关键概念（中文）", "explain": "一句话解释（不超过 40 字）", "terms": ["论文原文里的英文术语", "缩写"] }
  ],
  "claims": [
    { "label": "核心贡献", "text": "一句话" }
  ],
  "diagram": {
    "title": "方法总览",
    "nodes": [
      { "id": "n1", "label": "节点名（不超过 12 字）", "detail": "这个环节的一句话说明", "kind": "input", "sectionRef": "2" }
    ],
    "edges": [
      { "from": "n1", "to": "n2", "label": "箭头上的短说明" }
    ]
  }
}

约束：
- concepts 给 4-8 个；claims 给 2-4 条；tags 给 2-5 个。
- concepts[].terms：1-3 个**在论文原文里逐字出现**的检索词（英文术语或缩写，保留原文大小写），用于在 PDF 原文中定位；不要放中文翻译，没有把握就留空数组。
- diagram.kind 只能取 input / process / data / output 之一。
- diagram.nodes 给 4-9 个，必须覆盖"输入 → 关键处理环节 → 输出/结果"的完整链路，节点之间用 edges 连成有向图，不要出现孤立节点。
- diagram.nodes[].id 用 n1..n9；edges 里只允许引用已存在的 id。
- diagram.nodes[].sectionRef：填这个环节对应论文正文的章节编号（见下方章节列表），没有把握就留空字符串。
- 所有文案用中文（专有名词保留英文）。

论文标题：${title || '（未提供）'}

论文正文：
"""
${trimPaper(paper, 20000)}
"""

已有精读笔记：
"""
${String(reading || '').slice(0, 6000)}
"""

论文章节列表（sectionRef 填这里的编号）：
${sections.length ? sections.map((s) => `${s.number || '-'} ${s.title}${s.summary ? `：${s.summary}` : ''}`).join('\n') : '（未解析出章节，sectionRef 留空）'}`;
  return [
    { role: 'system', content: '你是一个严谨的论文结构化抽取器，只输出合法 JSON，绝不输出 JSON 之外的任何字符。' },
    { role: 'user', content: user },
  ];
}

/**
 * 章节整理：只对规则层给出的标题候选做判断，不接触正文与段落索引。
 * 返回数组里的 id 必须原样带回，服务端据此映射回已算好的段落区间。
 */
export function outlineMessages(headings) {
  return [
    {
      role: 'system',
      content: '你是论文目录整理器，只输出严格 JSON 数组，不要代码块、不要注释、不要多余文字。',
    },
    {
      role: 'user',
      content: `下面是论文里规则识别出的章节标题候选。请为每个候选判断：
- level：层级（1=一级节，2=子节，3=更细）；编号如 3.2 表示 level 2。
- title：规范化后的中文或英文标题（去掉编号，不超过 30 字）。
- summary：这一节大意的一句话（不超过 40 字）；看不出就留空字符串。
- id：**必须原样返回给定的 id**，不要改、不要排序、不要增删条目。

严格输出 JSON 数组，格式：[{"id":"h0","level":1,"title":"引言","summary":"说明研究背景与问题"}]

候选列表：
${JSON.stringify(headings)}`,
    },
  ];
}

/**
 * 追问消息。上下文由 context.mjs 的 buildAskContext() 组装后传入，
 * 这里只负责按联网开关切换 system 约束——两类来源不能混为一谈。
 */
export function askMessages(contextBlock, { question, webSearch = false } = {}) {
  const tail = webSearch
    ? '允许联网补充论文之外的信息：引用论文事实时在句末标注来源标记（如 [§核心方法]），引用网络信息时标注 [网络]。标记一律用英文方括号 []，不要用中文【】。两类来源不要混为一谈；论文没写且网络也没查到的，直接说"不清楚"。'
    : '只依据下面带来源标记的材料作答：引用论文事实时在句末标注（如 [§核心方法]、[原文段落]）。标记一律用英文方括号 []，不要用中文【】。不要编造；材料不足时说"论文未明确说明"。';

  return [
    {
      role: 'system',
      content: `${SYSTEM}\n现在进入追问模式：回答要短、准，能用例子就用例子，控制在 300 字内。${tail}`,
    },
    { role: 'user', content: String(contextBlock || `用户问题：${question || ''}`) },
  ];
}

/**
 * 导出报告用的「一页速览 + 追问总结」。
 * 一次调用同时产出两样东西：报告开头的执行摘要，以及追问区顶部的要点归纳。
 */
export function summaryMessages(paper, { title = '', reading = '', askThread = [] } = {}) {
  const qa = (Array.isArray(askThread) ? askThread : [])
    .filter((m) => m && String(m.text || '').trim() && String(m.text).trim() !== '…')
    .slice(-12)
    .map((m) => `${m.role === 'user' ? '用户' : 'AI'}：${String(m.text).trim().slice(0, 700)}`)
    .join('\n');

  const user = `下面是一篇论文的精读笔记${qa ? '和追问记录' : ''}。请输出**严格 JSON**（第一个字符就是 {，不要 markdown 代码块，不要注释）：

{
  "digest": "一页执行摘要：5-7 行 markdown 列表，每行一句，覆盖 研究问题 / 方法核心 / 关键结果 / 局限 / 可延伸方向",
  "qa_highlights": [
    { "question": "追问的问题（可压缩成一句话）", "takeaway": "回答的核心结论，一句话" }
  ]
}

约束：
- digest 用中文，总长不超过 260 字；只依据给定内容，不要编造数字或结论。
- qa_highlights 覆盖所有有实质回答的追问，最多 8 条；没有追问就给空数组 []。
- 每条 takeaway 不超过 60 字，直接给结论，不要写"作者认为"。
- 公式用 LaTeX：行内 $...$，独立公式 $$...$$。

论文标题：${title || '（未提供）'}

精读笔记：
"""
${String(reading || '').slice(0, 12000)}
"""
${qa ? `\n追问记录：\n"""\n${qa}\n"""` : ''}

论文正文节选（用于核对事实）：
"""
${trimPaper(paper, 6000)}
"""`;
  return [
    { role: 'system', content: '你是一个严谨的论文报告编辑，只输出合法 JSON，绝不输出 JSON 之外的任何字符。' },
    { role: 'user', content: user },
  ];
}
