/**
 * 3D 星空连接视图（零依赖，Canvas 2D + 手写透视投影）。
 *
 * 把知识图谱投到一颗"概念星云"上：前置关系分层决定高度（越靠后的概念飞得越高），
 * 同层概念按黄金角螺旋撒在星云盘上 —— 同样的数据永远是同一片星空。
 *
 * 交互：拖拽旋转 · 滚轮推近拉远 · 点击看详情 · 双击设为导图根 · 空闲时缓慢自转。
 */

import { buildLayeredLayout } from './graph.js';

const GOLDEN_ANGLE = 2.399963229728653;
const EDGE_COLORS = {
  prereq: '#6ea8ff',
  extends: '#b28aff',
  related: '#93a0b8',
  flow: '#3fd0bd',
};

const escapeText = (text) => String(text ?? '').replace(/[&<>]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[ch]));

/** 字符串 → 确定性 32 位散列（撒星抖动 / 闪烁相位用，保证每次刷新星星不跳） */
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 4294967295;
}

export class StarfieldView {
  constructor(canvas, { onSelect = () => {}, onMessage = () => {}, onRootChange = () => {} } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelect = onSelect;
    this.onMessage = onMessage;
    this.onRootChange = onRootChange;

    this.lib = { concepts: [], edges: [] };
    this.stars = [];
    this.edges = [];
    this.selectedId = '';
    this.query = '';
    this.path = new Set();
    this.hoverId = '';

    this.yaw = 0.6;
    this.pitch = 0.32;
    this.dist = 1150;
    this.targetYaw = null;
    this.targetPitch = null;
    this.targetDist = null;
    this.idleAt = 0;
    this.raf = 0;
    this.projected = []; // 每帧缓存 { id, x, y, scale, depth }
    this.background = [];

    this._resize = this._resize.bind(this);
    this._loop = this._loop.bind(this);
    this._observer = new ResizeObserver(this._resize);
    this._observer.observe(canvas);
    this._resize();
    this._bind();
  }

  /* ------------------------------- 数据 ------------------------------- */

  setLibrary(lib, { selectedId = '', query = '', path } = {}) {
    this.lib = {
      concepts: Array.isArray(lib?.concepts) ? lib.concepts : [],
      edges: Array.isArray(lib?.edges) ? lib.edges : [],
    };
    this.selectedId = selectedId;
    this.query = String(query || '');
    this.path = path instanceof Set ? path : new Set();
    this._build();
  }

  /** 布局：分层图定"高度层"，同层按黄金角撒成螺旋星盘，全部确定性 */
  _build() {
    const layout = buildLayeredLayout(this.lib.concepts, this.lib.edges, {});
    const maxLayer = Math.max(0, ...layout.nodes.map((node) => node.layer));
    const ordered = layout.nodes
      .slice()
      .sort((a, b) => a.layer - b.layer || a.y - b.y || a.concept.name.localeCompare(b.concept.name, 'zh-Hans-CN'));

    const total = Math.max(1, ordered.length);
    const disk = 90 + Math.sqrt(total) * 130;

    // 连接数 + 出处/资料数 + 解释完整度 → 重要性；越重要球越大
    const degree = new Map();
    for (const edge of this.lib.edges) {
      degree.set(edge.from, (degree.get(edge.from) || 0) + 1);
      degree.set(edge.to, (degree.get(edge.to) || 0) + 1);
    }
    const scores = ordered.map((node) => {
      const concept = node.concept || {};
      const deg = degree.get(node.id) || 0;
      const refs = Array.isArray(concept.refs) ? concept.refs.length : 0;
      const sources = Array.isArray(concept.sourceIds) ? concept.sourceIds.length : 0;
      const summary = String(concept.summary || '').length;
      let score =
        Math.log1p(deg) * 1.0 +
        Math.log1p(refs) * 0.9 +
        Math.log1p(sources) * 0.7 +
        Math.min(1, summary / 120) * 0.5;
      if (concept.stub) score *= 0.55;
      if (concept.kind === 'method' || concept.kind === 'task') score += 0.25;
      return score;
    });
    const minScore = scores.length ? Math.min(...scores) : 0;
    const maxScore = scores.length ? Math.max(...scores) : 0;
    const span = maxScore - minScore || 1;

    this.stars = ordered.map((node, index) => {
      const r = disk * Math.sqrt((index + 0.5) / total);
      const theta = index * GOLDEN_ANGLE;
      const j1 = hash(node.id) - 0.5;
      const j2 = hash(`${node.id}#z`) - 0.5;
      const t = (scores[index] - minScore) / span;
      // 2.6 ~ 11.6：孤立概念是小点，连接多 / 出处多的枢纽是大球
      const size = 2.6 + Math.pow(t, 0.6) * 9 + (hash(`${node.id}#r`) - 0.5) * 0.5;
      return {
        id: node.id,
        concept: node.concept,
        layer: node.layer,
        x: Math.cos(theta) * r + j1 * 46,
        y: (node.layer - maxLayer / 2) * -110 + j2 * 30,
        z: Math.sin(theta) * r + j1 * 46,
        r: Math.max(2.2, size),
        phase: hash(`${node.id}#t`) * Math.PI * 2,
        neighbors: new Set(),
      };
    });
    const byId = new Map(this.stars.map((star) => [star.id, star]));
    this.edges = this.lib.edges
      .filter((edge) => byId.has(edge.from) && byId.has(edge.to))
      .map((edge) => ({ ...edge, a: byId.get(edge.from), b: byId.get(edge.to) }));
    for (const edge of this.edges) {
      edge.a.neighbors.add(edge.b);
      edge.b.neighbors.add(edge.a);
    }
    this._buildBackground();
  }

