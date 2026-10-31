/**
 * 图谱布局与渲染（零依赖，纯 SVG）。
 *
 * 两种布局都是确定性的：同样的数据 → 同样的图。刷新、重启、换机器都不会跳。
 *   dag  分层有向图：只按 prereq 边分层（学它之前要先学什么），从左到右阅读
 *   mind 思维导图：以某个知识点为根的放射树，适合"讲给别人听"
 *
 * 手工拖动会记成每个节点的偏移量，存回 /api/layout 后位置就固定下来。
 */

const NODE_H = 38;
const UNIT_PX = 13;
/** 一行大约能放多少"字宽"：中文 1，ASCII 0.55 */
const LINE_UNITS = 13;

/* -------------------------------- 文本度量 -------------------------------- */

const isAscii = (text) => /^[\x20-\x7e]+$/.test(text);

const widthUnits = (text) =>
  [...String(text || '')].reduce((width, ch) => width + (isAscii(ch) ? 0.55 : 1), 0);

/**
 * 名称折行：按显示宽度切（中文 1 单位、ASCII 0.55 单位），
 * 英文不拆词，最多两行，超出的第二行用省略号收尾。
 */
export function splitLabel(name, maxUnits = LINE_UNITS) {
  const raw = String(name || '').trim();
  if (!raw) return [''];
  if (widthUnits(raw) <= maxUnits) return [raw];

  // 切成"词块"：连续的 ASCII 算一个词，空格和单个汉字各算一个块
  const tokens = [];
  let buffer = '';
  for (const ch of raw) {
    if (/[A-Za-z0-9][A-Za-z0-9\-_'’./]*/.test(ch) || (/[A-Za-z0-9\-_'’./]/.test(ch) && buffer)) {
      buffer += ch;
      continue;
    }
    if (buffer) {
      tokens.push({ text: buffer, width: buffer.length * 0.55 });
      buffer = '';
    }
    if (/\s/.test(ch)) tokens.push({ text: ' ', width: 0.4, space: true });
    else tokens.push({ text: ch, width: 1 });
  }
  if (buffer) tokens.push({ text: buffer, width: buffer.length * 0.55 });

  const lines = [];
  let current = '';
  let width = 0;
  let truncated = false;
  for (const token of tokens) {
    if (width + token.width > maxUnits && current.trim()) {
      lines.push(current.trim());
      current = '';
      width = 0;
      if (lines.length === 2) {
        truncated = true;
        break;
      }
      if (token.space) continue;
    }
    current += token.text;
    width += token.width;
  }
  if (current.trim() && lines.length < 2) lines.push(current.trim());
  else if (current.trim()) truncated = true;

  if (truncated) {
    if (lines.length < 2) lines.push('…');
    else lines[1] = `${lines[1].slice(0, Math.max(1, lines[1].length - 1))}…`;
  }
  return lines.slice(0, 2);
}

function measure(lines) {
  const widest = lines.reduce((max, line) => Math.max(max, widthUnits(line)), 0);
  return Math.max(84, Math.min(200, Math.round(widest * UNIT_PX + 24)));
}

/* -------------------------------- 图结构工具 -------------------------------- */

function buildAdjacency(concepts, edges, types) {
  const byId = new Map(concepts.map((concept) => [concept.id, concept]));
  const out = new Map(concepts.map((concept) => [concept.id, []]));
  const inc = new Map(concepts.map((concept) => [concept.id, []]));
  for (const edge of edges) {
    if (types && !types.includes(edge.type)) continue;
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    out.get(edge.from).push(edge.to);
    inc.get(edge.to).push(edge.from);
  }
  return { out, inc, byId };
}

/** DFS 找出一条回边就丢掉它，保证分层算法面对的是 DAG */
function breakCycles(concepts, edges) {
  const { out } = buildAdjacency(concepts, edges, ['prereq']);
  const state = new Map(); // 0 未访问 1 在栈上 2 完成
  const dropped = new Set();
  const visit = (id) => {
    state.set(id, 1);
    for (const next of out.get(id) || []) {
      const s = state.get(next) || 0;
      if (s === 1) {
        dropped.add(`${id}>${next}`);
        continue;
      }
      if (s === 0) visit(next);
    }
    state.set(id, 2);
  };
  for (const concept of concepts) if (!state.get(concept.id)) visit(concept.id);
  return dropped;
}

/* -------------------------------- 分层布局 -------------------------------- */

/**
 * 最长路径分层 + 重心排序，输出确定性的坐标。
 * 只让 prereq 边决定层级；extends / related / flow 只画线，不挪位置。
 */
