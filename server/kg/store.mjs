/**
 * 知识库存储：SQLite（Node 内置 node:sqlite，零第三方依赖）。
 *
 * 为什么迁到 SQLite：
 *   - 每次改动只写一行（导入一份资料 ~0.1ms，而不是把整个 JSON 重新序列化 15~90ms）
 *   - 事务 + WAL：写一半崩掉不会坏库
 *   - name_key 唯一约束：概念不可能重复
 *   - 外键级联：删资料 / 删概念时引用自动清干净
 *
 * 全文检索：默认走 LIKE（个人库规模下最坏 36ms，且天然支持 2 字中文查询）；
 * FTS5 trigram 索引作为可选加速器（KGRAPH_FTS=1 或设置里打开），
 * 因为实测在高频词上 trigram 反而更慢、索引还要 5 倍空间。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../shared/config.mjs';

/**
 * 存储布局：每个「图谱」一个独立的 SQLite 库。
 *   data/graphs/<graphId>.db   一个图谱的全部数据（资料/概念/关系/布局/视图）
 *   data/graphs/active.txt     上次打开的图谱
 *   data/backups/<graphId>-YYYY-MM-DD.db  每日快照
 *   data/assets/               图片素材（跨图谱共享，文件名唯一）
 *
 * 用「一图一库」而不是给所有表加 graph_id：切换图谱只是换个连接，
 * 删除图谱就是删一个文件，隔离彻底、迁移简单（旧 library.db 直接搬进来）。
 */
const GRAPHS_DIR = path.join(DATA_DIR, 'graphs');
const LEGACY_DB_PATH = path.join(DATA_DIR, 'library.db');
const ACTIVE_POINTER = path.join(GRAPHS_DIR, 'active.txt');
const LEGACY_JSON_PATH = path.join(DATA_DIR, 'library.json');
const ASSET_DIR = path.join(DATA_DIR, 'assets');
const DEFAULT_GRAPH_NAME = '我的知识库';

export const EDGE_TYPES = ['prereq', 'extends', 'related', 'flow'];
export const CONCEPT_KINDS = ['concept', 'method', 'formula', 'data', 'result', 'task', 'tool'];

const MAX_REFS_PER_SOURCE = 4;
const FTS_MAX_CANDIDATES = 200;

let sqlite;
try {
  sqlite = await import('node:sqlite');
} catch {
  throw new Error(
    `需要 Node >= 22.5 才能使用内置 SQLite（node:sqlite），当前是 ${process.version}。升级 Node 后再启动。`,
  );
}
const { DatabaseSync } = sqlite;

