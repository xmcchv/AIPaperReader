/**
 * 一次性迁移：papertrans 的 .cache/papertrans.sqlite → 论文库 papers.db
 *
 *   projects   → papers（id 原样保留，译文 / 分块覆盖 / 页数 / 字数 一并搬过来）
 *   pdfs       → <DATA_DIR>/papers/<id>.pdf + papers.pdf_path / pdf_hash
 *   translations → tr_cache
 *   segments     → seg_cache
 *   kv           → prefs（translate.prefs / translate.last）
 *
 * 原则：只读原库、只复制不删除、按 id 幂等跳过。原库始终原样保留，
 * 迁移前会自动备份 papers.db。
 *
 *   node scripts/migrate-papertrans.mjs [--from <path>] [--dry]
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { dbPath, getDb } from '../server/paper/db.mjs';
import { getPaper } from '../server/paper/library.mjs';

const argv = process.argv.slice(2);
const dry = argv.includes('--dry');
const fromIdx = argv.indexOf('--from');
const LEGACY =
  fromIdx >= 0 ? path.resolve(argv[fromIdx + 1]) : 'D:/lcheng/papertrans/.cache/papertrans.sqlite';

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');
const pdfHash = (buf) => sha1(Buffer.concat([buf.subarray(0, 1024 * 1024), Buffer.from(String(buf.length))]));
const iso = (ms) => new Date(Number(ms) || Date.now()).toISOString();
const parse = (text, fallback) => {
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
};

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

if (!fs.existsSync(LEGACY)) fail(`找不到旧库：${LEGACY}`);

/* 1. 复制到临时目录再读：原库（含 -wal / -shm）一个字节都不动 */
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'papertrans-migrate-'));
const copy = path.join(tmp, 'legacy.sqlite');
fs.copyFileSync(LEGACY, copy);
for (const suffix of ['-wal', '-shm']) {
  if (fs.existsSync(LEGACY + suffix)) fs.copyFileSync(LEGACY + suffix, copy + suffix);
}

const { DatabaseSync } = await import('node:sqlite');
const legacy = new DatabaseSync(copy);

const projects = legacy.prepare('SELECT id, name, data, pages, chars, updated_at FROM projects').all();
const pdfs = legacy.prepare('SELECT id, name, buf FROM pdfs').all();
const trCache = legacy.prepare('SELECT k, zh, created_at FROM translations').all();
const segCache = legacy.prepare('SELECT k, data, created_at FROM segments').all();
const kvRows = legacy.prepare('SELECT k, v FROM kv').all();
legacy.close();

