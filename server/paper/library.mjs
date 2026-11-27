/**
 * 论文库：正文 / PDF / 分块 / 译文 / 精读 / 结构化 / 追问，一行管到底。
 *
 * 分块（blocks_json）是 PDF 与概念定位的唯一真相：翻译页抽出来的块，
 * 精读页的 PDF 视图直接消费同一份，所以「点概念高亮的那块」就是「翻译卡片里那段」。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getDb, safeJson, PDF_DIR, dbPath } from './db.mjs';

const uid = () => `p_${crypto.randomBytes(5).toString('hex')}`;
const now = () => new Date().toISOString();

const LIST_COLUMNS = `id, title, source, kind, chars, pages, pdf_path, pdf_hash, reading_md,
  reading_model, blocks_json, tr_count, updated_at, created_at`;

function parseBlocks(text) {
  if (!text) return null;
  const parsed = safeJson(text, null);
  if (!parsed || !Array.isArray(parsed.blocks)) return null;
  return parsed;
}

function toSummary(row) {
  if (!row) return null;
  const blocks = parseBlocks(row.blocks_json);
  return {
    id: row.id,
    title: row.title,
    source: row.source,
    kind: row.kind,
    chars: row.chars,
    pages: Number(row.pages || 0),
    hasPdf: Boolean(row.pdf_path) && fs.existsSync(row.pdf_path),
    hasReading: Boolean(String(row.reading_md || '').trim()),
    hasBlocks: Boolean(blocks && blocks.blocks.length),
    blocksCount: blocks ? blocks.blocks.length : 0,
    trCount: Number(row.tr_count || 0),
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
    usage: safeJson(row.usage_json, null),
    paperUsage: safeJson(row.paper_usage_json, null),
    outline: safeJson(row.outline_json, null),
    pdf_path: row.pdf_path || '',
    pdfName: row.pdf_path ? path.basename(row.pdf_path) : '',
    blocks: parseBlocks(row.blocks_json),
    segOverrides: safeJson(row.seg_overrides_json, null),
    translations: safeJson(row.tr_json, []),
    trEngine: row.tr_engine || '',
  };
}

export function listPapers(limit = 200) {
  const rows = getDb()
    .prepare(`SELECT ${LIST_COLUMNS} FROM papers ORDER BY updated_at DESC LIMIT ?`)
    .all(Number(limit) || 200);
  return rows.map(toSummary);
}

export function getPaper(id) {
  if (!id) return null;
  return toPaper(getDb().prepare('SELECT * FROM papers WHERE id = ?').get(String(id)));
}

export function findByHash(hash) {
  const key = String(hash || '').trim();
  if (!key) return null;
  return toPaper(getDb().prepare('SELECT * FROM papers WHERE pdf_hash = ? LIMIT 1').get(key));
}

/**
 * 新建或更新。新论文（没有 id 或 id 不存在）生成 id；更新时只覆盖 patch 里出现的字段。
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
    usage_json: JSON.stringify(
      patch.usage !== undefined ? patch.usage || null : existing?.usage ?? null,
    ),
    paper_usage_json: JSON.stringify(
      patch.paperUsage !== undefined ? patch.paperUsage || null : existing?.paperUsage ?? null,
    ),
    outline_json: JSON.stringify(
      patch.outline !== undefined ? patch.outline || null : existing?.outline ?? null,
    ),
    created_at: existing?.createdAt || stamp,
    updated_at: stamp,
  };

  conn
    .prepare(
      `INSERT INTO papers (id, title, source, kind, text, chars, pdf_path, reading_md, reading_model, structure_json, ask_json, usage_json, paper_usage_json, outline_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title=excluded.title, source=excluded.source, kind=excluded.kind, text=excluded.text,
         chars=excluded.chars, pdf_path=excluded.pdf_path, reading_md=excluded.reading_md,
         reading_model=excluded.reading_model, structure_json=excluded.structure_json,
         ask_json=excluded.ask_json, usage_json=excluded.usage_json,
         paper_usage_json=excluded.paper_usage_json,
         outline_json=excluded.outline_json, updated_at=excluded.updated_at`,
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
      merged.usage_json,
      merged.paper_usage_json,
      merged.outline_json,
      merged.created_at,
      merged.updated_at,
    );

  return getPaper(id);
}

/** 保证记录存在（翻译页打开 PDF 时先建一行） */
export function ensurePaper(id, { title = '', source = '', kind = 'pdf' } = {}) {
  const conn = getDb();
  const stamp = now();
  const existing = conn.prepare('SELECT id FROM papers WHERE id = ?').get(String(id));
  if (existing) return id;
  conn
    .prepare(
      `INSERT INTO papers (id, title, source, kind, text, chars, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', 0, ?, ?)`,
    )
    .run(String(id), String(title).slice(0, 300), String(source), String(kind), stamp, stamp);
  return String(id);
}

export function touchPaper(id) {
  getDb().prepare('UPDATE papers SET updated_at = ? WHERE id = ?').run(now(), String(id));
}

/* --------------------------------- PDF ---------------------------------- */

const pdfFileName = (id) => `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}.pdf`;

