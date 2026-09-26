import { DEFAULT_SETTINGS, PROVIDERS, normalizeBaseUrl } from '../shared.js';

const safeId = id => /^[a-z][a-z0-9_-]{0,79}$/.test(id) && !['constructor', 'prototype', '__proto__'].includes(id);
export function normalizeSettings(stored = {}) {
  const providers = {};
  for (const id of new Set([...Object.keys(PROVIDERS), ...Object.keys(stored.providers || {})])) {
    if (!safeId(id)) continue;
    const def = PROVIDERS[id] || { label: '自定义 API', kind: 'chat', baseUrl: '', model: '' };
    const src = stored.providers?.[id] || {};
    providers[id] = {
      label: src.label || def.label, kind: src.kind || def.kind,
      baseUrl: src.baseUrl || def.baseUrl, model: src.model ?? (id === 'openai' && stored.model ? stored.model : def.model)
    };
  }
  return { ...DEFAULT_SETTINGS, ...stored, schemaVersion: 2, providers,
    modelProvider: Object.hasOwn(providers, stored.modelProvider) ? stored.modelProvider : 'openai',
    autoTranslate: stored.autoTranslate !== false, hoverLookup: stored.hoverLookup !== false };
}

export function validateProviders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 40) throw new Error('模型配置格式不正确，最多保存 40 组。');
  const result = {};
  for (const [id, config] of Object.entries(input)) {
    if (!safeId(id) || !config || typeof config !== 'object') throw new Error('模型配置 ID 无效。');
    const label = String(config.label || PROVIDERS[id]?.label || '自定义 API').trim();
    const model = String(config.model ?? '').trim();
    if (!label || label.length > 80) throw new Error('配置名称需要 1–80 个字符。');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(model)) throw new Error(label + '：请填写有效模型名（支持 /），不会自动替换模型。');
    const kind = config.kind || PROVIDERS[id]?.kind || 'chat';
    if (!['chat', 'responses'].includes(kind)) throw new Error('请选择 Chat Completions 或 Responses。');
    result[id] = { label, model, kind, baseUrl: normalizeBaseUrl(config.baseUrl) };
  }
  return result;
}

export async function modelFetch(url, options, fetcher = fetch) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(30000) });
      if (attempt === 0 && [502, 503, 504].includes(response.status)) {
        await response.body?.cancel();
        await new Promise(resolve => setTimeout(resolve, 800));
        continue;
      }
      return response;
    } catch (error) {
      if (attempt || error.name === 'TimeoutError' || error.name === 'AbortError') throw error;
      await new Promise(resolve => setTimeout(resolve, 800));
    }
  }
}