const uid = (prefix) => `${prefix}_${crypto.randomBytes(4).toString('hex')}`;
const now = () => new Date().toISOString();
const jsonParse = (text, fallback) => {
  try {
    const parsed = JSON.parse(text);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
};

/* --------------------------------- 连接与建表 --------------------------------- */

let db = null;
let currentGraphId = '';
let graphsReady = false;

/** 当前图谱的库连接（懒加载） */
function getDb() {
  if (db) return db;
  ensureGraphs();
  db = openGraphDb(currentGraphId);
  return db;
}

/** 打开某个图谱的库：建表、补 meta、按需建 FTS、留当天快照 */
function openGraphDb(graphId) {
  fs.mkdirSync(GRAPHS_DIR, { recursive: true });
  const conn = new DatabaseSync(graphPath(graphId));
  conn.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      excerpt TEXT NOT NULL DEFAULT '',
      chars INTEGER NOT NULL DEFAULT 0,
      asset_path TEXT NOT NULL DEFAULT '',
      topics TEXT NOT NULL DEFAULT '[]',
      meta TEXT NOT NULL DEFAULT '{}',
      added_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sources_added ON sources(added_at);

    CREATE TABLE IF NOT EXISTS concepts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      aliases TEXT NOT NULL DEFAULT '[]',
      summary TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'concept',
      tags TEXT NOT NULL DEFAULT '[]',
      stub INTEGER NOT NULL DEFAULT 0,
      manual INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS concept_sources (
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      PRIMARY KEY (concept_id, source_id)
    );

    CREATE TABLE IF NOT EXISTS refs (
      concept_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      quote TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (concept_id, source_id, quote)
    );
    CREATE INDEX IF NOT EXISTS idx_refs_source ON refs(source_id);

    CREATE TABLE IF NOT EXISTS edges (
      id TEXT PRIMARY KEY,
      from_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      to_id TEXT NOT NULL REFERENCES concepts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      label TEXT NOT NULL DEFAULT '',
      source_id TEXT NOT NULL DEFAULT '',
      quote TEXT NOT NULL DEFAULT '',
      manual INTEGER NOT NULL DEFAULT 0,
      UNIQUE (from_id, to_id, type)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
    CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);

    CREATE TABLE IF NOT EXISTS layout (
      bucket TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      x REAL NOT NULL,
      y REAL NOT NULL,
      PRIMARY KEY (bucket, concept_id)
    );
  `);
  ensureGraphMeta(conn, graphId);
  ensureFtsTable(conn);
  ensureDailyBackup(conn, graphId);
  return conn;
}

/**
 * 每天第一次打开某个图谱时留一份快照（data/backups/<graphId>-YYYY-MM-DD.db），每个图谱保留最近 7 份。
 * 用 VACUUM INTO 而不是复制文件：WAL 模式下直接拷 .db 可能拿到半写状态。
 */
function ensureDailyBackup(conn, graphId) {
  try {
    const dir = path.join(DATA_DIR, 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const target = path.join(dir, `${graphId}-${stamp}.db`);
    if (fs.existsSync(target)) return null;
    const concepts = conn.prepare('SELECT COUNT(*) c FROM concepts').get().c;
    const sources = conn.prepare('SELECT COUNT(*) c FROM sources').get().c;
    if (!concepts && !sources) return null; // 空图不占地方
    conn.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    const snapshots = fs
      .readdirSync(dir)
      .filter((name) => name.startsWith(`${graphId}-`) && name.endsWith('.db'))
      .sort();
    for (const old of snapshots.slice(0, Math.max(0, snapshots.length - 7))) {
      fs.rmSync(path.join(dir, old), { force: true });
    }
    return target;
  } catch {
    return null; // 备份失败不影响使用
  }
}

/** 事务包装：出错自动回滚，避免半写状态 */
function tx(fn) {
  const conn = getDb();
  conn.exec('BEGIN');
  try {
    const result = fn(conn);
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      conn.exec('ROLLBACK');
    } catch {
      /* 回滚失败也没别的办法 */
    }
    throw err;
  }
}

export function closeDb() {
  if (!db) return;
  try {
    db.close();
  } catch {
    /* ignore */
  }
  db = null;
}

/* ------------------------------- 图谱（工作区） ------------------------------- */

/** 图谱库文件路径 */
export function graphPath(graphId) {
  return path.join(GRAPHS_DIR, `${graphId}.db`);
}

function isValidGraphId(id) {
  return /^g_[A-Za-z0-9]{3,32}$/.test(String(id || ''));
}

export function graphExists(graphId) {
  return isValidGraphId(graphId) && fs.existsSync(graphPath(graphId));
}

function listGraphIds() {
  try {
    return fs
      .readdirSync(GRAPHS_DIR)
      .filter((name) => name.endsWith('.db'))
      .map((name) => name.slice(0, -3))
      .filter(isValidGraphId);
  } catch {
    return [];
  }
}

function readActivePointer() {
  try {
    return fs.readFileSync(ACTIVE_POINTER, 'utf8').trim();
  } catch {
    return '';
  }
}

function writeActivePointer(graphId) {
  try {
    fs.mkdirSync(GRAPHS_DIR, { recursive: true });
    fs.writeFileSync(ACTIVE_POINTER, graphId, 'utf8');
  } catch {
    /* 记不住上次打开的图不影响使用 */
  }
}

function ensureGraphMeta(conn, graphId) {
  if (metaGetConn(conn, 'graph_name', '')) return;
  metaSetConn(conn, 'graph_name', DEFAULT_GRAPH_NAME);
  metaSetConn(conn, 'graph_created_at', now());
}

/** 首次调用时准备图谱目录：迁移旧 library.db → 建立默认图谱 → 恢复上次打开的图 */
function ensureGraphs() {
  if (graphsReady) return;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(GRAPHS_DIR, { recursive: true });
  migrateLegacyDb();
  const ids = listGraphIds();
  if (!ids.length) {
    currentGraphId = createGraphRecord(DEFAULT_GRAPH_NAME).id;
  } else {
    const last = readActivePointer();
    currentGraphId = ids.includes(last) ? last : ids[0];
  }
  writeActivePointer(currentGraphId);
  graphsReady = true;
}

/** 建库 + 写 meta，但不切换当前图谱（供 ensureGraphs / createGraph 复用） */
function createGraphRecord(name, description = '') {
  const id = `g_${crypto.randomBytes(4).toString('hex')}`;
  const conn = openGraphDb(id);
  try {
    metaSetConn(conn, 'graph_name', String(name || DEFAULT_GRAPH_NAME).trim().slice(0, 60) || DEFAULT_GRAPH_NAME);
    metaSetConn(conn, 'graph_description', String(description || '').trim().slice(0, 200));
    metaSetConn(conn, 'graph_created_at', now());
    metaSetConn(conn, 'updated_at', now());
  } finally {
    conn.close();
  }
  return { id };
}

/**
 * 把旧版的单库 data/library.db 迁成一个图谱。
 * 用 VACUUM INTO 而不是移动文件：WAL 直接搬可能丢最后一段写入。
 */
function migrateLegacyDb() {
  if (!fs.existsSync(LEGACY_DB_PATH)) return null;
  fs.mkdirSync(GRAPHS_DIR, { recursive: true });
  const id = `g_${crypto.randomBytes(4).toString('hex')}`;
  const target = graphPath(id);
  try {
    const src = new DatabaseSync(LEGACY_DB_PATH);
    try {
      src.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
    } finally {
      src.close();
    }
  } catch (err) {
    return { ok: false, error: err.message };
  }
  try {
    const conn = new DatabaseSync(target);
    try {
      metaSetConn(conn, 'graph_name', DEFAULT_GRAPH_NAME);
      metaSetConn(conn, 'graph_created_at', now());
    } finally {
      conn.close();
    }
  } catch {
    /* meta 写不进去也能用，后续 ensureGraphMeta 会补 */
  }
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(LEGACY_DB_PATH + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
  return { ok: true, id };
}

/** 所有图谱概览（供切换器用） */
export function listGraphs() {
  const active = getActiveGraphId();
  return listGraphIds()
    .map((id) => {
      const info = {
        id,
        name: id,
        description: '',
        createdAt: '',
        updatedAt: '',
        sources: 0,
        concepts: 0,
        edges: 0,
        sizeBytes: 0,
        active: id === active,
      };
      try {
        const conn = new DatabaseSync(graphPath(id));
        try {
          info.name = metaGetConn(conn, 'graph_name', id);
          info.description = metaGetConn(conn, 'graph_description', '');
          info.createdAt = metaGetConn(conn, 'graph_created_at', '');
          info.updatedAt = metaGetConn(conn, 'updated_at', '');
          info.sources = conn.prepare('SELECT COUNT(*) c FROM sources').get().c;
          info.concepts = conn.prepare('SELECT COUNT(*) c FROM concepts').get().c;
          info.edges = conn.prepare('SELECT COUNT(*) c FROM edges').get().c;
        } finally {
          conn.close();
        }
      } catch {
        info.broken = true;
      }
      try {
        info.sizeBytes = fs.statSync(graphPath(id)).size;
      } catch {
        /* ignore */
      }
      return info;
    })
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export function getActiveGraphId() {
  if (!currentGraphId) ensureGraphs();
  return currentGraphId;
}

/** 当前图谱的完整概况（含存储信息） */
export function getCurrentGraph() {
  const info = getStorageInfo();
  return {
    id: currentGraphId,
    name: metaGet('graph_name', DEFAULT_GRAPH_NAME),
    description: metaGet('graph_description', ''),
    createdAt: metaGet('graph_created_at', ''),
    updatedAt: metaGet('updated_at', ''),
    path: info.path,
    sizeBytes: info.sizeBytes,
    sources: info.sources,
    concepts: info.concepts,
    edges: info.edges,
    fts: info.fts,
  };
}

export function createGraph({ name, description } = {}) {
  const record = createGraphRecord(name, description);
  activateGraph(record.id);
  return getCurrentGraph();
}

export function renameGraph(graphId, { name, description } = {}) {
  const id = String(graphId || '');
  if (!graphExists(id)) throw new Error('图谱不存在');
  const conn = new DatabaseSync(graphPath(id));
  try {
    if (typeof name === 'string' && name.trim()) metaSetConn(conn, 'graph_name', name.trim().slice(0, 60));
    if (typeof description === 'string') metaSetConn(conn, 'graph_description', description.trim().slice(0, 200));
    metaSetConn(conn, 'updated_at', now());
  } finally {
    conn.close();
  }
  return listGraphs().find((graph) => graph.id === id) || null;
}

/** 删除图谱：关连接 → 删库文件（快照保留，必要时能还原） */
export function deleteGraph(graphId) {
  const id = String(graphId || '');
  if (!graphExists(id)) throw new Error('图谱不存在');
  const wasActive = id === currentGraphId;
  if (wasActive) closeDb();
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(graphPath(id) + suffix, { force: true });
    } catch {
      /* ignore */
    }
  }
  const remaining = listGraphIds();
  if (!remaining.length) {
    db = null;
    currentGraphId = '';
    graphsReady = false;
    ensureGraphs();
  } else if (wasActive) {
    currentGraphId = '';
    activateGraph(remaining[0]);
  }
  return listGraphs();
}

export function activateGraph(graphId) {
  const id = String(graphId || '');
  if (!graphExists(id)) throw new Error('图谱不存在');
  if (id === currentGraphId && db) return getCurrentGraph();
  closeDb();
  currentGraphId = id;
  writeActivePointer(id);
  getDb(); // 立刻打开：建表、补 meta、留快照
  return getCurrentGraph();
}

/* -------------------------------- FTS5（可选） -------------------------------- */

function metaGetConn(conn, key, fallback = '') {
  const row = conn.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

function metaSetConn(conn, key, value) {
  conn
    .prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
    .run(key, String(value));
}

function metaGet(key, fallback = '') {
  return metaGetConn(getDb(), key, fallback);
}

function metaSet(key, value) {
  metaSetConn(getDb(), key, value);
}

function ftsTableExists(conn = getDb()) {
  return Boolean(conn.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'source_fts'`).get());
}