export function buildLayeredLayout(concepts, edges, { offsets = {}, direction = 'LR' } = {}) {
  const nodes = concepts.map((concept) => {
    const lines = splitLabel(concept.name);
    return {
      id: concept.id,
      concept,
      lines,
      w: measure(lines),
      h: NODE_H + (lines.length > 1 ? 12 : 0),
      layer: 0,
      order: 0,
      x: 0,
      y: 0,
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  const prereqEdges = edges.filter((edge) => edge.type === 'prereq' && nodeById.has(edge.from) && nodeById.has(edge.to));
  // 没有前置关系时退化成"用现有关系分层"，至少不会全挤在一行
  const flowEdges = prereqEdges.length
    ? prereqEdges
    : edges.filter((edge) => ['extends', 'flow'].includes(edge.type) && nodeById.has(edge.from) && nodeById.has(edge.to));

  const dropped = breakCycles(concepts, flowEdges);
  const { inc, out } = buildAdjacency(concepts, flowEdges, null);

  // 拓扑序 + 最长路径
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of flowEdges) {
    if (dropped.has(`${edge.from}>${edge.to}`)) continue;
    if (!indegree.has(edge.to)) indegree.set(edge.to, 0);
    indegree.set(edge.to, (indegree.get(edge.to) || 0) + 1);
  }
  const queue = nodes.filter((node) => (indegree.get(node.id) || 0) === 0).map((node) => node.id);
  const rank = new Map(nodes.map((node) => [node.id, 0]));
  const order = [];
  while (queue.length) {
    const id = queue.shift();
    order.push(id);
    const node = nodeById.get(id);
    node.layer = rank.get(id) || 0;
    for (const next of out.get(id) || []) {
      if (dropped.has(`${id}>${next}`)) continue;
      rank.set(next, Math.max(rank.get(next) || 0, node.layer + 1));
      indegree.set(next, (indegree.get(next) || 0) - 1);
      if ((indegree.get(next) || 0) <= 0) queue.push(next);
    }
  }
  // 有环兜底：没被拓扑到的节点放到最后一层
  const maxLayer = Math.max(0, ...[...rank.values()]);
  const placed = new Set(order);
  for (const node of nodes) {
    if (!placed.has(node.id)) node.layer = maxLayer + 1;
  }

  // 层内排序：先按名字，再用重心法迭代几次减少交叉
  const layers = [];
  for (const node of nodes) {
    (layers[node.layer] = layers[node.layer] || []).push(node);
  }
  for (const layer of layers) {
    if (!layer) continue;
    layer.sort((a, b) => a.concept.name.localeCompare(b.concept.name, 'zh-Hans-CN'));
    layer.forEach((node, index) => {
      node.order = index;
    });
  }

  for (let pass = 0; pass < 4; pass += 1) {
    for (let i = 1; i < layers.length; i += 1) {
      const prev = layers[i - 1] || [];
      const prevPos = new Map(prev.map((node) => [node.id, node.order]));
      for (const node of layers[i] || []) {
        const parents = (inc.get(node.id) || []).filter((id) => prevPos.has(id));
        if (!parents.length) continue;
        node.bary = parents.reduce((sum, id) => sum + prevPos.get(id), 0) / parents.length;
      }
      (layers[i] || []).sort((a, b) => {
        const ba = a.bary ?? a.order;
        const bb = b.bary ?? b.order;
        return ba - bb || a.concept.name.localeCompare(b.concept.name, 'zh-Hans-CN');
      });
      (layers[i] || []).forEach((node, index) => {
        node.order = index;
        node.bary = undefined;
      });
    }
  }

  // 坐标：层沿 x，层内沿 y，整体按最长的一层居中
  const gapX = 88;
  const gapY = 22;
  const layerWidths = layers.map((layer) => Math.max(0, ...(layer || []).map((node) => node.w)));
  const layerHeights = layers.map((layer) =>
    (layer || []).reduce((sum, node) => sum + node.h, 0) + Math.max(0, (layer || []).length - 1) * gapY,
  );
  const totalHeight = Math.max(0, ...layerHeights);
  let x = 0;
  layers.forEach((layer, index) => {
    const width = layerWidths[index] || 0;
    let y = (totalHeight - (layerHeights[index] || 0)) / 2;
    for (const node of layer || []) {
      node.x = x + width / 2;
      node.y = y + node.h / 2;
      y += node.h + gapY;
    }
    x += width + gapX;
  });

  return finalize(nodes, edges, offsets, direction);
}

/* -------------------------------- 思维导图 -------------------------------- */

/**
 * 以 rootId 为根，把图当无向图做 BFS 生成树，再按叶子数分配角度扇区。
 * 每层半径由"该层最小角距 + 节点尺寸"反推，既保证不重叠，也不会把图撑得过大。
 * 生成树的边会单独标记出来，导图模式下其它关系淡化显示。
 */
export function buildMindmapLayout(concepts, edges, rootId, { offsets = {} } = {}) {
  const { out, inc } = buildAdjacency(concepts, edges, null);
  const nodes = concepts.map((concept) => {
    const lines = splitLabel(concept.name);
    return {
      id: concept.id,
      concept,
      lines,
      w: measure(lines),
      h: NODE_H + (lines.length > 1 ? 12 : 0),
      x: 0,
      y: 0,
      depth: 0,
      children: [],
    };
  });
  const nodeById = new Map(nodes.map((node) => [node.id, node]));

  let root = nodeById.get(rootId);
  if (!root) {
    // 没指定根：优先"没有前置、撑起最多"的节点，它讲起来最像开篇
    root =
      nodes
        .slice()
        .map((node) => ({ node, indeg: inc.get(node.id)?.length || 0, outdeg: out.get(node.id)?.length || 0 }))
        .sort(
          (a, b) =>
            a.indeg - b.indeg ||
            b.outdeg - a.outdeg ||
            a.node.concept.name.length - b.node.concept.name.length,
        )[0]?.node || null;
  }
  if (!root) return finalize([], edges, offsets, 'mind');

  // BFS 生成树：优先沿 prereq 的正向（"它撑起了什么"），其次任意相连
  const seen = new Set([root.id]);
  const queue = [root.id];
  const treeEdgeKeys = new Set();
  while (queue.length) {
    const id = queue.shift();
    const node = nodeById.get(id);
    const candidates = [...(out.get(id) || []), ...(inc.get(id) || [])];
    for (const nextId of candidates) {
      if (seen.has(nextId)) continue;
      const child = nodeById.get(nextId);
      if (!child) continue;
      seen.add(nextId);
      child.depth = node.depth + 1;
      node.children.push(child);
      treeEdgeKeys.add(`${id}>${nextId}`);
      queue.push(nextId);
    }
  }
  // 孤立点也画出来，挂在根的第一层
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    node.depth = 1;
    root.children.push(node);
    treeEdgeKeys.add(`${root.id}>${node.id}`);
  }

  // 后序算叶子数
  const leaves = new Map();
  const countLeaves = (node) => {
    if (!node.children.length) {
      leaves.set(node.id, 1);
      return 1;
    }
    const total = node.children.reduce((sum, child) => sum + countLeaves(child), 0);
    leaves.set(node.id, total);
    return total;
  };
  countLeaves(root);

  // 分配角度：子树按叶子数占比切扇区
  const angles = new Map();
  const placeAngles = (node, startAngle, span) => {
    let angle = startAngle;
    const total = node.children.reduce((sum, child) => sum + (leaves.get(child.id) || 1), 0);
    for (const child of node.children) {
      const childSpan = total ? (span * (leaves.get(child.id) || 1)) / total : 0;
      angles.set(child.id, angle + childSpan / 2);
      placeAngles(child, angle, childSpan);
      angle += childSpan;
    }
  };
  placeAngles(root, -Math.PI / 2, Math.PI * 2);

  // 每层半径：同层相邻节点之间的弦长要不小于节点对角线 + 间隙
  const layers = new Map();
  for (const node of nodes) {
    if (!seen.has(node.id) || node.id === root.id) continue;
    if (!layers.has(node.depth)) layers.set(node.depth, []);
    layers.get(node.depth).push(node);
  }
  const radiusOf = new Map();
  let previous = 0;
  for (const depth of [...layers.keys()].sort((a, b) => a - b)) {
    const list = layers.get(depth).slice().sort((a, b) => (angles.get(a.id) || 0) - (angles.get(b.id) || 0));
    let minGap = Math.PI * 2;
    if (list.length > 1) {
      minGap = Math.PI * 2;
      for (let i = 0; i < list.length; i += 1) {
        const current = angles.get(list[i].id) || 0;
        const next = angles.get(list[(i + 1) % list.length].id) || 0;
        let gap = next - current;
        if (gap <= 0) gap += Math.PI * 2;
        minGap = Math.min(minGap, gap);
      }
    }
    const diagonal = Math.max(...list.map((node) => Math.hypot(node.w, node.h)));
    const needed = minGap > 0.004 ? (diagonal + 28) / (2 * Math.sin(Math.min(Math.PI, minGap) / 2)) : 200;
    const radius = Math.max(previous + 120, Math.min(Math.max(needed, 150 + depth * 60), 1500));
    radiusOf.set(depth, radius);
    previous = radius;
  }

  root.x = 0;
  root.y = 0;
  for (const node of nodes) {
    if (!seen.has(node.id) || node.id === root.id) continue;
    const radius = radiusOf.get(node.depth) ?? previous ?? 190;
    const angle = angles.get(node.id) || 0;
    node.x = Math.cos(angle) * radius;
    node.y = Math.sin(angle) * radius;
  }

  const finalNodes = nodes.filter((node) => seen.has(node.id));
  const layout = finalize(finalNodes, edges, offsets, 'mind', root.id);
  layout.treeEdgeKeys = treeEdgeKeys;
  return layout;
}

/* -------------------------------- 收尾 -------------------------------- */

function finalize(nodes, edges, offsets, direction, rootId = '') {
  for (const node of nodes) {
    const offset = offsets[node.id];
    if (offset && Number.isFinite(offset.x) && Number.isFinite(offset.y)) {
      node.x += offset.x;
      node.y += offset.y;
    }
  }
  const ids = new Set(nodes.map((node) => node.id));
  const links = edges
    .filter((edge) => ids.has(edge.from) && ids.has(edge.to))
    .map((edge) => ({ ...edge }));
  const box = bounds(nodes);
  return { mode: direction === 'mind' ? 'mind' : 'dag', nodes, edges: links, bounds: box, rootId };
}

function bounds(nodes) {
  if (!nodes.length) return { minX: 0, minY: 0, maxX: 800, maxY: 600 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - node.w / 2);
    maxX = Math.max(maxX, node.x + node.w / 2);
    minY = Math.min(minY, node.y - node.h / 2);
    maxY = Math.max(maxY, node.y + node.h / 2);
  }
  return { minX, minY, maxX, maxY };
}

