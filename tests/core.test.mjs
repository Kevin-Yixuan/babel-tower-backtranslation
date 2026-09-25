import test from 'node:test';
import assert from 'node:assert/strict';
import {
  matchingRule, normalizeWord, parseGlossary, responseText,
  assertTextLimit, normalizeBaseUrl, joinUrl, permissionOrigin,
  buildChatRequest, chatText, extractJson, classifyModelHttpError,
  validateJevAnswers, assertStructuredResult,
  MAX_REFERENCE_CHARS, MAX_DRAFT_CHARS, PROVIDERS, PROVIDER_IDS
} from '../shared.js';

test('a dictionary backup is not treated as a word list', () => {
  assert.throws(() => parseGlossary('<Dicts/>', 'LDOCE.eubak'), /不包含词条/);
});

test('local glossary accepts TSV and ignores unsafe terms', () => {
  assert.deepEqual(parseGlossary('hello\t你好\nworld,世界\n<script>,bad', 'words.tsv'), { hello: '你好', world: '世界' });
  assert.equal(normalizeWord('  HELLO!  '), 'hello');
});

test('Jev collapses only a clear match', () => {
  const rules = [{ text: '引战' }, { text: '加密货币广告' }];
  const answers = { rule_0: { noul: 0.72 }, rule_1: { noul: 0.91 } };
  assert.equal(matchingRule(answers, rules, 0.82)?.rule.text, '加密货币广告');
  assert.equal(matchingRule(answers, rules, 0.95), null);
});

test('raw Responses API output text is collected across messages', () => {
  assert.equal(responseText({ output: [{ content: [{ type: 'output_text', text: '第一段' }] }, { content: [{ type: 'output_text', text: '第二段' }] }] }), '第一段\n第二段');
});

test('text limits are 20k for reference and draft separately and never truncate', () => {
  assert.equal(MAX_REFERENCE_CHARS, 20000);
  assert.equal(MAX_DRAFT_CHARS, 20000);
  assert.equal(assertTextLimit('x'.repeat(20000), '参考材料', MAX_REFERENCE_CHARS).length, 20000);
  assert.throws(() => assertTextLimit('x'.repeat(20001), '参考材料', MAX_REFERENCE_CHARS), error => {
    assert.equal(error.code, 'too_long');
    assert.match(error.message, /20001 字符.*上限 20000/);
    return true;
  });
  // draft limit is independent of reference limit
  assert.equal(assertTextLimit('y'.repeat(20000), '你的草稿', MAX_DRAFT_CHARS).length, 20000);
});

