import { DEFAULT_SETTINGS, PROVIDERS, normalizeBaseUrl } from '../shared.js';

const safeId = id => /^[a-z][a-z0-9_-]{0,79}$/.test(id) && !['constructor', 'prototype', '__proto__'].includes(id);
const plainObject = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const trimString = value => (typeof value === 'string' ? value.trim() : '');

/**
 * 基线单配置形态迁移：0.2.x 只存四组固定 provider（无 label/kind），外加顶层
 * model（providers.openai.model 的镜像字段）与顶层 baseUrl（更早的单配置）。
 * 迁移必须无损：模型名、地址、当前选中的配置一律原样保留——包括已停用的
 * deepseek-chat（不静默替换，由 flashModelSuggestion 显示建议）。
 */
function legacyFields(source) {
  const legacy = {};
  const model = trimString(source.model);
  const baseUrl = trimString(source.baseUrl);
  if (model) legacy.model = model;
  if (baseUrl) legacy.baseUrl = baseUrl;
  return legacy;
}

export function normalizeSettings(stored = {}) {
  const source = plainObject(stored);
  const legacy = legacyFields(source);
  const storedProviders = plainObject(source.providers);
  const providers = {};
  for (const id of new Set([...Object.keys(PROVIDERS), ...Object.keys(storedProviders)])) {
    if (!safeId(id)) continue;
    const def = PROVIDERS[id] || { label: '自定义 API', kind: 'chat', baseUrl: '', model: '' };
    const src = plainObject(storedProviders[id]);
    const srcModel = trimString(src.model);
    const srcBaseUrl = trimString(src.baseUrl);
    providers[id] = {
      label: trimString(src.label) || def.label,
      kind: ['chat', 'responses'].includes(src.kind) ? src.kind : def.kind,
      baseUrl: srcBaseUrl || (id === 'openai' ? legacy.baseUrl : '') || def.baseUrl,
      model: srcModel || (id === 'openai' ? legacy.model : '') || def.model
    };
  }
  const result = { ...DEFAULT_SETTINGS, ...source, schemaVersion: 2, providers,
    modelProvider: Object.hasOwn(providers, source.modelProvider) ? source.modelProvider : 'openai',
    autoTranslate: source.autoTranslate !== false, hoverLookup: source.hoverLookup !== false };
  // 密钥永远不放进 settings 对象：即使旧数据/归档把密钥混进了 settings，导出与展示也不携带
  for (const secret of ['apiKeys', 'apiKey', 'openaiKey', 'jevKey', 'key']) delete result[secret];
  return result;
}

export function validateProviders(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length > 40) throw new Error('模型配置格式不正确，最多保存 40 组。');
  const result = {};
  for (const [id, config] of Object.entries(input)) {
    if (!safeId(id) || !config || typeof config !== 'object') throw new Error('模型配置 ID 无效。');
    const label = String(config.label || PROVIDERS[id]?.label || '自定义 API').trim();
    const model = String(config.model ?? '').trim();
    if (!label || label.length > 80) throw new Error('配置名称需要 1–80 个字符。');
    // 模型名允许 "/"（如 openai/gpt-4o-mini、org/model-name），上限 200 字符
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@+-]{0,199}$/.test(model)) throw new Error(label + '：请填写有效模型名（支持 /），不会自动替换模型。');
    const kind = config.kind || PROVIDERS[id]?.kind || 'chat';
    if (!['chat', 'responses'].includes(kind)) throw new Error('请选择 Chat Completions 或 Responses。');
    result[id] = { label, model, kind, baseUrl: normalizeBaseUrl(config.baseUrl) };
  }
  return result;
}

// ---------- 生效配置的读写：唯一保存实现（后台与设置页测试都走这里） ----------
// storage 只需 chrome.storage.local 的 get/set/remove 形状，便于测试只替换存储故障。

const clean = (value, max) => String(value ?? '').trim().slice(0, max);

export async function readSettings(storage) {
  const { settings: stored } = await storage.get('settings');
  return normalizeSettings(stored || {});
}

export async function readApiKeys(storage) {
  const { apiKeys = {}, openaiKey = '' } = await storage.get(['apiKeys', 'openaiKey']);
  const keys = { ...apiKeys };
  if (openaiKey && !keys.openai) { keys.openai = openaiKey; await storage.set({ apiKeys: keys }); }
  return keys;
}