/* -------------------------------- 前景关系 -------------------------------- */

const EDGE_LABEL = { prereq: '前置', extends: '延伸', related: '并列', flow: '流程' };
export const edgeLabel = (type) => EDGE_LABEL[type] || '相关';

const escapeXml = (text) =>
  String(text ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/* --------------------------------- 视图类 --------------------------------- */

export class GraphView {
  constructor(svg, { onSelect = () => {}, onMessage = () => {}, onRootChange = () => {} } = {}) {
    this.svg = svg;
    this.onSelect = onSelect;
    this.onMessage = onMessage;
    this.onRootChange = onRootChange;
    this.lib = { concepts: [], edges: [] };
    this.offsets = { dag: {}, mind: {} };
    this.mode = 'dag';
    this.rootId = '';
    this.selectedId = '';
    this.query = '';
    this.transform = { x: 0, y: 0, k: 1 };
    this.pathFrom = '';
    this.path = new Set();
    this.layout = null;
    this._bind();
  }

  setData(lib, { mode, rootId, selectedId } = {}) {
    this.lib = {
      concepts: Array.isArray(lib?.concepts) ? lib.concepts : [],
      edges: Array.isArray(lib?.edges) ? lib.edges : [],
    };
    this.offsets = {
      dag: { ...(lib?.layout?.dag || {}) },
      mind: { ...(lib?.layout?.mind || {}) },
    };
    if (mode) this.mode = mode;
    if (rootId !== undefined) this.rootId = rootId;
    if (selectedId !== undefined) this.selectedId = selectedId;
    this.render();
  }

  setMode(mode, rootId) {
    this.mode = mode === 'mind' ? 'mind' : 'dag';
    if (rootId !== undefined) this.rootId = rootId;
    this.path = new Set();
    this.pathFrom = '';
    this.render();
    this.fit();
  }

  /* ------------------------------ 布局与绘制 ------------------------------ */

  computeLayout() {
    if (this.mode === 'mind') {
      return buildMindmapLayout(this.lib.concepts, this.lib.edges, this.rootId, { offsets: this.offsets.mind });
    }
    return buildLayeredLayout(this.lib.concepts, this.lib.edges, { offsets: this.offsets.dag });
  }

  render() {
    const layout = this.computeLayout();
    this.layout = layout;
    // 不设 viewBox：SVG 用户坐标就等于 CSS 像素，fit() 算出来的平移/缩放才准
    this.svg.removeAttribute('viewBox');

    const { nodes, edges } = layout;
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const highlight = this.computeHighlight();
    const query = this.query.trim().toLowerCase();
    const treeKeys = layout.treeEdgeKeys;

    const edgeMarkup = edges.map((edge) => {
      const a = nodeById.get(edge.from);
      const b = nodeById.get(edge.to);
      if (!a || !b) return '';
      const active = this.path.size > 1 && this.path.has(edge.from) && this.path.has(edge.to);
      const damp = highlight.active && !(highlight.nodes.has(edge.from) && highlight.nodes.has(edge.to));
      // 导图模式下非生成树的边只作背景参考，避免长弧线糊成一片
      const secondary =
        this.mode === 'mind' &&
        treeKeys &&
        !treeKeys.has(`${edge.from}>${edge.to}`) &&
        !treeKeys.has(`${edge.to}>${edge.from}`);
      const cls = ['edge', `edge-${edge.type}`, damp ? 'damped' : '', active ? 'edge-path' : '', secondary ? 'edge-secondary' : '']
        .filter(Boolean)
        .join(' ');
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      const label =
        edge.label && this.transform.k > 0.75
          ? `<text class="edge-label" x="${mid.x}" y="${mid.y - 4}" text-anchor="middle">${escapeXml(edge.label)}</text>`
          : '';
      return `<g class="${cls}" data-edge="${edge.id}"><title>${escapeXml(`${a.concept.name} → ${b.concept.name}（${edgeLabel(edge.type)}）`)}</title>${this.edgePath(a, b)}${label}</g>`;
    });

    const nodeMarkup = nodes.map((node) => {
      const concept = node.concept;
      const isMatch = query ? this.matchText(concept).includes(query) : false;
      const classes = [
        'node',
        `kind-${concept.kind || 'concept'}`,
        concept.stub ? 'stub' : '',
        this.selectedId === node.id ? 'selected' : '',
        highlight.nodes.has(node.id) ? 'highlighted' : highlight.active ? 'damped' : '',
        this.path.has(node.id) ? 'path' : '',
        isMatch ? 'match' : query ? 'dimmed-by-search' : '',
      ]
        .filter(Boolean)
        .join(' ');
      const lineMarkup = node.lines
        .map((line, index) => {
          const offset = node.lines.length === 1 ? 4.5 : index === 0 ? -3 : 13;
          return `<text class="node-label" x="0" y="${offset}" text-anchor="middle">${escapeXml(line)}</text>`;
        })
        .join('');
      const badge = node.concept.stub ? '<circle class="stub-dot" cx="0" cy="-2" r="3" />' : '';
      const isRoot = this.mode === 'mind' && layout.rootId === node.id;
      return `<g class="${classes}${isRoot ? ' node-root' : ''}" data-node="${node.id}" transform="translate(${node.x.toFixed(1)},${node.y.toFixed(1)})"><title>${escapeXml(`${concept.name}${concept.summary ? `\n${concept.summary}` : ''}`)}</title><rect x="${-node.w / 2}" y="${-node.h / 2}" width="${node.w}" height="${node.h}" rx="10" />${lineMarkup}${badge}</g>`;
    });

    this.svg.innerHTML = `
      <defs>
        <marker id="arrow-prereq" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path class="arrow-head-prereq" d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
        <marker id="arrow-related" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path class="arrow-head-related" d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
        <marker id="arrow-extends" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path class="arrow-head-extends" d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
        <marker id="arrow-flow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
          <path class="arrow-head-flow" d="M 0 0 L 10 5 L 0 10 z" />
        </marker>
      </defs>
      <g class="viewport" transform="translate(${this.transform.x},${this.transform.y}) scale(${this.transform.k})">
        <g class="edges">${edgeMarkup.join('')}</g>
        <g class="nodes">${nodeMarkup.join('')}</g>
      </g>`;
    this.applyTransform();
  }

  edgePath(a, b) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const ax = a.x + Math.sign(dx || 1) * (a.w / 2);
    const bx = b.x - Math.sign(dx || 1) * (b.w / 2);
    if (Math.abs(dy) < 6) {
      return `<path d="M${ax.toFixed(1)},${a.y.toFixed(1)} L${bx.toFixed(1)},${b.y.toFixed(1)}" />`;
    }
    const mx = (ax + bx) / 2;
    return `<path d="M${ax.toFixed(1)},${a.y.toFixed(1)} C${mx.toFixed(1)},${a.y.toFixed(1)} ${mx.toFixed(1)},${b.y.toFixed(1)} ${bx.toFixed(1)},${b.y.toFixed(1)}" />`;
  }

  applyTransform() {
    const viewport = this.svg.querySelector('.viewport');
    if (!viewport) return;
    viewport.setAttribute(
      'transform',
      `translate(${this.transform.x.toFixed(2)},${this.transform.y.toFixed(2)}) scale(${this.transform.k.toFixed(4)})`,
    );
  }

  matchText(concept) {
    return [concept.name, concept.summary, ...(concept.aliases || []), ...(concept.tags || [])]
      .join(' ')
      .toLowerCase();
  }

  /* -------------------------------- 高亮计算 -------------------------------- */

  computeHighlight() {
    const active = Boolean(this.selectedId) || this.path.size > 0;
    const nodes = new Set();
    if (!active) return { active: false, nodes };
    const sets = [this.selectedId, ...this.path].filter(Boolean);
    const { out, inc } = buildAdjacency(this.lib.concepts, this.lib.edges, null);

    const walk = (starts, adjacency) => {
      const stack = [...starts];
      const seen = new Set();
      while (stack.length) {
        const id = stack.pop();
        for (const next of adjacency.get(id) || []) {
          if (seen.has(next)) continue;
          seen.add(next);
          stack.push(next);
        }
      }
      return seen;
    };
    for (const id of sets) {
      nodes.add(id);
      for (const id2 of walk([id], inc)) nodes.add(id2); // 所有前置
      for (const id2 of walk([id], out)) nodes.add(id2); // 所有延伸
    }
    return { active, nodes };
  }

  setSearch(query) {
    this.query = String(query || '');
    this.render();
  }

  select(id) {
    this.selectedId = id || '';
    this.render();
  }

  /** Shift 点击：第一次记起点，第二次算两点之间的最短路径（沿无向关系） */
  togglePath(id) {
    if (!this.pathFrom) {
      this.pathFrom = id;
      this.path = new Set([id]);
      this.selectedId = id;
      this.render();
      const name = this.lib.concepts.find((c) => c.id === id)?.name || '';
      this.onMessage(`起点：${name} —— 再 Shift 点另一个知识点，看它们之间的通路`);
      return;
    }
    const from = this.pathFrom;
    this.pathFrom = '';
    const path = shortestPath(this.lib.concepts, this.lib.edges, from, id);
    this.path = new Set(path || []);
    this.selectedId = id;
    this.render();
    if (!path) {
      this.onMessage('这两个知识点之间没有可见通路（可以在右侧给它们补一条关系）');
    } else {
      const names = path.map((pid) => this.lib.concepts.find((c) => c.id === pid)?.name).filter(Boolean);
      this.onMessage(names.join(' → '));
    }
  }

  clearPath() {
    this.path = new Set();
    this.pathFrom = '';
    this.render();
  }

  /* -------------------------------- 视图操作 -------------------------------- */

  fit(padding = 48, minScale = 0.45) {
    const rect = this.svg.getBoundingClientRect();
    const width = rect.width || 900;
    const height = rect.height || 640;
    const bounds = this.layout?.bounds;
    // 空图不缩放，避免空状态显示一个奇怪的百分比
    if (!bounds || !this.layout?.nodes?.length) {
      this.transform = { k: 1, x: 0, y: 0 };
      this.applyTransform();
      return;
    }
    const bw = Math.max(120, bounds.maxX - bounds.minX);
    const bh = Math.max(120, bounds.maxY - bounds.minY);
    // 缩到全览会看不清字：默认给一个可读下限，需要全貌时点「适应」（minScale 更低）
    const raw = Math.min((width - padding * 2) / bw, (height - padding * 2) / bh);
    const k = Math.min(1.35, Math.max(minScale, raw));
    const cx = (bounds.minX + bounds.maxX) / 2;
    const cy = (bounds.minY + bounds.maxY) / 2;
    this.transform = { k, x: width / 2 - cx * k, y: height / 2 - cy * k };
    this.applyTransform();
  }

  zoomBy(factor, center) {
    const rect = this.svg.getBoundingClientRect();
    const cx = center?.x ?? rect.width / 2;
    const cy = center?.y ?? rect.height / 2;
    const k = Math.min(3.2, Math.max(0.12, this.transform.k * factor));
    const ratio = k / this.transform.k;
    this.transform = {
      k,
      x: cx - (cx - this.transform.x) * ratio,
      y: cy - (cy - this.transform.y) * ratio,
    };
    this.applyTransform();
  }

  /** 把某个节点摆到画布正中（详情里「在图上定位」用） */
  centerOn(id, minScale = 0.95) {
    const node = this.layout?.nodes.find((item) => item.id === id);
    if (!node) return false;
    const rect = this.svg.getBoundingClientRect();
    const k = Math.max(this.transform.k, minScale);
    this.transform = {
      k,
      x: (rect.width || 900) / 2 - node.x * k,
      y: (rect.height || 640) / 2 - node.y * k,
    };
    this.applyTransform();
    this.selectedId = id;
    this.render();
    return true;
  }

  resetZoom() {
    this.transform = { x: this.transform.x, y: this.transform.y, k: 1 };
    this.applyTransform();
  }

  /* -------------------------------- 事件 -------------------------------- */

  _bind() {
    const svg = this.svg;
    let drag = null;

    svg.addEventListener('wheel', (event) => {
      event.preventDefault();
      const rect = svg.getBoundingClientRect();
      this.zoomBy(Math.exp(-event.deltaY * 0.0016), { x: event.clientX - rect.left, y: event.clientY - rect.top });
    }, { passive: false });

    svg.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      const nodeEl = event.target.closest('.node');
      drag = {
        startX: event.clientX,
        startY: event.clientY,
        originX: this.transform.x,
        originY: this.transform.y,
        nodeId: nodeEl?.dataset.node || '',
        moved: false,
        shift: event.shiftKey,
        nodeStart: nodeEl ? this.nodePosition(nodeEl.dataset.node) : null,
      };
      if (drag.nodeId) svg.classList.add('dragging-node');
      else svg.classList.add('dragging-bg');
    });

    window.addEventListener('mousemove', (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      if (drag.nodeId && drag.nodeStart) {
        const nodeEl = svg.querySelector(`.node[data-node="${drag.nodeId}"]`);
        if (!nodeEl) return;
        const nx = drag.nodeStart.x + dx / this.transform.k;
        const ny = drag.nodeStart.y + dy / this.transform.k;
        nodeEl.setAttribute('transform', `translate(${nx.toFixed(1)},${ny.toFixed(1)})`);
        if (!this.pendingDrag) {
          this.pendingDrag = { nodeId: drag.nodeId, nodes: (this.layout?.nodes || []).map((node) => ({ ...node })) };
        }
        const node = this.pendingDrag.nodes.find((item) => item.id === drag.nodeId);
        if (node) {
          node.x = nx;
          node.y = ny;
        }
        this.redrawEdgesForDrag();
      } else {
        this.transform.x = drag.originX + dx;
        this.transform.y = drag.originY + dy;
        this.applyTransform();
      }
    });

    window.addEventListener('mouseup', () => {
      if (!drag) return;
      svg.classList.remove('dragging-node', 'dragging-bg');
      if (drag.moved && drag.nodeId && this.pendingDrag) {
        // 记录相对自动布局的偏移，落盘后位置就固定了
        const auto = this.computeLayoutWithoutOffsets();
        const autoNode = auto.nodes.find((node) => node.id === drag.nodeId);
        const moved = this.pendingDrag.nodes.find((node) => node.id === drag.nodeId);
        if (autoNode && moved) {
          const bucket = this.mode === 'mind' ? this.offsets.mind : this.offsets.dag;
          bucket[drag.nodeId] = { x: moved.x - autoNode.x, y: moved.y - autoNode.y };
          fetch('/api/kg/layout', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mode: this.mode, positions: bucket }),
          }).catch(() => {});
        }
        this.pendingDrag = null;
        this.render();
      } else if (!drag.moved) {
        if (drag.nodeId) {
          if (drag.shift) this.togglePath(drag.nodeId);
          else {
            this.path = new Set();
            this.pathFrom = '';
            this.selectedId = drag.nodeId;
            this.render();
            this.onSelect(drag.nodeId);
          }
        } else {
          this.selectedId = '';
          this.path = new Set();
          this.render();
          this.onSelect('');
        }
      }
      drag = null;
    });

    svg.addEventListener('dblclick', (event) => {
      const nodeEl = event.target.closest('.node');
      if (!nodeEl) return;
      this.onRootChange(nodeEl.dataset.node);
    });
  }

  nodePosition(id) {
    const node = this.layout?.nodes.find((item) => item.id === id);
    return node ? { x: node.x, y: node.y } : null;
  }

  computeLayoutWithoutOffsets() {
    if (this.mode === 'mind') return buildMindmapLayout(this.lib.concepts, this.lib.edges, this.rootId, { offsets: {} });
    return buildLayeredLayout(this.lib.concepts, this.lib.edges, { offsets: {} });
  }

  redrawEdgesForDrag() {
    const nodeById = new Map(this.pendingDrag.nodes.map((node) => [node.id, node]));
    const groups = this.svg.querySelectorAll('.edges .edge');
    groups.forEach((group) => {
      const edge = this.lib.edges.find((item) => item.id === group.dataset.edge);
      if (!edge) return;
      const a = nodeById.get(edge.from);
      const b = nodeById.get(edge.to);
      if (!a || !b) return;
      const path = group.querySelector('path');
      if (!path) return;
      const ax = a.x + Math.sign(b.x - a.x || 1) * (a.w / 2);
      const bx = b.x - Math.sign(b.x - a.x || 1) * (b.w / 2);
      const mx = (ax + bx) / 2;
      path.setAttribute(
        'd',
        Math.abs(b.y - a.y) < 6
          ? `M${ax.toFixed(1)},${a.y.toFixed(1)} L${bx.toFixed(1)},${b.y.toFixed(1)}`
          : `M${ax.toFixed(1)},${a.y.toFixed(1)} C${mx.toFixed(1)},${a.y.toFixed(1)} ${mx.toFixed(1)},${b.y.toFixed(1)} ${bx.toFixed(1)},${b.y.toFixed(1)}`,
      );
    });
  }

  /* -------------------------------- 导出 -------------------------------- */

  exportSvg() {
    const bounds = this.layout?.bounds || { minX: 0, minY: 0, maxX: 900, maxY: 600 };
    const pad = 48;
    const width = Math.ceil(bounds.maxX - bounds.minX + pad * 2);
    const height = Math.ceil(bounds.maxY - bounds.minY + pad * 2);
    const viewport = this.svg.querySelector('.viewport');
    if (!viewport) return null;
    const clone = viewport.cloneNode(true);
    clone.setAttribute('transform', `translate(${pad - bounds.minX},${pad - bounds.minY})`);
    const theme = getComputedStyle(document.documentElement);
    const vars = [
      '--edge-prereq',
      '--edge-extends',
      '--edge-related',
      '--edge-flow',
      '--node-bg',
      '--node-border',
      '--node-text',
      '--graph-bg',
      '--muted',
    ]
      .map((name) => `${name}:${theme.getPropertyValue(name).trim()};`)
      .join('');
    const css = `
      :root { ${vars} }
      .node rect { fill: var(--node-bg); stroke: var(--node-border); stroke-width: 1.4; }
      .node.kind-method rect { stroke: #7c6cf0; }
      .node.kind-formula rect { stroke: #12a3a3; }
      .node.kind-data rect { stroke: #2ba36b; }
      .node.kind-result rect { stroke: #d9822b; }
      .node.kind-task rect { stroke: #c0558f; }
      .node.stub rect { stroke-dasharray: 4 4; opacity: .85; }
      .node-label { fill: var(--node-text); font-size: 13px; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
      .arrow-head-prereq { fill: var(--edge-prereq); }
      .arrow-head-extends { fill: var(--edge-extends); }
      .arrow-head-related { fill: var(--edge-related); }
      .arrow-head-flow { fill: var(--edge-flow); }
      .edge path { fill: none; stroke-width: 1.5; }
      .edge-prereq path { stroke: var(--edge-prereq); marker-end: url(#arrow-prereq); }
      .edge-extends path { stroke: var(--edge-extends); stroke-dasharray: 7 4; marker-end: url(#arrow-extends); }
      .edge-related path { stroke: var(--edge-related); stroke-dasharray: 2 4; marker-end: url(#arrow-related); }
      .edge-flow path { stroke: var(--edge-flow); stroke-dasharray: 5 3; marker-end: url(#arrow-flow); }
      .edge-label { fill: var(--muted); font-size: 10.5px; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    `;
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <style>${css}</style>
  <rect width="100%" height="100%" fill="var(--graph-bg)" />
  <g class="export-root">${clone.outerHTML}</g>
</svg>`;
  }

  async exportPng({ scale = 2 } = {}) {
    const markup = this.exportSvg();
    if (!markup) return null;
    const blob = new Blob([markup], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    try {
      const image = await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('导出图片失败'));
        img.src = url;
      });
      const canvas = document.createElement('canvas');
      canvas.width = image.width * scale;
      canvas.height = image.height * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);
      ctx.drawImage(image, 0, 0);
      return await new Promise((resolve) => canvas.toBlob((result) => resolve(result), 'image/png'));
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

/** 无向最短路径（用于 Shift 点击两点看通路） */
export function shortestPath(concepts, edges, fromId, toId) {
  if (!fromId || !toId) return null;
  if (fromId === toId) return [fromId];
  const adjacency = new Map(concepts.map((concept) => [concept.id, []]));
  for (const edge of edges) {
    if (!adjacency.has(edge.from) || !adjacency.has(edge.to)) continue;
    adjacency.get(edge.from).push(edge.to);
    adjacency.get(edge.to).push(edge.from);
  }
  const prev = new Map([[fromId, null]]);
  const queue = [fromId];
  while (queue.length) {
    const id = queue.shift();
    if (id === toId) break;
    for (const next of adjacency.get(id) || []) {
      if (prev.has(next)) continue;
      prev.set(next, id);
      queue.push(next);
    }
  }
  if (!prev.has(toId)) return null;
  const path = [];
  let cursor = toId;
  while (cursor !== null) {
    path.unshift(cursor);
    cursor = prev.get(cursor);
  }
  return path;
}
