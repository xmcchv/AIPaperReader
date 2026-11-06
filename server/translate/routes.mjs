/**
 * 翻译接口：批量翻译 / 测试连接 / AI 分段 / 服务目录。
 *
 * 与原 papertrans 的差异只有命名空间（/api/translate/*），旧路径作为别名保留一版：
 *   POST /api/translate, /api/segment, /api/test, GET /api/providers
 */
import { loadConfig, publicConfig, saveConfig } from '../shared/config.mjs';
import { HttpError, readBody, sendJson } from '../shared/http.mjs';
import { getPref, setPref } from '../paper/db.mjs';
import { publicCatalog } from './providers.mjs';
import { segmentPage } from './segment.mjs';
import { testConnection, translateTexts } from './translate.mjs';

const asError = (err) => ({ error: err?.code || 'translate_failed', message: err?.message || '翻译失败' });

/** 老版本把翻译配置（含明文 Key）存在 prefs 里，这里作为只读兜底 */
function legacyCfg() {
  const prefs = getPref('translate.prefs') || {};
  return prefs.cfg && typeof prefs.cfg === 'object' ? prefs.cfg : {};
}

/** 某个服务商在旧版 prefs 里留下的明文 Key（cfg 或 cfgStore 里都可能有） */
function legacyKeyOf(id) {
  const prefs = getPref('translate.prefs') || {};
  const fromStore = prefs.cfgStore?.[id]?.apiKey;
  if (fromStore) return String(fromStore).trim();
  const cfg = prefs.cfg;
  if (cfg && (!cfg.provider || cfg.provider === id) && cfg.apiKey) return String(cfg.apiKey).trim();
  return '';
}

/**
 * 请求体优先、服务端配置兜底。
 * 合并后前端不必再传任何 Key：Key 只存在于 config.json（密文）与进程内存。
 */
function mergeCfg(bodyCfg = {}, providerHint = '') {
  const cfg = loadConfig();
  const t = cfg.translate || { provider: 'free', providers: {} };
  const id = String(bodyCfg.provider || providerHint || t.provider || 'free');
  const entry = t.providers?.[id] || {};
  const legacy = id === (legacyCfg().provider || '') ? legacyCfg() : {};
  const pick = (incoming, a, b) => {
    const v = typeof incoming === 'string' ? incoming.trim() : '';
    return v || a || b || '';
  };
  return {
    provider: id,
    baseUrl: pick(bodyCfg.baseUrl, entry.base_url, legacy.baseUrl),
    model: pick(bodyCfg.model, entry.model, legacy.model),
    appId: pick(bodyCfg.appId, entry.app_id, legacy.appId),
    apiKey: pick(bodyCfg.apiKey, entry.api_key, legacy.apiKey),
  };
}

export async function handleTranslateApi(req, res, url) {
  const pathname = url.pathname;
  const { method } = req;

  if (method === 'GET' && (pathname === '/api/translate/providers' || pathname === '/api/providers')) {
    sendJson(res, 200, { providers: publicCatalog() });
    return true;
  }

  if (method === 'GET' && pathname === '/api/translate/config') {
    const env = process.env;
    const t = publicConfig().translate || { provider: 'free', providers: {} };
    const current = t.providers?.[t.provider] || {};
    const legacy = legacyCfg();
    sendJson(res, 200, {
      serverKey: Boolean(
        t.ready ||
          env.OPENAI_API_KEY ||
          env.DEEPSEEK_API_KEY ||
          env.GEMINI_API_KEY ||
          env.ANTHROPIC_API_KEY ||
          env.DEEPL_API_KEY,
      ),
      provider: legacy.provider || t.provider || 'free',
      baseUrl: current.base_url || legacy.baseUrl || '',
      model: current.model || legacy.model || '',
      providers: t.providers || {},
      locked: Boolean(t.locked),
      config_path: publicConfig().config_path,
    });
    return true;
  }

  // 保存翻译引擎配置：Key 用主密码加密后写进 config.json
  if ((method === 'POST' || method === 'PUT') && pathname === '/api/translate/config') {
    const body = await readBody(req);
    const cfg = body.config && typeof body.config === 'object' ? body.config : {};
    const id = String(body.provider || cfg.provider || '').trim();
    if (!id) throw new HttpError(400, '缺少翻译引擎');
    const patch = {
      passphrase: String(body.passphrase || ''),
      translate: {
        provider: id,
        providers: {
          [id]: {
            base_url: String(cfg.baseUrl ?? ''),
            model: String(cfg.model ?? ''),
            app_id: String(cfg.appId ?? ''),
            api_key: String(cfg.apiKey ?? ''),
            clear_key: Boolean(cfg.clearKey),
          },
        },
      },
    };
    // 旧版把 Key 明文存在 prefs 里：这次输入主密码保存时顺手迁移，迁完就删掉明文
    const legacyKey = legacyKeyOf(id);
    if (!cfg.apiKey && legacyKey) patch.translate.providers[id].api_key = legacyKey;
    try {
      const out = saveConfig(patch);
      if (legacyKey) {
        const prefs = getPref('translate.prefs') || {};
        if (prefs.cfg?.apiKey) delete prefs.cfg;
        if (prefs.cfgStore?.[id]?.apiKey) {
          prefs.cfgStore[id] = { ...prefs.cfgStore[id], apiKey: '' };
        }
        setPref('translate.prefs', prefs);
      }
      sendJson(res, 200, { ok: true, translate: out.translate });
    } catch (err) {
      sendJson(res, 400, { ok: false, error: err.message || '保存失败' });
    }
    return true;
  }

  if (method === 'POST' && (pathname === '/api/translate/batch' || pathname === '/api/translate')) {
    const { texts, config, fresh } = await readBody(req);
    if (!Array.isArray(texts) || !texts.length) {
      throw new HttpError(400, '缺少待翻译文本');
    }
    if (texts.length > 40) throw new HttpError(400, '单次最多 40 段');
    if (texts.some((t) => typeof t !== 'string' || !t.trim())) throw new HttpError(400, '文本内容不合法');
    try {
      const out = await translateTexts(texts, mergeCfg(config), { fresh: Boolean(fresh) });
      sendJson(res, 200, out);
    } catch (err) {
      const status = Number(err?.status) || 500;
      if (status >= 500) console.error('[translate]', err.message);
      sendJson(res, status, asError(err));
    }
    return true;
  }

  if (method === 'POST' && (pathname === '/api/translate/test' || pathname === '/api/test')) {
    const body = await readBody(req);
    try {
      sendJson(res, 200, await testConnection(mergeCfg(body?.config || {})));
    } catch (err) {
      sendJson(res, Number(err?.status) || 500, asError(err));
    }
    return true;
  }

  if (method === 'POST' && (pathname === '/api/translate/segment' || pathname === '/api/segment')) {
    const { lines, columns, config } = await readBody(req);
    if (!Array.isArray(lines) || !lines.length) throw new HttpError(400, '缺少待分段的文本行');
    try {
      sendJson(res, 200, await segmentPage({ lines, columns }, mergeCfg(config)));
    } catch (err) {
      const status = Number(err?.status) || 500;
      // 整篇每页都失败时别刷屏，前 3 条足够定位
      if (status >= 500 && segErrorLogged < 3) {
        segErrorLogged += 1;
        console.error('[segment]', err.message);
      }
      sendJson(res, status, asError(err));
    }
    return true;
  }

  return false;
}

let segErrorLogged = 0;
