/**
 * 自研 SVG 交互图解渲染器（零依赖）。
 * - 自动分层布局：按有向边做最长路径分层，层内纵向排列
 * - 交互：滚轮缩放、拖背景平移、拖节点重排、点击节点看细节并高亮相关链路
 * - 导出：把当前图（含主题色）序列化为独立 SVG 文件
 */

const SVG_NS = 'http://www.w3.org/2000/svg';
const KIND_COLOR = {
  input: 'var(--accent)',
  process: 'var(--accent-2)',
  data: 'var(--ok)',
  output: 'var(--warn)',
};
const KIND_LABEL = { input: 'INPUT', process: 'PROCESS', data: 'DATA', output: 'OUTPUT' };

// 导出报告/打印时固定用浅色调色板，不跟随界面深色主题
const LIGHT_EXPORT_VARS = {
  '--panel': '#ffffff',
  '--panel-2': '#f6f8fc',
  '--line': '#d7dde8',
  '--text': '#1f2430',
  '--text-dim': '#3d4454',
  '--muted': '#737d90',
  '--accent': '#2f6fdb',
  '--accent-2': '#5b8def',
  '--ok': '#1f8a5b',
  '--warn': '#b45309',
};

const TITLE_SIZE = 12.5;
const DETAIL_SIZE = 10.5;
const PAD_X = 13;
const GAP_X = 78;
const GAP_Y = 26;
const MIN_K = 0.35;
const MAX_K = 2.6;

/* ------------------------------- 文本度量 ------------------------------- */

/** 粗略估算文本宽度：中文 1 个单位，ASCII 0.55 */
function unitLength(str) {
  let u = 0;
  for (const ch of String(str)) {
    if (/[\u2E80-\u9FFF\uFF00-\uFFEF]/.test(ch)) u += 1;
    else if (ch === ' ') u += 0.32;
    else u += 0.56;
  }
  return u;
}

function wrap(text, maxUnits, maxLines = 99) {
  const chars = [...String(text || '').trim()];
  const lines = [];
  let line = '';
  let used = 0;
  for (const ch of chars) {
    const w = unitLength(ch);
    if (used + w > maxUnits && line) {
      lines.push(line);
      line = ch;
      used = w;
      if (lines.length === maxLines) break;
    } else {
      line += ch;
      used += w;
    }
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (!lines.length) lines.push('');
  return lines;
}

/* -------------------------------- 布局 -------------------------------- */

/** 纯函数布局，导出便于测试 */
export function buildLayout(diagram, orientation = 'h') {
  const nodes = (diagram.nodes || []).map((n, i) => ({ ...n, order: i }));  const edges = (diagram.edges || []).filter((e) => e && e.from !== e.to);
  const byId = new Map(nodes.map((n) => [n.id, n]));

  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  const outAdj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue;
    outAdj.get(e.from).push(e.to);
    indeg.set(e.to, (indeg.get(e.to) || 0) + 1);
  }

  // 最长路径分层
  const layer = new Map(nodes.map((n) => [n.id, 0]));
  const queue = nodes.filter((n) => (indeg.get(n.id) || 0) === 0).map((n) => n.id);
  const visited = new Set(queue);
  if (!queue.length && nodes.length) {
    queue.push(nodes[0].id);
    visited.add(nodes[0].id);
  }
  let guard = 0;
  while (queue.length && guard < 5000) {
    guard += 1;
    const id = queue.shift();
    for (const next of outAdj.get(id) || []) {
      layer.set(next, Math.max(layer.get(next) || 0, (layer.get(id) || 0) + 1));
      if (!visited.has(next)) {
        visited.add(next);
        queue.push(next);
      }
    }
  }
  // 环里的节点没被访问到，按前驱最大层兜底
  for (const n of nodes) {
    if (!visited.has(n.id)) {
      const preds = edges.filter((e) => e.to === n.id && layer.has(e.from));
      const base = preds.length ? Math.max(...preds.map((e) => layer.get(e.from) + 1)) : 0;
      layer.set(n.id, base);
    }
  }

  // 尺寸
  for (const n of nodes) {
    const title = n.label || n.id;
    const width = Math.min(248, Math.max(152, unitLength(title) * 7.4 + PAD_X * 2 + 12));
    const titleMaxUnits = (width - PAD_X * 2) / 7.4;
    const detailMaxUnits = (width - PAD_X * 2) / 5.6;
    n._w = width;
    n._titleLines = wrap(title, titleMaxUnits, 3);
    n._detailLines = n.detail ? wrap(n.detail, detailMaxUnits, 3) : [];
    n._h = 20 + n._titleLines.length * (TITLE_SIZE + 5) + (n._detailLines.length ? 4 + n._detailLines.length * (DETAIL_SIZE + 4) : 0) + 12;
    n._layer = layer.get(n.id) || 0;
  }

  // 坐标：按层推进，层内沿另一轴排布并居中。orientation 'h' = 横向流程图，'v' = 纵向流程图
  const dir = orientation === 'v' ? 'v' : 'h';
  const columns = new Map();
  for (const n of nodes) {
    if (!columns.has(n._layer)) columns.set(n._layer, []);
    columns.get(n._layer).push(n);
  }
  const layerKeys = [...columns.keys()].sort((a, b) => a - b);
  const alongGap = dir === 'h' ? GAP_X : GAP_Y;
  const crossGap = dir === 'h' ? GAP_Y : GAP_X;

  const layers = layerKeys.map((key) => {
    const list = columns.get(key).sort((a, b) => a.order - b.order);
    const thick = Math.max(...list.map((n) => (dir === 'h' ? n._w : n._h)));
    const extent = list.reduce((s, n) => s + (dir === 'h' ? n._h : n._w), 0) + crossGap * (list.length - 1);
    return { list, thick, extent };
  });
  const maxExtent = layers.length ? Math.max(...layers.map((l) => l.extent)) : 0;

  let pos = 40;
  for (const layer of layers) {
    let acc = 40 + (maxExtent - layer.extent) / 2;
    for (const n of layer.list) {
      if (dir === 'h') {
        n._x = pos + (layer.thick - n._w) / 2;
        n._y = acc;
        acc += n._h + crossGap;
      } else {
        n._y = pos + (layer.thick - n._h) / 2;
        n._x = acc;
        acc += n._w + crossGap;
      }
    }
    pos += layer.thick + alongGap;
  }

  return {
    nodes,
    edges: edges.filter((e) => byId.has(e.from) && byId.has(e.to)),
    byId: new Map(nodes.map((n) => [n.id, n])),
    title: diagram.title || '方法总览',
    orientation: dir,
  };
}