  /** 远景碎星：纯装饰，不参与交互 */
  _buildBackground() {
    this.background = [];
    for (let i = 0; i < 140; i += 1) {
      this.background.push({
        x: hash(`bg${i}x`) * 2 - 1,
        y: hash(`bg${i}y`) * 2 - 1,
        z: hash(`bg${i}z`) * 2 - 1,
        r: 0.4 + hash(`bg${i}r`) * 1.3,
        phase: hash(`bg${i}p`) * Math.PI * 2,
      });
    }
  }

  /* ------------------------------ 投影 ------------------------------ */

  _project(star) {
    const cosY = Math.cos(this.yaw);
    const sinY = Math.sin(this.yaw);
    const x1 = star.x * cosY + star.z * sinY;
    const z1 = -star.x * sinY + star.z * cosY;
    const cosP = Math.cos(this.pitch);
    const sinP = Math.sin(this.pitch);
    const y2 = star.y * cosP - z1 * sinP;
    const z2 = star.y * sinP + z1 * cosP;
    const depth = z2 + this.dist;
    if (depth < 60) return null;
    const scale = 640 / depth;
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.width / 2 + x1 * scale,
      y: rect.height / 2 - y2 * scale,
      scale,
      depth,
    };
  }

  /* ------------------------------ 渲染 ------------------------------ */

  _resize() {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.max(1, Math.round(rect.width * dpr));
    this.canvas.height = Math.max(1, Math.round(rect.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  start() {
    if (!this.raf) this.raf = requestAnimationFrame(this._loop);
  }

  stop() {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  _loop(now) {
    this.raf = requestAnimationFrame(this._loop);
    this._step(now);
    this._draw(now);
  }

  _step(now) {
    // 缓动到目标视角（focus() 用）；空闲 4 秒后缓慢自转
    if (this.targetYaw !== null) {
      this.yaw += (this.targetYaw - this.yaw) * 0.08;
      this.pitch += (this.targetPitch - this.pitch) * 0.08;
      if (this.targetDist !== null) this.dist += (this.targetDist - this.dist) * 0.08;
      if (Math.abs(this.targetYaw - this.yaw) < 0.002) {
        this.targetYaw = null;
        this.targetPitch = null;
        this.targetDist = null;
        this.idleAt = now;
      }
    } else if (now - this.idleAt > 4000) {
      this.yaw += 0.0012;
    }
  }

  _draw(now) {
    const ctx = this.ctx;
    const rect = this.canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const light = document.documentElement.dataset.theme !== 'dark';

    ctx.clearRect(0, 0, w, h);
    const grad = ctx.createRadialGradient(w / 2, h * 0.42, 0, w / 2, h * 0.42, Math.max(w, h) * 0.75);
    if (light) {
      grad.addColorStop(0, '#f3f5fb');
      grad.addColorStop(1, '#dfe5f2');
    } else {
      grad.addColorStop(0, '#0c1230');
      grad.addColorStop(1, '#05070f');
    }
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // 远景碎星（随视角轻转，增加纵深）
    for (const bg of this.background) {
      const p = this._project(bg);
      if (!p) continue;
      const tw = 0.4 + 0.6 * Math.abs(Math.sin(now / 1400 + bg.phase));
      ctx.globalAlpha = (light ? 0.28 : 0.5) * tw * Math.min(1, p.scale * 6);
      ctx.fillStyle = light ? '#6a7590' : '#9fb2ff';
      ctx.beginPath();
      ctx.arc(p.x, p.y, bg.r * Math.max(0.4, p.scale), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const query = this.query.trim().toLowerCase();
    const hasPath = this.path.size > 1;
    const focusActive = Boolean(this.selectedId) || hasPath;
    const focusSet = new Set(focusActive ? [this.selectedId, ...this.path].filter(Boolean) : []);
    if (focusActive) {
      for (const id of [...focusSet]) {
        const star = this.stars.find((item) => item.id === id);
        if (!star) continue;
        for (const n of star.neighbors) focusSet.add(n.id);
      }
    }

    // 连线：由远及近淡出，聚焦时只留邻域
    const lines = [];
    for (const edge of this.edges) {
      const pa = this._project(edge.a);
      const pb = this._project(edge.b);
      if (!pa || !pb) continue;
      const inFocus = !focusActive || (focusSet.has(edge.a.id) && focusSet.has(edge.b.id));
      if (!inFocus) continue;
      const onPath = hasPath && this.path.has(edge.a.id) && this.path.has(edge.b.id);
      const depthScale = Math.min(1, Math.max(0.15, 700 / Math.max(pa.depth, pb.depth)));
      lines.push({ edge, pa, pb, alpha: (onPath ? 0.95 : focusActive ? 0.3 : 0.42) * depthScale, onPath });
    }
    lines.sort((m, n) => n.pa.depth + n.pb.depth - (m.pa.depth + m.pb.depth));
    for (const line of lines) {
      ctx.strokeStyle = line.onPath ? '#ffd479' : EDGE_COLORS[line.edge.type] || '#8fa3c8';
      ctx.globalAlpha = line.alpha;
      ctx.lineWidth = line.onPath ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(line.pa.x, line.pa.y);
      ctx.lineTo(line.pb.x, line.pb.y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;

    // 星点：远的小而淡，近的大而亮；选中的带光环脉冲
    const hits = [];
    const drawList = [];
    for (const star of this.stars) {
      const p = this._project(star);
      if (!p) continue;
      hits.push({ id: star.id, x: p.x, y: p.y });
      const match = query ? `${star.concept.name} ${star.concept.summary || ''}`.toLowerCase().includes(query) : false;
      const selected = this.selectedId === star.id;
      const onPath = this.path.has(star.id);
      const dimmed = focusActive && !focusSet.has(star.id);
      drawList.push({ star, p, match, selected, onPath, dimmed });
    }
    drawList.sort((m, n) => n.p.depth - m.p.depth);
    for (const item of drawList) {
      const { star, p, selected, onPath, dimmed, match } = item;
      const size = Math.max(1.2, star.r * p.scale * 2.4);
      const twinkle = 0.75 + 0.25 * Math.sin(now / 900 + star.phase);
      let color = '#cfe0ff';
      if (star.concept.stub) color = '#8b93a7';
      else if (star.concept.kind === 'method') color = '#c0b4ff';
      else if (star.concept.kind === 'formula') color = '#7fd8d8';
      else if (star.concept.kind === 'result') color = '#ffbe85';
      ctx.globalAlpha = dimmed ? 0.14 : twinkle * (0.55 + Math.min(0.45, p.scale));
      if (!dimmed && (selected || onPath || match)) {
        ctx.shadowColor = selected || onPath ? '#ffd479' : '#ffffff';
        ctx.shadowBlur = 18;
      } else {
        ctx.shadowColor = color;
        ctx.shadowBlur = size * 2.2;
      }
      ctx.fillStyle = selected || onPath ? '#ffd479' : color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // 标签：够近 / 选中 / 搜索命中才显示
      if (!dimmed && (selected || onPath || match || p.scale > 0.55)) {
        ctx.globalAlpha = dimmed ? 0.15 : Math.min(1, 0.35 + p.scale);
        ctx.fillStyle = light ? '#25304a' : '#e8eeff';
        ctx.font = `${selected || onPath ? '600 ' : ''}${Math.max(10, Math.min(15, 12 * Math.max(0.8, p.scale * 1.4)))}px "Segoe UI", "Microsoft YaHei", sans-serif`;
        ctx.textAlign = 'left';
        const label = star.concept.name.length > 14 ? `${star.concept.name.slice(0, 13)}…` : star.concept.name;
        ctx.fillText(label, p.x + size + 5, p.y + 4);
      }
    }
    ctx.globalAlpha = 1;

    // 选中光环
    for (const item of drawList) {
      if (!item.selected) continue;
      const pulse = 1 + 0.12 * Math.sin(now / 300);
      ctx.strokeStyle = '#ffd479';
      ctx.globalAlpha = 0.9;
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.arc(item.p.x, item.p.y, Math.max(6, item.star.r * item.p.scale * 2.4) + 7 * pulse, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    this.projected = hits;
  }

  /* ------------------------------ 交互 ------------------------------ */

  _hitTest(x, y) {
    let best = null;
    let bestDist = 18;
    for (const hit of this.projected) {
      const d = Math.hypot(hit.x - x, hit.y - y);
      if (d < bestDist) {
        bestDist = d;
        best = hit.id;
      }
    }
    return best;
  }

  _bind() {
    const canvas = this.canvas;
    let drag = null;

    canvas.addEventListener('mousedown', (event) => {
      if (event.button !== 0) return;
      drag = { x: event.clientX, y: event.clientY, yaw: this.yaw, pitch: this.pitch, moved: false };
      canvas.style.cursor = 'grabbing';
    });
    window.addEventListener('mousemove', (event) => {
      if (!drag) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (!drag.moved && Math.hypot(dx, dy) < 4) return;
      drag.moved = true;
      this.targetYaw = null;
      this.yaw = drag.yaw + dx * 0.006;
      this.pitch = Math.max(-1.35, Math.min(1.35, drag.pitch + dy * 0.005));
    });
    window.addEventListener('mouseup', (event) => {
      if (!drag) return;
      canvas.style.cursor = 'grab';
      if (!drag.moved) {
        const rect = canvas.getBoundingClientRect();
        const id = this._hitTest(event.clientX - rect.left, event.clientY - rect.top);
        this.selectedId = id || '';
        this.onSelect(id || '');
      }
      drag = null;
    });
    canvas.addEventListener('mousemove', (event) => {
      if (drag) return;
      const rect = canvas.getBoundingClientRect();
      const id = this._hitTest(event.clientX - rect.left, event.clientY - rect.top);
      this.hoverId = id;
      canvas.style.cursor = id ? 'pointer' : 'grab';
    });
    canvas.addEventListener(
      'wheel',
      (event) => {
        event.preventDefault();
        this.targetDist = null;
        this.dist = Math.max(320, Math.min(2600, this.dist * Math.exp(event.deltaY * 0.0011)));
      },
      { passive: false },
    );
    canvas.addEventListener('dblclick', (event) => {
      const rect = canvas.getBoundingClientRect();
      const id = this._hitTest(event.clientX - rect.left, event.clientY - rect.top);
      if (id) this.onRootChange(id);
    });
    canvas.addEventListener('mouseleave', () => {
      this.hoverId = '';
    });
  }

  /** 把某个知识点转到镜头前（详情里「在图上定位」用） */
  focus(id) {
    const star = this.stars.find((item) => item.id === id);
    if (!star) return false;
    this.selectedId = id;
    // 反解 yaw / pitch，让这颗星正对镜头
    let yaw = Math.atan2(-star.z, star.x);
    // 取离当前视角最近的等价角，避免转一大圈
    while (yaw - this.yaw > Math.PI) yaw -= Math.PI * 2;
    while (yaw - this.yaw < -Math.PI) yaw += Math.PI * 2;
    const horizontal = Math.hypot(star.x, star.z);
    this.targetYaw = yaw;
    this.targetPitch = Math.max(-1.2, Math.min(1.2, Math.atan2(star.y, Math.max(1, horizontal))));
    this.targetDist = Math.max(560, Math.min(1600, this.dist));
    this.idleAt = performance.now();
    if (!this.raf) this.start();
    return true;
  }

  destroy() {
    this.stop();
    this._observer.disconnect();
  }
}
