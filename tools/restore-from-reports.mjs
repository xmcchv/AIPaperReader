/**
 * 从 PaperLens 导出的「精读报告 HTML」还原知识图谱。
 *
 * 用途：知识库丢失、或想把以前读过的论文一次性补进图谱时，
 * 报告里的「精读正文 / 核心概念表 / 方法链路图」都还在，可以重建：
 *   精读正文（7 节）   → 资料正文 + 出处检索源
 *   核心概念表         → 概念（名称 + 一句话解释）
 *   方法链路图 SVG     → 方法节点 + flow 边（SVG 里带 data-id / data-from / data-to）
 *
 * 局限（重要）：
 *   - 出处来自报告里的正文与概念解释，不是论文原文的句子
 *   - 前置关系报告里没有，需要模型可用（或手动补）才会生成
 *   - 图片、追问记录不在报告里，恢复不了
 *
 * 用法：
 *   node tools/restore-from-reports.mjs                    # dry-run，只看解析结果
 *   node tools/restore-from-reports.mjs --import           # 真的写进知识库
 *   node tools/restore-from-reports.mjs --dir=D:\reports --server=http://127.0.0.1:5180 --import
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const arg = (name, fallback) => {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const DIR = arg('dir', path.join(os.homedir(), 'Downloads'));
const BASE = arg('server', 'http://127.0.0.1:5180');
const DO_IMPORT = process.argv.includes('--import');

/* -------------------------------- HTML 解析 -------------------------------- */

const decode = (html) =>
  String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

/** 按 h2 文本切小节（h2 里带 <span class="num">，所以先 decode 再比对） */
function sections(html) {
  const blocks = [];
  const matches = [...html.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/gi)];
  for (let i = 0; i < matches.length; i += 1) {
    const title = decode(matches[i][1]).replace(/^\d+\s*/, '').trim();
    const start = matches[i].index + matches[i][0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : html.length;
    blocks.push({ title, html: html.slice(start, end) });
  }
  return blocks;
}

/** 精读正文：<article class="card"><h3>小节</h3><p>/<ul>… → markdown 风格文本 */
function readingText(blockHtml) {
  const out = [];
  for (const card of blockHtml.matchAll(/<article[^>]*class="card"[^>]*>([\s\S]*?)<\/article>/gi)) {
    const inner = card[1];
    const heading = decode(inner.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i)?.[1] || '');
    const bodyHtml = inner
      .replace(/<h3[\s\S]*?<\/h3>/i, '')
      .replace(/<li[^>]*>/gi, '\n- ')
      .replace(/<\/(p|ul|ol|div)>/gi, '\n');
    const body = decode(bodyHtml).replace(/\n{2,}/g, '\n').trim();
    if (heading) out.push(`## ${heading}`);
    if (body) out.push(body);
  }
  return out.join('\n\n');
}

/** 核心概念表：<tr><th scope="row">概念</th><td>解释</td></tr> */
function conceptRows(blockHtml) {
  const rows = [];
  for (const tr of blockHtml.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const name = decode(tr[1].match(/<th[^>]*>([\s\S]*?)<\/th>/i)?.[1] || '');
    const explain = decode(tr[1].match(/<td[^>]*>([\s\S]*?)<\/td>/i)?.[1] || '');
    if (name && explain && !/概念|一句话解释/.test(name)) rows.push({ name, explain });
  }
  return rows;
}

/** 方法链路图：node-group 的 data-id + text 类；edge-path 的 data-from/to + edge-label */
function parseDiagram(html) {
  const svg = html.match(/<svg[\s\S]*?<\/svg>/i)?.[0] || '';
  if (!svg) return null;
  const nodes = [];
  for (const g of svg.matchAll(/<g[^>]*class="node-group"[^>]*data-id="([^"]+)"[^>]*>([\s\S]*?)<\/g>/gi)) {
    const body = g[2];
    const pick = (cls) => decode(body.match(new RegExp(`<text[^>]*class="${cls}"[^>]*>([\\s\\S]*?)</text>`, 'i'))?.[1] || '');
    const label = pick('node-title');
    if (!label) continue;
    const kindRaw = pick('node-kind').toLowerCase();
    nodes.push({
      id: g[1],
      label,
      detail: pick('node-detail'),
      kind: ['input', 'process', 'data', 'output'].includes(kindRaw) ? kindRaw : 'process',
    });
  }
  const labels = [...svg.matchAll(/<text[^>]*class="edge-label"[^>]*>([\s\S]*?)<\/text>/gi)].map((m) => decode(m[1]));
  const edges = [];
  let index = 0;
  for (const p of svg.matchAll(/<path[^>]*class="edge-path"[^>]*data-from="([^"]+)"[^>]*data-to="([^"]+)"[^>]*>/gi)) {
    edges.push({ from: p[1], to: p[2], label: labels[index] || '' });
    index += 1;
  }
  return { title: '方法链路图', nodes, edges };
}

