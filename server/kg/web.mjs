/**
 * 网页 / arXiv 抓取：拿到"能抽概念的正文"，不是原文 HTML。
 *
 * 只用 Node 内置 fetch。中文站点常见 GBK 编码，按 Content-Type 或 meta charset 解码。
 */

const UA = 'KnowledgeGraph/1.0 (local knowledge base; contact: local-user)';

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”' };
  const safeChar = (code) => {
    try {
      return String.fromCodePoint(code);
    } catch {
      return '';
    }
  };
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => named[name.toLowerCase()] ?? m);
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

function decodeBody(buffer, contentType = '') {
  const head = Buffer.from(buffer.slice(0, 2048)).toString('latin1');
  const metaCharset = head.match(/charset=["']?\s*([\w-]+)/i)?.[1] || '';
  const headerCharset = String(contentType).match(/charset=["']?\s*([\w-]+)/i)?.[1] || '';
  const charset = (metaCharset || headerCharset || 'utf-8').toLowerCase();
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder('utf-8').decode(buffer);
  }
}

async function fetchPage(url, timeoutMs = 25000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`目标页面返回 ${res.status}`);
    const contentType = res.headers.get('content-type') || '';
    if (/application\/(pdf|octet-stream)/i.test(contentType)) {
      throw new Error('这是一个 PDF 链接：知识图谱不解析 PDF 原文，请改用论文阅读器读完再推送，或直接粘贴正文');
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.length > 12 * 1024 * 1024) throw new Error('页面超过 12MB，请换一个页面或粘贴正文');
    return { html: decodeBody(buffer, contentType), url: res.url || url };
  } catch (err) {
    if (err?.name === 'AbortError') throw new Error('抓取超时（25 秒），请检查网络或换个链接');
    if (/这一个 PDF|返回 \d{3}|超过 12MB/.test(err.message)) throw err;
    const code = err?.cause?.code || err?.code || '';
    if (/ENOTFOUND|EAI_AGAIN/.test(code)) throw new Error('域名解析失败，检查链接拼写或网络');
    if (/ECONNREFUSED/.test(code)) throw new Error('目标站点拒绝连接');
    throw new Error(`抓取失败：${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

/** 从 HTML 里挑正文块：优先 article/main，退化为 body 的块级元素 */
export function extractReadable(html, sourceUrl = '') {
  const title =
    stripTags(html.match(/<meta property="og:title" content="([^"]+)"/i)?.[1] || '') ||
    stripTags(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') ||
    sourceUrl;

  let scope = html;
  const article = html.match(/<article\b[\s\S]*?<\/article>/i);
  const main = html.match(/<main\b[\s\S]*?<\/main>/i);
  if (article && stripTags(article[0]).length > 600) scope = article[0];
  else if (main && stripTags(main[0]).length > 600) scope = main[0];

  scope = scope
    .replace(/<(script|style|noscript|svg|iframe|form|nav|aside|header|footer|button|select)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const chunks = [];
  const blockRe = /<(h[1-6]|p|li|blockquote|td|figcaption|pre)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m;
  let total = 0;
  while ((m = blockRe.exec(scope)) !== null) {
    const tag = m[1].toLowerCase();
    const text = stripTags(m[2]).replace(/\n+/g, ' ').trim();
    if (text.length < 2) continue;
    chunks.push(tag.startsWith('h') ? `\n${text}` : text);
    total += text.length;
    if (total > 60000) break;
  }

  let body = chunks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  if (body.length < 200) body = stripTags(scope);
  return { title: title.trim().slice(0, 200), text: body.slice(0, 60000) };
}

/* --------------------------------- arXiv --------------------------------- */

export function parseArxivId(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const modern = raw.match(/(\d{4}\.\d{4,5})(v\d+)?/);
  if (modern) return modern[1] + (modern[2] || '');
  const legacy = raw.match(/([a-z-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i);
  if (legacy) return legacy[1] + (legacy[2] || '');
  return null;
}

function isArxiv(url) {
  try {
    return /(^|\.)arxiv\.org$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** arXiv：abs 页取标题摘要，尽量再抓 HTML 全文 */
async function fetchArxiv(id, absUrl) {
  const { html: absHtml } = await fetchPage(absUrl);
  const title =
    stripTags(absHtml.match(/<h1 class="title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)?.[1] || '') ||
    stripTags(absHtml.match(/<meta name="citation_title" content="([^"]+)"/i)?.[1] || '') ||
    `arXiv:${id}`;
  const abstract = stripTags(
    absHtml.match(/<blockquote class="abstract[^"]*"[^>]*>([\s\S]*?)<\/blockquote>/i)?.[1] ||
      absHtml.match(/<meta name="citation_abstract" content="([\s\S]*?)"\s*\/?>/i)?.[1] ||
      absHtml.match(/<meta property="og:description" content="([\s\S]*?)"\s*\/?>/i)?.[1] ||
      '',
  ).replace(/^Abstract:\s*/i, '');

  let body = '';
  for (const url of [`https://arxiv.org/html/${id}`, `https://arxiv.org/html/${id.replace(/v\d+$/, '')}`]) {
    try {
      const { html } = await fetchPage(url, 30000);
      const readable = extractReadable(html, url);
      if (readable.text.length > 1200) {
        body = readable.text;
        break;
      }
    } catch {
      /* 该论文没有 HTML 版本，只有摘要 */
    }
  }

  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, ' ');
  const dup = abstract && norm(body.slice(0, 600)).includes(norm(abstract.slice(0, 60)));
  const text = body
    ? `${dup ? '' : `摘要\n${abstract}\n\n`}${body}`
    : `摘要\n${abstract}`;
  return { title: title.replace(/^Title:\s*/i, '').trim(), text: text.trim(), url: absUrl, kind: 'paper' };
}

/** 统一入口：给链接（或纯文本），返回 {title, text, url, kind} */
export async function fetchWeb(url) {
  const raw = String(url || '').trim();
  if (!raw) throw new Error('请填写网页链接');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error('这不是一个可用的链接（示例：https://example.com/article）');
  }
  if (!/^https?:$/.test(parsed.protocol)) throw new Error('只支持 http / https 链接');

  if (isArxiv(withScheme)) {
    const id = parseArxivId(withScheme);
    if (id) {
      return fetchArxiv(id, `https://arxiv.org/abs/${id}`);
    }
  }

  const { html, url: finalUrl } = await fetchPage(withScheme);
  const { title, text } = extractReadable(html, finalUrl);
  if (text.length < 200) {
    throw new Error('这个页面没有可读正文（可能是纯前端渲染或需要登录），可以直接粘贴正文');
  }
  return { title, text, url: finalUrl, kind: 'web' };
}
