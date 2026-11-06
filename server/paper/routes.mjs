/**
 * 论文库 API
 *   /api/paper/library   列表（侧栏）
 *   /api/paper/get       单篇全量（含分块 / 译文）
 *   /api/paper/save      新建 / 更新（正文、精读、结构化、追问）
 *   /api/paper/open      打开 PDF：按 pdf_hash 去重，命中复用，未命中新建
 *   /api/paper/pdf       GET 下载 / PUT 原始字节 / POST base64（兼容旧前端）
 *   /api/paper/blocks    写分块（翻译页抽块后回写，精读页消费同一份）
 *   /api/paper/translate 增量写译文
 *   /api/paper/stats     存储统计
 * 与 /api/paper/fetch（arXiv 抓取）区分：这里只管理已保存的论文。
 */
import { HttpError, readBody, readBuffer, sendJson, serveFile } from '../shared/http.mjs';
import {
  deletePaper,
  ensurePaper,
  findByHash,
  getPaper,
  getPdfPath,
  listPapers,
  mergeTranslations,
  paperStats,
  savePaper,
  savePdf,
  savePdfBuffer,
  setBlocks,
} from './library.mjs';

export async function handlePaperApi(req, res, url) {
  const pathname = url.pathname;
  const { method } = req;

  if (method === 'GET' && pathname === '/api/paper/library') {
    sendJson(res, 200, { ok: true, papers: listPapers() });
    return true;
  }

  if (method === 'GET' && pathname === '/api/paper/stats') {
    sendJson(res, 200, { ok: true, ...paperStats() });
    return true;
  }

  if (method === 'GET' && pathname === '/api/paper/get') {
    const paper = getPaper(url.searchParams.get('id') || '');
    if (!paper) {
      sendJson(res, 404, { ok: false, error: '没有这篇论文' });
      return true;
    }
    sendJson(res, 200, { ok: true, paper });
    return true;
  }

  if (method === 'POST' && pathname === '/api/paper/save') {
    const body = await readBody(req);
    const paper = savePaper(body.paper || body);
    sendJson(res, 200, { ok: true, paper });
    return true;
  }

  /** 打开 PDF：同一份文件（hash 相同）永远对应同一个 paperId */
  if (method === 'POST' && pathname === '/api/paper/open') {
    const hash = String(url.searchParams.get('hash') || '').trim();
    const name = String(url.searchParams.get('name') || 'document.pdf');
    const hit = hash ? findByHash(hash) : null;
    if (hit) {
      sendJson(res, 200, { ok: true, reused: true, paper: hit });
      return true;
    }
    const buf = await readBuffer(req);
    if (!buf.length) throw new HttpError(400, '没有收到 PDF 数据');
    const created = savePaper({
      title: name.replace(/\.pdf$/i, ''),
      source: name,
      kind: 'pdf',
      text: '',
    });
    savePdfBuffer(created.id, buf, { name, hash });
    sendJson(res, 200, { ok: true, reused: false, paper: getPaper(created.id) });
    return true;
  }

  if (method === 'POST' && pathname === '/api/paper/blocks') {
    const body = await readBody(req);
    const id = String(body.id || '');
    if (!id) throw new HttpError(400, '缺少论文 id');
    ensurePaper(id, { title: body.title || '', kind: 'pdf' });
    const blocks = setBlocks(id, {
      blocks: body.blocks,
      hash: body.hash || '',
      overrides: body.overrides,
      generator: body.generator || '',
    });
    sendJson(res, 200, { ok: true, count: blocks?.blocks?.length || 0 });
    return true;
  }

  if (method === 'POST' && pathname === '/api/paper/translate') {
    const body = await readBody(req);
    const id = String(body.id || '');
    if (!id) throw new HttpError(400, '缺少论文 id');
    ensurePaper(id, { title: body.title || '', kind: 'pdf' });
    const out = mergeTranslations(id, body.items || [], {
      engine: body.engine || '',
      replace: Boolean(body.replace),
    });
    sendJson(res, 200, { ok: true, ...out });
    return true;
  }

  if (method === 'POST' && pathname === '/api/paper/delete') {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, ...deletePaper(String(body.id || '')) });
    return true;
  }

  if (method === 'POST' && pathname === '/api/paper/pdf') {
    const body = await readBody(req);
    if (!body.id) throw new HttpError(400, '缺少论文 id');
    ensurePaper(String(body.id), { title: body.name || '', kind: 'pdf' });
    savePdf(String(body.id), body.base64, { name: body.name || '' });
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (method === 'PUT' && pathname === '/api/paper/pdf') {
    const id = String(url.searchParams.get('id') || '');
    if (!id) throw new HttpError(400, '缺少论文 id');
    ensurePaper(id, { title: String(url.searchParams.get('name') || ''), kind: 'pdf' });
    const buf = await readBuffer(req);
    savePdfBuffer(id, buf, { name: String(url.searchParams.get('name') || '') });
    sendJson(res, 200, { ok: true, bytes: buf.length });
    return true;
  }

  if (method === 'GET' && pathname === '/api/paper/pdf') {
    const file = getPdfPath(url.searchParams.get('id') || '');
    if (!file) {
      sendJson(res, 404, { ok: false, error: '这篇论文没有保存 PDF' });
      return true;
    }
    serveFile(res, file);
    return true;
  }

  return false;
}