test('base url normalization and permission origins', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/v1/'), 'https://api.deepseek.com/v1');
  assert.equal(normalizeBaseUrl('http://localhost:8787/v1'), 'http://localhost:8787/v1');
  assert.throws(() => normalizeBaseUrl(''), /请填写 Base URL/);
  assert.throws(() => normalizeBaseUrl('ftp://x.com'), /https:\/\//);
  assert.throws(() => normalizeBaseUrl('not a url'), /格式不正确/);
  assert.equal(joinUrl('https://api.deepseek.com/v1/', '/chat/completions'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(permissionOrigin('https://open.bigmodel.cn/api/paas/v4'), 'https://open.bigmodel.cn/*');
});

test('four providers are configured and chat requests carry schema instructions', () => {
  assert.deepEqual([...PROVIDER_IDS], ['openai', 'deepseek', 'mimo', 'glm']);
  assert.equal(PROVIDERS.openai.kind, 'responses');
  for (const id of ['deepseek', 'mimo', 'glm']) assert.equal(PROVIDERS[id].kind, 'chat');
  const body = buildChatRequest({ instructions: '检查作答。', input: 'hello', schema: { type: 'object' }, maxOutputTokens: 64 });
  assert.equal(body.messages[0].role, 'system');
  assert.match(body.messages[0].content, /JSON Schema/);
  assert.equal(body.messages[1].content, 'hello');
  assert.equal(body.max_tokens, 64);
});

test('chat completions text extraction and json recovery', () => {
  assert.equal(chatText({ choices: [{ message: { content: '  pong  ' } }] }), 'pong');
  assert.equal(chatText({ choices: [{ message: { content: [{ type: 'text', text: 'part1' }, { type: 'text', text: 'part2' }] } }] }), 'part1\npart2');
  assert.equal(chatText({ choices: [] }), '');
  assert.deepEqual(extractJson('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('前置说明 {"a": 2} 后置说明'), { a: 2 });
  assert.throws(() => extractJson('not json'), /格式不完整/);
});

test('http errors map to explicit chinese messages', () => {
  assert.match(classifyModelHttpError(401, 'DeepSeek'), /密钥无效.*DeepSeek/);
  assert.match(classifyModelHttpError(404, 'GLM'), /Base URL 无法访问/);
  assert.match(classifyModelHttpError(429, 'MiMo V2.6 Flash'), /频率|额度/);
  assert.match(classifyModelHttpError(503, 'OpenAI'), /暂不可用/);
  // 402 与「404 模型名不存在」必须和地址错误区分开
  assert.match(classifyModelHttpError(402, 'DeepSeek'), /402.*付费|充值/);
  assert.match(classifyModelHttpError(404, 'DeepSeek', '{"error":{"message":"The model `deepseek-chat` does not exist"}}'), /模型名不存在/);
  assert.match(classifyModelHttpError(404, 'DeepSeek', 'not found'), /Base URL 无法访问/);
  assert.match(classifyModelHttpError(400, 'MiMo V2.6 Flash', '{"error":{"type":"invalid_request_error","code":"model_not_found"}}'), /模型名无效/);
});

test('current provider defaults follow 2026-09 official docs', () => {
  // deepseek-chat 2026-07-24 停用 → 当前默认 deepseek-flash；MiMo 默认地址为官方 /v1
  assert.equal(PROVIDERS.deepseek.model, 'deepseek-flash');
  assert.notEqual(PROVIDERS.deepseek.model, 'deepseek-chat');
  assert.equal(PROVIDERS.mimo.baseUrl, 'https://api.xiaomimimo.com/v1');
  assert.equal(PROVIDERS.deepseek.baseUrl, 'https://api.deepseek.com/v1');
});

test('joinUrl never duplicates /v1 or appends onto a full endpoint path', () => {
  assert.equal(joinUrl('https://api.deepseek.com/v1', 'chat/completions'), 'https://api.deepseek.com/v1/chat/completions');
  assert.equal(joinUrl('https://api.xiaomimimo.com/v1/chat/completions', 'chat/completions'), 'https://api.xiaomimimo.com/v1/chat/completions');
  assert.equal(joinUrl('https://api.openai.com/v1/responses', 'responses'), 'https://api.openai.com/v1/responses');
  assert.equal(joinUrl('https://api.deepseek.com/v1/', '/chat/completions'), 'https://api.deepseek.com/v1/chat/completions');
});

test('chat request shape follows each provider protocol', () => {
  const mimo = buildChatRequest({ instructions: 'i', input: 'x', maxOutputTokens: 64, provider: 'mimo' });
  assert.equal(mimo.max_completion_tokens, 64); // 官方只认这个参数
  assert.equal(mimo.max_tokens, undefined);
  assert.deepEqual(mimo.thinking, { type: 'disabled' }); // 官方默认 enabled，短任务显式关闭
  const deepseek = buildChatRequest({ instructions: 'i', input: 'x', maxOutputTokens: 64, provider: 'deepseek' });
  assert.equal(deepseek.max_tokens, 64);
  assert.deepEqual(deepseek.thinking, { type: 'disabled' });
  const glm = buildChatRequest({ instructions: 'i', input: 'x', maxOutputTokens: 64, provider: 'glm' });
  assert.equal(glm.max_tokens, 64);
  assert.equal(glm.thinking, undefined);
  const legacy = buildChatRequest({ instructions: 'i', input: 'x', maxOutputTokens: 64 });
  assert.equal(legacy.max_tokens, 64); // 不传 provider 时保持旧行为
});

test('malformed Jev answers are failures, not cached non-matches', () => {
  assert.throws(() => validateJevAnswers({}, 1), error => error.code === 'bad_response');
  assert.throws(() => validateJevAnswers({ answers: {} }, 1), error => error.code === 'bad_response');
  assert.throws(() => validateJevAnswers({ answers: { rule_0: { noul: 'x' } } }, 1), error => error.code === 'bad_response');
  assert.throws(() => validateJevAnswers(null, 1), error => error.code === 'bad_response');
  assert.equal(validateJevAnswers({ answers: { rule_0: { type: 'noul', noul: 0.9 } } }, 1), true);
  // 某条规则缺项按不命中处理，但至少要有一条有效概率
  assert.equal(validateJevAnswers({ answers: { rule_0: { noul: 0.1 } } }, 2), true);
});

test('structured model results must contain required fields of the right type', () => {
  const schema = {
    type: 'object',
    properties: {
      draft: { type: 'string' }, note: { type: 'string' },
      points: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['fix', 'polish', 'keep'] }, span: { type: 'string' } }, required: ['kind', 'span'] } }
    },
    required: ['draft', 'note']
  };
  assert.deepEqual(assertStructuredResult({ draft: 'd', note: 'n' }, schema, 't'), { draft: 'd', note: 'n' });
  assert.throws(() => assertStructuredResult({}, schema, 't'), error => error.code === 'bad_schema');
  assert.throws(() => assertStructuredResult({ draft: 1, note: 'n' }, schema, 't'), error => error.code === 'bad_schema');
  assert.throws(() => assertStructuredResult({ draft: 'd', note: 'n', points: [{ kind: 'oops', span: 's' }] }, schema, 't'), /取值不在允许范围/);
  assert.throws(() => assertStructuredResult({ draft: 'd', note: 'n', points: [{ kind: 'fix' }] }, schema, 't'), /缺少必需字段/);
});
