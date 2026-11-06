/**
 * 把旧版存在 prefs 里的明文翻译 Key，一次性迁移成 config.json 里的密文。
 *
 *   node scripts/encrypt-translate-keys.mjs                # 用 PAPERLENS_PASSPHRASE
 *   node scripts/encrypt-translate-keys.mjs --passphrase 你的主密码
 *   node scripts/encrypt-translate-keys.mjs --dry          # 只列出会被迁移的服务
 *
 * 走的是正在运行的服务端接口，所以迁完当下就能用（密钥同时进了进程内存）。
 * 迁移成功后 prefs 里的明文会被清掉，只保留地址/模型这类非敏感字段。
 */
import { dbPath, getPref } from '../server/paper/db.mjs';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const passIdx = argv.indexOf('--passphrase');
const portIdx = argv.indexOf('--port');
const passphrase = (passIdx >= 0 ? argv[passIdx + 1] : process.env.PAPERLENS_PASSPHRASE || '').trim();
const port = Number(portIdx >= 0 ? argv[portIdx + 1] : process.env.PORT || 5173);
const base = `http://127.0.0.1:${port}`;

const prefs = getPref('translate.prefs') || {};
const cfgStore = prefs.cfgStore && typeof prefs.cfgStore === 'object' ? prefs.cfgStore : {};
const targets = [];

for (const [id, entry] of Object.entries(cfgStore)) {
  if (entry?.apiKey) targets.push({ id, baseUrl: entry.baseUrl || '', model: entry.model || '', appId: entry.appId || '' });
}
if (prefs.cfg?.apiKey && !targets.some((t) => t.id === prefs.cfg.provider)) {
  targets.push({
    id: prefs.cfg.provider || 'free',
    baseUrl: prefs.cfg.baseUrl || '',
    model: prefs.cfg.model || '',
    appId: prefs.cfg.appId || '',
  });
}

if (!targets.length) {
  console.log('\n  没有需要迁移的明文 Key（prefs 里已经干净了）。\n');
  process.exit(0);
}

console.log(`\n  数据库：${dbPath()}`);
console.log(`  待迁移：${targets.map((t) => t.id).join(', ')}`);
if (dry) {
  console.log('\n  --dry：只看不写。\n');
  process.exit(0);
}
if (!passphrase) {
  console.error('\n  ✗ 需要主密码：--passphrase <你的主密码> 或设置 PAPERLENS_PASSPHRASE\n');
  process.exit(1);
}

let ok = 0;
for (const t of targets) {
  try {
    const res = await fetch(`${base}/api/translate/config`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        provider: t.id,
        config: { provider: t.id, baseUrl: t.baseUrl, model: t.model, appId: t.appId, apiKey: '' },
        passphrase,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      console.log(`  ✗ ${t.id}：${data.error || `HTTP ${res.status}`}`);
      continue;
    }
    console.log(`  ✓ ${t.id}：已加密写入 config.json`);
    ok += 1;
  } catch (err) {
    console.log(`  ✗ ${t.id}：${err.message}（服务端没起来？先 npm start）`);
  }
}

console.log(`\n  完成 ${ok}/${targets.length}。明文 Key 已从数据库移除；config.json 里只有密文。\n`);
process.exit(ok === targets.length ? 0 : 1);
