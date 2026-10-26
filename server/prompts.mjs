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
- 先给结论再给推理，避免空话套话，不要复述摘要。`;

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

export function structureMessages(paper, reading = '', { title = '' } = {}) {
  const user = `下面是一篇论文的正文与已有的精读笔记。请输出**严格 JSON**（第一个字符就是 {，不要 markdown 代码块，不要注释）：

{
  "title": "论文标题的简洁版本",
  "one_liner": "一句话结论",
  "tags": ["领域/方法标签", "..."],
  "concepts": [
    { "name": "关键概念", "explain": "一句话解释（不超过 40 字）" }
  ],
  "claims": [
    { "label": "核心贡献", "text": "一句话" }
  ],
  "diagram": {
    "title": "方法总览",
    "nodes": [
      { "id": "n1", "label": "节点名（不超过 12 字）", "detail": "这个环节的一句话说明", "kind": "input" }
    ],
    "edges": [
      { "from": "n1", "to": "n2", "label": "箭头上的短说明" }
    ]
  }
}

约束：
- concepts 给 4-8 个；claims 给 2-4 条；tags 给 2-5 个。
- diagram.kind 只能取 input / process / data / output 之一。
- diagram.nodes 给 4-9 个，必须覆盖"输入 → 关键处理环节 → 输出/结果"的完整链路，节点之间用 edges 连成有向图，不要出现孤立节点。
- diagram.nodes[].id 用 n1..n9；edges 里只允许引用已存在的 id。
- 所有文案用中文（专有名词保留英文）。

论文标题：${title || '（未提供）'}

论文正文：
"""
${trimPaper(paper, 20000)}
"""

已有精读笔记：
"""
${String(reading || '').slice(0, 6000)}
"""`;
  return [
    { role: 'system', content: '你是一个严谨的论文结构化抽取器，只输出合法 JSON，绝不输出 JSON 之外的任何字符。' },
    { role: 'user', content: user },
  ];
}

export function askMessages(paper, { title = '', selection = '', reading = '', question }) {
  const context = [
    title ? `论文标题：${title}` : '',
    selection ? `用户选中的原文片段：\n"""${selection.slice(0, 4000)}"""` : '',
    reading ? `已有的精读笔记（节选）：\n"""${reading.slice(0, 3000)}"""` : '',
    `论文正文（节选）：\n"""${trimPaper(paper, 12000)}"""`,
  ]
    .filter(Boolean)
    .join('\n\n');

  return [
    {
      role: 'system',
      content: `${SYSTEM}\n现在进入追问模式：回答要短、准、贴着原文，能用例子就用例子，控制在 300 字内。`,
    },
    { role: 'user', content: `${context}\n\n用户问题：${question}` },
  ];
}