if (!projects.length) {
  console.log('\n  旧库里没有论文记录，无需迁移。\n');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

const pdfById = new Map(pdfs.map((row) => [row.id, row]));
const kv = new Map(kvRows.map((row) => [row.k, row.v]));

console.log(`\n  旧库：${LEGACY}`);
console.log(`  论文 ${projects.length} 篇 · PDF ${pdfs.length} 份 · 译文缓存 ${trCache.length} 条 · 分段缓存 ${segCache.length} 条`);

const conn = getDb();
const papersFile = dbPath();
const dataDir = path.dirname(papersFile);
const stats = { papers: 0, skipped: 0, pdfs: 0, trCache: 0, segCache: 0 };

if (dry) {
  for (const p of projects) {
    console.log(`  · ${p.id}  ${String(p.name || '').slice(0, 60)}  ${getPaper(p.id) ? '（已存在，跳过）' : ''}`);
  }
  console.log('\n  --dry：只看不写。\n');
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(0);
}

/* 2. 备份论文库 */
if (fs.existsSync(papersFile)) {
  const backup = `${papersFile}.bak-${Date.now()}`;
  fs.copyFileSync(papersFile, backup);
  console.log(`  已备份论文库 → ${backup}`);
}

/* 3. 逐篇写入 */
const insertPaper = conn.prepare(
  `INSERT INTO papers (id, title, source, kind, text, chars, pdf_path, pdf_hash, pages,
     blocks_json, blocks_hash, blocks_at, seg_overrides_json, tr_json, tr_engine, tr_count,
     reading_md, reading_model, structure_json, ask_json, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', '', ?, ?, '', ?, '', '', '{}', '[]', ?, ?)
   ON CONFLICT(id) DO NOTHING`,
);

conn.exec('BEGIN');
try {
  for (const row of projects) {
    if (getPaper(row.id)) {
      stats.skipped += 1;
      continue;
    }
    const data = parse(row.data, {});
    const translations = Array.isArray(data.translations) ? data.translations : [];
    const pdf = pdfById.get(row.id);
    let pdfPath = '';
    let hash = '';
    if (pdf?.buf?.length) {
      hash = pdfHash(Buffer.from(pdf.buf));
      pdfPath = path.join(dataDir, 'papers', `${String(row.id).replace(/[^a-zA-Z0-9_-]/g, '')}.pdf`);
      fs.mkdirSync(path.dirname(pdfPath), { recursive: true });
      fs.writeFileSync(pdfPath, Buffer.from(pdf.buf));
      stats.pdfs += 1;
    }
    const stamp = iso(row.updated_at);
    insertPaper.run(
      row.id,
      String(row.name || data.name || '未命名文档').slice(0, 300),
      'papertrans',
      'pdf',
      '',
      Number(row.chars || data.chars || 0),
      pdfPath,
      hash,
      Number(row.pages || data.pages || 0),
      JSON.stringify(data.overrides || {}),
      JSON.stringify(translations.filter((t) => t?.text)),
      translations.filter((t) => t?.text).length,
      stamp,
      stamp,
    );
    stats.papers += 1;
  }

  const insTr = conn.prepare('INSERT OR IGNORE INTO tr_cache (k, zh, created_at) VALUES (?, ?, ?)');
  for (const row of trCache) {
    insTr.run(row.k, row.zh, Number(row.created_at) || Date.now());
    stats.trCache += 1;
  }
  const insSeg = conn.prepare('INSERT OR IGNORE INTO seg_cache (k, data, created_at) VALUES (?, ?, ?)');
  for (const row of segCache) {
    insSeg.run(row.k, row.data, Number(row.created_at) || Date.now());
    stats.segCache += 1;
  }

  const prefsRaw = kv.get('prefs');
  if (prefsRaw) {
    const prefs = parse(prefsRaw, null);
    const existing = conn.prepare('SELECT v FROM prefs WHERE k = ?').get('translate.prefs');
    if (!existing) {
      conn
        .prepare('INSERT INTO prefs (k, v, updated_at) VALUES (?, ?, ?)')
        .run('translate.prefs', JSON.stringify(prefs || {}), Date.now());
    }
  }
  const last = kv.get('last');
  if (last) {
    const existing = conn.prepare('SELECT v FROM prefs WHERE k = ?').get('translate.last');
    if (!existing) {
      conn
        .prepare('INSERT INTO prefs (k, v, updated_at) VALUES (?, ?, ?)')
        .run('translate.last', JSON.stringify(String(parse(last, ''))), Date.now());
    }
  }

  conn.exec('COMMIT');
} catch (err) {
  conn.exec('ROLLBACK');
  fs.rmSync(tmp, { recursive: true, force: true });
  fail(`迁移失败，已回滚：${err.message}`);
}

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n  完成：新增论文 ${stats.papers} 篇（跳过 ${stats.skipped} 篇）· PDF ${stats.pdfs} 份`);
console.log(`  译文缓存 ${stats.trCache} 条 · 分段缓存 ${stats.segCache} 条`);
console.log(`  原库未改动：${LEGACY}`);
console.log(`  首次打开翻译页会重算分块（译文按原文文本匹配，不会丢）\n`);