export function isFtsEnabled() {
  if (process.env.KGRAPH_FTS === '1') return ftsTableExists();
  if (process.env.KGRAPH_FTS === '0') return false;
  return metaGet('fts', '0') === '1' && ftsTableExists();
}

function ensureFtsTable(conn) {
  if (metaGetConn(conn, 'fts', '0') !== '1' && process.env.KGRAPH_FTS !== '1') return;
  conn.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(
      ref UNINDEXED, title, body, tokenize = 'trigram', detail = none, columnsize = 0
    );
  `);
}

function rebuildFts() {
  const conn = getDb();
  const started = Date.now();
  conn.exec(`
    DELETE FROM source_fts;
    INSERT INTO source_fts (ref, title, body) SELECT id, title, text FROM sources;
  `);
  return { rows: conn.prepare('SELECT COUNT(*) c FROM source_fts').get().c, ms: Date.now() - started };
}

/** 开 / 关 FTS 加速器（开启会重建索引，关闭会丢掉索引占的空间） */
export function setFtsEnabled(enabled) {
  const on = Boolean(enabled);
  if (on) {
    metaSet('fts', '1');
    getDb().exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS source_fts USING fts5(
        ref UNINDEXED, title, body, tokenize = 'trigram', detail = none, columnsize = 0
      );
    `);
    const built = rebuildFts();
    return { enabled: true, ...built };
  }
  metaSet('fts', '0');
  getDb().exec('DROP TABLE IF EXISTS source_fts');
  return { enabled: false };
}

function ftsUpsert(source) {
  if (!isFtsEnabled()) return;
  try {
    const conn = getDb();
    conn.prepare('DELETE FROM source_fts WHERE ref = ?').run(source.id);
    conn.prepare('INSERT INTO source_fts (ref, title, body) VALUES (?, ?, ?)').run(source.id, source.title, source.text || '');
  } catch {
    /* FTS 只是加速器，写失败不影响主流程 */
  }
}

function ftsDelete(sourceId) {
  if (!isFtsEnabled()) return;
  try {
    getDb().prepare('DELETE FROM source_fts WHERE ref = ?').run(sourceId);
  } catch {
    /* ignore */
  }
}

/* ---------------------------------- 行映射 ---------------------------------- */

const rowToSource = (row) => ({
  id: row.id,
  kind: row.kind,
  title: row.title,
  url: row.url,
  text: row.text,
  excerpt: row.excerpt,
  chars: row.chars,
  assetPath: row.asset_path,
  topics: jsonParse(row.topics, []),
  meta: jsonParse(row.meta, {}),
  addedAt: row.added_at,
});

