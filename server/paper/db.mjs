/**
 * 论文库单连接层：整个「论文侧」只有这一个 SQLite 文件。
 *
 *   <DATA_DIR>/papers.db      论文 / 分块 / 译文 / 精读 / 翻译缓存 / 偏好
 *   <DATA_DIR>/papers/*.pdf   PDF 原件
 *
 * 知识图谱仍然一图一库（graphs/<id>.db），那是刻意的边界：
 * 单图导出、单图损坏不扩散都依赖它，不并进这个文件。
 */
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../shared/config.mjs';

const DB_PATH = path.join(DATA_DIR, 'papers.db');
export const PDF_DIR = path.join(DATA_DIR, 'papers');

let sqlite;
try {
  sqlite = await import('node:sqlite');
} catch {
  throw new Error(
    `需要 Node >= 22.5 才能使用内置 SQLite（node:sqlite），当前是 ${process.version}。升级 Node 后再启动。`,
  );
}
const { DatabaseSync } = sqlite;

let db = null;

const PAPERS_SCHEMA = `
  CREATE TABLE IF NOT EXISTS papers (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT '',
    kind TEXT NOT NULL DEFAULT 'text',
    text TEXT NOT NULL DEFAULT '',
    chars INTEGER NOT NULL DEFAULT 0,
    pdf_path TEXT NOT NULL DEFAULT '',
    reading_md TEXT NOT NULL DEFAULT '',
    reading_model TEXT NOT NULL DEFAULT '',
    structure_json TEXT NOT NULL DEFAULT '{}',
    ask_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_papers_updated ON papers(updated_at);
`;

/** 老库升级：缺哪列补哪列，不重建表 */
const PAPER_COLUMNS = [
  ['pdf_hash', "TEXT NOT NULL DEFAULT ''"],
  ['pages', 'INTEGER NOT NULL DEFAULT 0'],
  ['blocks_json', "TEXT NOT NULL DEFAULT ''"],
  ['blocks_hash', "TEXT NOT NULL DEFAULT ''"],
  ['blocks_at', "TEXT NOT NULL DEFAULT ''"],
  ['seg_overrides_json', "TEXT NOT NULL DEFAULT ''"],
  ['tr_json', "TEXT NOT NULL DEFAULT ''"],
  ['tr_engine', "TEXT NOT NULL DEFAULT ''"],
  ['tr_count', 'INTEGER NOT NULL DEFAULT 0'],
  ['usage_json', "TEXT NOT NULL DEFAULT '{}'"],
  // 本篇累计用量：跨多次精读/追问累加，重跑精读不清零；与 usage_json（本次）分开
  ['paper_usage_json', "TEXT NOT NULL DEFAULT ''"],
  ['outline_json', "TEXT NOT NULL DEFAULT ''"],
];

const EXTRA_TABLES = `
  CREATE TABLE IF NOT EXISTS tr_cache (
    k TEXT PRIMARY KEY, zh TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS seg_cache (
    k TEXT PRIMARY KEY, data TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prefs (
    k TEXT PRIMARY KEY, v TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
`;

function migrate(conn) {
  conn.exec(PAPERS_SCHEMA);
  const cols = conn
    .prepare('PRAGMA table_info(papers)')
    .all()
    .map((row) => row.name);
  for (const [name, decl] of PAPER_COLUMNS) {
    if (!cols.includes(name)) conn.exec(`ALTER TABLE papers ADD COLUMN ${name} ${decl}`);
  }
  conn.exec('CREATE INDEX IF NOT EXISTS idx_papers_hash ON papers(pdf_hash)');
  conn.exec(EXTRA_TABLES);
}

export function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  migrate(db);
  return db;
}

export const dbPath = () => DB_PATH;

export const safeJson = (text, fallback) => {
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
};

/** 偏好 / 小对象：整体存一个 JSON */
export function getPref(key) {
  const row = getDb().prepare('SELECT v FROM prefs WHERE k = ?').get(String(key));
  return row ? safeJson(row.v, null) : null;
}

export function setPref(key, value) {
  const stamp = Date.now();
  getDb()
    .prepare(
      `INSERT INTO prefs (k, v, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at`,
    )
    .run(String(key), JSON.stringify(value ?? null), stamp);
}

export function allPrefs() {
  const out = {};
  for (const row of getDb().prepare('SELECT k, v FROM prefs').all()) {
    out[row.k] = safeJson(row.v, null);
  }
  return out;
}
