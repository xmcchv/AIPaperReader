/**
 * 开发期截图：用 CDP 打开页面、可选执行一段脚本、保存 PNG。
 *   node scripts/shot.mjs <url> <out.png> [viewName] [waitMs]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const [, , url, out, viewName = '', waitMs = '2500'] = process.argv;
const PORT = 9334;
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-shot-'));

const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    '--window-size=1440,900',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitPort() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return true;
    } catch {
      /* 等待 */
    }
    await sleep(150);
  }
  throw new Error('Chrome 调试端口未就绪');
}

await waitPort();
const target = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' }).then((r) =>
  r.json(),
);
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve));

let nextId = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve) => {
    const id = ++nextId;
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params }));
  });

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', {
  width: 1440,
  height: 900,
  deviceScaleFactor: 1,
  mobile: false,
});
await send('Page.navigate', { url });
await sleep(Number(waitMs));

if (viewName) {
  await send('Runtime.evaluate', { expression: `window.paperlens.setView('${viewName}')` });
  await sleep(900);
}

// 可选：截图前执行一段脚本（点击历史项、切视图等）
if (process.env.SHOT_EVAL) {
  const r = await send('Runtime.evaluate', {
    expression: process.env.SHOT_EVAL,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.result?.exceptionDetails) console.error('eval error:', r.result.exceptionDetails.text);
  else console.log('eval ->', JSON.stringify(r.result?.result?.value));
  await sleep(Number(process.env.SHOT_EVAL_WAIT || 5000));
}

const shot = await send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'));
console.log(`saved ${out}`);

ws.close();
child.kill();
await sleep(500);
try {
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
} catch {
  /* Chrome 占着文件就让它留在临时目录 */
}
