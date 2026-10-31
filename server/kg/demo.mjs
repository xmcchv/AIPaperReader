/**
 * 内置示例：没配 API Key 也能立刻看到完整交互（图谱、前置链路、出处、思维导图）。
 * 它是一份"可导入的资料"，点「加载示例」就走和真实导入完全相同的合并流程。
 */

export const DEMO_SOURCE = {
  kind: 'text',
  title: '示例资料 · Transformer 与注意力机制',
  url: 'https://arxiv.org/abs/1706.03762',
  text: `Transformer 与注意力机制（整理笔记）

在把文本交给模型之前，先要把词变成向量，这一步叫词表示（Word Representation）。词表示决定了模型能看见什么，后面所有结构都建立在它之上。

循环神经网络（RNN）曾长期是序列建模的主流：它按时间步依次读入词向量，用隐状态携带历史信息。问题是必须顺序计算，长距离依赖会被逐步稀释，训练也无法并行。

编码器-解码器（Encoder-Decoder）把任务拆成两段：编码器把输入序列压成表示，解码器据此逐词生成输出。它是机器翻译等序列到序列任务的基本骨架。

注意力机制（Attention）让模型在生成每个位置时直接回看输入的所有位置，按相关性加权求和，而不是把信息压进一个固定向量。权重由查询与键的相似度决定。

缩放点积注意力（Scaled Dot-Product Attention）是注意力的具体算法：查询与键做点积得到分数，除以维度的平方根避免 softmax 落在饱和区，再对值加权求和。

多头注意力（Multi-Head Attention）把同一份表示投影到多组子空间，并行做多次缩放点积注意力再拼接。不同的头可以关注不同的关系，例如指代、句法或位置邻近。

自注意力（Self-Attention）指查询、键、值都来自同一段序列的注意力，因此序列中任意两个位置之间的路径长度都是 1，长距离依赖不需要经过循环。

位置编码（Positional Encoding）补上顺序信息：自注意力本身对排列不敏感，必须把位置写成向量加进词表示，模型才知道词的先后。

残差连接（Residual Connection）把子层的输入直接加到输出上，让梯度有一条直通的路径，深层网络才训练得动。

层归一化（Layer Normalization）在每个样本内部对特征做归一化，稳定激活值的尺度，与残差连接一起决定深层堆叠能否收敛。

前馈网络（Feed-Forward Network）在每个位置上独立地做两次线性变换加非线性激活，负责逐位置的特征变换，不与其它位置交互。

Transformer 编码器层（Encoder Layer）把多头注意力、前馈网络各自包上残差连接与层归一化，是"注意力 + 逐位置变换"的标准积木。

Transformer 模型把若干编码器层与解码器层堆叠起来，完全用注意力替代循环结构，训练可以并行，长距离依赖的路径最短。代价是计算量随序列长度平方增长，位置信息要额外编码。`,
};