const rowToConcept = (row) => ({
  id: row.id,
  name: row.name,
  aliases: jsonParse(row.aliases, []),
  summary: row.summary,
  kind: row.kind,
  tags: jsonParse(row.tags, []),
  stub: Boolean(row.stub),
  manual: Boolean(row.manual),
  sourceIds: [],
  refs: [],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const rowToEdge = (row) => ({
  id: row.id,
  from: row.from_id,
  to: row.to_id,
  type: row.type,
  label: row.label,
  sourceId: row.source_id,
  quote: row.quote,
  manual: Boolean(row.manual),
});

/* ---------------------------------- 读取 ---------------------------------- */

/** 完整知识库（不含资料全文：全文按需 getSourceText，避免几百 MB 进内存） */
export function loadLibrary() {
  const conn = getDb();
  const sources = conn.prepare('SELECT * FROM sources ORDER BY added_at').all().map(rowToSource);
  for (const source of sources) source.text = '';

  const concepts = conn.prepare('SELECT * FROM concepts ORDER BY created_at').all().map(rowToConcept);
  const byId = new Map(concepts.map((concept) => [concept.id, concept]));

  for (const row of conn.prepare('SELECT concept_id, source_id FROM concept_sources').all()) {
    byId.get(row.concept_id)?.sourceIds.push(row.source_id);
  }
  for (const row of conn.prepare('SELECT concept_id, source_id, quote, at FROM refs ORDER BY at').all()) {
    byId.get(row.concept_id)?.refs.push({ sourceId: row.source_id, quote: row.quote, at: row.at });
  }

  const edges = conn.prepare('SELECT * FROM edges').all().map(rowToEdge);

  const layout = { dag: {}, mind: {} };
  for (const row of conn.prepare('SELECT bucket, concept_id, x, y FROM layout').all()) {
    if (!layout[row.bucket]) layout[row.bucket] = {};
    layout[row.bucket][row.concept_id] = { x: row.x, y: row.y };
  }

  const view = jsonParse(metaGet('view', ''), null) || { mode: 'dag', selectedId: '', rootId: '' };

  return {
    version: 1,
    updatedAt: metaGet('updated_at', now()),
    sources,
    concepts,
    edges,
    layout,
    view,
  };
}

/** 给前端的精简视图：资料不带全文，避免打开就传几百 KB */
export function publicLibrary(lib = loadLibrary()) {
  return {
    version: lib.version,
    updatedAt: lib.updatedAt,
    sources: lib.sources.map((source) => ({
      id: source.id,
      kind: source.kind,
      title: source.title,
      url: source.url,
      excerpt: source.excerpt,
      chars: source.chars,
      topics: source.topics,
      assetPath: source.assetPath,
      // 图片资料给一个可直接引用的地址（服务端 /assets/<文件名>）
      assetUrl: source.assetPath ? `/api/kg/assets/${path.basename(source.assetPath)}` : '',
      addedAt: source.addedAt,
      meta: source.meta,
    })),
    concepts: lib.concepts,
    edges: lib.edges,
    layout: lib.layout,
    view: lib.view,
  };
}

export function getSource(sourceId) {
  const row = getDb().prepare('SELECT * FROM sources WHERE id = ?').get(String(sourceId || ''));
  return row ? rowToSource(row) : null;
}

export function getSourceText(sourceId) {
  const source = getSource(sourceId);
  return source ? { source, text: source.text } : null;
}

export function getConcept(conceptId) {
  const conn = getDb();
  const row = conn.prepare('SELECT * FROM concepts WHERE id = ?').get(String(conceptId || ''));
  if (!row) return null;
  const concept = rowToConcept(row);
  concept.sourceIds = conn.prepare('SELECT source_id FROM concept_sources WHERE concept_id = ?').all(row.id).map((r) => r.source_id);
  concept.refs = conn
    .prepare('SELECT source_id, quote, at FROM refs WHERE concept_id = ? ORDER BY at')
    .all(row.id)
    .map((r) => ({ sourceId: r.source_id, quote: r.quote, at: r.at }));
  return concept;
}

export function getStorageInfo() {
  const conn = getDb();
  const dbPath = graphPath(currentGraphId);
  let size = 0;
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      size += fs.statSync(dbPath + suffix).size;
    } catch {
      /* 文件可能还不存在 */
    }
  }
  return {
    engine: 'sqlite',
    node: process.version,
    graphId: currentGraphId,
    graphName: metaGetConn(conn, 'graph_name', ''),
    graphsDir: GRAPHS_DIR,
    path: dbPath,
    sizeBytes: size,
    sources: conn.prepare('SELECT COUNT(*) c FROM sources').get().c,
    concepts: conn.prepare('SELECT COUNT(*) c FROM concepts').get().c,
    edges: conn.prepare('SELECT COUNT(*) c FROM edges').get().c,
    fts: isFtsEnabled(),
    ftsRows: ftsTableExists() ? conn.prepare('SELECT COUNT(*) c FROM source_fts').get().c : 0,
  };
}

/* ---------------------------------- 归一化 ---------------------------------- */