/** 写入 PDF 字节；返回落盘路径 */
export function savePdfBuffer(id, buffer, { name = '', hash = '' } = {}) {
  if (!id) throw new Error('缺少论文 id');
  if (!buffer || !buffer.length) throw new Error('没有收到 PDF 数据');
  fs.mkdirSync(PDF_DIR, { recursive: true });
  const target = path.join(PDF_DIR, pdfFileName(id));
  fs.writeFileSync(target, buffer);
  getDb()
    .prepare('UPDATE papers SET pdf_path = ?, pdf_hash = ?, updated_at = ? WHERE id = ?')
    .run(target, String(hash || ''), now(), String(id));
  if (name) {
    getDb()
      .prepare("UPDATE papers SET title = CASE WHEN title = '' THEN ? ELSE title END WHERE id = ?")
      .run(String(name).replace(/\.pdf$/i, '').slice(0, 300), String(id));
  }
  return target;
}

/** 兼容旧接口：base64 上传 */
export function savePdf(id, base64, opts = {}) {
  const raw = String(base64 || '').replace(/^data:[^;]+;base64,/, '');
  if (!raw) throw new Error('没有收到 PDF 数据');
  return savePdfBuffer(id, Buffer.from(raw, 'base64'), opts);
}

export function setPdfMeta(id, { name = '', hash = '', pages = 0 } = {}) {
  const conn = getDb();
  if (name) {
    const target = path.join(PDF_DIR, pdfFileName(id));
    if (fs.existsSync(target)) {
      const renamed = path.join(PDF_DIR, `${String(id).replace(/[^a-zA-Z0-9_-]/g, '')}__${name.replace(/[^\w.\-]+/g, '_')}`);
      try {
        fs.renameSync(target, renamed);
        conn.prepare('UPDATE papers SET pdf_path = ? WHERE id = ?').run(renamed, String(id));
      } catch {
        /* 改名失败就保留原名 */
      }
    }
  }
  if (hash) conn.prepare('UPDATE papers SET pdf_hash = ? WHERE id = ?').run(String(hash), String(id));
  if (pages) conn.prepare('UPDATE papers SET pages = ? WHERE id = ?').run(Number(pages), String(id));
}

export function getPdfPath(id) {
  const paper = getPaper(id);
  if (!paper?.pdf_path) return '';
  const target = path.join(PDF_DIR, path.basename(paper.pdf_path));
  return fs.existsSync(target) ? target : '';
}

export function getPdfName(id) {
  const paper = getPaper(id);
  return paper?.pdfName || 'document.pdf';
}

/* ------------------------------- 分块 / 译文 ------------------------------ */

/** 写分块：blocks 由翻译页的 extract.mjs 产出，精读页直接消费 */
export function setBlocks(id, { blocks, hash = '', overrides = undefined, generator = '' } = {}) {
  if (!id || !Array.isArray(blocks)) throw new Error('缺少分块数据');
  const payload = JSON.stringify({ hash: String(hash || ''), generator: String(generator || ''), blocks });
  const conn = getDb();
  const stamp = now();
  if (overrides === undefined) {
    conn
      .prepare('UPDATE papers SET blocks_json = ?, blocks_hash = ?, blocks_at = ?, updated_at = ? WHERE id = ?')
      .run(payload, String(hash || ''), stamp, stamp, String(id));
  } else {
    conn
      .prepare(
        `UPDATE papers SET blocks_json = ?, blocks_hash = ?, blocks_at = ?, seg_overrides_json = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(payload, String(hash || ''), stamp, JSON.stringify(overrides || null), stamp, String(id));
  }
  return getPaper(id)?.blocks;
}

/** 增量写译文：按原文文本为 key，重排版 / 重分段都不会丢 */
export function mergeTranslations(id, items, { engine = '', replace = false } = {}) {
  if (!id) throw new Error('缺少论文 id');
  if (!Array.isArray(items)) throw new Error('译文格式不正确');
  const conn = getDb();
  const paper = getPaper(id);
  if (!paper) throw new Error('没有这篇论文');
  const map = new Map();
  if (!replace) for (const it of paper.translations || []) if (it?.text) map.set(it.text, it.zh);
  for (const it of items) {
    const text = String(it?.text || '');
    const zh = String(it?.zh ?? '');
    if (!text) continue;
    if (zh) map.set(text, zh);
    else map.delete(text);
  }
  const list = [...map].map(([text, zh]) => ({ text, zh }));
  conn
    .prepare('UPDATE papers SET tr_json = ?, tr_count = ?, tr_engine = ?, updated_at = ? WHERE id = ?')
    .run(JSON.stringify(list), list.length, String(engine || paper.trEngine || ''), now(), String(id));
  return { trCount: list.length };
}

export function deletePaper(id) {
  if (!id) return { ok: false };
  // 删论文是不可逆操作，留一行日志：出问题时能对上是谁在什么时候删的
  console.log(`[paper] delete ${id} ${new Date().toISOString()}`);
  const paper = getPaper(id);
  if (paper?.pdf_path) {
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

export function paperStats() {
  const conn = getDb();
  const papers = Number(conn.prepare('SELECT COUNT(*) AS n FROM papers').get()?.n || 0);
  const withPdf = Number(conn.prepare("SELECT COUNT(*) AS n FROM papers WHERE pdf_path <> ''").get()?.n || 0);
  const tr = Number(conn.prepare('SELECT COALESCE(SUM(tr_count), 0) AS n FROM papers').get()?.n || 0);
  const cache = Number(conn.prepare('SELECT COUNT(*) AS n FROM tr_cache').get()?.n || 0);
  const seg = Number(conn.prepare('SELECT COUNT(*) AS n FROM seg_cache').get()?.n || 0);
  return { engine: 'node:sqlite', file: dbPath(), projects: papers, withPdf, translations: tr, cache, segments: seg };
}