/** 名称形式的图：合并时按名字解析，已存在的概念会自动并过去 */
export const DEMO_GRAPH = {
  topics: ['深度学习', '自然语言处理', 'Transformer'],
  concepts: [
    {
      name: '词表示',
      aliases: ['Word Representation', 'Embedding'],
      summary: '把词映射成稠密向量，是后续所有结构共享的输入。',
      kind: 'concept',
      tags: ['基础'],
      prereqs: [],
      quotes: ['在把文本交给模型之前，先要把词变成向量，这一步叫词表示（Word Representation）。'],
    },
    {
      name: '序列建模',
      summary: '对有序序列建模的任务设定：输出依赖于输入的顺序与上下文。',
      kind: 'task',
      tags: ['任务'],
      prereqs: ['词表示'],
      quotes: ['词表示决定了模型能看见什么，后面所有结构都建立在它之上。'],
    },
    {
      name: '循环神经网络',
      aliases: ['RNN'],
      summary: '按时间步顺序读入、用隐状态传递历史信息的序列模型。',
      kind: 'method',
      tags: ['序列模型'],
      prereqs: ['序列建模'],
      quotes: ['它按时间步依次读入词向量，用隐状态携带历史信息。'],
    },
    {
      name: '编码器-解码器',
      aliases: ['Encoder-Decoder'],
      summary: '编码器压缩输入、解码器逐词生成输出的两段式结构。',
      kind: 'method',
      tags: ['结构'],
      prereqs: ['序列建模'],
      quotes: ['编码器把输入序列压成表示，解码器据此逐词生成输出。'],
    },
    {
      name: '注意力机制',
      aliases: ['Attention'],
      summary: '按查询与键的相关性对值加权求和，直接回看所有输入位置。',
      kind: 'concept',
      tags: ['核心机制'],
      prereqs: ['词表示'],
      quotes: ['注意力机制（Attention）让模型在生成每个位置时直接回看输入的所有位置，按相关性加权求和，而不是把信息压进一个固定向量。'],
    },
    {
      name: '缩放点积注意力',
      aliases: ['Scaled Dot-Product Attention'],
      summary: '点积打分、除以维度平方根后 softmax 加权的注意力算法。',
      kind: 'formula',
      tags: ['核心机制'],
      prereqs: ['注意力机制'],
      quotes: ['查询与键做点积得到分数，除以维度的平方根避免 softmax 落在饱和区，再对值加权求和。'],
    },
    {
      name: '自注意力',
      aliases: ['Self-Attention'],
      summary: '查询、键、值同源的注意力，任意两位置路径长度为 1。',
      kind: 'concept',
      tags: ['核心机制'],
      prereqs: ['缩放点积注意力'],
      quotes: ['查询、键、值都来自同一段序列的注意力，因此序列中任意两个位置之间的路径长度都是 1，长距离依赖不需要经过循环。'],
    },
    {
      name: '多头注意力',
      aliases: ['Multi-Head Attention'],
      summary: '多组子空间并行做注意力再拼接，不同头关注不同关系。',
      kind: 'method',
      tags: ['核心机制'],
      prereqs: ['自注意力'],
      quotes: ['把同一份表示投影到多组子空间，并行做多次缩放点积注意力再拼接。'],
    },
    {
      name: '位置编码',
      aliases: ['Positional Encoding'],
      summary: '把位置写成向量加进词表示，补上顺序信息。',
      kind: 'method',
      tags: ['结构'],
      prereqs: ['词表示'],
      quotes: ['自注意力本身对排列不敏感，必须把位置写成向量加进词表示，模型才知道词的先后。'],
    },
    {
      name: '残差连接',
      aliases: ['Residual Connection'],
      summary: '把子层输入直接加到输出上，给梯度一条直通路径。',
      kind: 'method',
      tags: ['训练技巧'],
      prereqs: [],
      quotes: ['把子层的输入直接加到输出上，让梯度有一条直通的路径，深层网络才训练得动。'],
    },
    {
      name: '层归一化',
      aliases: ['Layer Normalization', 'LayerNorm'],
      summary: '在样本内部对特征归一化，稳定激活尺度。',
      kind: 'method',
      tags: ['训练技巧'],
      prereqs: ['残差连接'],
      quotes: ['在每个样本内部对特征做归一化，稳定激活值的尺度，与残差连接一起决定深层堆叠能否收敛。'],
    },
    {
      name: '前馈网络',
      aliases: ['Feed-Forward Network', 'FFN'],
      summary: '逐位置独立的两层线性变换 + 非线性，不与其它位置交互。',
      kind: 'method',
      tags: ['结构'],
      prereqs: [],
      quotes: ['在每个位置上独立地做两次线性变换加非线性激活，负责逐位置的特征变换，不与其它位置交互。'],
    },
    {
      name: 'Transformer 编码器层',
      aliases: ['Encoder Layer'],
      summary: '注意力与前馈网络各包一层残差和归一化的标准积木。',
      kind: 'method',
      tags: ['结构'],
      prereqs: ['多头注意力', '位置编码', '残差连接', '层归一化', '前馈网络'],
      quotes: ['把多头注意力、前馈网络各自包上残差连接与层归一化，是"注意力 + 逐位置变换"的标准积木。'],
    },
    {
      name: 'Transformer',
      summary: '完全用注意力替代循环的序列模型，训练可并行但复杂度随长度平方增长。',
      kind: 'method',
      tags: ['模型'],
      prereqs: ['编码器-解码器', 'Transformer 编码器层'],
      quotes: ['完全用注意力替代循环结构，训练可以并行，长距离依赖的路径最短。'],
    },
  ],
  edges: [
    { from: '循环神经网络', to: 'Transformer', type: 'related', label: '被后者替代' },
    { from: '多头注意力', to: '缩放点积注意力', type: 'extends', label: '多子空间并行' },
    { from: 'Transformer', to: '编码器-解码器', type: 'extends', label: '沿用两段式骨架' },
    { from: '位置编码', to: '自注意力', type: 'related', label: '补齐顺序信息' },
  ],
};