/** 名称归一化：全角转半角、去空白、去标点，用来合并"同一个概念的不同写法" */
export function nameKey(name) {
  return String(name || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '')
    .replace(/[·・:：,，。.、;；!！?？"'“”‘’()（）[\]【】<>《》/\\|+\-—_~`]/g, '');
}

const squash = (s) => String(s || '').replace(/[\s\u3000]+/g, '');

/** 出处校验：quote 必须能在资料原文里找到（允许换行/空格差异） */
export function locateQuote(text, quote) {
  const q = String(quote || '').trim();
  const src = String(text || '');
  if (q.length < 4 || !src) return null;
  if (src.includes(q)) return q;
  if (squash(src).includes(squash(q))) return q;
  return null;
}

/** 从资料里取出包含某个检索词的整句 */
export function sentenceAround(text, term, limit = 220) {
  const src = String(text || '');
  const needle = String(term || '').trim();
  if (!needle) return '';
  const idx = src.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return '';
  let start = idx;
  while (start > 0 && idx - start < limit && !/[。！？!?\n]/.test(src[start - 1])) start -= 1;
  let end = idx + needle.length;
  while (end < src.length && end - idx < limit && !/[。！？!?\n]/.test(src[end])) end += 1;
  const sentence = src.slice(start, Math.min(src.length, end + 1)).trim();
  return sentence.length >= 6 ? sentence : needle;
}

function dedupeStrings(list, max = 6, maxLen = 120) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const value = String(item || '').trim().slice(0, maxLen);
    const key = nameKey(value);
    if (!value || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

/* ---------------------------------- 写入 ---------------------------------- */

/** 新增一份资料 */
export function addSource(partial = {}) {
  const source = {
    id: uid('s'),
    kind: ['paper', 'web', 'image', 'text', 'paperlens'].includes(partial.kind) ? partial.kind : 'text',
    title: String(partial.title || '未命名资料').trim().slice(0, 200),
    url: String(partial.url || '').trim(),
    text: String(partial.text || '').slice(0, 400000),
    excerpt: String(partial.excerpt || partial.text || '').replace(/\s+/g, ' ').trim().slice(0, 240),
    chars: String(partial.text || '').length,
    assetPath: String(partial.assetPath || ''),
    topics: dedupeStrings(partial.topics, 8, 40),
    meta: partial.meta && typeof partial.meta === 'object' ? partial.meta : {},
    addedAt: now(),
  };
  getDb()
    .prepare(
      `INSERT INTO sources (id, kind, title, url, text, excerpt, chars, asset_path, topics, meta, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      source.id,
      source.kind,
      source.title,
      source.url,
      source.text,
      source.excerpt,
      source.chars,
      source.assetPath,
      JSON.stringify(source.topics),
      JSON.stringify(source.meta),
      source.addedAt,
    );
  metaSet('updated_at', now());
  ftsUpsert(source);
  return source;
}

/** 合并资料 meta（pending / needsText / extracted 这类状态） */
export function patchSourceMeta(sourceId, patch = {}) {
  const source = getSource(sourceId);
  if (!source) return null;
  const meta = { ...source.meta, ...patch };
  getDb().prepare('UPDATE sources SET meta = ? WHERE id = ?').run(JSON.stringify(meta), source.id);
  source.meta = meta;
  return source;
}

/** name_key → 概念（含别名），合并时判断"是不是同一个概念" */
function buildNameIndex() {
  const index = new Map();
  for (const row of getDb().prepare('SELECT * FROM concepts').all()) {
    const concept = rowToConcept(row);
    for (const key of [concept.name, ...concept.aliases]) {
      const k = nameKey(key);
      if (k && !index.has(k)) index.set(k, concept);
    }
  }
  return index;
}

function conceptRowById(conceptId) {
  const row = getDb().prepare('SELECT * FROM concepts WHERE id = ?').get(conceptId);
  return row ? rowToConcept(row) : null;
}

function addRef(source, conceptId, quote, stats) {
  const verified = locateQuote(source.text, quote);
  if (!verified) return false;
  const conn = getDb();
  const exists = conn
    .prepare('SELECT 1 FROM refs WHERE concept_id = ? AND source_id = ? AND quote = ?')
    .get(conceptId, source.id, verified);
  if (exists) return false;
  const count = conn.prepare('SELECT COUNT(*) c FROM refs WHERE concept_id = ? AND source_id = ?').get(conceptId, source.id).c;
  if (count >= MAX_REFS_PER_SOURCE) {
    conn
      .prepare(
        `DELETE FROM refs WHERE rowid IN (
           SELECT rowid FROM refs WHERE concept_id = ? AND source_id = ? ORDER BY at ASC LIMIT ?
         )`,
      )
      .run(conceptId, source.id, count - MAX_REFS_PER_SOURCE + 1);
  }
  conn
    .prepare('INSERT INTO refs (concept_id, source_id, quote, at) VALUES (?, ?, ?, ?)')
    .run(conceptId, source.id, verified, now());
  if (stats) stats.refsAdded += 1;
  return true;
}

function linkSource(conceptId, sourceId) {
  getDb().prepare('INSERT OR IGNORE INTO concept_sources (concept_id, source_id) VALUES (?, ?)').run(conceptId, sourceId);
}

/**
 * 建或更新一个概念。同名（含别名）视为同一个概念。
 * @returns {{ concept: object|null, created: boolean }}
 */
export function upsertConcept(input = {}, source = null, { stub = false, stats = null } = {}) {
  const name = String(input.name || input.label || '').trim().slice(0, 80);
  const key = nameKey(name);
  if (!name || !key) return { concept: null, created: false };

  const conn = getDb();
  const existingRow = conn.prepare('SELECT * FROM concepts WHERE name_key = ?').get(key);
  const aliases = dedupeStrings(input.aliases || input.terms, 6, 60);
  const tags = dedupeStrings(input.tags, 6, 40);
  const summary = String(input.summary || input.explain || input.detail || '').trim().slice(0, 400);
  const kind = CONCEPT_KINDS.includes(String(input.kind)) ? String(input.kind) : 'concept';

  let concept;
  let created = false;

  if (existingRow) {
    concept = rowToConcept(existingRow);
    const nextAliases = dedupeStrings([...concept.aliases, ...aliases], 8, 60);
    const nextTags = dedupeStrings([...concept.tags, ...tags], 8, 40);
    const nextSummary = summary && summary.length > String(concept.summary || '').length ? summary : concept.summary;
    const nextKind = kind !== 'concept' && concept.kind === 'concept' ? kind : concept.kind;
    const nextStub = concept.stub && stub ? 1 : 0;
    conn
      .prepare('UPDATE concepts SET aliases = ?, tags = ?, summary = ?, kind = ?, stub = ?, updated_at = ? WHERE id = ?')
      .run(JSON.stringify(nextAliases), JSON.stringify(nextTags), nextSummary, nextKind, nextStub, now(), concept.id);
    concept = { ...concept, aliases: nextAliases, tags: nextTags, summary: nextSummary, kind: nextKind, stub: Boolean(nextStub) };
  } else {
    const id = uid('c');
    const stamp = now();
    conn
      .prepare(
        `INSERT INTO concepts (id, name, name_key, aliases, summary, kind, tags, stub, manual, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        name,
        key,
        JSON.stringify(aliases),
        summary,
        kind,
        JSON.stringify(tags),
        stub ? 1 : 0,
        input.manual ? 1 : 0,
        stamp,
        stamp,
      );
    concept = {
      id,
      name,
      aliases,
      summary,
      kind,
      tags,
      stub: Boolean(stub),
      manual: Boolean(input.manual),
      sourceIds: [],
      refs: [],
      createdAt: stamp,
      updatedAt: stamp,
    };
    created = true;
  }

  if (source) {
    linkSource(concept.id, source.id);
    for (const quote of Array.isArray(input.quotes) ? input.quotes : []) {
      addRef(source, concept.id, quote, stats);
    }
    if (!input.quotes?.length && input.quote) addRef(source, concept.id, input.quote, stats);
  }

  return { concept, created };
}

/** 加边（同 from/to/type 只留一条，出处合并） */
export function addEdge(fromId, toId, type = 'prereq', extra = {}) {
  if (!fromId || !toId || fromId === toId) return null;
  const kind = EDGE_TYPES.includes(type) ? type : 'prereq';
  const conn = getDb();
  const existing = conn.prepare('SELECT * FROM edges WHERE from_id = ? AND to_id = ? AND type = ?').get(fromId, toId, kind);
  if (existing) {
    conn
      .prepare(
        `UPDATE edges SET
           label = CASE WHEN label = '' THEN ? ELSE label END,
           source_id = CASE WHEN source_id = '' THEN ? ELSE source_id END,
           quote = CASE WHEN quote = '' THEN ? ELSE quote END,
           manual = MAX(manual, ?)
         WHERE id = ?`,
      )
      .run(
        String(extra.label || '').slice(0, 40),
        extra.sourceId || '',
        String(extra.quote || '').slice(0, 400),
        extra.manual ? 1 : 0,
        existing.id,
      );
    return getDb().prepare('SELECT * FROM edges WHERE id = ?').get(existing.id);
  }
  const id = uid('e');
  conn
    .prepare('INSERT INTO edges (id, from_id, to_id, type, label, source_id, quote, manual) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(
      id,
      fromId,
      toId,
      kind,
      String(extra.label || '').trim().slice(0, 40),
      extra.sourceId || '',
      String(extra.quote || '').slice(0, 400),
      extra.manual ? 1 : 0,
    );
  return { id };
}

export function deleteEdge(edgeId) {
  const result = getDb().prepare('DELETE FROM edges WHERE id = ?').run(String(edgeId || ''));
  if (result.changes) metaSet('updated_at', now());
  return { ok: result.changes > 0 };
}

/**
 * 把一次抽取结果并进知识库。
 *   - 同名 / 别名相同的概念自动合并（跨资料长成一张网）
 *   - 前置概念找不到时建"待补全"占位节点，前置链路不会断
 *   - 每条 quote 都要在资料原文里核对，核对不过就丢掉
 */
export function mergeGraph(source, extraction = {}) {
  const stats = { conceptsAdded: 0, conceptsUpdated: 0, stubsAdded: 0, edgesAdded: 0, refsAdded: 0 };
  const conceptList = Array.isArray(extraction.concepts) ? extraction.concepts : [];

  tx((conn) => {
    const index = buildNameIndex();
    const batch = new Map();

    const remember = (concept) => {
      for (const key of [concept.name, ...(concept.aliases || [])]) {
        const k = nameKey(key);
        if (k && !batch.has(k)) batch.set(k, concept);
      }
    };

    // 1) 本批概念
    for (const raw of conceptList) {
      const { concept, created } = upsertConcept(raw, source, { stats });
      if (!concept) continue;
      if (created) stats.conceptsAdded += 1;
      else stats.conceptsUpdated += 1;
      remember(concept);
      const key = nameKey(concept.name);
      if (key && !index.has(key)) index.set(key, concept);
    }

    const resolve = (name, { stubOf = '' } = {}) => {
      const key = nameKey(name);
      if (!key) return null;
      const hit = index.get(key) || batch.get(key);
      if (hit) return hit;
      const stubResult = upsertConcept(
        { name: String(name).trim(), summary: stubOf ? `待补全：${stubOf} 的前置概念` : '', kind: 'concept' },
        null,
        { stub: true, stats },
      );
      if (!stubResult.concept) return null;
      batch.set(key, stubResult.concept);
      stats.stubsAdded += 1;
      return stubResult.concept;
    };

    const linkEdge = (from, to, type, extra) => {
      const existed = Boolean(
        conn.prepare('SELECT 1 FROM edges WHERE from_id = ? AND to_id = ? AND type = ?').get(from.id, to.id, type),
      );
      addEdge(from.id, to.id, type, extra);
      if (!existed) stats.edgesAdded += 1;
    };

    // 2) 概念里声明的前置
    for (const raw of conceptList) {
      const target = resolve(raw.name);
      if (!target) continue;
      for (const prereqName of Array.isArray(raw.prereqs) ? raw.prereqs : []) {
        const prereq = resolve(prereqName, { stubOf: target.name });
        if (!prereq || prereq.id === target.id) continue;
        linkEdge(prereq, target, 'prereq', {
          sourceId: source.id,
          quote: Array.isArray(raw.quotes) ? raw.quotes[0] : '',
        });
      }
    }

    // 3) 显式给出的关系
    for (const raw of Array.isArray(extraction.edges) ? extraction.edges : []) {
      const from = resolve(raw.from || raw.source, { stubOf: '关系来源' });
      const to = resolve(raw.to || raw.target, { stubOf: '关系目标' });
      if (!from || !to || from.id === to.id) continue;
      linkEdge(from, to, raw.type || 'related', {
        label: raw.label,
        sourceId: source.id,
        quote: raw.quote || '',
      });
    }

    // 4) 话题记成标签
    const topics = dedupeStrings(extraction.topics, 6, 40);
    if (topics.length) {
      const merged = dedupeStrings([...(source.topics || []), ...topics], 8, 40);
      conn.prepare('UPDATE sources SET topics = ? WHERE id = ?').run(JSON.stringify(merged), source.id);
      source.topics = merged;
    }

    metaSet('updated_at', now());
  });

  return stats;
}

/** 新建或编辑一个知识点（手动） */
export function saveConcept(input = {}) {
  const name = String(input.name || '').trim().slice(0, 80);
  if (!name) throw new Error('知识点名字不能为空');
  const key = nameKey(name);
  const conn = getDb();
  const aliases = dedupeStrings(input.aliases, 8, 60);
  const tags = dedupeStrings(input.tags, 8, 40);
  const summary = String(input.summary ?? '').trim().slice(0, 400);
  const kind = CONCEPT_KINDS.includes(String(input.kind)) ? String(input.kind) : 'concept';

  const byKey = conn.prepare('SELECT * FROM concepts WHERE name_key = ?').get(key);

  if (input.id) {
    const current = conceptRowById(String(input.id));
    if (!current) throw new Error('没有这个知识点');
    if (byKey && byKey.id !== current.id) throw new Error(`已经存在同名知识点「${byKey.name}」，换个名字或先合并`);
    conn
      .prepare(
        'UPDATE concepts SET name = ?, name_key = ?, aliases = ?, summary = ?, kind = ?, tags = ?, stub = 0, manual = 1, updated_at = ? WHERE id = ?',
      )
      .run(
        name,
        key,
        JSON.stringify(aliases),
        summary,
        kind,
        JSON.stringify(tags.length ? tags : jsonParse(current.tags, [])),
        now(),
        current.id,
      );
    metaSet('updated_at', now());
    return getConcept(current.id);
  }

  if (byKey) {
    // 同名：视为编辑已有概念，不新建
    conn
      .prepare('UPDATE concepts SET aliases = ?, summary = ?, kind = ?, tags = ?, stub = 0, manual = 1, updated_at = ? WHERE id = ?')
      .run(
        JSON.stringify(aliases),
        summary || byKey.summary,
        kind,
        JSON.stringify(tags.length ? tags : jsonParse(byKey.tags, [])),
        now(),
        byKey.id,
      );
    metaSet('updated_at', now());
    return getConcept(byKey.id);
  }

  const id = uid('c');
  const stamp = now();
  conn
    .prepare(
      `INSERT INTO concepts (id, name, name_key, aliases, summary, kind, tags, stub, manual, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?)`,
    )
    .run(id, name, key, JSON.stringify(aliases), summary, kind, JSON.stringify(tags), stamp, stamp);
  metaSet('updated_at', now());
  return getConcept(id);
}

export function deleteConcept(conceptId) {
  const id = String(conceptId || '');
  if (!getDb().prepare('SELECT 1 FROM concepts WHERE id = ?').get(id)) return { ok: false, error: '没有这个知识点' };
  tx((conn) => {
    conn.prepare('DELETE FROM concepts WHERE id = ?').run(id);
    conn.prepare('DELETE FROM edges WHERE from_id NOT IN (SELECT id FROM concepts) OR to_id NOT IN (SELECT id FROM concepts)').run();
    metaSet('updated_at', now());
  });
  return { ok: true };
}

/** 删除资料，并清理只属于它的概念与边 */
export function deleteSource(sourceId) {
  const id = String(sourceId || '');
  if (!getDb().prepare('SELECT 1 FROM sources WHERE id = ?').get(id)) return { ok: false, error: '没有这份资料' };

  const removed = tx((conn) => {
    conn.prepare('DELETE FROM sources WHERE id = ?').run(id); // 级联清 refs / concept_sources
    const orphans = conn
      .prepare(
        `SELECT id FROM concepts
         WHERE manual = 0
           AND id NOT IN (SELECT concept_id FROM refs)
           AND id NOT IN (SELECT concept_id FROM concept_sources)`,
      )
      .all();
    const del = conn.prepare('DELETE FROM concepts WHERE id = ?');
    for (const orphan of orphans) del.run(orphan.id);
    conn.prepare('DELETE FROM edges WHERE source_id = ?').run(id);
    conn.prepare('DELETE FROM edges WHERE from_id NOT IN (SELECT id FROM concepts) OR to_id NOT IN (SELECT id FROM concepts)').run();
    metaSet('updated_at', now());
    return orphans.length;
  });

  ftsDelete(id);
  return { ok: true, removedConcepts: removed };
}

export function saveLayout(bucket, positions = {}) {
  const name = bucket === 'mind' ? 'mind' : 'dag';
  tx((conn) => {
    conn.prepare('DELETE FROM layout WHERE bucket = ?').run(name);
    const insert = conn.prepare('INSERT INTO layout (bucket, concept_id, x, y) VALUES (?, ?, ?, ?)');
    for (const [conceptId, pos] of Object.entries(positions || {})) {
      const x = Number(pos?.x);
      const y = Number(pos?.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      insert.run(name, String(conceptId), x, y);
    }
    metaSet('updated_at', now());
  });
  return { ok: true };
}

export function saveView(view = {}) {
  const current = jsonParse(metaGet('view', ''), null) || { mode: 'dag', selectedId: '', rootId: '' };
  const next = {
    mode: ['dag', 'mind', 'star'].includes(view.mode) ? view.mode : 'dag',
    selectedId: String(view.selectedId || ''),
    rootId: String(view.rootId || ''),
  };
  metaSet('view', JSON.stringify({ ...current, ...next }));
  return next;
}

export function clearLibrary() {
  tx((conn) => {
    conn.exec(`
      DELETE FROM refs;
      DELETE FROM concept_sources;
      DELETE FROM edges;
      DELETE FROM concepts;
      DELETE FROM sources;
      DELETE FROM layout;
      DELETE FROM meta WHERE key IN ('view', 'updated_at');
    `);
    if (ftsTableExists()) conn.exec('DELETE FROM source_fts');
  });
  return { ok: true };
}

/* ---------------------------------- 检索 ---------------------------------- */

const trigrams = (text) => {
  const chars = [...String(text)];
  const out = [];
  for (let i = 0; i + 3 <= chars.length; i += 1) out.push(chars.slice(i, i + 3).join(''));
  return [...new Set(out)];
};

const likePattern = (query) => `%${String(query).replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

/** 在原文里截一段命中上下文（FTS 只做粗筛，片段在应用层生成，中文更直观） */
export function snippetOf(text, query, span = 48) {
  const src = String(text || '');
  const needle = String(query || '').split(/\s+/).filter(Boolean)[0] || String(query || '');
  if (!needle) return src.slice(0, span * 2).replace(/\s+/g, ' ');
  const idx = src.toLowerCase().indexOf(needle.toLowerCase());
  if (idx < 0) return src.slice(0, span * 2).replace(/\s+/g, ' ');
  const start = Math.max(0, idx - span);
  const end = Math.min(src.length, idx + needle.length + span);
  const head = src.slice(start, idx).replace(/\s+/g, ' ');
  const tail = src.slice(idx + needle.length, end).replace(/\s+/g, ' ');
  return `${start > 0 ? '…' : ''}${head}【${src.slice(idx, idx + needle.length)}】${tail}${end < src.length ? '…' : ''}`;
}

/**
 * 统一检索：概念 + 资料正文。
 * 资料检索默认 LIKE；FTS 打开且查询 >= 3 字符时先粗筛再精确校验，粗筛无果自动回退 LIKE。
 */
export function searchAll(query, { limit = 20 } = {}) {
  const q = String(query || '').trim();
  if (!q) return { query: q, mode: 'none', concepts: [], sources: [] };
  const conn = getDb();
  const pattern = likePattern(q);

  const conceptRows = conn
    .prepare(
      `SELECT * FROM concepts
       WHERE name LIKE ? ESCAPE '\\' OR summary LIKE ? ESCAPE '\\' OR aliases LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\'
       ORDER BY (CASE WHEN name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END), length(name) ASC
       LIMIT ?`,
    )
    .all(pattern, pattern, pattern, pattern, pattern, limit * 2);

  const concepts = conceptRows.map((row) => {
    const concept = rowToConcept(row);
    concept.refs = conn
      .prepare('SELECT source_id, quote, at FROM refs WHERE concept_id = ? ORDER BY at')
      .all(row.id)
      .map((r) => ({ sourceId: r.source_id, quote: r.quote, at: r.at }));
    concept.sourceIds = conn.prepare('SELECT source_id FROM concept_sources WHERE concept_id = ?').all(row.id).map((r) => r.source_id);
    return concept;
  });

  let mode = 'like';
  let sourceRows = [];

  if (isFtsEnabled() && [...q].length >= 3) {
    const grams = trigrams(q);
    const match = grams.map((gram) => `"${gram.replace(/"/g, '""')}"`).join(' AND ');
    let candidates = [];
    try {
      candidates = conn
        .prepare('SELECT ref FROM source_fts WHERE source_fts MATCH ? LIMIT ?')
        .all(match, FTS_MAX_CANDIDATES)
        .map((row) => row.ref);
    } catch {
      candidates = [];
    }
    if (candidates.length) {
      const needle = q.toLowerCase();
      const lookup = conn.prepare('SELECT * FROM sources WHERE id = ?');
      const hits = [];
      for (const ref of candidates) {
        const row = lookup.get(ref);
        if (!row) continue;
        if (!String(row.text || '').toLowerCase().includes(needle) && !String(row.title || '').toLowerCase().includes(needle)) continue;
        hits.push(row);
        if (hits.length >= limit) break;
      }
      if (hits.length) {
        mode = 'fts';
        sourceRows = hits;
      }
    }
  }

  if (!sourceRows.length) {
    sourceRows = conn
      .prepare(
        `SELECT * FROM sources WHERE text LIKE ? ESCAPE '\\' OR title LIKE ? ESCAPE '\\' ORDER BY added_at DESC LIMIT ?`,
      )
      .all(pattern, pattern, limit);
  }

  const sources = sourceRows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    url: row.url,
    addedAt: row.added_at,
    chars: row.chars,
    snippet: snippetOf(row.text || row.title, q),
  }));

  return { query: q, mode, concepts, sources, fts: isFtsEnabled() };
}

