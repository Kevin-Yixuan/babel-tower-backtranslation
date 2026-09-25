export const MAX_REFERENCE_CHARS = 20000;
export const MAX_DRAFT_CHARS = 20000;

// 模型名与地址依据 2026-09 官方文档核对：
// DeepSeek 旧名 deepseek-chat 已于 2026-07-24 停用，当前 ChatCompletions 可用名为
// deepseek-flash（V4.1 Flash）/ deepseek-v4-pro（api-docs.deepseek.com/updates 2026-09-10、api/create-chat-completion）；
// MiMo OpenAI 兼容地址为 https://api.xiaomimimo.com/v1，参数用 max_completion_tokens，
// thinking 默认 enabled（mimo.mi.com/docs …/api/chat/openai-api）。
export const PROVIDERS = Object.freeze({
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna', kind: 'responses' },
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash', kind: 'chat' },
  mimo: { label: 'MiMo V2.6 Flash', baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash', kind: 'chat' },
  glm: { label: 'GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', kind: 'chat' }
});

export const PROVIDER_IDS = Object.freeze(Object.keys(PROVIDERS));

export const DEFAULT_SETTINGS = Object.freeze({
  modelProvider: 'openai',
  providers: {
    openai: { baseUrl: PROVIDERS.openai.baseUrl, model: PROVIDERS.openai.model },
    deepseek: { baseUrl: PROVIDERS.deepseek.baseUrl, model: PROVIDERS.deepseek.model },
    mimo: { baseUrl: PROVIDERS.mimo.baseUrl, model: PROVIDERS.mimo.model },
    glm: { baseUrl: PROVIDERS.glm.baseUrl, model: PROVIDERS.glm.model }
  },
  model: 'gpt-6-luna', // legacy field, migrated into providers.openai.model on first load
  targetLanguage: '英语',
  filterEnabled: false,
  filterRules: [],
  filterThreshold: 0.82,
  filterDailyLimit: 80
});

/** 硬性规格：参考材料与用户草稿分别 ≤ 20,000 字符，超限报错，禁止静默截断。（MAX_* 常量在文件顶部，全仓唯一一份） */
export function assertTextLimit(value, label, max = MAX_REFERENCE_CHARS) {
  const text = String(value ?? '').trim();
  if (text.length > max) {
    const error = new Error(`${label}共 ${text.length} 字符，超过上限 ${max} 字符。请分段处理；插件不会自动截断。`);
    error.code = 'too_long';
    throw error;
  }
  return text;
}

export function normalizeBaseUrl(raw) {
  const value = String(raw || '').trim().replace(/\/+$/, '');
  if (!value) {
    const error = new Error('请填写 Base URL（例如 https://api.deepseek.com/v1）。');
    error.code = 'bad_url';
    throw error;
  }
  let url;
  try { url = new URL(value); } catch {
    const error = new Error('Base URL 格式不正确，应类似 https://api.deepseek.com/v1。');
    error.code = 'bad_url';
    throw error;
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    const error = new Error('Base URL 必须使用 https://（本地调试可用 http://localhost）。');
    error.code = 'bad_url';
    throw error;
  }
  return value;
}

export function joinUrl(baseUrl, path) {
  // 用户可能把完整接口地址贴进 Base URL（…/v1/chat/completions），剥掉末尾的接口段，
  // 避免拼成 …/v1/chat/completions/chat/completions 或重复 /v1。
  const base = String(baseUrl || '').trim()
    .replace(/\/+(chat\/completions|responses|embeddings|completions)\/{0,1}$/i, '')
    .replace(/\/+$/, '');
  return `${base}/${String(path || '').replace(/^\/+/, '')}`;
}

export function permissionOrigin(raw) {
  const url = new URL(normalizeBaseUrl(raw));
  return `${url.protocol}//${url.host}/*`;
}

export function buildChatRequest({ instructions, input, schema = null, maxOutputTokens = 1200, provider = null }) {
  let system = String(instructions || '');
  if (schema) system += `\n\n只输出符合此 JSON Schema 的 JSON（不要 markdown 代码块，不要解释）：${JSON.stringify(schema)}`;
  const id = typeof provider === 'string' ? provider : (provider?.id || '');
  const body = {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: String(input ?? '') }
    ]
  };
  if (id === 'mimo') {
    // 官方协议：只认 max_completion_tokens（max_tokens 不在参数表里），thinking 默认 enabled。
    body.max_completion_tokens = maxOutputTokens;
    body.thinking = { type: 'disabled' }; // 短任务关闭思考：思考 token 计入输出预算，会挤占正文并增加费用
  } else {
    body.max_tokens = maxOutputTokens;
    if (id === 'deepseek') body.thinking = { type: 'disabled' }; // ChatCompletions 同样默认 enabled
  }
  return body;
}