/** 概念名的写法变体：报告里常用 en dash、全角空格、大小写混排，正文未必逐字一致 */
function variants(name) {
  const list = [name];
  const noSpace = name.replace(/[\s\u00a0]/g, '');
  if (noSpace !== name) list.push(noSpace);
  const dashed = name.replace(/[–—]/g, '-');
  if (dashed !== name) list.push(dashed);
  const dashedNoSpace = dashed.replace(/[\s\u00a0]/g, '');
  if (!list.includes(dashedNoSpace)) list.push(dashedNoSpace);
  const spaced = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  if (spaced !== name) list.push(spaced);
  return [...new Set(list)].slice(0, 4);
}

function parseReport(file) {
  const html = fs.readFileSync(file, 'utf8');
  const rawTitle = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || path.basename(file, '.html'));
  const blocks = sections(html);
  const byTitle = (keyword) => blocks.find((block) => block.title.includes(keyword))?.html || '';
  return {
    file: path.basename(file),
    title: rawTitle.replace(/\s*[·|]\s*精读报告\s*$/, '').trim(),
    summary: decode(byTitle('执行摘要')).slice(0, 400),
    reading: readingText(byTitle('精读正文')),
    concepts: conceptRows(byTitle('核心概念')),
    claims: (() => {
      const rows = [];
      for (const li of byTitle('核心概念').matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
        const label = decode(li[1].match(/<span[^>]*class="claim-label"[^>]*>([\s\S]*?)<\/span>/i)?.[1] || '');
        const text = decode(li[1].replace(/<span[^>]*class="claim-label"[^>]*>[\s\S]*?<\/span>/i, ''));
        if (label && text) rows.push({ label, text });
      }
      return rows;
    })(),
    diagram: parseDiagram(html),
  };
}

/* --------------------------------- 主流程 --------------------------------- */

if (!fs.existsSync(DIR)) {
  console.error(`目录不存在：${DIR}`);
  process.exit(1);
}
const files = fs
  .readdirSync(DIR)
  .filter((name) => name.endsWith('精读报告.html'))
  .map((name) => path.join(DIR, name));
if (!files.length) {
  console.error(`在 ${DIR} 里没有找到 *精读报告.html`);
  process.exit(1);
}

const reports = files.map(parseReport);
for (const report of reports) {
  const hit = report.concepts.filter((c) => variants(c.name).some((v) => report.reading.includes(v))).length;
  console.log(`\n===== ${report.title}`);
  console.log(`  精读正文 ${report.reading.length} 字（${(report.reading.match(/^## /gm) || []).length} 个小节）`);
  console.log(`  概念 ${report.concepts.length} 个：${report.concepts.map((c) => c.name).join('、')}`);
  console.log(`  论断 ${report.claims.length} 条`);
  console.log(
    `  链路图 ${report.diagram?.nodes.length || 0} 节点 / ${report.diagram?.edges.length || 0} 边：${report.diagram?.nodes.map((n) => n.label).join(' → ')}`,
  );
  console.log(`  正文里能定位到名字的概念：${hit}/${report.concepts.length}`);
}

if (!DO_IMPORT) {
  console.log('\n（dry-run，没有写入。加 --import 才会导入）');
  process.exit(0);
}

const post = async (endpoint, body) => {
  const res = await fetch(BASE + endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
};

const health = await fetch(`${BASE}/api/health`).catch(() => null);
if (!health || !health.ok) {
  console.error(`连不上知识图谱服务 ${BASE}，先启动 node server/index.mjs`);
  process.exit(1);
}

for (const report of reports) {
  const paperText = `${report.reading}\n\n${report.concepts.map((c) => `${c.name}：${c.explain}`).join('\n')}`;
  const structure = {
    title: report.title,
    one_liner: report.summary.split('\n')[0] || '',
    tags: [],
    concepts: report.concepts.map((c) => ({ name: c.name, explain: c.explain, terms: variants(c.name) })),
    claims: report.claims,
    diagram: report.diagram,
  };
  const result = await post('/api/import/paperlens', {
    paper: { title: report.title, text: paperText, source: '' },
    reading: report.reading,
    structure,
  });
  if (!result.data.ok) {
    console.log(`  ✗ ${report.title}: ${result.data.error || result.status}`);
    continue;
  }
  const stats = result.data.stats || {};
  console.log(
    `  ✓ ${report.title}: +${stats.conceptsAdded || 0} 概念 / +${stats.edgesAdded || 0} 关系 / 合并 ${stats.conceptsUpdated || 0} 个已有概念`,
  );
}

const state = await (await fetch(BASE + '/api/state')).json();
const lib = state.library;
console.log(`\n当前库：${lib.sources.length} 份资料 / ${lib.concepts.length} 个知识点 / ${lib.edges.length} 条关系`);
console.log(
  `出处：${lib.concepts.filter((c) => c.refs.length).length} 个概念带原句；待补全：${lib.concepts.filter((c) => c.stub).length} 个（默认在图上隐藏）`,
);