/* ------------------------------- 迁移 / 导出 ------------------------------- */

function insertSourceRow(source) {
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO sources (id, kind, title, url, text, excerpt, chars, asset_path, topics, meta, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      String(source.id || uid('s')),
      String(source.kind || 'text'),
      String(source.title || '未命名资料').slice(0, 200),
      String(source.url || ''),
      String(source.text || '').slice(0, 400000),
      String(source.excerpt || '').slice(0, 240),
      Number(source.chars) || String(source.text || '').length,
      String(source.assetPath || ''),
      JSON.stringify(Array.isArray(source.topics) ? source.topics : []),
      JSON.stringify(source.meta && typeof source.meta === 'object' ? source.meta : {}),
      String(source.addedAt || now()),
    );
}

/** 把旧版 library.json 的结构整体导入（迁移与恢复都用它） */
export function importLibrary(lib = {}) {
  const counts = { sources: 0, concepts: 0, edges: 0 };
  tx((conn) => {
    for (const source of Array.isArray(lib.sources) ? lib.sources : []) {
      if (!source?.id) continue;
      insertSourceRow(source);
      counts.sources += 1;
    }
    for (const concept of Array.isArray(lib.concepts) ? lib.concepts : []) {
      const name = String(concept?.name || '').trim();
      const key = nameKey(name);
      if (!name || !key) continue;
      const id = String(concept.id || uid('c'));
      conn
        .prepare(
          `INSERT OR REPLACE INTO concepts (id, name, name_key, aliases, summary, kind, tags, stub, manual, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          name.slice(0, 80),
          key,
          JSON.stringify(Array.isArray(concept.aliases) ? concept.aliases.slice(0, 8) : []),
          String(concept.summary || '').slice(0, 400),
          CONCEPT_KINDS.includes(String(concept.kind)) ? String(concept.kind) : 'concept',
          JSON.stringify(Array.isArray(concept.tags) ? concept.tags.slice(0, 8) : []),
          concept.stub ? 1 : 0,
          concept.manual ? 1 : 0,
          String(concept.createdAt || now()),
          String(concept.updatedAt || now()),
        );
      counts.concepts += 1;
      for (const sourceId of Array.isArray(concept.sourceIds) ? concept.sourceIds : []) {
        if (conn.prepare('SELECT 1 FROM sources WHERE id = ?').get(sourceId)) linkSource(id, sourceId);
      }
      for (const ref of Array.isArray(concept.refs) ? concept.refs : []) {
        if (!ref?.sourceId || !ref?.quote) continue;
        if (!conn.prepare('SELECT 1 FROM sources WHERE id = ?').get(ref.sourceId)) continue;
        conn
          .prepare('INSERT OR IGNORE INTO refs (concept_id, source_id, quote, at) VALUES (?, ?, ?, ?)')
          .run(id, ref.sourceId, String(ref.quote).slice(0, 400), String(ref.at || now()));
      }
    }
    for (const edge of Array.isArray(lib.edges) ? lib.edges : []) {
      if (!edge?.from || !edge?.to || edge.from === edge.to) continue;
      if (!conn.prepare('SELECT 1 FROM concepts WHERE id = ?').get(edge.from)) continue;
      if (!conn.prepare('SELECT 1 FROM concepts WHERE id = ?').get(edge.to)) continue;
      conn
        .prepare(
          `INSERT OR IGNORE INTO edges (id, from_id, to_id, type, label, source_id, quote, manual)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          String(edge.id || uid('e')),
          edge.from,
          edge.to,
          EDGE_TYPES.includes(String(edge.type)) ? String(edge.type) : 'related',
          String(edge.label || '').slice(0, 40),
          String(edge.sourceId || ''),
          String(edge.quote || '').slice(0, 400),
          edge.manual ? 1 : 0,
        );
      counts.edges += 1;
    }
    for (const bucket of ['dag', 'mind']) {
      const positions = lib.layout?.[bucket] || {};
      const insert = conn.prepare('INSERT OR REPLACE INTO layout (bucket, concept_id, x, y) VALUES (?, ?, ?, ?)');
      for (const [conceptId, pos] of Object.entries(positions)) {
        if (!Number.isFinite(Number(pos?.x)) || !Number.isFinite(Number(pos?.y))) continue;
        insert.run(bucket, conceptId, Number(pos.x), Number(pos.y));
      }
    }
    if (lib.view && typeof lib.view === 'object') metaSet('view', JSON.stringify(lib.view));
    metaSet('updated_at', now());
  });
  if (isFtsEnabled()) rebuildFts();
  return counts;
}

