/**
 * 把 papertrans 的样式表作用域化进三视图外壳。
 *
 *   public/translate/styles.raw.css  →  public/translate/styles.css   （#view-translate 前缀）
 *                                    →  public/sidebar.css            （#sidebar 前缀，跨视图共用）
 *
 * 同名 class（btn / topbar / pane / workspace …）一共 14 个，靠 ID 前缀压过去：
 * `#view-translate .btn` 的特异性是 (1,1,0)，任何纯 class 规则都赢不了它。
 *
 *   node scripts/scope-css.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'public/translate/styles.raw.css');
const OUT_VIEW = path.join(ROOT, 'public/translate/styles.css');
const OUT_SIDE = path.join(ROOT, 'public/sidebar.css');

const VIEW = '#view-translate';
const SIDE = '#sidebar';

/** 侧栏相关选择器：这些规则给全局 #sidebar 用，不进 translate 作用域 */
const SIDE_HEAD = ['.sidebar', '.side-', '.history', '.hitem', '.hbadge', '.nav-'];

const isSideSelector = (sel) => SIDE_HEAD.some((head) => sel.startsWith(head) || sel.includes(` ${head}`));

/** 整条丢弃：外壳（html/body）与全局重置由主样式表负责 */
const GLOBAL_DROP = [/^html\b/, /^html,/, /^\*$/, /^::selection$/, /^::-webkit-scrollbar/];

function splitSelectors(list) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of list) {
    if (ch === '(' || ch === '[') depth += 1;
    if (ch === ')' || ch === ']') depth -= 1;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 单条选择器 → 加前缀后的结果；null 表示丢弃 */
function scopeSelector(sel) {
  let s = sel.trim();
  if (!s) return null;

  // 主题变量块：翻译页有自己的一套色板，不能污染全局 --bg/--panel
  if (s === ':root') return VIEW;
  if (/^\[data-theme=["']?dark["']?\]$/.test(s)) return `html[data-theme='dark'] ${VIEW}`;
  if (/^\[data-theme=["']?light["']?\]$/.test(s)) return `html[data-theme='light'] ${VIEW}`;

  // 外壳重置交给主样式表
  if (GLOBAL_DROP.some((re) => re.test(s))) return null;

  // 侧栏折叠：body 上的类由翻译页 JS 切换，落到全局侧栏上
  if (/^body\.sidebar-collapsed\s+(#sidebar|\.sidebar)$/.test(s)) return `body.sidebar-collapsed ${SIDE}`;

  // body 上的编辑态：body.X .blk → body.X #view-translate .blk
  const bodyMatch = s.match(/^body((?:\.[\w-]+)*)\s*(.*)$/);
  if (bodyMatch) {
    const chain = bodyMatch[1];
    const rest = bodyMatch[2].trim();
    if (!chain) {
      return rest ? `${VIEW} ${rest}` : VIEW;
    }
    return rest ? `body${chain} ${VIEW} ${rest}` : `body${chain} ${VIEW}`;
  }

  // 侧栏元素本身用 #sidebar，子元素再挂在它下面
  if (s === '.sidebar') return SIDE;
  if (s.startsWith('#sidebar')) return s;
  if (isSideSelector(s)) return `${SIDE} ${s}`;

  return `${VIEW} ${s}`;
}

function scopeList(list) {
  const out = [];
  for (const one of splitSelectors(list)) {
    const scoped = scopeSelector(one);
    if (scoped) out.push(scoped);
  }
  return out;
}

/** 递归处理一段 CSS，产出 view / side 两份 */
function process(css, { inAtRule = false } = {}) {
  const view = [];
  const side = [];
  let i = 0;
  while (i < css.length) {
    const braceOpen = css.indexOf('{', i);
    if (braceOpen === -1) break;
    const prelude = css.slice(i, braceOpen);
    const trimmed = prelude.trim();
    if (!trimmed) {
      i = braceOpen + 1;
      continue;
    }

    // 找配对的右括号
    let depth = 0;
    let end = -1;
    for (let k = braceOpen; k < css.length; k += 1) {
      if (css[k] === '{') depth += 1;
      else if (css[k] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    if (end === -1) break;
    const body = css.slice(braceOpen + 1, end);
    i = end + 1;

    if (trimmed.startsWith('@keyframes') || trimmed.startsWith('@font-face')) {
      view.push(`${trimmed} {${body}}`);
      continue;
    }
    if (trimmed.startsWith('@media') || trimmed.startsWith('@supports')) {
      const inner = process(body, { inAtRule: true });
      if (inner.view.length) view.push(`${trimmed} {\n  ${inner.view.join('\n  ')}\n}`);
      if (inner.side.length) side.push(`${trimmed} {\n  ${inner.side.join('\n  ')}\n}`);
      continue;
    }
    if (trimmed.startsWith('@')) {
      view.push(`${trimmed} {${body}}`);
      continue;
    }

    const selectors = splitSelectors(trimmed);
    const viewSelectors = [];
    const sideSelectors = [];
    for (const one of selectors) {
      const scoped = scopeSelector(one);
      if (!scoped) continue;
      if (isSideSelector(one.trim())) sideSelectors.push(scoped);
      else viewSelectors.push(scoped);
    }
    const props = body.trim();
    if (viewSelectors.length) view.push(`${viewSelectors.join(', ')} { ${props} }`);
    if (sideSelectors.length) side.push(`${sideSelectors.join(', ')} { ${props} }`);
  }
  return { view, side };
}

if (!fs.existsSync(SRC)) {
  console.error(`找不到源样式：${SRC}`);
  process.exit(1);
}

const css = fs.readFileSync(SRC, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
const palette = (selector) => {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const hit = css.match(re);
  return hit ? hit[1].trim() : '';
};
const lightVars = palette(':root');
const darkVars = palette('[data-theme="dark"]');
const { view, side } = process(css);

const header = (what, scope) => `/* 由 scripts/scope-css.mjs 生成，请勿直接编辑。源：public/translate/styles.raw.css
   作用域：${scope}（${what}） */\n`;

fs.writeFileSync(OUT_VIEW, `${header('翻译视图', VIEW)}\n${view.join('\n')}\n`, 'utf8');
const sidePalette = [
  lightVars ? `${SIDE} { ${lightVars} }` : '',
  darkVars ? `html[data-theme='dark'] ${SIDE} { ${darkVars} }` : '',
].filter(Boolean).join('\n');
fs.writeFileSync(OUT_SIDE, `${header('跨视图侧栏', SIDE)}\n${sidePalette}\n${side.join('\n')}\n`, 'utf8');

console.log(`  ✓ ${path.relative(ROOT, OUT_VIEW)}  ${view.length} 条规则`);
console.log(`  ✓ ${path.relative(ROOT, OUT_SIDE)}  ${side.length} 条规则`);
