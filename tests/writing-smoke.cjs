const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 本地工作台浏览器验收：不触碰真实 x.com，不读真实密钥；模型 fetch 在 service worker 内 mock。

// 启动时清理 30 分钟前的本测试遗留 profile，防止临时盘写满。
(() => { try { for (const d of fs.readdirSync(os.tmpdir())) { if (/^(backwrite-x-smoke-|backwrite-x-writing-|bx-adversarial-|bx-workbench-|bx-debug)/.test(d)) { const p = path.join(os.tmpdir(), d); if (Date.now() - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } } } catch {} })();

(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'backwrite-x-writing-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const worker = await (async () => { for (let i = 0; i < 60; i++) { const w = context.serviceWorkers()[0]; if (w) return w; try { return await context.waitForEvent('serviceworker', { timeout: 500 }); } catch { /* retry */ } } throw new Error('service worker 未在 30s 内启动'); })();
  const extensionId = new URL(worker.url()).host;
  const errors = [];

  // Mock 模型接口：记录请求形状，验证任务名与输入长度；不使用真实密钥。
  await worker.evaluate(() => {
    globalThis.__writingLastRequest = null;
    globalThis.__writingRequests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('api.openai.com/v1/responses')) {
        const request = JSON.parse(options.body);
        globalThis.__writingLastRequest = request;
        globalThis.__writingRequests.push({ name: request.text?.format?.name || '', inputLength: String(request.input || '').length, input: String(request.input || '') });
        const name = request.text?.format?.name;
        const text = name === 'learn_expressions' ? JSON.stringify({ expressions: [
          { text: 'make thinking visible', kind: 'structure', note: '把抽象过程写成具体效果，适合开场。' },
          { text: 'changes how you act', kind: 'sentence', note: '表达观点影响行为而非仅认知。' }
        ] })
          : name === 'generate_reply' ? JSON.stringify({ draft: 'I agree—writing helps me clarify what I think.', backtranslation: '我同意——写作帮助我厘清自己的想法。', meaningRisk: '无明显风险：观点均来自用户想法。', suggestions: [{ point: '开头', problem: '可再简洁', fix: '保留一个核心观点即可' }], followUp: ['对方回应后可以补充一个具体例子。'], note: '保持友好、简洁。' })
          : name === 'check_writing' ? JSON.stringify({
            meaningOk: true, meaningNote: '主题清楚，读者能明白你在写什么。',
            grammarOk: false, grammarNote: '发现 1 处语法问题：主谓一致。',
            summary: '整体可读，修一处语法更好。',
            points: [
              { kind: 'fix', span: 'He go to school', reason: '第三人称单数动词缺 s。', direction: '改为 He goes to school。' },
              { kind: 'polish', span: 'very good', reason: '略显笼统。', direction: '换成更具体的评价词。' }
            ]
          })
          : '这句话以 Writing 为主语，用 is 连接后面的说明。';
        return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url, options);
    };
  });

  // 需要先在设置里写入测试密钥（占位符，非真实密钥），runAI 才会放行。
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#provider-key').fill('test-placeholder-key');
  await popup.locator('#save-main').click();
  await popup.locator('#status').getByText('已保存').waitFor({ timeout: 8000 });

  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`chrome-extension://${extensionId}/writing.html`);
  await page.locator('#w-body').waitFor();

  // ── 2. 自由写作工作台：输入 → 刷新 → 内容仍在 ──
  await page.locator('#w-title').fill('A note on writing');
  await page.locator('#w-body').fill('Writing helps me think clearly. He go to school every day.');
  await page.waitForTimeout(1400); // 等待 700ms 防抖自动保存
  assert((await page.locator('#w-save-state').innerText()).includes('已自动保存'));
  await page.reload();
  await page.locator('#w-body').waitFor();
  assert((await page.locator('#w-body').inputValue()).includes('Writing helps me think clearly'), '刷新后正文仍在');
  assert.equal(await page.locator('#w-title').inputValue(), 'A note on writing');
  await page.screenshot({ path: path.join(root, 'tests', 'writing-workbench.png'), fullPage: true });
  assert.equal(await page.locator('#w-authored').isChecked(), false, '未确认来源的草稿不得默认算亲写');
  await page.locator('#w-authored').check();
  await page.waitForTimeout(1000);
  assert.equal((await worker.evaluate(async () => (await chrome.storage.local.get('writingDrafts')).writingDrafts))[0].authoredByUser, true, '明确确认后才标为亲写');
  await page.locator('#w-body').fill('Writing helps me think clearly. He go to school every day. Revised.');
  await page.waitForTimeout(1000);
  assert.equal(await page.locator('#w-authored').isChecked(), false, '正文变动后必须重新确认来源');
  assert.equal((await worker.evaluate(async () => (await chrome.storage.local.get('writingDrafts')).writingDrafts))[0].authoredByUser, false);

  // ── 3. 参考文章：19,000 字符不报错；20,001 得到明确中文错误 ──
  const longOk = 'Writing is thinking made visible. '.repeat(600).slice(0, 19000);
  assert.equal(longOk.length, 19000);
  await page.locator('#w-reference').fill(longOk);
  await page.waitForTimeout(200);
  assert(!(await page.locator('#w-ref-count').innerText()).includes('超过'), '19000 计数不标超限');
  await page.locator('#w-learn').click();
  await page.locator('#w-learn-results:not([hidden])').waitFor({ timeout: 15000 });
  assert((await page.locator('#w-learn-results').innerText()).includes('make thinking visible'), '学习结果渲染');
  // 记录后台实际收到的参考材料长度（基线 clean(2500) 会截断——如实记录，归 integration 修复）
  const learnReq = await worker.evaluate(() => globalThis.__writingRequests.find(r => r.name === 'learn_expressions') || null);
  assert(learnReq, '应发出 learn_expressions 请求');
  assert(learnReq.inputLength >= 19000, `19,000 字符不得被截断，请求实际 ${learnReq.inputLength} 字符`);
  assert(learnReq.input.includes(longOk.slice(-60)), '参考文尾部内容必须仍在请求中');
  console.log(`[evidence] learn_expressions inputLength=${learnReq.inputLength}（UI 输入 19000，无截断）`);

  // 一键收藏（SAVE_CARD）
  await page.locator('[data-save-expr="0"]').click();
  await page.waitForTimeout(400);

  // 超限：20,001 字符 → 明确中文错误（含实际长度与上限），不静默截断输入框
  const tooLong = 'a'.repeat(20001);
  await page.locator('#w-reference').fill(tooLong);
  await page.waitForTimeout(300);
  const overStatus = await page.locator('#w-status').innerText();
  assert(overStatus.includes('20001') || overStatus.includes('20,001'), `超限提示需含实际长度，实际：${overStatus}`);
  assert(overStatus.includes('20000') || overStatus.includes('20,000'), `超限提示需含上限，实际：${overStatus}`);
  assert.equal((await page.locator('#w-reference').inputValue()).length, 20001, '输入框内容不得被截断');
  // 点击仍可得到明确错误（不禁用成“没反应”）
  await page.locator('#w-learn').click();
  await page.waitForTimeout(300);
  const clickStatus = await page.locator('#w-status').innerText();
  assert(clickStatus.includes('20001') || clickStatus.includes('20,001'), `点击后错误需含实际长度，实际：${clickStatus}`);
  await page.screenshot({ path: path.join(root, 'tests', 'writing-over-limit.png'), fullPage: true });

  // ── 4. 分层反馈：三个区块 ──
  await page.locator('#w-reference').fill('');
  await page.locator('#w-body').fill('Writing helps me think clearly. He go to school every day and it was very good.');
  await page.locator('#w-check').click();
  await page.locator('#w-feedback-block:not([hidden])').waitFor({ timeout: 15000 });
  const layers = page.locator('#w-feedback .w-layer');
  assert.equal(await layers.count(), 3, '反馈必须分三个区块');
  const fbText = await page.locator('#w-feedback').innerText();
  assert(fbText.includes('意思是否传达'));
  assert(fbText.includes('语法问题'));
  assert(fbText.includes('表达润色'));
  assert(fbText.includes('主谓一致'), '第二层含语法问题内容');
  assert(fbText.includes('需要修正') && fbText.includes('可以优化'), '第三层含 fix/polish 点');
  const checkReq = await worker.evaluate(() => globalThis.__writingRequests.find(r => r.name === 'check_writing') || null);
  assert(checkReq, '应发出 check_writing 请求');
  await page.screenshot({ path: path.join(root, 'tests', 'writing-feedback.png'), fullPage: true });

  // ── 清空二次确认 ──
  let clearDialogs = 0;
  page.on('dialog', async dialog => {
    clearDialogs += 1;
    assert(dialog.message().includes('清空'), `确认文案：${dialog.message()}`);
    await dialog.accept();
  });
  await page.locator('#w-clear').click();
  await page.waitForTimeout(600);
  assert(clearDialogs >= 2, `清空需要两次确认，实际弹出 ${clearDialogs} 次`);
  assert.equal(await page.locator('#w-body').inputValue(), '', '二次确认后正文清空');
  assert.equal(await page.locator('#w-reference').inputValue(), '');

  // ── 旧数据超过 20 条：载入不裁剪不覆盖；满额阻止新建 ──
  await worker.evaluate(async () => {
    const drafts = Array.from({ length: 22 }, (_, i) => ({ id: `d${i}`, title: `t${i}`, body: `b${i}`, reference: '', updatedAt: new Date(Date.now() + i * 1000).toISOString() }));
    await chrome.storage.local.set({ writingDrafts: drafts });
  });
  await page.reload();
  await page.locator('#w-draft-list').waitFor();
  const draftItems = await page.locator('#w-draft-list li').count();
  assert.equal(draftItems, 22, `超过 20 条的旧数据不得被静默裁剪，实际 ${draftItems}`);
  const storedDrafts = await worker.evaluate(async () => (await chrome.storage.local.get('writingDrafts')).writingDrafts);
  assert.equal(storedDrafts.length, 22, 'storage 中也不得裁剪');
  assert(storedDrafts.some(d => d.body === 'b0'), '最旧草稿正文必须保留（W04）');
  await page.locator('#w-new').click();
  assert((await page.locator('#w-status').innerText()).includes('上限'), '满额新建必须提示上限');
  assert.equal(await page.locator('#w-draft-list li').count(), 22, '第 21+ 次新建被阻止，条数不变');
  console.log(`[evidence] writingDrafts legacy load kept = ${draftItems}, new-draft blocked`);

  // ── 1. 回复入口 + 5. 安全插入：走本地 fixture 页 ──
  await page.route('https://x.com/backwrite-fixture', route => route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8') }));
  await page.goto('https://x.com/backwrite-fixture');
  await page.locator('.bx-inline-button').waitFor({ timeout: 15000 });
  await page.locator('.bx-inline-button').click();
  await page.locator('#bx-sidebar.bx-open').waitFor();
  await page.locator('[data-bx-mode="write"]').click();
  await page.locator('#bx-idea').fill('我同意，写作让思考变清晰。');
  await page.locator('#bx-generate').click();
  await page.locator('#bx-draft').waitFor();
  assert((await page.locator('#bx-draft').inputValue()).length > 0, '生成后草稿有内容');
  // 生成中/生成后手动改，内容保留
  await page.locator('#bx-draft').fill('Edited by hand after generation.');
  // 模拟生成失败：改 mock 返回 500，再点生成，确认想法与草稿不清空
  await worker.evaluate(() => {
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('api.openai.com/v1/responses')) {
        return new Response(JSON.stringify({ error: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    };
  });
  await page.locator('#bx-generate').click();
  await page.waitForTimeout(800);
  assert((await page.locator('#bx-idea').inputValue()).includes('写作让思考变清晰'), '生成失败不清空想法');
  assert((await page.locator('#bx-draft').inputValue()).includes('Edited by hand after generation'), '生成失败不清空草稿');
  assert((await page.locator('#bx-body').innerText()).includes('请求失败') || (await page.locator('#bx-body').innerText()).includes('失败'), '失败有提示');

  // 恢复成功 mock，走插入确认
  await worker.evaluate(() => {
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('api.openai.com/v1/responses')) {
        return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ draft: 'I agree—writing clarifies thought.', note: '简洁。' }) }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response('{}', { status: 200 });
    };
  });
  await page.locator('#bx-draft').fill('I agree—writing clarifies thought. Final wording.');
  await page.locator('#bx-insert').click();
  await page.locator('.bx-insert-confirm').waitFor();
  const preview = await page.locator('.bx-insert-confirm').innerText();
  assert(preview.includes('将插入到：'), '插入预览');
  assert(preview.includes('Dan Koe') || preview.includes('@'), '预览含作者');
  assert(preview.includes('Writing is thinking'), '预览含帖子前 40 字');
  await page.locator('#bx-insert-confirm').click();
  const editorText = await page.locator('[data-testid="tweetTextarea_0"]').innerText();
  assert(editorText.includes('Existing draft line that must survive.'), '原文字仍在');
  assert(editorText.includes('Final wording'), '新文字在末尾');
  assert(editorText.indexOf('Existing') < editorText.indexOf('Final wording'), '顺序：原文在前');
  // 复制按钮存在
  await page.locator('[data-bx-mode="write"]').click();
  assert(await page.locator('#bx-copy-draft').isVisible(), '复制按钮兜底存在');
  await page.screenshot({ path: path.join(root, 'tests', 'write-insert-preview.png'), fullPage: true });

  assert.deepEqual(errors, []);
  console.log('Writing workbench smoke passed.');
  await context.close();
})().catch(error => { console.error(error); process.exit(1); });
