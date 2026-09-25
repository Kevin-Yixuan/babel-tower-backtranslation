// 审计对抗验收：真实加载扩展到独立 Edge profile，本地双帖/双编辑框仿真页。
// 模型 fetch 在 service worker 内受控 mock（延迟响应）——只证明消息链路与 UI 行为，不宣称真实模型成功。
// 不访问真实 x.com，不点击发布。
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const LONG_POST = 'Long X simulation material for truncation check. '.repeat(114) + 'TAIL_MARKER_XYZ_END';
const OVER_POST = 'x'.repeat(20001);

const flatHtml = `<!doctype html><html><body><main>
<article data-testid="tweet" id="a"><div data-testid="User-Name">Author A</div><div data-testid="tweetText">A post for writing a reply. This text is longer than forty characters so it can be filtered and selected.</div><a href="/a/status/111">link</a><div role="group"><button>Reply A</button></div></article>
<article data-testid="tweet" id="b"><div data-testid="User-Name">Author B</div><div data-testid="tweetText">B post about a completely different subject. This text is also over forty characters long.</div><a href="/b/status/222">link</a><div role="group"><button>Reply B</button></div></article>
<div id="edA" data-testid="tweetTextarea_0" contenteditable="true" role="textbox">A existing</div><div id="edB" data-testid="tweetTextarea_0" contenteditable="true" role="textbox">B existing</div>
</main></body></html>`;

const nestedHtml = `<!doctype html><html><body><main>
<article data-testid="tweet" id="a"><div data-testid="User-Name">Author A</div><div data-testid="tweetText">A post for writing a reply. This text is longer than forty characters so it can be filtered and selected.</div><a href="/a/status/111">link</a><div role="group"><button>Reply A</button></div><div id="edA" data-testid="tweetTextarea_0" contenteditable="true" role="textbox">A existing</div></article>
<article data-testid="tweet" id="b"><div data-testid="User-Name">Author B</div><div data-testid="tweetText">B post about a completely different subject. This text is also over forty characters long.</div><a href="/b/status/222">link</a><div role="group"><button>Reply B</button></div><div id="edB" data-testid="tweetTextarea_0" contenteditable="true" role="textbox">B existing</div></article>
</main></body></html>`;

const longHtml = `<!doctype html><html><body><main>
<article data-testid="tweet" id="long"><div data-testid="User-Name">Long Author</div><div data-testid="tweetText">${LONG_POST}</div><a href="/long/status/333">link</a><div role="group"><button>Reply</button></div></article>
<article data-testid="tweet" id="toolong"><div data-testid="User-Name">Huge Author</div><div data-testid="tweetText">${OVER_POST}</div><a href="/huge/status/444">link</a><div role="group"><button>Reply</button></div></article>
</main></body></html>`;


