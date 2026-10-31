/**
 * 跨平台冒烟测试：用临时数据目录启动服务，检查关键接口与本地前端资源。
 * 不写用户目录、不读取用户配置，跑完即清理。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.SMOKE_PORT || 5100 + Math.floor(Math.random() * 800));
const BASE = `http://127.0.0.1:${PORT}`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'paperlens-smoke-'));
const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  PAPERLENS_HOME: tmp,
  PAPERLENS_CONFIG: path.join(tmp, 'config.json'),
  PAPERLENS_DATA_DIR: path.join(tmp, 'data'),
};

const child = spawn(process.execPath, ['server/index.mjs'], {
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
child.stdout.on('data', (chunk) => {
  logs += chunk;
});
child.stderr.on('data', (chunk) => {
  logs += chunk;
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForHealth() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(`${BASE}/api/health`);
      if (res.ok) return await res.json();
    } catch {
      /* 服务还没起来 */
    }
    await sleep(150);
  }
  throw new Error(`服务没有在 15 秒内启动：\n${logs}`);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

try {
  const health = await waitForHealth();
  assert(health.ok && health.kg === true, 'health 接口没有同时报告图谱');

  const home = await fetch(`${BASE}/`);
  assert(home.status === 200, `首页状态 ${home.status}`);
  const html = await home.text();
  assert(html.includes('id="view-kg"'), '首页缺少图谱视图（单页外壳）');

  const kg = await fetch(`${BASE}/api/kg/state`);
  assert(kg.ok, `图谱状态 ${kg.status}`);
  const kgState = await kg.json();
  assert(Array.isArray(kgState.library?.sources), '图谱 library.sources 缺失');

  const papers = await fetch(`${BASE}/api/paper/library`);
  assert(papers.ok, `论文库 ${papers.status}`);
  const paperState = await papers.json();
  assert(Array.isArray(paperState.papers), '论文库 papers 缺失');

  const pdfjs = await fetch(`${BASE}/vendor/pdfjs/pdf.min.mjs`);
  assert(pdfjs.status === 200, '本地 pdf.js 不可访问');
  const katex = await fetch(`${BASE}/vendor/katex/katex.min.css`);
  assert(katex.status === 200, '本地 KaTeX 不可访问');

  const redirect = await fetch(`${BASE}/kg/`, { redirect: 'manual' });
  assert(redirect.status === 302, `旧图谱地址没有重定向：${redirect.status}`);
  assert(
    String(redirect.headers.get('location') || '').includes('view=kg'),
    '旧图谱地址重定向缺少 view=kg',
  );

  console.log('smoke ok');
} finally {
  child.kill();
  await sleep(250);
  try {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* Windows 上偶尔还有文件句柄没释放，不影响测试结果 */
  }
}
