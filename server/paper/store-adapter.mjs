/**
 * 翻译页的「旧接口」适配层：/api/store/*
 *
 * 这些路径原本指向 .cache/papertrans.sqlite（projects / pdfs / kv），
 * 现在全部落到论文库 papers.db —— project id 就是 paperId，
 * 所以翻译页不需要改任何存储调用，旧书签与旧前端也照样能用。
 */
import fs from 'node:fs';
import path from 'node:path';

import { HttpError, readBody, readBuffer, sendJson, serveFile } from '../shared/http.mjs';
import { getDb, getPref, setPref } from './db.mjs';
import {
  deletePaper,
  ensurePaper,
  getPaper,
  getPdfName,
  getPdfPath,
  listPapers,
  mergeTranslations,
  paperStats,
  savePdfBuffer,
  touchPaper,
} from './library.mjs';

const PREFS_KEY = 'translate.prefs';
const LAST_KEY = 'translate.last';

const ok = (res, extra = {}) => sendJson(res, 200, { ok: true, ...extra });

/** 历史列表：字段与原 projects 摘要保持一致，前端一个字都不用改 */
function toLegacyRow(paper) {
  const name = paper.pdfName
    ? decodeURIComponent(paper.pdfName.replace(/\.pdf$/i, ''))
    : paper.title || '未命名文档';
  return {
    id: paper.id,
    name: paper.title || name,
    pages: paper.pages || 0,
    translations: paper.trCount || 0,
    updatedAt: paper.updatedAt,
    hasPdf: paper.hasPdf,
    hasReading: paper.hasReading,
    hasBlocks: paper.hasBlocks,
  };
}

/** 工程数据：{ name, overrides, translations, savedAt, pages, chars } */
function toLegacyProject(paper) {
  return {
    name: paper.title || '',
    pages: paper.pages || 0,
    chars: paper.chars || 0,
    overrides: paper.segOverrides || {},
    translations: paper.translations || [],
    savedAt: Date.parse(paper.updatedAt) || 0,
  };
}

export async function handleStoreApi(req, res, url) {
  const { pathname } = url;
  const { method } = req;

  if (method === 'GET' && pathname === '/api/store/stats') {
    sendJson(res, 200, paperStats());
    return true;
  }

  if (pathname === '/api/store/prefs') {
    if (method === 'GET') {
      sendJson(res, 200, { prefs: getPref(PREFS_KEY) || {} });
      return true;
    }
    if (method === 'PUT') {
      const { prefs } = await readBody(req);
      if (!prefs || typeof prefs !== 'object' || Array.isArray(prefs)) throw new HttpError(400, 'prefs 不合法');
      setPref(PREFS_KEY, prefs);
      ok(res);
      return true;
    }
  }

  if (pathname === '/api/store/last') {
    if (method === 'GET') {
      sendJson(res, 200, { id: getPref(LAST_KEY) || '' });
      return true;
    }
    if (method === 'PUT') {
      const { id } = await readBody(req);
      if (!id) throw new HttpError(400, '缺少 id');
      setPref(LAST_KEY, String(id));
      ok(res);
      return true;
    }
    if (method === 'DELETE') {
      setPref(LAST_KEY, '');
      ok(res);
      return true;
    }
  }

  if (method === 'POST' && pathname === '/api/store/migrate') {
    // 浏览器旧数据迁移在 papertrans 阶段已完成；这里保留接口，避免前端报错
    ok(res, { moved: { prefs: 0, overrides: 0, projects: 0 } });
    return true;
  }

  if (method === 'GET' && pathname === '/api/store/projects') {
    sendJson(res, 200, { projects: listPapers().map(toLegacyRow) });
    return true;
  }

  const match = pathname.match(/^\/api\/store\/project\/([^/]+)(\/pdf|\/touch)?$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const kind = match[2] || '';

    if (kind === '/touch' && method === 'POST') {
      touchPaper(id);
      ok(res);
      return true;
    }

    if (kind === '/pdf') {
      if (method === 'GET') {
        const file = getPdfPath(id);
        if (!file) throw new HttpError(404, '这篇论文没有 PDF');
        const paper = getPaper(id);
        const fileName = path.basename(paper?.title ? `${paper.title}.pdf` : getPdfName(id) || 'document.pdf');
        res.setHeader('X-Papertrans-Name', encodeURIComponent(fileName));
        serveFile(res, file);
        return true;
      }
      if (method === 'PUT') {
        const buf = await readBuffer(req);
        if (!buf.length) throw new HttpError(400, '没有收到 PDF 数据');
        ensurePaper(id, { title: String(url.searchParams.get('name') || '').replace(/\.pdf$/i, '') });
        savePdfBuffer(id, buf, { name: String(url.searchParams.get('name') || '') });
        ok(res, { bytes: buf.length });
        return true;
      }
      if (method === 'DELETE') {
        const paper = getPaper(id);
        if (paper?.pdf_path) {
          try {
            fs.unlinkSync(paper.pdf_path);
          } catch {
            /* 文件不在就算了 */
          }
        }
        ok(res);
        return true;
      }
    }

    if (method === 'GET' && !kind) {
      const paper = getPaper(id);
      sendJson(res, 200, { project: paper ? toLegacyProject(paper) : null });
      return true;
    }

    if (method === 'PUT' && !kind) {
      const body = await readBody(req);
      const project = body?.project;
      if (!project || typeof project !== 'object' || Array.isArray(project)) {
        throw new HttpError(400, 'project 不合法');
      }
      ensurePaper(id, { title: String(project.name || ''), kind: 'pdf' });
      if (Array.isArray(project.translations)) {
        mergeTranslations(id, project.translations, { replace: true });
      }
      const conn = getDb();
      conn
        .prepare('UPDATE papers SET title = ?, pages = ?, chars = ?, seg_overrides_json = ?, updated_at = ? WHERE id = ?')
        .run(
          String(project.name || '').slice(0, 300),
          Number(project.pages || 0),
          Number(project.chars || 0),
          JSON.stringify(project.overrides || {}),
          new Date().toISOString(),
          id,
        );
      ok(res);
      return true;
    }

    if (method === 'DELETE' && !kind) {
      sendJson(res, 200, { ok: true, ...deletePaper(id) });
      return true;
    }
  }

  return false;
}
