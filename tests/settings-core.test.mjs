// T1 专项：services/settings.js —— 旧配置（基线单配置形态）无损迁移、稳定配置 ID、
// 模型名支持 "/"、两种协议校验、Flash 建议只读、密钥永不进入 settings/导出内容。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeSettings, validateProviders, flashModelSuggestion, FLASH_RECOMMENDATIONS
} from '../services/settings.js';

const freezeDeep = value => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeDeep(child);
  }
  return value;
};

// ---------- 旧配置迁移 ----------

test('迁移：基线单配置形态（顶层 model 镜像、无 label/kind）无损保留', () => {
  // 0.2.x 存储形态：四组固定 provider 只有 baseUrl/model，外加顶层 model 镜像字段
  const legacy = {
    modelProvider: 'deepseek',
    model: 'my-legacy-model',
    targetLanguage: '日语',
    providers: {
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-custom' },
      deepseek: { baseUrl: 'https://my-proxy.example.com/v1/', model: 'deepseek-flash' }
    },
    filterEnabled: true, filterThreshold: 0.9, filterDailyLimit: 30
  };
  const settings = normalizeSettings(legacy);
  // 当前选中的配置绝不被改写
  assert.equal(settings.modelProvider, 'deepseek');
  // 用户自定义的地址与模型名原样保留（读取不改写；保存校验时才归一尾斜杠）
  assert.equal(settings.providers.deepseek.baseUrl, 'https://my-proxy.example.com/v1/');
  assert.equal(settings.providers.deepseek.model, 'deepseek-flash');
  assert.equal(settings.providers.openai.model, 'gpt-custom');
  // 顶层 model 镜像迁入 openai（基线语义），其余设置原样
  assert.equal(settings.model, 'my-legacy-model');
  assert.equal(settings.targetLanguage, '日语');
  assert.equal(settings.filterEnabled, true);
  assert.equal(settings.filterThreshold, 0.9);
  assert.equal(settings.filterDailyLimit, 30);
  // 缺失的 label/kind 由默认补齐，便于直接通过 validateProviders（备份导出路径同样依赖这一点）
  const validated = validateProviders(settings.providers);
  assert.equal(validated.deepseek.baseUrl, 'https://my-proxy.example.com/v1');
  assert.equal(validated.deepseek.kind, 'chat');
  assert.equal(validated.openai.kind, 'responses');
  assert.equal(validated.deepseek.label, 'DeepSeek');
});

test('迁移：只有 {modelProvider, model} 的最老单配置也能读出，且模型名含 / 不被改写', () => {
  const settings = normalizeSettings({ modelProvider: 'mimo', model: 'xiaomi/flash-special' });
  assert.equal(settings.modelProvider, 'mimo');
  assert.equal(settings.providers.openai.model, 'xiaomi/flash-special');
  assert.equal(settings.providers.mimo.model, 'mimo-v2.6-flash');
  assert.deepEqual(validateProviders(settings.providers).openai.model, 'xiaomi/flash-special');
});

