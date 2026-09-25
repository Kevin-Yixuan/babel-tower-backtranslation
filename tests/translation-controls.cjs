// Translation language and material picker acceptance; synthetic X and mock model only.
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const root = path.resolve(process.env.EXTENSION_ROOT || path.join(__dirname, '..'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-translation-controls-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    await worker.evaluate(async () => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set({
        openaiKey: 'test-placeholder-key',
        settings: { modelProvider: 'openai', targetLanguage: '英语', filterEnabled: false, filterRules: [], filterThreshold: 0.82, filterDailyLimit: 80 }
      });
      globalThis.__translateRequests = [];
      const original = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        if (String(url).includes('api.openai.com/v1/responses')) {
          const body = JSON.parse(options.body);
          globalThis.__translateRequests.push(body);
          const output = globalThis.__echoTranslation ? String(body.input).split('原文：\n').at(-1) : '这是中文译文。';
          return new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: output }] }] }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
          });
        }
        return original(url, options);
      };
    });
    const requests = () => worker.evaluate(() => globalThis.__translateRequests.slice());
    const page = await context.newPage();
    const full = 'Writing changes how we think. SECOND_SENTENCE stays in the original post but outside the first selected sentence.';
    await page.route('https://x.com/translation-controls', route => route.fulfill({ status: 200, contentType: 'text/html',
      body: `<!doctype html><html><body><main><article data-testid="tweet" id="a"><div data-testid="User-Name">Author</div><div data-testid="tweetText">${full}</div><a href="/author/status/9001">link</a><div role="group"></div></article></main></body></html>` }));
    await page.goto('https://x.com/translation-controls');
    await page.locator('#a .bx-inline-button').click();
    await page.waitForFunction(() => document.querySelector('.bx-pair-dst.bx-done'));
    assert.equal(await page.locator('#bx-read-source-language').inputValue(), '自动检测');
    assert.equal(await page.locator('#bx-read-target-language').inputValue(), '中文');
    const first = (await requests())[0];
    assert(first.input.includes(full) && first.input.includes('目标语言：中文'));
    assert(first.instructions.includes('译文必须使用中文'));
    const settings = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    assert.equal(settings.targetLanguage, '英语', '回复写作语言与阅读翻译分开');
    if (process.env.TRANSLATION_SCREENSHOT) await page.screenshot({ path: process.env.TRANSLATION_SCREENSHOT, fullPage: true });
    console.log('PASS English post defaults to Chinese translation independently of reply language');

    await worker.evaluate(() => { globalThis.__echoTranslation = true; });
    await page.locator('#bx-retranslate').click();
    await page.waitForFunction(() => document.querySelector('#bx-body')?.textContent?.includes('译文与原文完全相同'));
    assert.equal(await page.locator('.bx-pair-dst.bx-done').count(), 0, '原文回显不能当成成功译文');
    await worker.evaluate(() => { globalThis.__echoTranslation = false; });
    console.log('PASS unchanged model echo is reported instead of shown as translation');

    const countBeforeSame = (await requests()).length;
    await page.locator('#bx-read-target-language').selectOption('英语');
    await page.waitForFunction(() => document.querySelector('#bx-body')?.textContent?.includes('原文和目标语言都是英语'));
    assert.equal((await requests()).length, countBeforeSame, '同语言不调用模型');
    console.log('PASS same-language selection is stopped before model call');

    await page.locator('#bx-read-scope').selectOption('manual');
    await page.locator('#bx-read-source-language').selectOption('英语');
    await page.locator('#bx-read-target-language').selectOption('中文');
    const countBeforeManual = (await requests()).length;
    const manual = 'Only this pasted sentence should go to the model.';
    await page.locator('#bx-read-manual').fill(manual);
    await page.waitForTimeout(1100);
    assert.equal((await requests()).length, countBeforeManual, '手动输入期间不自动发送半成品');
    await page.locator('#bx-read-manual-submit').click();
    await page.waitForFunction(() => document.querySelector('.bx-pair-dst.bx-done'));
    const manualReq = (await requests()).at(-1);
    assert(manualReq.input.includes(manual) && !manualReq.input.includes('SECOND_SENTENCE'));
    assert.equal(await page.locator('.bx-pair-src').first().innerText(), manual);
    console.log('PASS manual input sends only the entered text after explicit click');

    await page.locator('#bx-read-swap').click();
    assert.equal(await page.locator('#bx-read-source-language').inputValue(), '中文');
    assert.equal(await page.locator('#bx-read-target-language').inputValue(), '英语');
    const saved = await worker.evaluate(async () => (await chrome.storage.local.get('readingPrefs')).readingPrefs);
    assert.deepEqual(saved, { source: '中文', target: '英语' });
    await page.reload();
    await page.locator('#bx-sidebar-handle').click();
    await page.waitForFunction(() => document.querySelector('#bx-read-source-language')?.value === '中文');
    assert.equal(await page.locator('#bx-read-target-language').inputValue(), '英语');
    console.log('PASS language swap persists across reload');

    await page.locator('#bx-read-source-language').selectOption('自动检测');
    await page.locator('#bx-read-target-language').selectOption('中文');
    const selected = 'Writing changes how we think.';
    await page.locator('#a [data-testid="tweetText"]').evaluate((el, length) => {
      const range = document.createRange(); range.setStart(el.firstChild, 0); range.setEnd(el.firstChild, length);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }, selected.length);
    await page.waitForFunction(() => document.querySelector('#bx-read-scope')?.value === 'selection'
      && document.querySelector('.bx-pair-src')?.textContent === 'Writing changes how we think.');
    await page.locator('.bx-pair-dst.bx-done').first().waitFor();
    const selectedReq = (await requests()).at(-1);
    assert(selectedReq.input.includes(selected) && !selectedReq.input.includes('SECOND_SENTENCE'));
    console.log('PASS mouse-selected sentence, not whole post, is translated');
  } finally {
    if (context) await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
