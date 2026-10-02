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