test('迁移：停用的 deepseek-chat 不被暗中替换，只给出建议', () => {
  const legacy = { modelProvider: 'deepseek', providers: { deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' } } };
  const settings = freezeDeep(normalizeSettings(structuredClone(legacy)));
  assert.equal(settings.providers.deepseek.model, 'deepseek-chat', '绝不暗改用户已选的模型');
  assert.deepEqual(validateProviders(settings.providers).deepseek.model, 'deepseek-chat');
  const before = JSON.stringify(settings);
  const hint = flashModelSuggestion(settings);
  assert.ok(hint, '停用模型应给出替换建议');
  assert.equal(hint.deprecatedCurrent, true);
  assert.match(hint.reason, /停用/);
  assert.equal(JSON.stringify(settings), before, '建议函数不修改配置');
});

test('迁移：自定义配置 ID（含 custom_ 前缀与 UUID）原样保留，重命名只改 label', () => {
  const id = 'custom_8f14e45f-ea2e-4c11-9d3f-000000000001';
  const settings = normalizeSettings({
    modelProvider: id,
    providers: { [id]: { label: '旧名字', kind: 'chat', baseUrl: 'https://gw.example.com/v1', model: 'org/model-v2' } }
  });
  assert.equal(settings.modelProvider, id, '切换到自定义配置后不回退');
  const renamed = validateProviders({ ...settings.providers, [id]: { ...settings.providers[id], label: '新名字' } });
  assert.deepEqual(Object.keys(renamed), Object.keys(settings.providers), '重命名不产生新 ID，也不丢配置');
  assert.ok(Object.hasOwn(renamed, id));
  assert.equal(renamed[id].label, '新名字');
  assert.equal(renamed[id].model, 'org/model-v2');
  // 无效 ID（原型污染键）被拒绝
  assert.throws(() => validateProviders(JSON.parse('{"__proto__": {"label":"x","model":"m","baseUrl":"https://x.com"}}')), /无效/);
});

// ---------- 模型名与协议校验 ----------

test('模型名允许 "/"，两种协议都能通过校验，非法输入明确报错', () => {
  const providers = {
    a: { label: 'A', kind: 'chat', baseUrl: 'https://a.example.com/v1', model: 'org/model-name' },
    b: { label: 'B', kind: 'responses', baseUrl: 'https://b.example.com/v1', model: 'models/gpt-x-2026' }
  };
  const result = validateProviders(providers);
  assert.equal(result.a.model, 'org/model-name');
  assert.equal(result.a.kind, 'chat');
  assert.equal(result.b.kind, 'responses');
  assert.throws(() => validateProviders({ a: { ...providers.a, model: '' } }), /有效模型名/);
  assert.throws(() => validateProviders({ a: { ...providers.a, model: 'bad model!' } }), /有效模型名/);
  assert.throws(() => validateProviders({ a: { ...providers.a, kind: 'grpc' } }), /Chat Completions 或 Responses/);
  assert.throws(() => validateProviders({ a: { ...providers.a, label: 'x'.repeat(81) } }), /1–80/);
  const many = Object.fromEntries(Array.from({ length: 41 }, (_, i) => [`custom_p${i}`, { ...providers.a }]));
  assert.throws(() => validateProviders(many), /最多保存 40/);
});

// ---------- Flash 建议只读 ----------

test('Flash 建议：只建议、不改写；已是推荐模型时不再打扰', () => {
  const settings = freezeDeep(normalizeSettings({
    modelProvider: 'custom_x',
    providers: { custom_x: { label: '自定义', kind: 'chat', baseUrl: 'https://x.example.com/v1', model: 'my-own-model' } }
  }));
  const before = JSON.stringify(settings);
  const hint = flashModelSuggestion(settings);
  assert.ok(hint && hint.model, '非 Flash 模型应给出建议');
  assert.ok(FLASH_RECOMMENDATIONS.some(item => item.model === hint.model));
  assert.match(hint.reason, /不会更改你的选择|停用/);
  assert.equal(JSON.stringify(settings), before, '建议函数不修改输入');

  const already = freezeDeep(normalizeSettings({ modelProvider: 'deepseek' })); // deepseek-flash
  assert.equal(already.providers.deepseek.model, 'deepseek-flash');
  assert.equal(flashModelSuggestion(already), null, '已是推荐模型则返回 null');
});

// ---------- 密钥隔离 ----------

test('settings 对象与归档化输出永不含密钥（即使旧数据把密钥混进 settings）', () => {
  const dirty = {
    modelProvider: 'openai',
    apiKey: 'sk-direct-SECRET',
    openaiKey: 'sk-openai-SECRET',
    jevKey: 'jev-SECRET',
    apiKeys: { openai: 'sk-map-SECRET' },
    providers: { openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna', key: 'sk-nested-SECRET' } }
  };
  const settings = normalizeSettings(dirty);
  const json = JSON.stringify(settings);
  for (const secret of ['sk-direct-SECRET', 'sk-openai-SECRET', 'jev-SECRET', 'sk-map-SECRET', 'sk-nested-SECRET']) {
    assert.equal(json.includes(secret), false, `settings 输出不得包含 ${secret}`);
  }
  const validated = JSON.stringify(validateProviders(settings.providers));
  assert.equal(validated.includes('sk-'), false);
});
