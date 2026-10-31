/**
 * 论文库：单机 SQLite 存储（Node 内置 node:sqlite）。
 *
 * 与知识图谱的「一图一库」分开：一篇论文可以被推送到多个图谱，
 * 精读结果也不应该因为切换图谱而消失，所以论文库是跨图谱的独立库。
 *
 *   <DATA_DIR>/papers.db        论文正文 / 精读 / 结构化 / 追问
 *   <DATA_DIR>/papers/<id>.pdf  PDF 原件（可选）
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../shared/config.mjs';

const DB_PATH = path.join(DATA_DIR, 'papers.db');
const PDF_DIR = path.join(DATA_DIR, 'papers');

let sqlite;
try {
  sqlite = await import('node:sqlite');
} catch {
  throw new Error(
    `需要 Node >= 22.5 才能使用内置 SQLite（node:sqlite），当前是 ${process.version}。升级 Node 后再启动。`,
  );
}
const { DatabaseSync } = sqlite;

const uid = () => `p_${crypto.randomBytes(5).toString('hex')}`;
const now = () => new Date().toISOString();

let db = null;

function getDb() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;

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
  `);
  return db;
}

const safeJson = (text, fallback) => {
  try {
    return JSON.parse(text) ?? fallback;
  } catch {
    return fallback;
  }
};

function toSummary(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    kind: row.kind,
    chars: row.chars,
    hasPdf: Boolean(row.pdf_path),
    hasReading: Boolean(String(row.reading_md || '').trim()),
    readingModel: row.reading_model,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPaper(row) {
  if (!row) return null;
  return {
    ...toSummary(row),
    text: row.text,
    reading_md: row.reading_md,
    reading_model: row.reading_model,
    structure: safeJson(row.structure_json, null),
    ask_thread: safeJson(row.ask_json, []),
  };
}

export function listPapers(limit = 200) {
  const rows = getDb()
    .prepare(
      `SELECT id, title, source, kind, chars, pdf_path, reading_md, reading_model, created_at, updated_at
       FROM papers ORDER BY updated_at DESC LIMIT ?`,
    )
    .all(Number(limit) || 200);
  return rows.map(toSummary);
}

export function getPaper(id) {
  if (!id) return null;
  return toPaper(getDb().prepare('SELECT * FROM papers WHERE id = ?').get(String(id)));
}

/**
 * 新建或更新。
 * 新论文（没有 id 或 id 不存在）生成 id；更新时只覆盖 patch 里出现的字段。
 */
export function savePaper(patch = {}) {
  const conn = getDb();
  const existing = patch.id ? getPaper(patch.id) : null;
  const id = existing?.id || uid();
  const stamp = now();

  const text = patch.text !== undefined ? String(patch.text || '') : existing?.text || '';
  const merged = {
    id,
    title: patch.title !== undefined ? String(patch.title || '').trim().slice(0, 300) : existing?.title || '',
    source: patch.source !== undefined ? String(patch.source || '').trim() : existing?.source || '',
    kind: patch.kind !== undefined ? String(patch.kind || 'text') : existing?.kind || 'text',
    text,
    chars: text.length,
    pdf_path: existing?.pdf_path || '',
    reading_md:
      patch.reading_md !== undefined ? String(patch.reading_md || '') : existing?.reading_md || '',
    reading_model:
      patch.reading_model !== undefined ? String(patch.reading_model || '') : existing?.reading_model || '',
    structure_json: JSON.stringify(
      patch.structure !== undefined ? patch.structure || null : existing?.structure ?? null,
    ),
    ask_json: JSON.stringify(
      patch.ask_thread !== undefined ? patch.ask_thread || [] : existing?.ask_thread || [],
    ),
    created_at: existing?.createdAt || stamp,
    updated_at: stamp,
  };

  conn
    .prepare(
      `INSERT INTO papers (id, title, source, kind, text, chars, pdf_path, reading_md, reading_model, structure_json, ask_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, source=excluded.source, kind=excluded.kind, text=excluded.text,
         chars=excluded.chars, pdf_path=excluded.pdf_path, reading_md=excluded.reading_md,
         reading_model=excluded.reading_model, structure_json=excluded.structure_json,
         ask_json=excluded.ask_json, updated_at=excluded.updated_at`,
    )
    .run(
      merged.id,
      merged.title,
      merged.source,
      merged.kind,
      merged.text,
      merged.chars,
      merged.pdf_path,
      merged.reading_md,
      merged.reading_model,
      merged.structure_json,
      merged.ask_json,
      merged.created_at,
      merged.updated_at,
    );

  return toSummary(getDb().prepare('SELECT * FROM papers WHERE id = ?').get(id));
}

/** 保存 PDF 原件；返回可访问的相对路径 */
export function savePdf(id, base64) {
  if (!id) throw new Error('缺少论文 id');
  const raw = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!raw) throw new Error('没有收到 PDF 数据');
  fs.mkdirSync(PDF_DIR, { recursive: true });
  const target = path.join(PDF_DIR, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.pdf`);
  fs.writeFileSync(target, Buffer.from(raw, 'base64'));
  getDb().prepare('UPDATE papers SET pdf_path = ?, updated_at = ? WHERE id = ?').run(target, now(), id);
  return target;
}

export function getPdfPath(id) {
  const paper = getPaper(id);
  if (!paper?.hasPdf) return '';
  const target = path.join(PDF_DIR, path.basename(paper.pdf_path || `${id}.pdf`));
  return fs.existsSync(target) ? target : '';
}

export function deletePaper(id) {
  if (!id) return { ok: false };
  const paper = getPaper(id);
  if (paper?.hasPdf) {
    try {
      fs.unlinkSync(paper.pdf_path);
    } catch {
      /* 文件不在就算了 */
    }
  }
  const result = getDb().prepare('DELETE FROM papers WHERE id = ?').run(String(id));
  return { ok: result.changes > 0, id };
}

export function paperCount() {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM papers').get();
  return Number(row?.n || 0);
}