/** 启动时把旧版 data/library.json 迁到 SQLite（迁完把原文件改名留档） */
export function migrateLegacyJson() {
  const conn = getDb();
  if (!fs.existsSync(LEGACY_JSON_PATH)) return null;
  if (conn.prepare('SELECT COUNT(*) c FROM sources').get().c > 0) return null; // 库里已有数据，不动
  let legacy;
  try {
    legacy = JSON.parse(fs.readFileSync(LEGACY_JSON_PATH, 'utf8'));
  } catch (err) {
    return { ok: false, error: `旧库 library.json 解析失败：${err.message}` };
  }
  if (!legacy || !Array.isArray(legacy.sources)) return { ok: false, error: '旧库结构不认识' };
  const counts = importLibrary(legacy);
  const backup = path.join(DATA_DIR, `library.legacy-${Date.now()}.json`);
  try {
    fs.renameSync(LEGACY_JSON_PATH, backup);
  } catch {
    /* 改名失败不影响迁移结果 */
  }
  return { ok: true, ...counts, backup };
}

/** 导出成旧版 JSON 结构（备份 / 迁移 / 换机器用，含资料全文） */
export function exportLibraryJson() {
  const lib = loadLibrary();
  const conn = getDb();
  const textOf = conn.prepare('SELECT text FROM sources WHERE id = ?');
  lib.sources = lib.sources.map((source) => ({ ...source, text: textOf.get(source.id)?.text || '' }));
  return lib;
}

/* ---------------------------------- 素材 ---------------------------------- */

/** 保存图片素材（视觉模型识别不出来时至少留个原件可查） */
export function saveAsset(filename, base64) {
  fs.mkdirSync(ASSET_DIR, { recursive: true });
  const ext = path.extname(String(filename || '')).toLowerCase();
  const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(ext) ? ext : '.png';
  const name = `img_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}${safeExt}`;
  const target = path.join(ASSET_DIR, name);
  fs.writeFileSync(target, Buffer.from(String(base64 || ''), 'base64'));
  return path.relative(DATA_DIR, target).split(path.sep).join('/');
}

export { GRAPHS_DIR, ASSET_DIR, LEGACY_JSON_PATH, LEGACY_DB_PATH };
