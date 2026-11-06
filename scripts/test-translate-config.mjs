/**
 * D2 回归测试：翻译引擎凭据从「明文 prefs」迁到「config.json 密文」。
 *
 *   node scripts/test-translate-config.mjs
 *
 * 全程用临时 HOME，不碰真实配置；不访问外部网络。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = 5400 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pl-d2-'));
const configPath = path.join(home, 'config.json');
const env = {
  ...process.env,
  PORT: String(PORT),
  HOST: '127.0.0.1',
  PAPERLENS_HOME: home,
  PAPERLENS_CONFIG: configPath,
  PAPERLENS_DATA_DIR: path.join(home, 'data'),
  // 图谱配置的只读回退指向真实用户目录，测试时必须隔离掉
  KGRAPH_CONFIG: path.join(home, 'kgraph.json'),
  PAPERLENS_PASSPHRASE: '',
  KGRAPH_PASSPHRASE: '',
};

const PASS = 'test-pass-123';
const KEY = 'sk-test-0123456789';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let child = null;

async function start() {
  child = spawn(process.execPath, ['server/index.mjs'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let logs = '';
  child.stdout.on('data', (c) => (logs += c));
  child.stderr.on('data', (c) => (logs += c));
  for (let i = 0; i < 100; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      /* 等待启动 */
    }
    await sleep(120);
  }
  throw new Error(`服务没有启动：\n${logs}`);
}

async function stop() {
  if (!child) return;
  child.kill();
  await sleep(400);
  child = null;
}

const json = async (p, init) => {
  const r = await fetch(BASE + p, init);
  const body = await r.json().catch(() => ({}));
  return { status: r.status, body };
};

const post = (p, body) =>
  json(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

try {
  await start();

  // 1. 初始：没有翻译配置
  let cfg = (await json('/api/translate/config')).body;
  assert(cfg.provider === 'free', `初始 provider 应为 free，实际 ${cfg.provider}`);
  assert(Object.keys(cfg.providers || {}).length === 0, '初始不应有服务商配置');

  // 2. 带主密码保存 Key
  const saved = await post('/api/translate/config', {
    provider: 'deepseek',
    config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: KEY },
    passphrase: PASS,
  });
  assert(saved.status === 200, `保存失败：${JSON.stringify(saved.body)}`);

  const raw = fs.readFileSync(configPath, 'utf8');
  assert(raw.includes('api_key_enc'), 'config.json 里没有密文');
  assert(!raw.includes(KEY), 'config.json 里出现了明文 Key');

  // 3. 接口不回传 Key
  cfg = (await json('/api/translate/config')).body;
  assert(cfg.providers.deepseek?.has_key === true, 'has_key 应为 true');
  assert(!JSON.stringify(cfg).includes(KEY), '接口把 Key 回传了');

  // 4. 空 Key + 主密码：不覆盖已有密文
  const keep = await post('/api/translate/config', {
    provider: 'deepseek',
    config: { provider: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: '' },
    passphrase: PASS,
  });
  assert(keep.status === 200, `再保存失败：${JSON.stringify(keep.body)}`);
  assert(fs.readFileSync(configPath, 'utf8').includes('api_key_enc'), '空 Key 把密文清掉了');

  // 5. 重启后是锁定态，解锁后恢复
  await stop();
  await start();
  cfg = (await json('/api/translate/config')).body;
  assert(cfg.locked === true, '重启后应为锁定态');
  assert(cfg.providers.deepseek?.has_key === false, '锁定态不应报告 has_key');

  const unlocked = await post('/api/config/unlock', { passphrase: PASS });
  assert(unlocked.status === 200 && unlocked.body.ok, `解锁失败：${JSON.stringify(unlocked.body)}`);
  cfg = (await json('/api/translate/config')).body;
  assert(cfg.providers.deepseek?.has_key === true, '解锁后 has_key 应恢复');
  assert(cfg.locked === false, '解锁后不应还是锁定态');

  // 6. 旧版明文 prefs → 输入主密码保存一次即完成加密迁移
  await json('/api/store/prefs', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prefs: {
        cfg: { provider: 'deepl', baseUrl: 'https://api-free.deepl.com', model: 'ZH', apiKey: 'deepl-legacy-key' },
        theme: 'dark',
      },
    }),
  });
  const migrate = await post('/api/translate/config', {
    provider: 'deepl',
    config: { provider: 'deepl', baseUrl: 'https://api-free.deepl.com', model: 'ZH', apiKey: '' },
    passphrase: PASS,
  });
  assert(migrate.status === 200, `迁移旧 Key 失败：${JSON.stringify(migrate.body)}`);
  const raw2 = fs.readFileSync(configPath, 'utf8');
  assert(raw2.includes('deepl'), 'config.json 里没有 deepl 配置');
  assert(!raw2.includes('deepl-legacy-key'), '旧 Key 还是明文');

  const prefs = (await json('/api/store/prefs')).body.prefs || {};
  assert(!prefs.cfg, 'prefs 里的明文 cfg 没被清掉');
  assert(prefs.theme === 'dark', '迁移时误删了其它偏好');

  console.log('D2 ok：加密存储 / 不回传 / 锁定与解锁 / 旧明文迁移');
} finally {
  await stop();
  try {
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 });
  } catch {
    /* 临时目录交给系统清理 */
  }
}
