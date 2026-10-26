/**
 * 论文获取：支持 arXiv ID / abs 链接，抓到标题、摘要，尽量抓 HTML 全文。
 * 不做 PDF 解析（浏览器侧用 pdf.js 更准），这里只处理 arXiv 的两个 HTML 端点。
 */

const UA = 'PaperLens/1.0 (+local reader; contact: local-user)';

export function parseArxivId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const modern = raw.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  if (modern) return modern[1] + (modern[2] || '');
  const legacy = raw.match(/([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i);
  if (legacy) return legacy[1] + (legacy[2] || '');
  return null;
}

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml' },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`${url} 返回 ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(html) {
  return decodeEntities(
    String(html)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<math[\s\S]*?<\/math>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/[ \t\u00a0]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
}

function safeChar(code) {
  try {
    return String.fromCodePoint(code);
  } catch {
    return '';
  }
}

/** 从 arXiv HTML 正文里按小节切段，丢掉参考文献等噪音 */
function extractHtmlBody(html) {
  const bodyMatch = html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<body[\s\S]*?<\/body>/i);
  const scope = bodyMatch ? bodyMatch[0] : html;

  const chunks = [];
  const blockRe = /<(h[1-6]|p|li|figcaption)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  while ((m = blockRe.exec(scope)) !== null) {
    const tag = m[1].toLowerCase();
    const text = stripTags(m[2]);
    if (!text || text.length < 2) continue;
    if (/^(references|bibliography|acknowledg)/i.test(text) && tag.startsWith('h')) break;
    // 跳过 arXiv HTML 里的许可声明、图片版权声明等噪音
    if (/proper attribution is provided|hereby grants permission|licensed under a creative commons|reproduce the tables and figures/i.test(text)) continue;
    chunks.push(tag.startsWith('h') ? `\n${text}` : text);
    if (chunks.join('\n').length > 60000) break;
  }
  return chunks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

export async function fetchArxivPaper(input) {
  const id = parseArxivId(input);
  if (!id) throw new Error('没能识别 arXiv 编号，示例：2401.12345 或 https://arxiv.org/abs/2401.12345');

  const absUrl = `https://arxiv.org/abs/${id}`;
  let absHtml;
  try {
    absHtml = await fetchText(absUrl);
  } catch (err) {
    if (/返回 404/.test(err.message)) throw new Error(`arXiv 上没有找到 ${id}，编号可能有误`);
    throw new Error(`抓取 arXiv 失败：${err.message}（需要能访问 arxiv.org）`);
  }

  const titleMatch =
    absHtml.match(/<h1 class="title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || absHtml.match(/<meta name="citation_title" content="([^"]+)"/i);
  const title = titleMatch ? stripTags(titleMatch[1]).replace(/^Title:\s*/i, '') : `arXiv:${id}`;

  const absMatch =
    absHtml.match(/<blockquote class="abstract[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/i) ||
    absHtml.match(/<meta name="citation_abstract" content="([\s\S]*?)"\s*\/?>/i) ||
    absHtml.match(/<meta property="og:description" content="([\s\S]*?)"\s*\/?>/i);
  const abstract = absMatch ? stripTags(absMatch[1]).replace(/^Abstract:\s*/i, '') : '';

  let body = '';
  for (const url of [`https://arxiv.org/html/${id}`, `https://arxiv.org/html/${id.replace(/v\d+$/, '')}`]) {
    try {
      const html = await fetchText(url, 25000);
      const extracted = extractHtmlBody(html);
      if (extracted.length > 1200) {
        body = extracted;
        break;
      }
    } catch {
      /* 该论文没有 HTML 版本，继续 */
    }
  }

  // arXiv HTML 正文本身包含 Abstract 段，避免和抓到的摘要重复
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ');
  const bodyHead = norm(body.slice(0, 600));
  const abstractAlreadyInBody = abstract && bodyHead.includes(norm(abstract.slice(0, 60)));

  const text = body
    ? `${abstractAlreadyInBody ? '' : `摘要\n${abstract}\n\n`}${body}`
    : `摘要\n${abstract}\n\n（未能获取 arXiv HTML 全文，可能该论文尚未提供 HTML 版本。请在左侧直接粘贴论文正文，或上传 PDF。）`;

  return {
    title,
    text: text.trim(),
    source: absUrl,
    full_text: Boolean(body),
  };
}
