/* ------------------------------------------------------------------ */
/* 统一存储：所有数据都存到服务端的 SQLite 数据库（.cache/papertrans.sqlite） */
/*                                                                      */
/* 浏览器不再保存 PDF 原件、译文、分段改动、修正记录或配置：                  */
/*   - 避免 localStorage 5MB 配额爆掉（分段一多就写不进去）                  */
/*   - 刷新、换浏览器、清站点数据都不丢数据                                  */
/* 首次启动会把旧版 localStorage / IndexedDB 里的数据一次性迁过去并清理。    */
/* ------------------------------------------------------------------ */

const BASE = '/api/store';
const enc = (s) => encodeURIComponent(String(s));

let warned = false;
let pendingWarn = false;
let warnHandler = null;
/** app.js 注册一个 toast 回调：服务端不可写时只提示一次，避免刷屏 */
export function setStoreWarnHandler(fn) {
  warnHandler = fn;
  // 模块加载阶段的请求可能早于注册，补提示
  if (pendingWarn && !warned) {
    warned = true;
    try {
      fn();
    } catch {}
  }
}
function warn(e) {
  if (!warnHandler) pendingWarn = true;
  else if (!warned) {
    warned = true;
    try {
      warnHandler();
    } catch {}
  }
  console.warn('[store]', e);
}

async function getJson(path) {
  try {
    const r = await fetch(BASE + path, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    warn(e);
    return null;
  }
}

async function send(method, path, body, { raw = false } = {}) {
  try {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['Content-Type'] = raw ? 'application/octet-stream' : 'application/json';
      init.body = raw ? body : JSON.stringify(body);
    }
    const r = await fetch(BASE + path, init);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.json().catch(() => ({ ok: true }));
  } catch (e) {
    warn(e);
    return null;
  }
}

/* ---------------- 偏好 / 设置（整体一个小 JSON） ---------------- */
/** 单一真实源：内存里的对象，启动时从服务端载入，之后所有改动先改它再落库 */
export const prefs = {};
export const prefsReady = (async () => {
  const r = await getJson('/prefs');
  if (r?.prefs && typeof r.prefs === 'object') Object.assign(prefs, r.prefs);
})();

let prefTimer = 0;
function schedulePrefs() {
  clearTimeout(prefTimer);
  prefTimer = setTimeout(() => {
    prefTimer = 0;
    send('PUT', '/prefs', { prefs });
  }, 200);
}
export function flushPrefs() {
  if (!prefTimer) return Promise.resolve(true);
  clearTimeout(prefTimer);
  prefTimer = 0;
  return send('PUT', '/prefs', { prefs }).then(Boolean);
}
export function setPref(key, value) {
  prefs[key] = value;
  schedulePrefs();
}
// 关页面前把还没落库的偏好立刻写出去
window.addEventListener('pagehide', () => {
  if (prefTimer) {
    clearTimeout(prefTimer);
    prefTimer = 0;
    try {
      fetch(BASE + '/prefs', {
        method: 'PUT',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prefs }),
      });
    } catch {}
  }
});

/* ---------------- 工程数据 ---------------- */
/** { name, overrides, translations:[{text,zh}], savedAt, pages, chars } */
export async function getProject(key) {
  const r = await getJson(`/project/${enc(key)}`);
  return r?.project || null;
}
export async function putProject(key, data) {
  const r = await send('PUT', `/project/${enc(key)}`, { project: data });
  return Boolean(r?.ok);
}
/** 历史文档摘要列表：[{ id, name, pages, translations, updatedAt, hasPdf, pdfBytes }] */
export async function listProjects() {
  const r = await getJson('/projects');
  // null = 读不到（服务端旧版或没启动），调用方保留旧列表；[] = 确实没有历史
  return Array.isArray(r?.projects) ? r.projects : null;
}
export async function delProject(key) {
  const r = await send('DELETE', `/project/${enc(key)}`);
  return Boolean(r?.ok);
}
/** 只刷新「最近打开」时间，不重写整包工程数据 */
export async function touchProject(key) {
  const r = await send('POST', `/project/${enc(key)}/touch`);
  return Boolean(r?.ok);
}

/** PDF 原件单独存 BLOB，返回 { name, buf: ArrayBuffer } */
export async function getPdf(key) {
  try {
    const r = await fetch(`${BASE}/project/${enc(key)}/pdf`, { cache: 'no-store' });
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    let name = 'document.pdf';
    try {
      name = decodeURIComponent(r.headers.get('X-Papertrans-Name') || '') || name;
    } catch {}
    return { name, buf: await r.arrayBuffer(), savedAt: 0 };
  } catch (e) {
    warn(e);
    return null;
  }
}
export async function putPdf(key, rec) {
  if (!rec?.buf) return false;
  const path = `/project/${enc(key)}/pdf?name=${enc(rec.name || 'document.pdf')}`;
  const r = await send('PUT', path, rec.buf, { raw: true });
  return Boolean(r?.ok);
}
export async function delPdf(key) {
  const r = await send('DELETE', `/project/${enc(key)}/pdf`);
  return Boolean(r?.ok);
}

