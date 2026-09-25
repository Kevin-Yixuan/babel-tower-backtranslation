const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');


// 启动时清理 30 分钟前的本测试遗留 profile，防止临时盘写满。
(() => { try { for (const d of fs.readdirSync(os.tmpdir())) { if (/^(backwrite-x-smoke-|backwrite-x-writing-|bx-adversarial-|bx-workbench-|bx-debug)/.test(d)) { const p = path.join(os.tmpdir(), d); if (Date.now() - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } } } catch {} })();

(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'backwrite-x-smoke-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://x.com/backwrite-fixture', route => route.fulfill({ status: 200, contentType: 'text/html', body: fs.readFileSync(path.join(__dirname, 'fixture.html'), 'utf8') }));
  await page.goto('https://x.com/backwrite-fixture');
  await page.locator('.bx-inline-button').waitFor({ timeout: 15000 });
  await page.locator('.bx-inline-button').click();
  await page.locator('#bx-sidebar.bx-open').waitFor();
  assert((await page.locator('#bx-body').innerText()).includes('Writing is thinking'));
  await page.waitForTimeout(250);
  await page.screenshot({ path: path.join(root, 'tests', 'panel-preview.png'), fullPage: true });
  await page.locator('[data-bx-mode="write"]').click();
  await page.locator('#bx-idea').fill('我同意，写作能帮助我澄清想法。');
  assert(!(await page.locator('#bx-generate').isDisabled()));
  await page.locator('#bx-close').click();
  await page.locator('#bx-sidebar-handle').click();
  assert((await page.locator('#bx-idea').inputValue()).includes('澄清想法'));
  const worker = await (async () => { for (let i = 0; i < 60; i++) { const w = context.serviceWorkers()[0]; if (w) return w; try { return await context.waitForEvent('serviceworker', { timeout: 500 }); } catch { /* retry */ } } throw new Error('service worker 未在 30s 内启动'); })();
  await worker.evaluate(() => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('api.typesafe.ai/v1/systemone')) {
        return new Response(JSON.stringify({ model: 'jev-latest', answers: { rule_0: { type: 'noul', noul: 0.93 } }, usage: { input_tokens: 55, output_tokens: 2 } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (String(url).includes('api.openai.com/v1/responses')) {
        const request = JSON.parse(options.body);
        const name = request.text?.format?.name;
        const text = name === 'prepare_practice' ? JSON.stringify({ chinese: '写作让思考变得可见。', context: 'X 上的写作观点', focus: '主谓结构' })
          : name === 'check_practice' || name === 'check_reply' ? JSON.stringify({ meaningOk: true, meaningNote: '意思已传达。', grammarOk: true, grammarNote: '无语法问题。', summary: '意思和语法都成立。', points: [{ kind: 'keep', span: 'Writing makes thinking visible.', reason: '自然表达。', direction: '可以保留。' }] })
          : name === 'generate_reply' ? JSON.stringify({ draft: 'I agree—writing helps me clarify what I think.', backtranslation: '我同意——写作帮助我厘清自己的想法。', meaningRisk: '无明显风险：观点均来自用户想法。', suggestions: [{ point: '开头', problem: '可再简洁', fix: '保留一个核心观点即可' }], followUp: ['对方回应后可以补充一个具体例子。'], note: '保持友好、简洁。' })
          : '这句话以 Writing 为主语，用 is 连接后面的说明。';
        return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return originalFetch(url, options);
    };
  });
  const extensionId = new URL(worker.url()).host;
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 372, height: 620 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('#provider-key').waitFor();
  assert(!(await popup.locator('#status').innerText()).includes('此操作只允许'));
  await popup.screenshot({ path: path.join(root, 'tests', 'popup-preview.png') });
  await popup.locator('[data-tab="filters"]').click();
  await popup.locator('#add-rule').click();
  await popup.locator('[data-rule-text="0"]').fill('折叠只为引战、没有实质信息的帖子');
  assert.equal(await popup.locator('.rule').count(), 1);
  await popup.locator('#save-filter').click();
  await popup.locator('#status').getByText('已保存').waitFor({ timeout: 8000 });
  await popup.locator('[data-tab="dictionary"]').click();
  await popup.locator('#glossary-file').setInputFiles({ name: 'words.tsv', mimeType: 'text/tab-separated-values', buffer: Buffer.from('writing\t写作\n') });
  await popup.locator('#glossary-count').getByText('已导入 1 个词条').waitFor();
  await page.locator('[data-bx-mode="read"]').click();
  await page.locator('#bx-word').fill('writing');
  await page.locator('#bx-lookup').click();
  try {
    await page.locator('.bx-result').getByText('写作').waitFor({ timeout: 5000 });
  } catch (error) {
    console.error('Lookup panel:', await page.locator('#bx-body').innerText());
    throw error;
  }
  await popup.locator('[data-tab="home"]').click();
  await popup.locator('#provider-key').fill('test-key');
  await popup.locator('[data-tab="filters"]').click();
  await popup.locator('#jev-key').fill('test-jev-key');
  await popup.locator('#filter-enabled').check();
  await popup.locator('#save-filter').click();
  await page.reload();
  // 折叠后按钮会被隐藏，等 attached 即可，避免与 Jev 折叠竞态
  await page.locator('.bx-inline-button').waitFor({ state: 'attached' });
  try { await page.locator('.bx-collapsed').waitFor({ timeout: 10000 }); }
  catch (error) {
    console.error('Filter status:', await popup.locator('#status').innerText());
    console.error('Post state:', await page.locator('article').first().evaluate(node => ({ filtered: node.dataset.bxFiltered, html: node.outerHTML.slice(0, 700) })));
    console.error('Stored settings:', await worker.evaluate(async () => (await chrome.storage.local.get(['settings', 'jevKey'])).settings));
    throw error;
  }
  await page.locator('.bx-collapse-bar button').click();
  assert(await page.locator('[data-testid="tweetText"]').isVisible());
  await page.locator('.bx-inline-button').click();
  await page.locator('[data-bx-mode="practice"]').click();
  await page.locator('#bx-create-practice').click();
  await page.locator('#bx-answer').waitFor();
  await page.locator('#bx-answer').fill('Writing makes thinking visible.');
  await page.locator('#bx-check-practice').click();
  await page.locator('.bx-feedback').first().waitFor();
  assert((await page.locator('.bx-feedback').first().innerText()).includes('意思和语法都成立'));
  await page.locator('[data-bx-mode="write"]').click();
  await page.locator('#bx-idea').fill('我同意，写作帮助我澄清想法。');
  await page.locator('#bx-generate').click();
  await page.locator('#bx-draft').waitFor();
  assert((await page.locator('#bx-draft').inputValue()).includes('writing helps me'));
  // 生成后继续手动修改，内容不丢
  await page.locator('#bx-draft').fill('writing helps me clarify ideas. Hand-edited after generation.');
  assert((await page.locator('#bx-draft').inputValue()).includes('Hand-edited'));
  // 插入前显示目标预览；已有文字时确认后追加到末尾，不覆盖原文
  await page.locator('#bx-insert').click();
  const confirmBox = page.locator('.bx-insert-confirm');
  await confirmBox.waitFor();
  assert((await confirmBox.innerText()).includes('将插入到：'), '必须显示插入目标预览');
  assert((await confirmBox.innerText()).includes('Writing is thinking'), '预览需含帖子前 40 字');
  await page.locator('#bx-insert-confirm').click();
  const editorText = await page.locator('[data-testid="tweetTextarea_0"]').innerText();
  assert(editorText.includes('Existing draft line that must survive.'), '原文字必须保留');
  assert(editorText.includes('Hand-edited after generation'), '新文字追加在末尾');
  assert(editorText.indexOf('Existing') < editorText.indexOf('Hand-edited'), '原文在前、草稿在后');
  assert.deepEqual(errors, []);
  console.log('Extension UI smoke passed.');
  await context.close();
})().catch(error => { console.error(error); process.exit(1); });
