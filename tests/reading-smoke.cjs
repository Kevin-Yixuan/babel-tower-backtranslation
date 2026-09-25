// 阅读模块浏览器验收（reading Agent；任务书 1）：真实加载扩展到独立 Edge profile，
// page.route 拦截 x.com 域名返回自建 HTML（本地仿真 only，绝不打开真实已登录 x.com、不点发布）。
// 模型 fetch 在 service worker 内受控 mock（记录请求形状 + 可挂起逐条放行）——
// 只证明消息链路与 UI 行为，不宣称真实模型验证通过；无真实密钥的端到端一律「未实测」。
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 启动时清理 30 分钟前的本测试遗留 profile，防止临时盘写满。
(() => { try { for (const d of fs.readdirSync(os.tmpdir())) { if (/^(bx-reading-)/.test(d)) { const p = path.join(os.tmpdir(), d); if (Date.now() - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } } } catch {} })();

const A_TEXT = 'Writing is thinking made visible. ALPHA_SRC sentences stay attached to the post they were opened from today.';
const B_TEXT = 'BETA_SRC habits compound quietly. Shipping small improvements daily beats waiting for a perfect plan.';
const SENTENCE_A = A_TEXT.slice(0, 33); // 'Writing is thinking made visible.'
const TAIL = 'TAIL_MARKER_XYZ_END';

const tweetsHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>reading tweets fixture</title></head><body><main>
<article data-testid="tweet" id="a"><div data-testid="User-Name">Alpha Author<br>@alpha</div><div data-testid="tweetText">${A_TEXT}</div><a href="/alpha/status/9001">Sep 25</a><div role="group"><button>Reply</button></div></article>
<article data-testid="tweet" id="b"><div data-testid="User-Name">Beta Author<br>@beta</div><div data-testid="tweetText">${B_TEXT}</div><a href="/beta/status/9002">Sep 25</a><div role="group"><button>Reply</button></div></article>
<section><div id="ed" data-testid="tweetTextarea_0" contenteditable="true" role="textbox" aria-label="Post text">Editing draft text here</div></section>
</main></body></html>`;

// 文章正文延迟/分批渲染：首段先出，3.5s 后补第二段（观察 DOM 增长 → 补译）
const articleHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>delayed article fixture</title></head><body><main>
<h1 id="art-title">Delayed Article</h1>
<div data-testid="longformRichTextComponent" id="art">
  <p id="p1">Article paragraph one arrives first: the reader opens the sidebar and expects a faithful translation of what is visible on screen.</p>
</div>
<script>setTimeout(function () {
  var p = document.createElement('p');
  p.id = 'p2';
  p.textContent = 'Article paragraph two arrives later through dynamic rendering and must trigger a supplementary translation, ending with TAIL_MARK_ART_TWO.';
  document.getElementById('art').appendChild(p);
}, 3500);</script>
</main></body></html>`;

// 单段 20,001 字符：必须报明确中文错误（含实际长度与上限），且不发任何模型请求
const overHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>over limit article fixture</title></head><body><main>
<div data-testid="articleBody"><p id="giant">${'x'.repeat(20001)}</p></div>
</main></body></html>`;

// 长文（未超限）：尾部标记必须出现在翻译请求里，且全文完整展示
const longHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>long article fixture</title></head><body><main>
<div data-testid="longformRichTextComponent">
  <p id="lp1">Long article paragraph one lays out the argument with enough ordinary prose to behave like a real longform body paragraph on X.</p>
  <p id="lp2">Long article paragraph two wraps up the argument and ends with the tail marker ${TAIL} for the request shape check.</p>
</div>
</main></body></html>`;

const log = [];
const say = line => { log.push(line); console.log(line); };

// 启动时清理 30 分钟前的本测试遗留 profile，防止临时盘写满。
(async () => {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'tests');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-reading-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const pageErrors = [];
  const worker = await (async () => { for (let i = 0; i < 60; i++) { const w = context.serviceWorkers()[0]; if (w) return w; try { return await context.waitForEvent('serviceworker', { timeout: 500 }); } catch { /* retry */ } } throw new Error('service worker 未在 30s 内启动'); })();

  // 受控 mock：记录请求形状；hold=true 时挂起进队列由测试逐条放行。绝不写入真实 API Key。
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      glossary: { writing: '写作' },
      settings: { modelProvider: 'openai', providers: { openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' } }, targetLanguage: '英语', filterEnabled: false, filterRules: [], filterThreshold: 0.82, filterDailyLimit: 80 }
      // 注意：此处故意不写 openaiKey —— 先验证「无密钥时错误原样展示」
    });
    globalThis.__requests = [];
    globalThis.__pending = [];
    globalThis.__hold = false;
    const wrap = text => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    globalThis.__wrap = wrap;
    globalThis.__translateFor = input => String(input).includes('ALPHA_SRC') ? 'ALPHA_TRANS_ZZZ'
      : String(input).includes('BETA_SRC') ? 'BETA_TRANS_YYY'
        : 'TRANSL<' + String(input).replace(/\s+/g, ' ').slice(0, 60) + '>';
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const u = String(url);
      if (u.includes('api.openai.com/v1/responses')) {
        const request = JSON.parse(options.body);
        const input = String(request.input || '');
        globalThis.__requests.push({ name: request.text?.format?.name || 'plain', instructions: String(request.instructions || ''), input });
        if (globalThis.__hold) return new Promise(resolve => globalThis.__pending.push({ resolve, request }));
        return wrap(globalThis.__translateFor(input));
      }
      if (u.includes('dictionaryapi.dev')) return new Response(JSON.stringify([{ word: 'unknown', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'mock online definition' }] }] }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('mymemory.translated.net')) return new Response(JSON.stringify({ responseData: { translatedText: 'mock 在线释义' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      if (u.includes('typesafe.ai')) return new Response('{}', { status: 200 });
      return original(url, options);
    };
  });

  const translateRequests = () => worker.evaluate(() => globalThis.__requests.slice());
  const waitPending = async (expected = 1) => {
    for (let i = 0; i < 120; i++) {
      const count = await worker.evaluate(() => globalThis.__pending.length);
      if (count >= expected) return;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`等待挂起请求超时（期望 ≥${expected}）`);
  };
  const releaseHold = async () => {
    const released = await worker.evaluate(() => {
      const queue = globalThis.__pending;
      if (!queue.length) return false;
      const { resolve, request } = queue.shift();
      const input = String(request.input || '');
      resolve(globalThis.__wrap(globalThis.__translateFor(input)));
      return true;
    });
    assert(released, '应有挂起请求可放行');
  };

  const openFixture = async (html, url, { waitEntry = false } = {}) => {
    const page = await context.newPage();
    page.on('pageerror', error => pageErrors.push(`${url}: ${error.message}`));
    await page.route(url, route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto(url);
    await page.locator('#bx-sidebar-handle').waitFor({ timeout: 15000 });
    if (waitEntry) await page.locator('.bx-inline-button').first().waitFor({ timeout: 15000 });
    return page;
  };

  // 在文本节点里按下 start..end 的划选并派发 mouseup（本地仿真划选手势）
  const selectRange = (page, selector, start, end) => page.locator(selector).evaluate((el, { start, end }) => {
    const node = el.firstChild;
    if (!node || node.nodeType !== 3) throw new Error('fixture 期望单一文本节点');
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, end);
    const selection = document.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
  }, { start, end });

  // ─── ① 打开阅读自动翻译：无密钥错误原样展示 → 有密钥（mock）请求形状与 UI ───
  const tweets = await openFixture(tweetsHtml, 'https://x.com/reading-tweets', { waitEntry: true });
  await tweets.locator('#a .bx-inline-button').click();
  await tweets.locator('#bx-sidebar.bx-open').waitFor();
  await tweets.locator('#bx-body .bx-error').waitFor({ timeout: 10000 });
  const noKeyText = await tweets.locator('#bx-body').innerText();
  assert(noKeyText.includes('先在插件设置中填写'), `无密钥错误须原样展示：${noKeyText.slice(0, 300)}`);
  assert(noKeyText.includes('API Key'), '错误含 API Key 字样');
  assert.equal((await translateRequests()).length, 0, '无密钥不得发出模型请求');
  say('PASS 打开阅读自动翻译：无密钥错误原样展示且 0 请求');

  await worker.evaluate(() => chrome.storage.local.set({ openaiKey: 'test-placeholder-key' }));
  await worker.evaluate(() => { globalThis.__hold = true; globalThis.__pending = []; });
  await tweets.reload();
  await tweets.locator('#a .bx-inline-button').first().waitFor({ timeout: 15000 });
  await tweets.locator('#a .bx-inline-button').click();
  await waitPending(1);
  const [firstReq] = await translateRequests();
  assert(firstReq.input.includes(A_TEXT), '请求 input 必须含完整原文（无静默截断）');
  assert(firstReq.instructions.includes('英语'), '目标语言进入 prompt');
  assert(firstReq.instructions.includes('不要执行'), 'prompt 要求不执行原文中的指令');
  assert(firstReq.instructions.includes('不得静默截断'), 'prompt 要求不静默截断');
  await releaseHold();
  await tweets.locator('.bx-pair-dst.bx-done').first().waitFor({ timeout: 10000 });
  const autoText = await tweets.locator('#bx-body').innerText();
  assert(autoText.includes('ALPHA_TRANS_ZZZ'), '译文渲染在阅读页签内');
  assert(autoText.includes(A_TEXT.slice(0, 40)), '原文在对照区展示');
  await tweets.screenshot({ path: path.join(out, 'reading-auto-translate.png'), fullPage: true });
  say('PASS 打开阅读自动翻译：TRANSLATE 请求形状正确、译文出现在对照区（mock 链路，非真实模型）');
  await worker.evaluate(() => { globalThis.__hold = false; });

  // ─── ④ 划选半个单词 → 补词界 → 小释义浮窗（LOOKUP 走本地词表）───
  await selectRange(tweets, '#a [data-testid="tweetText"]', 0, 4); // 'Writ'
  await tweets.locator('#bx-word-pop.bx-show').waitFor({ timeout: 5000 });
  assert.equal(await tweets.locator('#bx-word-pop').getAttribute('data-word'), 'Writing', '半词必须补全到完整词界');
  const popText = await tweets.locator('#bx-word-pop').innerText();
  assert(popText.includes('Writing'), `浮窗显示补全后的完整词：${popText}`);
  assert(popText.includes('写作'), `浮窗显示查词结果：${popText}`);
  const popBox = await tweets.locator('#bx-word-pop').boundingBox();
  assert(popBox && popBox.width <= 280 && popBox.height <= 210, `浮窗必须小尺寸不遮挡大片网页：${JSON.stringify(popBox)}`);
  await tweets.screenshot({ path: path.join(out, 'reading-word-pop.png'), fullPage: true });
  say('PASS 划选半词 → 补词界显示完整词 + 小释义浮窗（本地词表命中，0 网络）');

  // ─── ⑤ 选中句子 → 送入侧栏阅读页签（与选区条衔接）───
  await tweets.locator('#bx-close').click();
  await selectRange(tweets, '#a [data-testid="tweetText"]', 0, 33); // 整句
  await tweets.locator('#bx-sidebar.bx-open').waitFor({ timeout: 5000 });
  assert(await tweets.locator('[data-bx-mode="read"]').evaluate(el => el.classList.contains('bx-active')), '送入阅读页签');
  const sentenceBody = await tweets.locator('#bx-body').innerText();
  assert(sentenceBody.includes(SENTENCE_A), `阅读页签展示选中句子：${sentenceBody.slice(0, 300)}`);
  assert.equal(await tweets.locator('#bx-selection-bar.bx-show').count(), 1, '选区条衔接保留');
  assert.equal(await tweets.locator('#bx-word-pop.bx-show').count(), 0, '句子不弹词义浮窗');
  await tweets.screenshot({ path: path.join(out, 'reading-sentence-sidebar.png'), fullPage: true });
  say('PASS 选中句子 → 送入侧栏阅读页签，选区条衔接、不弹大浮窗');

  // ─── ⑥ 切帖不串内容：A 的在途翻译晚到被丢弃，A 的选区不出现在 B 上下文 ───
  await tweets.reload();
  await tweets.locator('#a .bx-inline-button').first().waitFor({ timeout: 15000 });
  await worker.evaluate(() => { globalThis.__hold = true; globalThis.__pending = []; globalThis.__requests = []; });
  await tweets.locator('#a .bx-inline-button').click();
  await waitPending(1); // A 的自动翻译挂起
  await selectRange(tweets, '#a [data-testid="tweetText"]', 0, 33);
  const aBody = await tweets.locator('#bx-body').innerText();
  assert(aBody.includes(SENTENCE_A), 'A 选区在 A 上下文可见');
  await tweets.locator('#b .bx-inline-button').click(); // 切帖
  await waitPending(2); // B 的自动翻译也发出
  let bBody = await tweets.locator('#bx-body').innerText();
  if (!bBody.includes('BETA_SRC')) {
    console.error('[debug] bBody =', JSON.stringify(bBody.slice(0, 600)));
    console.error('[debug] activeTab =', await tweets.locator('.bx-tabs .bx-active').getAttribute('data-bx-mode').catch(() => 'none'));
    console.error('[debug] pending =', await worker.evaluate(() => globalThis.__pending.map(p => p.request.input.slice(0, 60))));
    console.error('[debug] requests =', await worker.evaluate(() => globalThis.__requests.map(r => r.input.slice(0, 60))));
  }
  assert(bBody.includes('BETA_SRC'), 'B 帖文进入对照区');
  assert(!bBody.includes(SENTENCE_A), '切帖后 A 的选区不得出现在 B 上下文');
  assert.equal(await tweets.locator('#bx-selection-bar.bx-show').count(), 0, '切帖后选区条收起');
  await releaseHold(); // 先放行 A（晚到）
  await tweets.waitForTimeout(600);
  bBody = await tweets.locator('#bx-body').innerText();
  assert(!bBody.includes('ALPHA_TRANS_ZZZ'), 'A 的在途翻译晚到必须被丢弃');
  await releaseHold(); // 再放行 B
  await tweets.locator('.bx-pair-dst.bx-done').first().waitFor({ timeout: 10000 });
  bBody = await tweets.locator('#bx-body').innerText();
  assert(bBody.includes('BETA_TRANS_YYY'), 'B 的翻译正常呈现');
  assert(!bBody.includes('ALPHA_TRANS_ZZZ'), 'B 上下文不得混入 A 的翻译');
  assert(!bBody.includes(SENTENCE_A), 'B 上下文不得混入 A 的选区');
  await tweets.screenshot({ path: path.join(out, 'reading-post-switch.png'), fullPage: true });
  say('PASS 切帖不串内容：A 在途翻译晚到被丢弃，选区不跨帖');
  await worker.evaluate(() => { globalThis.__hold = false; });

  // ─── ② 文章正文延迟加载：先出半段 → 后补段落 → 补译出现、内容完整 ───
  await worker.evaluate(() => { globalThis.__requests = []; });
  const articlePage = await openFixture(articleHtml, 'https://x.com/reading-article');
  await articlePage.locator('#bx-sidebar-handle').click();
  await articlePage.locator('#bx-sidebar.bx-open').waitFor();
  await articlePage.locator('.bx-pair-dst.bx-done').first().waitFor({ timeout: 15000 });
  assert.equal(await articlePage.locator('.bx-pair').count(), 1, '首段先翻译完成');
  const earlyReqs = await translateRequests();
  assert(earlyReqs.length >= 1, '首段发出翻译请求');
  await articlePage.locator('.bx-pair').nth(1).waitFor({ state: 'attached', timeout: 25000 });
  await articlePage.locator('.bx-pair-dst.bx-done').nth(1).waitFor({ timeout: 15000 });
  const articleText = await articlePage.locator('#bx-body').innerText();
  assert(articleText.includes('Article paragraph one arrives first'), '第一段原文完整保留');
  assert(articleText.includes('Article paragraph two arrives later'), '第二段补译后原文完整出现');
  assert(articleText.includes('TAIL_MARK_ART_TWO'), '尾段尾部内容完整展示');
  assert((await translateRequests()).length >= 2, '动态补段必须触发补译请求');
  assert.equal(await articlePage.locator('.bx-pair').count(), 2, '两段对照齐全');
  await articlePage.screenshot({ path: path.join(out, 'reading-article-paras.png'), fullPage: true });
  say('PASS 文章正文延迟加载：先出半段、后补段落 → 补译出现、内容完整');

  // ─── ③a 单段 20,001 字符：明确中文错误（含 20001 与 20000），不发请求 ───
  const reqBefore = (await translateRequests()).length;
  const overPage = await openFixture(overHtml, 'https://x.com/reading-over');
  await overPage.locator('#bx-sidebar-handle').click();
  await overPage.locator('#bx-body .bx-error').waitFor({ timeout: 15000 });
  const overText = await overPage.locator('#bx-body').innerText();
  assert(overText.includes('20001'), `超限错误须含实际长度 20001：${overText.slice(0, 300)}`);
  assert(overText.includes('20000'), '超限错误须含上限 20000');
  assert(overText.includes('不会静默截断') || overText.includes('没有自动分段'), '错误说明不静默截断');
  await overPage.waitForTimeout(700);
  assert.equal((await translateRequests()).length, reqBefore, '超限不得发出任何模型请求');
  await overPage.screenshot({ path: path.join(out, 'reading-over-limit.png'), fullPage: true });
  say('PASS 按段对照无静默截断：20,001 字符报明确错误且 0 请求');

  // ─── ③b 长文尾部标记必须出现在请求里，全文完整展示 ───
  const longPage = await openFixture(longHtml, 'https://x.com/reading-long');
  await longPage.locator('#bx-sidebar-handle').click();
  await longPage.locator('.bx-pair-dst.bx-done').nth(1).waitFor({ timeout: 15000 });
  const longReqs = await translateRequests();
  assert(longReqs.some(req => req.input.includes(TAIL)), '长文尾部标记必须出现在翻译请求中');
  const longText = await longPage.locator('#bx-body').innerText();
  assert(longText.includes(TAIL), '长文尾部内容在对照区完整展示');
  assert.equal(await longPage.locator('.bx-pair').count(), 2, '长文两段对照齐全');
  await longPage.screenshot({ path: path.join(out, 'reading-article-complete.png'), fullPage: true });
  say('PASS 长文尾部标记进入请求、全文按段对照完整');

  // ─── ⑦ 编辑框误触发：contenteditable 里划选不弹词义浮窗、不送侧栏、不抢焦点 ───
  const editorPage = await openFixture(tweetsHtml, 'https://x.com/reading-editor', { waitEntry: true });
  await editorPage.locator('#ed').focus();
  await selectRange(editorPage, '#ed', 8, 12); // 'draf'（半词，但位于编辑框）
  await editorPage.waitForTimeout(500);
  assert.equal(await editorPage.locator('#bx-word-pop.bx-show').count(), 0, '编辑框划选不触发词义浮窗');
  assert.equal(await editorPage.locator('#bx-sidebar.bx-open').count(), 0, '编辑框划选不打开侧栏');
  assert.equal(await editorPage.locator('#bx-selection-bar.bx-show').count(), 0, '编辑框划选不显示选区条');
  assert.equal(await editorPage.evaluate(() => document.activeElement?.id), 'ed', '编辑框划选不得抢焦点');
  await editorPage.screenshot({ path: path.join(out, 'reading-editor-quiet.png'), fullPage: true });
  say('PASS 编辑框内划选：不弹窗、不送侧栏、不抢焦点');

  assert.deepEqual(pageErrors, [], `页面错误：${pageErrors.join(' | ')}`);
  say('READING_SMOKE_PASS');
  await context.close();
})().catch(error => { console.error(error); console.error(log.join('\n')); process.exit(1); });
