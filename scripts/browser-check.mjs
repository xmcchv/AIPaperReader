/**
 * 用 Chrome DevTools 协议做一次真实浏览器冒烟：加载页面、收集控制台错误、
 * 检查三视图与侧栏是否就位。仅开发期使用。
 *   node scripts/browser-check.mjs [url]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_TARGET = process.argv[2] || 'http://127.0.0.1:5199/';
const PORT = 9333;
const CHROME =
  process.env.CHROME_PATH ||
  'C:/Program Files/Google/Chrome/Application/chrome.exe';

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-chrome-'));
const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort(deadline = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(200);
  }
  throw new Error('Chrome 调试端口未就绪');
}

const version = await waitPort();
const target = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_TARGET)}`, {
  method: 'PUT',
}).then((r) => r.json());

const ws = new WebSocket(target.webSocketDebuggerUrl);
let nextId = 0;
const pending = new Map();
const errors = [];
const logs = [];

ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    errors.push(`${d.text} ${d.exception?.description || ''}`.trim());
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    logs.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`.trim());
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    logs.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' '));
  }
});

const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await new Promise((resolve) => ws.addEventListener('open', resolve));
await send('Runtime.enable');
await send('Log.enable');
await send('Page.enable');
await send('Page.navigate', { url: URL_TARGET });
await sleep(6000);

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

const report = await evaluate(`(() => {
  const view = (id) => {
    const el = document.getElementById(id);
    return el ? { hidden: el.hidden } : null;
  };
  const sidebar = document.getElementById('sidebar');
  return {
    bodyView: document.body.dataset.view,
    views: { translate: view('view-translate'), paper: view('view-paper'), kg: view('view-kg') },
    sidebarHidden: sidebar ? getComputedStyle(sidebar).display === 'none' : null,
    sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : 0,
    historyItems: document.querySelectorAll('#historyList .hitem').length,
    historyCount: document.getElementById('historyCount')?.textContent || '',
    translateCards: document.querySelectorAll('#cards .card').length,
    translateTopbar: !!document.querySelector('#view-translate .topbar'),
    paperTopbar: !!document.querySelector('#view-paper .topbar'),
    kgTopbar: !!document.querySelector('#view-kg .topbar'),
    switches: document.querySelectorAll('[data-app-switch]').length,
  };
})()`);

console.log('\n=== 页面状态 ===');
console.log(JSON.stringify(report, null, 2));
console.log('\n=== 运行时异常 ===');
console.log(errors.length ? errors.join('\n') : '(无)');
console.log('\n=== 控制台错误 ===');
console.log(logs.length ? logs.join('\n') : '(无)');

// 切到翻译视图再切回来，验证外壳
await evaluate("window.paperlens.setView('translate')");
await sleep(1200);
const after = await evaluate(`(() => ({
  bodyView: document.body.dataset.view,
  translateVisible: !document.getElementById('view-translate').hidden,
  cards: document.querySelectorAll('#cards .card').length,
  emptyShown: !document.getElementById('empty')?.hidden,
  sidebarWidth: Math.round(document.getElementById('sidebar').getBoundingClientRect().width),
}))()`);
console.log('\n=== 切到翻译视图 ===');
console.log(JSON.stringify(after, null, 2));

ws.close();
child.kill();
await sleep(600);
try {
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
} catch {
  /* Chrome 还占着文件，交给系统临时目录清理 */
}
console.log('\nChrome:', version.Browser);
process.exit(errors.length || logs.length ? 1 : 0);
