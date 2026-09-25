// Local-only browser test: dynamic timeline simulation, Jev retry/diagnostics,
// provider connection tests. Never touches a real x.com session.
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 启动时清理 30 分钟前的本测试遗留 profile，防止临时盘写满。
(() => { try { for (const d of fs.readdirSync(os.tmpdir())) { if (/^(bx-timeline-)/.test(d)) { const p = path.join(os.tmpdir(), d); if (Date.now() - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } } } catch {} })();

const log = [];
const say = line => { log.push(line); console.log(line); };

(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-timeline-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://x.com/timeline-fixture', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fs.readFileSync(path.join(__dirname, 'timeline.html'), 'utf8') }));
  await page.goto('https://x.com/timeline-fixture');
  await page.locator('.bx-inline-button').first().waitFor({ timeout: 15000 });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 5000 });

  async function installMock() {
    await worker.evaluate(() => {
      if (globalThis.__bxMockInstalled) return;
      globalThis.__bxMockInstalled = true;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        const u = String(url);
        if (u.includes('api.typesafe.ai/v1/systemone')) {
          const body = JSON.parse(options.body);
          const post = body.state?.post || '';
          const st = await chrome.storage.local.get(['mockStats', 'mockMode']);
          const stats = st.mockStats || { counts: {}, total: 0 };
          const key = post.slice(0, 50);
          stats.counts = stats.counts || {};
          stats.counts[key] = (stats.counts[key] || 0) + 1;
          stats.total = (stats.total || 0) + 1;
          await chrome.storage.local.set({ mockStats: stats });
          if (post.includes('always-fail')) return new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } });
          const mode = st.mockMode || 'normal';
          if (mode === 'fail-first' && post.toLowerCase().includes('dynamically') && stats.counts[key] === 1) return new Response('boom', { status: 500 });
          if (mode === 'all-500') return new Response('boom', { status: 500 });
          const hit = post.toLowerCase().includes('flame');
          return new Response(JSON.stringify({ model: 'jev-latest', answers: { rule_0: { type: 'noul', noul: hit ? 0.93 : 0.3 } }, usage: { input_tokens: 10, output_tokens: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (u.includes('api.openai.com/v1/responses')) {
          const request = JSON.parse(options.body);
          const name = request.text?.format?.name;
          const text = name === 'prepare_practice' ? JSON.stringify({ chinese: '练习。', context: '仿真', focus: '主谓' })
            : name === 'check_practice' || name === 'check_reply' || name === 'check_writing' ? JSON.stringify({ meaningOk: true, meaningNote: '清楚。', grammarOk: true, grammarNote: '无语法问题。', summary: '通过。', points: [] })
            : name === 'generate_reply' ? JSON.stringify({ draft: 'ok draft', backtranslation: '中文回译。', meaningRisk: '无明显风险。', suggestions: [], followUp: [], note: 'n' })
            : name === 'learn_expressions' ? JSON.stringify({ expressions: [{ text: 'made visible', kind: 'sentence', note: '示例' }] })
            // no schema (e.g. EXPLAIN): echo the received input length so the test can prove no truncation
            : `inputLen=${String(request.input || '').length}`;
          return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        if (u.includes('api.deepseek.com')) {
          const auth = options?.headers?.Authorization || '';
          if (auth.includes('sk-bad')) return new Response('{"error":"unauthorized"}', { status: 401, headers: { 'Content-Type': 'application/json' } });
          if (auth.includes('sk-nonpong')) return new Response(JSON.stringify({ choices: [{ message: { content: 'I am just some arbitrary text, not a probe reply.' }, finish_reason: 'stop' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
          const request = JSON.parse(options.body);
          return new Response(JSON.stringify({ choices: [{ message: { content: request.messages?.[0]?.content?.includes('connectivity') ? 'pong' : '{"draft":"ds","note":"n"}' } }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return originalFetch(url, options);
      };
    });
  }

  const baseSettings = {
    modelProvider: 'openai',
    providers: {
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' },
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
      mimo: { baseUrl: '', model: 'mimo-v2.6-flash' },
      glm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' }
    },
    targetLanguage: '英语',
    filterEnabled: true,
    filterRules: [{ id: 'r1', text: '引战', enabled: true }],
    filterThreshold: 0.82,
    filterDailyLimit: 80
  };

  // ---------- Phase A: dynamic load + retry + node reuse + collapse/expand ----------
  await installMock();
  await worker.evaluate(async ({ baseSettings }) => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      settings: baseSettings, jevKey: 'test-jev-key',
      mockMode: 'fail-first', mockStats: { counts: {}, total: 0 }
    });
  }, { baseSettings });
  await page.reload();
  // note: flame posts collapse quickly and their buttons become hidden — wait for a visible one
  await page.locator('.bx-inline-button:visible').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(1800); // allow dynamic append (500/700ms) + recycle (1200ms) + scan debounce

  // all four surviving posts have the inline button (dynamic + recycled nodes covered)
  await page.waitForFunction(() => document.querySelectorAll('.bx-inline-button').length >= 4, null, { timeout: 10000 });
  say('PASS 动态加载与复用节点均挂上「翻译／回复」入口按钮');

  // POST2 (stable node, flame hit) must be collapsed, and expandable
  const flame2 = page.locator('article').filter({ hasText: 'Flame in the kitchen' });
  await flame2.locator('.bx-collapsed, .bx-collapse-bar').first().waitFor({ timeout: 15000 });
  assert(await flame2.first().evaluate(node => node.classList.contains('bx-collapsed')), 'POST2 should be collapsed');
  say('PASS 命中规则只折叠（POST2 flame 命中）');
  await flame2.locator('.bx-collapse-bar button').click();
  assert(await flame2.locator('[data-testid="tweetText"]').first().isVisible(), 'expand must reveal post');
  assert(!(await flame2.first().evaluate(node => node.classList.contains('bx-collapsed'))), 'expanded post must not stay collapsed');
  say('PASS 折叠后可展开，展开后恢复可见');

  // node reuse: POST4 lives in POST1\'s old node and was re-filtered
  const recycle = page.locator('article').filter({ hasText: 'replaced POST1 inside the same DOM node' });
  await recycle.first().waitFor({ timeout: 5000 });
  await page.waitForFunction(() => {
    const node = [...document.querySelectorAll('article')].find(a => a.textContent.includes('replaced POST1'));
    return node && node.dataset.bxPostKey && node.dataset.bxPostKey.includes('/status/1004');
  }, null, { timeout: 10000 });
  say('PASS 节点复用被检测（bxPostKey 更新为新帖 /status/1004）');

  // transient failure retried exactly once at HTTP level: dynamically post = 2 calls
  // (wait until always-fail has exhausted so all counting is final; DOM-only check in page world)
  await page.waitForFunction(() => [...document.querySelectorAll('article')].some(a => a.textContent.includes('always-fail') && a.dataset.bxFiltered === 'failed'), null, { timeout: 25000 });
  const statsA = await worker.evaluate(async () => (await chrome.storage.local.get('mockStats')).mockStats);
  const dynKey = Object.keys(statsA.counts).find(k => k.includes('Dynamically'));
  assert(dynKey, 'dynamic post key should exist in mock stats: ' + JSON.stringify(statsA.counts));
  assert.equal(statsA.counts[dynKey], 2, `dynamic post expected 2 calls (500 then retry), got ${statsA.counts[dynKey]}`);
  say('PASS 瞬时 500 由 background 自动重试一次后成功（dynamically=2 次调用）');

  // always-fail post: bounded retries exhausted, error recorded (not swallowed)
  const failInfo = await page.evaluate(() => {
    const node = [...document.querySelectorAll('article')].find(a => a.textContent.includes('always-fail'));
    return { filtered: node?.dataset.bxFiltered, error: node?.dataset.bxLastError || '' };
  });
  assert.equal(failInfo.filtered, 'failed', 'always-fail post must end as failed');
  assert.match(failInfo.error, /500|失败/, 'last error must be recorded on the node');
  const failKey = Object.keys(statsA.counts).find(k => k.includes('always-fail'));
  assert(statsA.counts[failKey] >= 4, `expected >=4 attempts for always-fail, got ${statsA.counts[failKey]}`);
  say(`PASS 错误不再被吞掉：bxLastError="${failInfo.error}"，HTTP 尝试 ${statsA.counts[failKey]} 次后标记 failed`);

  // no duplicate calls for settled posts (counts stay stable)
  await page.waitForTimeout(2500);
  const statsA2 = await worker.evaluate(async () => (await chrome.storage.local.get('mockStats')).mockStats);
  assert.equal(statsA2.total, statsA.total, `no new requests after settling (was ${statsA.total}, now ${statsA2.total})`);
  const p1Key = Object.keys(statsA2.counts).find(k => k.includes('pure flame bait'));
  if (p1Key) assert.equal(statsA2.counts[p1Key], 1, 'recycled-away original content must not be re-requested');
  say('PASS 稳定后无重复请求；被复用节点的旧内容不再重发');

  // diagnostics in popup
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  popup.on('pageerror', error => errors.push('popup:' + error.message));
  await popup.setViewportSize({ width: 372, height: 680 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#provider-key').waitFor();
  await popup.locator('[data-tab="filters"]').click();
  await popup.locator('#jev-diagnostics').getByText(/失败 [1-9]/).waitFor({ timeout: 5000 });
  const diagText = await popup.locator('#jev-diagnostics').innerText();
  assert.match(diagText, /失败 [1-9]/, 'diagnostics must show failures: ' + diagText);
  assert.match(diagText, /今日 API 请求 \d+\/\d+/, 'diagnostics must show real API request budget: ' + diagText);
  assert.match(diagText, /跳过 \d+/);
  await popup.screenshot({ path: path.join(root, 'tests', 'timeline-diagnostics.png') });
  say('PASS Jev 诊断面板显示请求数/判断/跳过/折叠/缓存/失败/上限计数');

  // ---------- Phase B: daily limit halts with explicit state ----------
  await worker.evaluate(async ({ baseSettings }) => {
    await chrome.storage.local.clear();
    const day = new Date().toISOString().slice(0, 10);
    await chrome.storage.local.set({
      settings: baseSettings, jevKey: 'test-jev-key',
      apiKeys: { openai: 'test-key' }, // placeholder key so under-limit AI calls pass the key check (mock only)
      jevDaily: { day, used: 80 },
      mockMode: 'normal', mockStats: { counts: {}, total: 0 }
    });
  }, { baseSettings });
  await page.reload();
  await page.locator('.bx-inline-button:visible').first().waitFor({ timeout: 15000 });
  await page.waitForFunction(() => [...document.querySelectorAll('article')].some(a => a.dataset.bxFiltered === 'limited'), null, { timeout: 10000 });
  const statsB = await worker.evaluate(async () => (await chrome.storage.local.get('mockStats')).mockStats);
  assert.equal(statsB.total || 0, 0, `daily limit must prevent all HTTP calls, got ${statsB.total}`);
  say('PASS 每日上限：已达 80/80 时零请求、帖子标记 limited、会话熔断');
  await popup.reload();
  await popup.locator('[data-tab="filters"]').click();
  await popup.locator('#jev-diagnostics').getByText(/达上限 [1-9]/).waitFor({ timeout: 5000 });
  say('PASS 诊断面板显示“达上限”计数');

  // ---------- 20k limits e2e (still on default OpenAI provider; popup is an extension page) ----------
  const overDraft = await popup.evaluate(async () => chrome.runtime.sendMessage({
    action: 'AI', task: 'EXPLAIN', payload: { text: 'x'.repeat(20001), context: '' }
  }));
  assert.equal(overDraft.ok, false, 'over-limit draft must be rejected: ' + JSON.stringify(overDraft));
  assert.match(overDraft.error, /20001 字符.*上限 20000|超过上限 20000/, 'draft over-limit error: ' + overDraft.error);
  const overRef = await popup.evaluate(async () => chrome.runtime.sendMessage({
    action: 'AI', task: 'GENERATE_REPLY', payload: { text: '短输入', context: 'r'.repeat(20001) }
  }));
  assert.equal(overRef.ok, false, 'over-limit reference must be rejected');
  assert.match(overRef.error, /参考材料.*20001|超过上限 20000/, 'reference over-limit error: ' + overRef.error);
  const underRef = await popup.evaluate(async () => chrome.runtime.sendMessage({
    action: 'AI', task: 'GENERATE_REPLY', payload: { text: '我同意。', context: 'r'.repeat(19000) }
  }));
  assert.equal(underRef.ok, true, '19k reference under limit must pass through to the model (mock): ' + JSON.stringify(underRef));
  // prove NO silent truncation: mock echoes received input length for schema-less tasks
  const echo = await popup.evaluate(async () => chrome.runtime.sendMessage({
    action: 'AI', task: 'EXPLAIN', payload: { text: 'x'.repeat(19000), context: '' }
  }));
  assert.equal(echo.ok, true, '19k explain must reach the model: ' + JSON.stringify(echo));
  const echoed = Number((String(echo.data?.text || '').match(/inputLen=(\d+)/) || [])[1] || 0);
  assert(echoed >= 19000, `model must receive full 19k input, mock saw inputLen=${echoed}, full response: ${JSON.stringify(echo)}`);
  say(`PASS 20k 硬上限端到端：草稿 20001 报错、参考材料 20001 报错、19000 完整送达模型（mock 实测 inputLen=${echoed}，无静默截断）`);

  // ---------- Phase C: provider settings, connection test, explicit errors ----------
  await installMock(); // SW may have restarted during the long Phase A/B window
  await popup.locator('[data-tab="home"]').click();
  await popup.locator('#model-provider').selectOption('deepseek');
  await popup.locator('#provider-base-url').fill('https://api.deepseek.com/v1');
  await popup.locator('#provider-model').fill('deepseek-chat');
  await popup.locator('#provider-key').fill('sk-test');
  await popup.locator('#test-model').click();
  await popup.locator('#test-result.ok').waitFor({ timeout: 15000 });
  assert.match(await popup.locator('#test-result').innerText(), /DeepSeek 连接正常/);
  say('PASS DeepSeek 连接测试成功（OpenAI 兼容 chat/completions，mock）');

  await popup.locator('#provider-key').fill('sk-bad');
  await popup.locator('#test-model').click();
  await popup.locator('#test-result.error').waitFor({ timeout: 15000 });
  assert.match(await popup.locator('#test-result').innerText(), /密钥无效/);
  say('PASS 401 明确提示「密钥无效或无权限」');

  // a 200 response that is NOT the pong probe must fail the connection test
  await popup.locator('#provider-key').fill('sk-nonpong');
  await popup.locator('#test-model').click();
  await popup.locator('#test-result.error').waitFor({ timeout: 15000 });
  assert.match(await popup.locator('#test-result').innerText(), /pong 探测应答/);
  say('PASS 连接测试校验探测应答：非 pong 的 200 响应判为未通过');

  // per-provider fields survive switching
  await popup.locator('#model-provider').selectOption('glm');
  assert.equal(await popup.locator('#provider-base-url').inputValue(), 'https://open.bigmodel.cn/api/paas/v4');
  await popup.locator('#model-provider').selectOption('deepseek');
  assert.equal(await popup.locator('#provider-base-url').inputValue(), 'https://api.deepseek.com/v1');
  assert.equal(await popup.locator('#provider-key').inputValue(), 'sk-nonpong');
  say('PASS 服务商切换保留各自 Base URL/模型名/密钥草稿');

  // mimo now has the official default baseUrl; a cleared field must still give an explicit error
  await popup.locator('#model-provider').selectOption('mimo');
  assert.equal(await popup.locator('#provider-base-url').inputValue(), 'https://api.xiaomimimo.com/v1', 'MiMo 默认地址应为官方 /v1');
  await popup.locator('#provider-base-url').fill('');
  await popup.locator('#test-model').click();
  await popup.locator('#test-result.error').waitFor({ timeout: 10000 });
  assert.match(await popup.locator('#test-result').innerText(), /Base URL/);
  say('PASS MiMo 默认地址为官方 /v1；清空 Base URL 给出明确错误提示');

  // save deepseek as active provider and verify persistence
  await popup.locator('#model-provider').selectOption('deepseek');
  await popup.locator('#provider-key').fill('sk-test');
  await popup.locator('#save-main').click();
  await popup.locator('#status').getByText('已保存').waitFor({ timeout: 5000 });
  const persisted = await worker.evaluate(async () => {
    const st = await chrome.storage.local.get(['settings', 'apiKeys', 'openaiKey']);
    return { provider: st.settings?.modelProvider, dsKey: st.apiKeys?.deepseek, legacyKey: st.openaiKey ?? null };
  });
  assert.equal(persisted.provider, 'deepseek');
  assert.equal(persisted.dsKey, 'sk-test');
  assert.equal(persisted.legacyKey, null, 'legacy openaiKey must be migrated away');
  await popup.screenshot({ path: path.join(root, 'tests', 'timeline-providers.png') });
  say('PASS 服务商配置持久化；旧 openaiKey 字段完成迁移清理');

  assert.deepEqual(errors, []);
  say('PASS 页面无 JS 错误');
  say('timeline.cjs 全部完成');
  fs.writeFileSync(path.join(__dirname, 'evidence-timeline.txt'), log.join('\n'), 'utf8');
  await context.close();
  process.exit(0);
})().catch(error => {
  console.error(error);
  try { fs.writeFileSync(path.join(__dirname, 'evidence-timeline.txt'), log.join('\n') + '\nFAILED: ' + error.stack, 'utf8'); } catch {}
  process.exit(1);
});