export function chatText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content === 'string' && content.trim()) return content.trim();
  if (Array.isArray(content)) return content.map(part => part?.text || '').join('\n').trim();
  return '';
}

export function extractJson(text) {
  let raw = String(text || '').trim();
  const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/);
  if (fenced) raw = fenced[1];
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) raw = raw.slice(start, end + 1);
  try { return JSON.parse(raw); } catch {
    const error = new Error('模型反馈格式不完整，请重试。');
    error.code = 'bad_json';
    throw error;
  }
}

export function classifyModelHttpError(status, providerLabel, bodyText = '') {
  // 404/400 结合响应体区分「模型名不存在」和「Base URL 错」——两者体感完全不同，不能都归咎于地址。
  const body = String(bodyText || '').slice(0, 800);
  const looksLikeModelIssue = /model/i.test(body) && /(not[_\s-]*found|not[_\s-]*exist|does[_\s-]*not[_\s-]*exist|invalid|unknown|no[_\s-]*such|unavailable|deprecat|disabled)/i.test(body);
  if (status === 401 || status === 403) return `密钥无效或无权限（${providerLabel}）。请在设置中检查 API Key。`;
  if (status === 402) return `额度不足或需要付费（${providerLabel}，402）。请充值或检查订阅后再试。`;
  if (status === 404) return looksLikeModelIssue
    ? `模型名不存在（${providerLabel}，404）。请在设置中改成该服务商当前可用的模型名。`
    : `Base URL 无法访问（${providerLabel}）。请检查服务商地址。`;
  if (status === 429) return `请求过于频繁或额度不足（${providerLabel}）。请稍后再试或检查额度。`;
  if (status === 400) return looksLikeModelIssue
    ? `模型名无效（${providerLabel}，400）。请在设置中检查模型名。`
    : `请求被拒绝（${providerLabel}，400）。请检查模型名与 Base URL 是否匹配。`;
  if (status >= 500) return `服务商暂不可用（${providerLabel}，${status}）。请稍后重试。`;
  return `语言模型请求失败（${providerLabel}，${status}）。请检查密钥、额度或网络后重试。`;
}

