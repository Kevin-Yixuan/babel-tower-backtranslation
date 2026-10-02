import test from 'node:test';
import assert from 'node:assert/strict';

const store = { settings: { agentBaseUrl: 'http://127.0.0.1:4097' }, agentKey: 'test-token' };
globalThis.chrome = {
  storage: { local: {
    async get(keys) {
      return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => Object.hasOwn(store, key)).map(key => [key, structuredClone(store[key])]));
    },
    async set(values) { Object.assign(store, structuredClone(values)); }
  } },
  permissions: { async contains() { return true; } }
};
const { agentOp } = await import('../services/pi-agent.js');

test('等待 Pi 回复期间，保存文稿与读取连接状态仍可完成', async () => {
  const originalFetch = globalThis.fetch;
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  globalThis.fetch = async url => {
    if (url.endsWith('/health')) return Response.json({ ready: true, version: 'test' });
    started();
    await pending;
    return Response.json({ answer: '助手回复' });
  };
  const chat = agentOp({ action: 'AGENT_CHAT', payload: { message: '协助改稿', sessionId: 'pending-chat' } });
  try {
    await ready;
    const save = agentOp({ action: 'SAVE_DOCUMENT', payload: { id: 'live-draft', content: '# 等待期间的修改' } });
    const result = await Promise.race([save, new Promise((_, reject) => setTimeout(() => reject(new Error('文稿保存被模型请求阻塞')), 500))]);
    assert.equal(result.content, '# 等待期间的修改');
    assert.equal(store.documents['live-draft'].content, result.content);
    const status = await agentOp({ action: 'AGENT_STATUS' });
    assert.equal(status.ready, true);
  } finally {
    release();
    await chat;
    globalThis.fetch = originalFetch;
  }
});

test('并发对话依次处理，后一次包含前一次结果；清空不会被晚到回复恢复', async () => {
  const originalFetch = globalThis.fetch;
  let release, started;
  const pending = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  const prompts = [];
  globalThis.fetch = async (_url, options) => {
    prompts.push(JSON.parse(options.body).prompt);
    if (prompts.length === 1) { started(); await pending; }
    return Response.json({ answer: `回复${prompts.length}` });
  };
  const first = agentOp({ action: 'AGENT_CHAT', payload: { message: '第一步', sessionId: 'ordered-chat' } });
  try {
    await ready;
    const second = agentOp({ action: 'AGENT_CHAT', payload: { message: '第二步', sessionId: 'ordered-chat' } });
    const reset = agentOp({ action: 'RESET_AGENT_SESSION', sessionId: 'ordered-chat' });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(prompts.length, 1);
    release();
    await first;
    const result = await second;
    assert.match(prompts[1], /第一步/);
    assert.match(prompts[1], /回复1/);
    assert.equal(result.session.messages.length, 4);
    await reset;
    assert.equal(store.agentSessions['ordered-chat'], undefined);
  } finally { release(); await first; globalThis.fetch = originalFetch; }
});

test('模型请求失败后，后续对话和文稿保存仍正常', async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => { throw new Error('连接中断'); };
    await assert.rejects(agentOp({ action: 'AGENT_CHAT', payload: { message: '失败请求' } }), /连接中断/);
    globalThis.fetch = async () => Response.json({ answer: '恢复后的回复' });
    const result = await agentOp({ action: 'AGENT_CHAT', payload: { message: '重新尝试' } });
    assert.equal(result.answer, '恢复后的回复');
    const document = await agentOp({ action: 'SAVE_DOCUMENT', payload: { content: '仍可保存' } });
    assert.equal(store.documents[document.id].content, '仍可保存');
  } finally { globalThis.fetch = originalFetch; }
});

test('两个窗口编辑同一文稿，旧版本保存另存副本并能继续编辑', async () => {
  const initial = await agentOp({ action: 'SAVE_DOCUMENT', payload: { id: 'shared-document', title: '共同原稿', content: '原稿', kind: 'reference', folder: '参考文章', sourceUrl: 'https://x.com/a/status/1' } });
  const first = await agentOp({ action: 'SAVE_DOCUMENT', payload: { ...initial, content: '窗口 A 修改', expectedRevision: initial.revision } });
  const second = await agentOp({ action: 'SAVE_DOCUMENT', payload: { ...initial, content: '窗口 B 修改', expectedRevision: initial.revision } });
  assert.equal(store.documents[initial.id].content, '窗口 A 修改');
  assert.notEqual(second.id, initial.id);
  assert.equal(second.conflictOf, initial.id);
  assert.equal(second.content, '窗口 B 修改');
  assert.equal(second.sourceUrl, initial.sourceUrl);
  assert.equal(second.folder, initial.folder);
  assert.equal(second.kind, initial.kind);
  assert.equal(first.revision, initial.revision + 1);
  const continued = await agentOp({ action: 'SAVE_DOCUMENT', payload: { ...second, content: '窗口 B 继续修改', expectedRevision: second.revision } });
  assert.equal(continued.id, second.id);
  assert.equal(store.documents[second.id].content, '窗口 B 继续修改');
  assert.equal(store.documents[initial.id].content, '窗口 A 修改');
});

test('未改动保存不制造冲突或递增版本，已删除文稿的旧窗口写入另存', async () => {
  const original = await agentOp({ action: 'SAVE_DOCUMENT', payload: { id: 'unchanged-document', content: '保持不变' } });
  const same = await agentOp({ action: 'SAVE_DOCUMENT', payload: { ...original, expectedRevision: 0 } });
  assert.deepEqual(same, original);
  await agentOp({ action: 'DELETE_DOCUMENT', id: original.id });
  const restored = await agentOp({ action: 'SAVE_DOCUMENT', payload: { ...original, content: '删除后旧窗口的修改', expectedRevision: original.revision } });
  assert.notEqual(restored.id, original.id);
  assert.equal(store.documents[original.id], undefined);
  assert.equal(store.documents[restored.id].content, '删除后旧窗口的修改');
});
