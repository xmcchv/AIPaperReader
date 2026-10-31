/**
 * 论文库 API：/api/paper/{library,get,save,delete,pdf}
 * 与 /api/paper/fetch（arXiv 抓取）区分：这里只管理已保存的论文。
 */
import { HttpError, sendJson, readBody, serveFile } from '../shared/http.mjs';
import { deletePaper, getPaper, getPdfPath, listPapers, savePaper, savePdf } from './library.mjs';

export async function handlePaperApi(req, res, url) {
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/api/paper/library') {
    sendJson(res, 200, { ok: true, papers: listPapers() });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/paper/get') {
    const paper = getPaper(url.searchParams.get('id') || '');
    if (!paper) {
      sendJson(res, 404, { ok: false, error: '没有这篇论文' });
      return true;
    }
    sendJson(res, 200, { ok: true, paper });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/paper/save') {
    const body = await readBody(req);
    const paper = savePaper(body.paper || body);
    sendJson(res, 200, { ok: true, paper });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/paper/delete') {
    const body = await readBody(req);
    sendJson(res, 200, { ok: true, ...deletePaper(String(body.id || '')) });
    return true;
  }

  if (req.method === 'POST' && pathname === '/api/paper/pdf') {
    const body = await readBody(req);
    if (!body.id) throw new HttpError(400, '缺少论文 id');
    savePdf(String(body.id), body.base64);
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (req.method === 'GET' && pathname === '/api/paper/pdf') {
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