/* ------------------------------- 渲染器 ------------------------------- */

export function createDiagram(host, { onNodeClick } = {}) {
  let raw = { nodes: [], edges: [] };
  let layout = buildLayout({ nodes: [], edges: [] });
  let svg = null;
  let viewport = null;
  let edgeLayer = null;
  let nodeLayer = null;
  let view = { x: 0, y: 0, k: 1 };
  let selected = null;
  let popover = null;

  function el(name, attrs = {}) {
    const node = document.createElementNS(SVG_NS, name);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null) continue;
      node.setAttribute(k, String(v));
    }
    return node;
  }

  /** 连接线：横向从左节点右侧出发，纵向从下节点底边出发 */
  function edgePath(a, b) {
    if (layout.orientation === 'v') {
      const x1 = a._x + a._w / 2;
      const y1 = a._y + a._h;
      const x2 = b._x + b._w / 2;
      const y2 = b._y;
      if (y2 >= y1 + 8) {
        const dy = Math.max(26, (y2 - y1) * 0.5);
        return { d: `M ${x1} ${y1} C ${x1} ${y1 + dy}, ${x2} ${y2 - dy}, ${x2} ${y2}`, mx: (x1 + x2) / 2 + 8, my: (y1 + y2) / 2 };
      }
      // 回边：绕右侧
      const lift = Math.max(a._x + a._w, b._x + b._w) + 30;
      const d = `M ${a._x + a._w} ${a._y + a._h / 2} C ${lift} ${a._y + a._h / 2}, ${lift} ${b._y + b._h / 2}, ${b._x + b._w} ${b._y + b._h / 2}`;
      return { d, mx: lift - 6, my: (a._y + b._y) / 2 };
    }

    const x1 = a._x + a._w;
    const y1 = a._y + a._h / 2;
    const x2 = b._x;
    const y2 = b._y + b._h / 2;
    if (x2 >= x1 + 10) {
      const dx = Math.max(28, (x2 - x1) * 0.5);
      return { d: `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 };
    }
    // 回边：从上方绕
    const lift = Math.min(a._y, b._y) - 34;
    const d = `M ${a._x + a._w / 2} ${a._y} C ${a._x + a._w / 2} ${lift}, ${b._x + b._w / 2} ${lift}, ${b._x + b._w / 2} ${b._y}`;
    return { d, mx: (a._x + a._w / 2 + b._x + b._w / 2) / 2, my: lift + 6 };
  }

  function draw() {
    host.innerHTML = '';
    popover = null;

    svg = el('svg', { xmlns: SVG_NS, preserveAspectRatio: 'xMidYMid meet' });
    const defs = el('defs');
    const marker = el('marker', {
      id: 'arrow',
      viewBox: '0 0 10 10',
      refX: 9,
      refY: 5,
      markerWidth: 7,
      markerHeight: 7,
      orient: 'auto-start-reverse',
    });
    marker.appendChild(el('path', { d: 'M 0 0 L 10 5 L 0 10 z', fill: 'var(--muted)' }));
    marker.setAttribute('class', 'arrow-marker');
    defs.appendChild(marker);
    svg.appendChild(defs);

    viewport = el('g', { class: 'viewport' });
    svg.appendChild(viewport);

    edgeLayer = el('g', { class: 'edges' });
    nodeLayer = el('g', { class: 'nodes' });
    viewport.appendChild(edgeLayer);
    viewport.appendChild(nodeLayer);

    // 边
    for (const e of layout.edges) {
      const a = layout.byId.get(e.from);
      const b = layout.byId.get(e.to);
      if (!a || !b) continue;
      const { d, mx, my } = edgePath(a, b);
      const path = el('path', { class: 'edge-path', d, 'marker-end': 'url(#arrow)', 'data-from': e.from, 'data-to': e.to });
      edgeLayer.appendChild(path);
      if (e.label) {
        const label = el('text', { class: 'edge-label', x: mx, y: my - 6, 'text-anchor': 'middle', 'data-from': e.from, 'data-to': e.to });
        label.textContent = e.label;
        edgeLayer.appendChild(label);
      }
    }

    // 节点
    for (const n of layout.nodes) {
      const g = el('g', { class: 'node-group', 'data-id': n.id, transform: `translate(${n._x} ${n._y})` });
      const color = KIND_COLOR[n.kind] || KIND_COLOR.process;
      g.appendChild(
        el('rect', {
          class: 'node-box',
          x: 0,
          y: 0,
          width: n._w,
          height: n._h,
          rx: 10,
          fill: 'var(--panel-2)',
          stroke: 'var(--line)',
          'stroke-width': 1.2,
        }),
      );
      g.appendChild(el('rect', { x: 0, y: 0, width: 3.5, height: n._h, rx: 1.8, fill: color }));
      const kindText = el('text', { class: 'node-kind', x: PAD_X, y: 15, fill: color });
      kindText.textContent = KIND_LABEL[n.kind] || 'PROCESS';
      g.appendChild(kindText);

      let ty = 30;
      for (const line of n._titleLines) {
        const t = el('text', { class: 'node-title', x: PAD_X, y: ty });
        t.textContent = line;
        g.appendChild(t);
        ty += TITLE_SIZE + 5;
      }
      if (n._detailLines.length) {
        ty += 2;
        for (const line of n._detailLines) {
          const t = el('text', { class: 'node-detail', x: PAD_X, y: ty });
          t.textContent = line;
          g.appendChild(t);
          ty += DETAIL_SIZE + 4;
        }
      }
      nodeLayer.appendChild(g);
    }

    host.appendChild(svg);
    const hint = document.createElement('div');
    hint.className = 'diagram-hint';
    hint.textContent = '滚轮缩放 · 拖拽节点 · 点击看细节';
    host.appendChild(hint);

    bindEvents();
    applyView();
    if (layout.nodes.length) fit();
  }

  function applyView() {
    if (!viewport) return;
    viewport.setAttribute('transform', `translate(${view.x} ${view.y}) scale(${view.k})`);
  }

  function bounds() {
    if (!layout.nodes.length) return { x: 0, y: 0, w: 100, h: 100 };
    const xs = layout.nodes.map((n) => n._x);
    const ys = layout.nodes.map((n) => n._y);
    const x2 = Math.max(...layout.nodes.map((n) => n._x + n._w));
    const y2 = Math.max(...layout.nodes.map((n) => n._y + n._h));
    const minX = Math.min(...xs) - 20;
    const minY = Math.min(...ys) - 20;
    return { x: minX, y: minY, w: x2 - minX + 20, h: y2 - minY + 20 };
  }

  function fit() {
    const box = bounds();
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const k = Math.min(rect.width / box.w, rect.height / box.h, 1.35);
    view = { k: Math.max(MIN_K, Math.min(MAX_K, k)), x: rect.width / 2 - (box.x + box.w / 2) * k, y: rect.height / 2 - (box.y + box.h / 2) * k };
    applyView();
  }

  /** 依据容器宽高比挑方向：宽扁容器用横向流程图，窄高容器用纵向流程图 */
  function pickOrientation() {
    const rect = host.getBoundingClientRect();
    if (!rect.width || !rect.height) return 'h';
    return rect.width / rect.height >= 1.15 ? 'h' : 'v';
  }

  function relayout() {
    layout = buildLayout(raw, pickOrientation());
    draw();
  }

  function applyHighlight(id) {
    selected = id;
    if (!nodeLayer) return;
    const groups = nodeLayer.querySelectorAll('.node-group');
    const neighbors = new Set([id]);
    for (const e of layout.edges) {
      if (e.from === id) neighbors.add(e.to);
      if (e.to === id) neighbors.add(e.from);
    }
    groups.forEach((g) => {
      const gid = g.getAttribute('data-id');
      g.classList.toggle('active', selected === gid);
      g.classList.toggle('dim', Boolean(selected) && !neighbors.has(gid));
      const box = g.querySelector('.node-box');
      if (box) box.setAttribute('stroke', selected === gid ? 'var(--accent)' : 'var(--line)');
    });
    edgeLayer.querySelectorAll('.edge-path').forEach((p) => {
      const on = Boolean(selected) && (p.getAttribute('data-from') === selected || p.getAttribute('data-to') === selected);
      p.classList.toggle('hl', on);
    });
    showPopover(id);
  }

  /** 外部驱动：强制选中某节点（不 toggle）；id 为空则清除 */
  function selectNode(id) {
    if (!id || !layout.byId.has(id)) {
      applyHighlight(null);
      return;
    }
    applyHighlight(id);
  }

  function highlight(id) {
    const next = selected === id ? null : id;
    applyHighlight(next);
    if (typeof onNodeClick === 'function') {
      const node = raw.nodes.find((n) => n.id === next);
      onNodeClick(next, node || null);
    }
  }

  function showPopover(id) {
    if (popover) {
      popover.remove();
      popover = null;
    }
    if (!id) return;
    const node = layout.byId.get(id);
    if (!node) return;
    const div = document.createElement('div');
    div.className = 'diagram-popover';
    const strong = document.createElement('strong');
    strong.textContent = node.label;
    div.appendChild(strong);
    const p = document.createElement('div');
    p.textContent = node.detail || '（模型没有给出这一步的细节说明）';
    div.appendChild(p);

    const hostRect = host.getBoundingClientRect();
    const px = view.x + (node._x + node._w / 2) * view.k;
    const py = view.y + (node._y + node._h) * view.k + 8;
    div.style.left = `${Math.min(Math.max(8, px - 130), hostRect.width - 268)}px`;
    div.style.top = `${Math.min(Math.max(8, py), hostRect.height - 110)}px`;
    host.appendChild(div);
    popover = div;
  }

  function bindEvents() {
    // 滚轮缩放（以指针为中心）
    host.onwheel = (ev) => {
      ev.preventDefault();
      const rect = host.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      const my = ev.clientY - rect.top;
      const factor = ev.deltaY < 0 ? 1.12 : 1 / 1.12;
      const k = Math.max(MIN_K, Math.min(MAX_K, view.k * factor));
      view.x = mx - ((mx - view.x) / view.k) * k;
      view.y = my - ((my - view.y) / view.k) * k;
      view.k = k;
      applyView();
    };

    // 拖背景平移 / 拖节点移动
    let drag = null;
    svg.onpointerdown = (ev) => {
      const nodeEl = ev.target.closest?.('.node-group');
      if (nodeEl) {
        const id = nodeEl.getAttribute('data-id');
        const node = layout.byId.get(id);
        if (!node) return;
        drag = { type: 'node', id, startX: ev.clientX, startY: ev.clientY, ox: node._x, oy: node._y, moved: false, el: nodeEl };
        svg.setPointerCapture(ev.pointerId);
        ev.preventDefault();
        return;
      }
      drag = { type: 'pan', startX: ev.clientX, startY: ev.clientY, ox: view.x, oy: view.y, moved: false };
      svg.setPointerCapture(ev.pointerId);
    };

    svg.onpointermove = (ev) => {
      if (!drag) return;
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.type === 'pan') {
        view.x = drag.ox + dx;
        view.y = drag.oy + dy;
        applyView();
      } else {
        const node = layout.byId.get(drag.id);
        node._x = drag.ox + dx / view.k;
        node._y = drag.oy + dy / view.k;
        drag.el.setAttribute('transform', `translate(${node._x} ${node._y})`);
        redrawEdges();
      }
    };

    svg.onpointerup = (ev) => {
      if (!drag) return;
      const wasDrag = drag;
      drag = null;
      try {
        svg.releasePointerCapture(ev.pointerId);
      } catch {
        /* ignore */
      }
      if (wasDrag.type === 'node' && !wasDrag.moved) highlight(wasDrag.id);
      else if (wasDrag.type === 'pan' && !wasDrag.moved) highlight(null);
      else if (wasDrag.type === 'node') showPopover(wasDrag.id);
    };

    svg.onpointercancel = () => {
      drag = null;
    };
  }

  function redrawEdges() {
    edgeLayer.querySelectorAll('[data-from]').forEach((node) => {
      const a = layout.byId.get(node.getAttribute('data-from'));
      const b = layout.byId.get(node.getAttribute('data-to'));
      if (!a || !b) return;
      const { d, mx, my } = edgePath(a, b);
      if (node.tagName === 'path') node.setAttribute('d', d);
      else {
        node.setAttribute('x', mx);
        node.setAttribute('y', my - 6);
      }
    });
  }

  function exportSvg({ theme = 'auto' } = {}) {
    if (!svg || !layout.nodes.length) return null;
    const box = bounds();
    const light = theme === 'light';
    const cssVars = ['--panel', '--panel-2', '--line', '--text', '--text-dim', '--muted', '--accent', '--accent-2', '--ok', '--warn'];
    const computed = getComputedStyle(document.documentElement);
    const varCss = cssVars
      .map((v) => `${v}: ${(light ? LIGHT_EXPORT_VARS[v] : computed.getPropertyValue(v).trim()) || LIGHT_EXPORT_VARS[v]};`)
      .join(' ');
    const bg = light ? LIGHT_EXPORT_VARS['--panel'] : computed.getPropertyValue('--panel').trim() || '#fff';

    const out = document.createElementNS(SVG_NS, 'svg');
    out.setAttribute('xmlns', SVG_NS);
    out.setAttribute('viewBox', `${box.x} ${box.y} ${box.w} ${box.h}`);
    out.setAttribute('width', String(Math.round(box.w)));
    out.setAttribute('height', String(Math.round(box.h)));
    const style = document.createElementNS(SVG_NS, 'style');
    style.textContent = `:root{${varCss}}
      .node-title{font:600 12.5px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;fill:var(--text)}
      .node-detail{font:10.5px -apple-system,"PingFang SC","Microsoft YaHei",sans-serif;fill:var(--muted)}
      .node-kind{font:9px -apple-system,"PingFang SC",sans-serif;fill:var(--muted);letter-spacing:.8px}
      .edge-path{stroke:var(--muted);stroke-width:1.6;fill:none;opacity:.7}
      .edge-label{font:10px -apple-system,"PingFang SC",sans-serif;fill:var(--muted)}`;
    out.appendChild(style);
    out.appendChild(el('rect', { x: box.x, y: box.y, width: box.w, height: box.h, fill: bg }));
    const clone = viewport.cloneNode(true);
    clone.removeAttribute('transform');
    out.appendChild(clone);
    return { svg: new XMLSerializer().serializeToString(out), width: box.w, height: box.h };
  }

  function render(diagram) {
    raw = {
      title: diagram?.title || '方法总览',
      nodes: Array.isArray(diagram?.nodes) ? diagram.nodes : [],
      edges: Array.isArray(diagram?.edges) ? diagram.edges : [],
    };
    selected = null;
    if (!raw.nodes.length) {
      host.innerHTML =
        '<div class="empty-state"><p class="empty-title">图解会出现在这里</p><p class="empty-sub">精读完成后自动生成「输入 → 处理 → 输出」的方法链路图，可拖拽、缩放、点击查看细节。</p></div>';
      svg = null;
      return;
    }
    layout = buildLayout(raw, pickOrientation());
    draw();
  }

  return { render, fit, relayout, exportSvg, selectNode, clearSelection: () => selectNode(null) };
}