/* ---------------- 上次打开的文档指针 ---------------- */
export async function getLast() {
  const r = await getJson('/last');
  return r?.id || null;
}
export async function setLast(key) {
  const r = await send('PUT', '/last', { id: key });
  return Boolean(r?.ok);
}
export async function clearLast() {
  const r = await send('DELETE', '/last');
  return Boolean(r?.ok);
}

export async function getStoreStats() {
  return await getJson('/stats');
}

/* ------------------------------------------------------------------ */
/* 旧数据迁移：localStorage + IndexedDB → SQLite                        */
/* 只在服务端对应记录为空时补写，重复执行不会覆盖较新的数据库内容           */
/* ------------------------------------------------------------------ */
const OVR_PREFIX = 'papertrans.ovr.';
const PREF_KEYS = {
  'papertrans.cfg': 'cfg',
  'papertrans.cfgStore': 'cfgStore',
  'papertrans.theme': 'theme',
  'papertrans.font': 'font',
  'papertrans.split': 'split',
  'papertrans.remember': 'remember',
  'papertrans.ai': 'ai',
  'papertrans.corrections': 'corrections',
};
const JSON_KEYS = new Set(['cfg', 'cfgStore', 'corrections']);

function readLegacyStorage() {
  const prefs = {};
  const overrides = {};
  const keys = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith(OVR_PREFIX)) {
        keys.push(k);
        try {
          const v = JSON.parse(localStorage.getItem(k) || 'null');
          if (v && typeof v === 'object') overrides[k.slice(OVR_PREFIX.length)] = v;
        } catch {}
      } else if (PREF_KEYS[k]) {
        keys.push(k);
        const pk = PREF_KEYS[k];
        const raw = localStorage.getItem(k);
        if (raw === null) continue;
        if (JSON_KEYS.has(pk)) {
          try {
            prefs[pk] = JSON.parse(raw);
          } catch {}
        } else {
          prefs[pk] = raw;
        }
      }
    }
  } catch {
    return { prefs: {}, overrides: {}, keys: [] };
  }
  return { prefs, overrides, keys };
}

function openLegacyDB() {
  return new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open('papertrans', 1);
    } catch {
      resolve(null);
      return;
    }
    req.onupgradeneeded = () => {}; // 库不存在时会建个空库，随后直接删掉
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    req.onblocked = () => resolve(null);
  });
}

function readAll(db, name) {
  return new Promise((resolve) => {
    const out = [];
    try {
      const cur = db.transaction(name, 'readonly').objectStore(name).openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) {
          out.push([c.key, c.value]);
          c.continue();
        } else resolve(out);
      };
      cur.onerror = () => resolve(out);
    } catch {
      resolve(out);
    }
  });
}

async function hasLegacyDB() {
  try {
    if (typeof indexedDB.databases !== 'function') return true;
    const list = await indexedDB.databases();
    return list.some((d) => d.name === 'papertrans');
  } catch {
    return true;
  }
}

/**
 * 返回 { prefs, overrides, projects, pdfs, cleaned }；没有旧数据或失败时 cleaned=false，
 * 浏览器里的原数据会保留，下次启动自动重试。
 */
export async function migrateBrowserData() {
  await prefsReady;
  const ls = readLegacyStorage();
  const idbExists = await hasLegacyDB();
  if (!ls.keys.length && !idbExists) return { cleaned: false, prefs: 0, overrides: 0, projects: 0, pdfs: 0 };

  let db = null;
  const projects = {};
  const pdfPairs = [];
  let last = '';
  if (idbExists) {
    db = await openLegacyDB();
    if (db) {
      for (const [id, value] of await readAll(db, 'projects')) {
        if (value && typeof value === 'object') projects[id] = value;
      }
      pdfPairs.push(...(await readAll(db, 'pdfs')));
      for (const [k, value] of await readAll(db, 'meta')) {
        if (k === 'last' && typeof value === 'string') last = value;
      }
    }
  }

  const r = await send('POST', '/migrate', {
    prefs: ls.prefs,
    overrides: ls.overrides,
    projects,
    last,
  });
  if (!r?.ok) {
    db?.close();
    return { cleaned: false, prefs: 0, overrides: 0, projects: 0, pdfs: 0, failed: true };
  }

  let pdfCount = 0;
  let pdfFailed = 0;
  for (const [id, rec] of pdfPairs) {
    if (!rec?.buf) continue;
    if (await putPdf(id, rec)) pdfCount++;
    else pdfFailed++;
  }

  // 数据搬完再清浏览器，确保任何一步失败都能下次重试
  if (ls.keys.length) {
    try {
      for (const k of ls.keys) localStorage.removeItem(k);
    } catch {}
  }
  if (db && !pdfFailed) {
    try {
      db.close();
      indexedDB.deleteDatabase('papertrans');
    } catch {}
  } else {
    db?.close();
  }

  // 以服务端为准刷新内存偏好（migrate 可能合并了旧值）
  const fresh = await getJson('/prefs');
  if (fresh?.prefs && typeof fresh.prefs === 'object') {
    for (const k of Object.keys(prefs)) delete prefs[k];
    Object.assign(prefs, fresh.prefs);
  }

  return {
    cleaned: true,
    prefs: r.moved?.prefs || 0,
    overrides: r.moved?.overrides || 0,
    projects: r.moved?.projects || 0,
    pdfs: pdfCount,
    pdfFailed,
  };
}