export async function publicSettings(storage) {
  const [settings, apiKeys] = await Promise.all([readSettings(storage), readApiKeys(storage)]);
  const { jevKey = '', glossary = {} } = await storage.get(['jevKey', 'glossary']);
  return {
    ...settings,
    hasModel: Boolean(apiKeys[settings.modelProvider]),
    hasOpenAI: Boolean(apiKeys.openai),
    hasJev: Boolean(jevKey),
    glossaryCount: Object.keys(glossary).length
  };
}

export async function saveSettings(payload, storage) {
  if (!payload || typeof payload !== 'object') throw new Error('设置格式有误。');
  const previous = await readSettings(storage);
  const settings = {
    schemaVersion: 2,
    autoTranslate: payload.autoTranslate ?? previous.autoTranslate,
    hoverLookup: payload.hoverLookup ?? previous.hoverLookup,
    modelProvider: payload.modelProvider || previous.modelProvider,
    providers: {},
    targetLanguage: clean(payload.targetLanguage || '英语', 30),
    filterEnabled: Boolean(payload.filterEnabled),
    filterRules: Array.isArray(payload.filterRules) ? payload.filterRules.slice(0, 8).map((rule, index) => ({ id: clean(rule.id || `rule-${index}`, 40), text: clean(rule.text, 180), enabled: Boolean(rule.enabled) })).filter(rule => rule.text) : [],
    filterThreshold: Math.max(0.65, Math.min(0.98, Number(payload.filterThreshold) || DEFAULT_SETTINGS.filterThreshold)),
    filterDailyLimit: Math.max(10, Math.min(200, Number(payload.filterDailyLimit) || 80))
  };
  settings.providers = validateProviders(payload.providers || previous.providers);
  if (!Object.hasOwn(settings.providers, settings.modelProvider)) throw new Error('当前模型配置不存在。');
  settings.model = settings.providers.openai?.model || previous.model;
  const apiKeys = await readApiKeys(storage);
  for (const id of Object.keys(settings.providers)) {
    // undefined = 调用方没发这一格（保留已存）；空串 = 明确清空
    const incoming = payload.apiKeys?.[id];
    const key = incoming === undefined ? (apiKeys[id] || '') : clean(incoming, 250);
    if (key) apiKeys[id] = key; else delete apiKeys[id];
  }
  for (const id of Object.keys(apiKeys)) if (!Object.hasOwn(settings.providers, id)) delete apiKeys[id];
  const jevKey = payload.jevKey === undefined ? (await storage.get('jevKey')).jevKey || '' : clean(payload.jevKey, 250);
  await storage.set({ settings, apiKeys, jevKey });
  await storage.remove('openaiKey'); // 已并入 apiKeys
  return publicSettings(storage);
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

// ---------- Flash / 低延迟模型建议（只读建议，绝不改写任何配置） ----------

export const FLASH_RECOMMENDATIONS = Object.freeze([
  Object.freeze({ id: 'mimo', model: 'mimo-v2.6-flash', kind: 'chat', note: 'MiMo V2.6 Flash（低延迟）' }),
  Object.freeze({ id: 'deepseek', model: 'deepseek-flash', kind: 'chat', note: 'DeepSeek V4.1 Flash' }),
  Object.freeze({ id: 'openai', model: 'gpt-6-luna', kind: 'responses', note: 'GPT-6 Luna · Responses 低推理档' })
]);

/**
 * 返回对「当前生效配置」的低延迟模型建议；settings 只读，绝不写入。
 * 已经在用推荐模型时返回 null；deepseek-chat（2026-07-24 停用）会得到替换建议，
 * 但替换只发生在用户手动保存之后。
 */
export function flashModelSuggestion(settings) {
  const source = plainObject(settings);
  const providers = plainObject(source.providers);
  const current = providers[source.modelProvider] || {};
  const currentModel = trimString(current.model);
  const deprecated = currentModel === 'deepseek-chat';
  if (!deprecated && FLASH_RECOMMENDATIONS.some(item => item.model === currentModel)) return null;
  const candidate = FLASH_RECOMMENDATIONS.find(item => item.model !== currentModel) || FLASH_RECOMMENDATIONS[0];
  return {
    ...candidate,
    deprecatedCurrent: deprecated,
    reason: deprecated
      ? 'deepseek-chat 已于 2026-07-24 停用，建议改用 deepseek-flash（需手动保存才会生效）'
      : '交互翻译优先选择 Flash／低延迟模型，可明显缩短等待（仅建议，不会更改你的选择）'
  };
}