export function normalizeWord(value) {
  const word = String(value || '').trim().toLowerCase().replace(/^[\s"'“”‘’.,!?;:()]+|[\s"'“”‘’.,!?;:()]+$/g, '');
  return /^[a-z][a-z'-]{0,47}$/.test(word) ? word : '';
}

export function matchingRule(answers, rules, threshold) {
  const matches = rules.map((rule, index) => ({ rule, probability: Number(answers?.[`rule_${index}`]?.noul ?? 0) }));
  return matches.filter(item => Number.isFinite(item.probability) && item.probability >= threshold).sort((a, b) => b.probability - a.probability)[0] || null;
}

/** 校验 TypeSafe/Jev 答案结构：HTTP 200 但缺 answers/概率的响应必须当失败，不能当「未命中」缓存。 */
export function validateJevAnswers(data, ruleCount) {
  const bad = message => { const error = new Error(message); error.code = 'bad_response'; return error; };
  const answers = data?.answers;
  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) {
    throw bad('Jev 返回格式异常（缺少 answers 字段），本次结果不采信。');
  }
  let valid = 0;
  for (let i = 0; i < ruleCount; i++) {
    const entry = answers[`rule_${i}`];
    if (entry == null) continue; // 缺失的规则按不命中处理，但至少要有一条有效概率
    const noul = Number(entry?.noul);
    if (!Number.isFinite(noul)) throw bad(`Jev 返回格式异常（rule_${i} 的 noul 不是数字），本次结果不采信。`);
    valid++;
  }
  if (ruleCount > 0 && valid === 0) throw bad('Jev 返回格式异常（answers 里没有任何有效概率），本次结果不采信。');
  return true;
}

/** 结构化模型结果的最小 schema 校验：必需字段缺失或类型不符一律当失败，不渲染残缺结果。 */
export function assertStructuredResult(value, schema, label = '结果') {
  if (!schema || schema.type !== 'object' || !value || typeof value !== 'object') return value;
  const props = schema.properties || {};
  const typeOk = (v, type) => {
    if (type === 'array') return Array.isArray(v);
    if (type === 'string') return typeof v === 'string';
    if (type === 'boolean') return typeof v === 'boolean';
    if (type === 'number') return typeof v === 'number' && Number.isFinite(v);
    if (type === 'object') return v && typeof v === 'object' && !Array.isArray(v);
    return true;
  };
  const failWith = message => { const error = new Error(message); error.code = 'bad_schema'; throw error; };
  for (const key of Object.keys(props)) {
    if (!(key in value)) {
      if ((schema.required || []).includes(key)) failWith(`模型返回缺少必需字段「${key}」（${label}），结果不完整，请重试。`);
      continue;
    }
    const want = props[key];
    if (want.type && !typeOk(value[key], want.type)) failWith(`模型返回的字段「${key}」类型不符（${label}），结果不完整，请重试。`);
    if (want.enum && !want.enum.includes(value[key])) failWith(`模型返回的字段「${key}」取值不在允许范围内（${label}），请重试。`);
    if (want.type === 'array' && want.items?.type === 'object' && Array.isArray(value[key])) {
      value[key].slice(0, 20).forEach((item, index) => assertStructuredResult(item, want.items, `${label}.${key}[${index}]`));
    }
  }
  for (const key of schema.required || []) {
    if (!(key in value)) failWith(`模型返回缺少必需字段「${key}」（${label}），结果不完整，请重试。`);
  }
  return value;
}

export function responseText(data) {
  const fragments = [];
  for (const item of data?.output || []) {
    for (const part of item.content || []) {
      if (part.type === 'output_text' && typeof part.text === 'string') fragments.push(part.text);
    }
  }
  return fragments.join('\n').trim();
}

export function parseGlossary(text, fileName = '') {
  if (fileName.toLowerCase().endsWith('.eubak')) throw new Error('.eubak 是词典配置备份，不包含词条。请提供实际 .mdx，或导入 TSV/CSV 词表。');
  if (text.length > 2_000_000) throw new Error('词表超过 2 MB，请拆分后导入。');
  let rows;
  if (fileName.toLowerCase().endsWith('.json')) {
    const parsed = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed.map(item => [item.word || item.term, item.meaning || item.definition]) : Object.entries(parsed);
  } else {
    rows = text.split(/\r?\n/).filter(Boolean).map(line => {
      const separator = line.includes('\t') ? '\t' : ',';
      const index = line.indexOf(separator);
      return index < 0 ? [] : [line.slice(0, index), line.slice(index + 1)];
    });
  }
  const glossary = {};
  for (const [rawWord, rawMeaning] of rows.slice(0, 5000)) {
    const word = normalizeWord(rawWord);
    const meaning = String(rawMeaning || '').trim().slice(0, 400);
    if (word && meaning) glossary[word] = meaning;
  }
  if (!Object.keys(glossary).length) throw new Error('未找到词条。格式应为：单词 + Tab/逗号 + 释义。');
  return glossary;
}