// 启动时清理 30 分钟前的本测试遗留 profile，防止临时盘写满。
(() => { try { for (const d of fs.readdirSync(os.tmpdir())) { if (/^(backwrite-x-smoke-|backwrite-x-writing-|bx-adversarial-|bx-workbench-|bx-debug)/.test(d)) { const p = path.join(os.tmpdir(), d); if (Date.now() - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } } } catch {} })();

(async () => {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'tests');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-adversarial-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const worker = await (async () => { for (let i = 0; i < 60; i++) { const w = context.serviceWorkers()[0]; if (w) return w; try { return await context.waitForEvent('serviceworker', { timeout: 500 }); } catch { /* retry */ } } throw new Error('service worker 未在 30s 内启动'); })();
  const extensionId = new URL(worker.url()).host;

  // 受控 mock：__hold=true 时请求挂起进队列，由测试逐个放行；记录请求形状。
  await worker.evaluate(async () => {
    await chrome.storage.local.set({ openaiKey: 'test-placeholder-key', settings: { model: 'gpt-6-luna', targetLanguage: '英语', filterEnabled: false, filterRules: [], filterThreshold: 0.82, filterDailyLimit: 80 } });
    globalThis.__pending = [];
    globalThis.__requests = [];
    globalThis.__hold = true;
    const wrap = payload => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: payload }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    globalThis.__wrap = wrap;
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('api.openai.com/v1/responses')) {
        const request = JSON.parse(options.body);
        globalThis.__requests.push({ name: request.text?.format?.name || 'plain', input: String(request.input || '') });
        if (globalThis.__hold) return new Promise(resolve => globalThis.__pending.push({ resolve, request }));
        const name = request.text?.format?.name;
        const text = name === 'generate_reply' ? JSON.stringify({ draft: 'INSTANT DRAFT', note: 'n' })
          : name === 'prepare_practice' ? JSON.stringify({ chinese: '中文练习题。', context: '情境', focus: 'focus' })
          : JSON.stringify({ meaningOk: true, meaningNote: 'm', grammarOk: true, grammarNote: '无语法问题', summary: 's', points: [] });
        return wrap(text);
      }
      return new Response('{}', { status: 200 });
    };
  });
  // 放行一条挂起请求；payload 是该请求类型的响应内容（generate 用 draft 文本，check 用固定反馈）。
  const releaseHold = async draftText => {
    const released = await worker.evaluate(p => {
      const queue = globalThis.__pending;
      if (!queue.length) return false;
      const { resolve, request } = queue.shift();
      const name = request.text?.format?.name;
      const text = name === 'generate_reply' ? JSON.stringify({ draft: p, backtranslation: `中文回译：${p}`, meaningRisk: '无明显风险：内容来自用户输入。', suggestions: [], followUp: [], note: 'late' })
        : name === 'prepare_practice' ? JSON.stringify({ chinese: '中文练习题。', context: '情境', focus: 'focus' })
        : name === 'check_reply' ? JSON.stringify({ draft: 'Checked complete reply based on user draft.', backtranslation: '中文回译：检查后的完整回复。', meaningRisk: '无明显风险：按当时作答。', suggestions: [{ point: '按当时作答的片段', problem: '可再自然一些', fix: '按反馈方向微调' }], followUp: ['如对方回应，可继续举例。'], note: '当时无问题。' })
        : JSON.stringify({ meaningOk: true, meaningNote: 'm', grammarOk: true, grammarNote: '无语法问题', summary: 's', points: [] });
      resolve(globalThis.__wrap(text));
      return true;
    }, draftText);
    assert(released, `应有挂起请求可放行（draftText=${draftText}）`);
  };
  const pendingCount = () => worker.evaluate(() => globalThis.__pending.length);
  const requestsNamed = name => worker.evaluate(n => globalThis.__requests.filter(r => r.name === n), name);
  const waitPending = async (expected = 1) => {
    for (let i = 0; i < 60; i++) {
      if ((await pendingCount()) >= expected) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error(`等待挂起请求超时（期望 ≥${expected}）`);
  };
  const pageErrors = [];
  const openFixture = async (html, url) => {
    const page = await context.newPage();
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.route(url, route => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
    await page.goto(url);
    await page.locator('.bx-inline-button').first().waitFor({ timeout: 15000 });
    return page;
  };

  // ─── 1. 平铺双编辑框：审计复现（打开A → 聚焦B → 插入）必须拒绝写入，仅复制 ───
  const flat = await openFixture(flatHtml, 'https://x.com/fixture-flat');
  await flat.locator('#a .bx-inline-button').click();
  await flat.locator('[data-bx-mode="write"]').click();
  await flat.locator('#bx-idea').fill('我想回应A');
  await flat.locator('#bx-draft').fill('Reply written for A');
  await flat.locator('#edB').focus();
  await flat.locator('#bx-insert').click();
  const refuseBox = flat.locator('.bx-insert-blocked');
  await refuseBox.waitFor();
  const refuseText = await refuseBox.innerText();
  assert(refuseText.includes('Author A'), `拒绝框需显示回复对象：${refuseText}`);
  assert(refuseText.includes('复制'), '拒绝时必须提供复制');
  assert.equal(await refuseBox.locator('#bx-insert-confirm').count(), 0, '拒绝时不得有确认写入按钮');
  await refuseBox.locator('#bx-copy-inline').click();
  await flat.waitForTimeout(300);
  assert.equal(await flat.locator('#edA').innerText(), 'A existing', 'A 编辑框未被触碰');
  assert.equal(await flat.locator('#edB').innerText(), 'B existing', '审计复现：不得写入 B');
  console.log('FLAT_AUDIT_REPLAY_REFUSED');
  await flat.screenshot({ path: path.join(out, 'adv-refuse-flat.png'), fullPage: true });
  await flat.close();

  // ─── 2. 帖内编辑框：预览A → 聚焦B → 确认只写A；已有文字追加；目标移除后拒绝 ───
  const nested = await openFixture(nestedHtml, 'https://x.com/fixture-nested');
  await nested.locator('#a .bx-inline-button').click();
  await nested.locator('[data-bx-mode="write"]').click();
  await nested.locator('#bx-idea').fill('我想回应A');
  await nested.locator('#edA').focus();
  await nested.locator('#bx-draft').fill('Reply written for A');
  await nested.locator('#bx-insert').click();
  const confirmBox = nested.locator('.bx-insert-confirm:not(.bx-insert-blocked)');
  await confirmBox.waitFor();
  const preview = await confirmBox.innerText();
  assert(preview.includes('将插入到：'), '预览标题');
  assert(preview.includes('Author A'), `预览必须是 A：${preview}`);
  assert(preview.includes('A post for writing'), '预览含帖子前40字');
  // 预览后聚焦 B —— 绑定已冻结，不得改写目标
  await nested.locator('#edB').focus();
  await confirmBox.locator('#bx-insert-confirm').click();
  const textA = await nested.locator('#edA').innerText();
  const textB = await nested.locator('#edB').innerText();
  assert(textA.includes('A existing') && textA.includes('Reply written for A'), `A 应保留原文并追加：${textA}`);
  assert(textA.indexOf('A existing') < textA.indexOf('Reply written for A'), '原文在前、草稿在后（追加不覆盖）');
  assert.equal(textB, 'B existing', '聚焦 B 后确认，B 不得被写入');
  console.log('NESTED_PREVIEW_A_FOCUS_B_WRITE_A_APPEND_OK');
  await nested.screenshot({ path: path.join(out, 'adv-nested-insert.png'), fullPage: true });

  // 目标移除后：安全拒绝（不写入任何框）
  await nested.locator('#bx-draft').fill('Second draft after removal');
  await nested.locator('#bx-insert').click();
  await nested.locator('#edA').evaluate(el => el.remove());
  const confirmAgain = nested.locator('.bx-insert-confirm:not(.bx-insert-blocked)');
  await confirmAgain.waitFor();
  await confirmAgain.locator('#bx-insert-confirm').click();
  const afterRemove = await nested.locator('#bx-body').innerText();
  assert(afterRemove.includes('已不可用') || afterRemove.includes('未写入'), `目标移除后必须安全拒绝：${afterRemove.slice(0, 300)}`);
  assert.equal(await nested.locator('#edB').innerText(), 'B existing', '拒绝路径不得写 B');
  console.log('REMOVED_TARGET_REFUSED');
  await nested.close();

  // ─── 3. 在途模型保护 ───
  const race = await openFixture(flatHtml, 'https://x.com/fixture-race');
  await race.locator('#a .bx-inline-button').click();
  await race.locator('[data-bx-mode="write"]').click();
  await race.locator('#bx-idea').fill('想法');
  await race.locator('#bx-generate').click();
  await waitPending(1);
  await race.locator('#bx-draft').fill('I changed this while waiting');
  await releaseHold('STALE MODEL ANSWER');
  await race.locator('.bx-candidate').waitFor({ timeout: 8000 });
  assert.equal(await race.locator('#bx-draft').inputValue(), 'I changed this while waiting', 'W01：旧结果不得覆盖新输入');
  assert((await race.locator('.bx-candidate').innerText()).includes('STALE MODEL ANSWER'), '旧结果进入候选区');
  await race.locator('#bx-dismiss-candidate').click();
  assert.equal(await race.locator('#bx-draft').inputValue(), 'I changed this while waiting');
  console.log('W01_CANDIDATE_NO_OVERWRITE');

  // 取消：晚到响应被丢弃
  await race.locator('#bx-generate').click();
  await waitPending(1);
  await race.locator('#bx-cancel-request').click();
  await releaseHold('SHOULD_BE_DISCARDED');
  await race.waitForTimeout(500);
  assert.equal(await race.locator('#bx-draft').inputValue(), 'I changed this while waiting', '取消后晚到结果被丢弃');
  assert(!(await race.locator('#bx-body').innerText()).includes('SHOULD_BE_DISCARDED'), '被取消结果不进候选不进正文');
  console.log('CANCEL_DISCARDS_LATE_RESULT');

  // 切换帖子：晚到响应被丢弃
  await race.locator('#bx-generate').click();
  await waitPending(1);
  await race.locator('#bx-close').click();
  await race.locator('#b .bx-inline-button').click(); // openArticle 切到 B（模式回到 read）
  await releaseHold('POST_SWITCH_RESULT');
  await race.waitForTimeout(500);
  await race.locator('[data-bx-mode="write"]').click();
  assert.equal(await race.locator('#bx-draft').inputValue(), '', '切到 B 后不得带入 A 的草稿');
  await race.locator('#a .bx-entry-reply').click();
  assert.equal(await race.locator('#bx-draft').inputValue(), 'I changed this while waiting', '返回 A 时原稿仍在');
  await race.locator('#b .bx-entry-reply').click();
  assert((await race.locator('#bx-body').innerText()).includes('已切换回复对象'), '切帖有明确提示');
  console.log('POST_SWITCH_DISCARDS_LATE_RESULT');

  // 检查反馈不得挂到已变化的输入
  await race.locator('#bx-draft').fill('Draft for check');
  await race.locator('#bx-check-reply').click();
  await waitPending(1);
  await race.locator('#bx-draft').fill('Edited during check');
  await releaseHold('feedback');
  await race.waitForTimeout(500);
  assert.equal(await race.locator('#bx-feedback').count(), 0, '输入变化后反馈不渲染');
  assert((await race.locator('#bx-body').innerText()).includes('已忽略'), '反馈过期有提示');
  console.log('W01_STALE_FEEDBACK_NOT_ATTACHED');

  // IME 组合态：组合期间响应不得重建正在输入的编辑框
  console.log('IME_STEP open A');
  await race.locator('#a .bx-inline-button').click();
  await race.locator('[data-bx-mode="write"]').click();
  console.log('IME_STEP fill idea');
  await race.locator('#bx-idea').fill('中文想法');
  await race.locator('#bx-draft').focus();
  console.log('IME_STEP compositionstart');
  await race.locator('#bx-draft').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  // 在节点上打标记：若渲染重建了 textarea，标记会丢失。
  await race.locator('#bx-draft').evaluate(el => { el.dataset.imeMarker = 'alive'; });
  console.log('IME_STEP generate click');
  await race.locator('#bx-generate').click();
  console.log('IME_STEP wait pending');
  await waitPending(1);
  console.log('IME_STEP release');
  await releaseHold('IME_APPLIED');
  await race.waitForTimeout(400);
  console.log('IME_STEP check marker');
  const marker = await race.locator('#bx-draft').evaluate(el => el.dataset.imeMarker || '');
  assert.equal(marker, 'alive', 'IME 组合期间不得重建编辑框');
  console.log('IME_STEP compositionend');
  await race.locator('#bx-draft').evaluate(el => el.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  await race.waitForTimeout(300);
  const afterIme = (await race.locator('#bx-body').innerText()) + (await race.locator('#bx-draft').inputValue());
  assert(afterIme.includes('IME_APPLIED'), '组合结束后渲染恢复（结果可见）');
  console.log('IME_COMPOSITION_NOT_REBUILT');
  await race.screenshot({ path: path.join(out, 'adv-ime-candidate.png'), fullPage: true });
  await race.close();

  // ─── 4. 长材料：5000 字尾部标记必须在请求中；20001 明确报错且不发请求 ───
  await worker.evaluate(() => { globalThis.__hold = false; });
  const longPage = await openFixture(longHtml, 'https://x.com/fixture-long');
  await longPage.locator('#long .bx-inline-button').click();
  await longPage.locator('[data-bx-mode="practice"]').click();
  await longPage.locator('#bx-create-practice').click();
  await longPage.locator('#bx-answer').waitFor({ timeout: 15000 });
  const practiceReqs = await requestsNamed('prepare_practice');
  assert(practiceReqs.length >= 1, '发出过 prepare_practice');
  assert(practiceReqs.at(-1).input.includes('TAIL_MARKER_XYZ_END'), 'W06：5000 字帖尾部标记必须仍在请求中');
  console.log('LONG_POST_TAIL_IN_REQUEST');

  await longPage.locator('#toolong .bx-inline-button').click();
  await longPage.locator('[data-bx-mode="practice"]').click();
  const reqCountBefore = (await requestsNamed('prepare_practice')).length;
  await longPage.locator('#bx-create-practice').click();
  await longPage.waitForTimeout(700);
  const practiceText = await longPage.locator('#bx-body').innerText();
  assert(practiceText.includes('20001'), `超限提示需含实际长度：${practiceText.slice(0, 300)}`);
  assert(practiceText.includes('20000'), '超限提示需含上限');
  assert(practiceText.includes('没有自动分段'), '说明当前没有自动分段');
  assert.equal((await requestsNamed('prepare_practice')).length, reqCountBefore, '超限不得发出请求');
  console.log('OVER_LIMIT_CLEAR_ERROR_NO_REQUEST');
  await longPage.screenshot({ path: path.join(out, 'adv-over-limit.png'), fullPage: true });
  await longPage.close();

  assert.deepEqual(pageErrors, [], `页面错误：${pageErrors.join(' | ')}`);
  console.log('ADVERSARIAL_SMOKE_PASS');
  await context.close();
})().catch(error => { console.error(error); process.exit(1); });
