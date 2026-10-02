import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createPiServer } from '../pi-bridge/http.mjs';
import { runPi } from '../pi-bridge/process.mjs';

async function fixture(run, ready = true) {
  const server = createPiServer({ token: 'fixture-token', health: { ready, version: 'fixture' }, run });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
const headers = { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json', Origin: 'chrome-extension://testextension' };
const post = (url, data, extra = {}) => fetch(url + '/chat', { method: 'POST', headers, body: JSON.stringify(data), ...extra });
const close = server => new Promise(resolve => server.close(resolve));

test('真实 HTTP 入口保持鉴权、来源检查与输入校验', async () => {
  let calls = 0;
  const { server, url } = await fixture(async ({ prompt }) => { calls++; return prompt; });
  try {
    assert.equal((await fetch(url + '/health')).status, 401);
    assert.equal((await fetch(url + '/health', { headers: { ...headers, Origin: 'https://example.com' } })).status, 403);
    assert.equal((await fetch(url + '/health', { headers })).status, 200);
    assert.equal((await post(url, null)).status, 400);
    assert.equal((await post(url, { prompt: 'test', model: 'bad model' })).status, 400);
    assert.equal((await post(url, { prompt: 'x'.repeat(80001) })).status, 413);
    assert.equal((await post(url, { prompt: 'x'.repeat(100000) })).status, 413);
    assert.equal(calls, 0);
    const answer = await post(url, { prompt: '合法指令' });
    assert.equal(answer.status, 200);
    assert.equal((await answer.json()).answer, '合法指令');
  } finally { await close(server); }
});

test('中文字符跨 TCP 数据块传输不会被损坏', async () => {
  const { server, url } = await fixture(async ({ prompt }) => prompt);
  try {
    const bytes = Buffer.from(JSON.stringify({ prompt: '中文材料' }));
    const split = bytes.indexOf(Buffer.from('中')) + 1;
    const answer = await new Promise((resolve, reject) => {
      const request = http.request(url + '/chat', { method: 'POST', headers }, response => {
        let body = ''; response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve(JSON.parse(body)));
      });
      request.on('error', reject);
      request.write(bytes.subarray(0, split));
      setTimeout(() => request.end(bytes.subarray(split)), 20);
    });
    assert.equal(answer.answer, '中文材料');
  } finally { await close(server); }
});

test('并发请求明确限流，连接状态仍可读取；断开连接取消进程并释放槽位', async () => {
  let started, aborted;
  const running = new Promise(resolve => { started = resolve; });
  const cancelled = new Promise(resolve => { aborted = resolve; });
  const { server, url } = await fixture(async ({ signal }) => {
    started();
    try { return await runPi({ executable: process.execPath, prefix: ['-e', 'setInterval(()=>{},1000)', '--'], prompt: 'fixture', timeoutMs: 3000, signal }); }
    finally { aborted(); }
  });
  const controller = new AbortController();
  const request = post(url, { prompt: 'pending' }, { signal: controller.signal }).catch(error => error);
  try {
    await running;
    assert.equal((await post(url, { prompt: 'second' })).status, 429);
    assert.equal((await fetch(url + '/health', { headers })).status, 200);
    controller.abort();
    await request;
    await cancelled;
    // The process finally block completes before the next request arrives.
    const retry = await post(url, { prompt: 'retry' });
    assert.equal(retry.status, 504);
  } finally { controller.abort(); await request; await close(server); }
});

test('Pi 未就绪时返回可恢复的 503 状态', async () => {
  const { server, url } = await fixture(() => { throw new Error('must not run'); }, false);
  try { assert.equal((await post(url, { prompt: 'test' })).status, 503); }
  finally { await close(server); }
});
