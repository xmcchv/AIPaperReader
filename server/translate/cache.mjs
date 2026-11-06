/**
 * 翻译缓存：译文按「服务 + 地址 + 模型 + 原文」做 key，AI 分段按「模型 + 页内行」做 key。
 * 两张表都在论文库同一个 SQLite 里（papers.db），跨论文复用。
 */
import { getDb, safeJson } from '../paper/db.mjs';

const now = () => Date.now();

export function getTranslation(key) {
  if (!key) return null;
  const row = getDb().prepare('SELECT zh FROM tr_cache WHERE k = ?').get(String(key));
  return row ? row.zh : null;
}

export function setTranslation(key, zh) {
  if (!key || !zh) return;
  getDb()
    .prepare(
      `INSERT INTO tr_cache (k, zh, created_at) VALUES (?, ?, ?)
       ON CONFLICT(k) DO UPDATE SET zh = excluded.zh, created_at = excluded.created_at`,
    )
    .run(String(key), String(zh), now());
}

export function getSegment(key) {
  if (!key) return null;
  const row = getDb().prepare('SELECT data FROM seg_cache WHERE k = ?').get(String(key));
  if (!row) return null;
  const parsed = safeJson(row.data, null);
  return Array.isArray(parsed) ? parsed : null;
}

export function setSegment(key, groups) {
  if (!key) return;
  getDb()
    .prepare(
      `INSERT INTO seg_cache (k, data, created_at) VALUES (?, ?, ?)
       ON CONFLICT(k) DO UPDATE SET data = excluded.data, created_at = excluded.created_at`,
    )
    .run(String(key), JSON.stringify(groups || []), now());
}
