// Real MV3 extension + isolated Edge + synthetic X. Only external fetch is replaced.
// EXTENSION_ROOT can point at an extracted candidate; UX_ONLY selects one regression.
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(process.env.EXTENSION_ROOT || path.join(__dirname, '..'));
const A = 'A new sentence selected by the user. The rest of this original post stays outside the selected sentence.';
const B = 'Another post has unrelated source material and must never inherit the first post draft or selection.';
const article = (id, text, name = 'alpha') => `<article data-testid="tweet" id="p${id}"><div data-testid="User-Name">${name}</div><div data-testid="tweetText">${text}</div><a href="/${name}/status/${id}"><time>Today</time></a><div role="group"></div></article>`;
const html = body => `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:20px;font:16px sans-serif}main{max-width:700px}article{padding:12px;margin:15px 0;border:1px solid #ccc}[contenteditable]{min-height:60px;border:1px solid #777}#dialog{margin-top:20px}</style></head><body><main>${body}</main></body></html>`;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-ux-'));
  let context;
  const results = [];
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: true, viewport: { width: 1440, height: 1100 },
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    context.setDefaultTimeout(8000);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extensionId = new URL(worker.url()).host;
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ apiKeys: { openai: 'ux-test-placeholder' }, settings: {
        modelProvider: 'openai', autoTranslate: false, hoverLookup: true,
        providers: { openai: { label: 'OpenAI', kind: 'responses', baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' } }
      } });
      globalThis.__ux = { calls: [], pending: [], hold: false, failText: '' };
      globalThis.fetch = async (url, options) => {
        if (!String(url).includes('/responses')) return new Response('{}', { status: 200 });
        const body = JSON.parse(options.body);
        const input = String(body.input || '');
        globalThis.__ux.calls.push({ input, body });
        const response = () => globalThis.__ux.failText && input.includes(globalThis.__ux.failText)
          ? new Response('{"error":{"message":"fixture failure"}}', { status: 400 })
          : new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: input === 'ping' ? 'pong' : '译文：' + input.slice(-120) }] }] }), { status: 200 });
        if (globalThis.__ux.hold) return new Promise(resolve => globalThis.__ux.pending.push(() => resolve(response())));
        return response();
      };
    });
    const seed = async records => {
      const manager = await context.newPage();
      try {
        await manager.goto(`chrome-extension://${extensionId}/options.html`);
        const response = await manager.evaluate(data => chrome.runtime.sendMessage({ action: 'SESSION', payload: { op: 'import', data } }), records);
        assert(response?.ok, response?.error || 'session fixture import failed');
      } finally { await manager.close({ runBeforeUnload: false }); }
    };
    const pages = [];
    const errors = [];
    async function open(body, route) {
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', error => errors.push(error.message));
      await page.route('https://x.com/**', request => request.fulfill({ contentType: 'text/html', body: html(body) }));
      await page.goto('https://x.com/' + route);
      await page.locator('#bx-sidebar-handle').waitFor();
      return page;
    }
    async function ready(page) {
      await page.waitForFunction(() => document.querySelector('#bx-body') && !document.querySelector('#bx-body').inert);
    }
    async function saved(page) {
      await page.waitForFunction(() => document.querySelector('#bx-save-status')?.textContent.includes('已自动保存'));
    }
    async function select(page, id, length) {
      await page.locator(`#p${id} [data-testid="tweetText"]`).evaluate((element, end) => {
        const range = document.createRange(); range.setStart(element.firstChild, 0); range.setEnd(element.firstChild, end);
        const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      }, length);
    }
    async function test(name, fn) {
      if (process.env.UX_ONLY && !name.includes(process.env.UX_ONLY)) return;
      errors.length = 0;
      try { await fn(); assert.deepEqual(errors.splice(0), []); results.push({ name, pass: true }); console.log('PASS ' + name); }
      catch (error) { results.push({ name, pass: false, error: error.message }); console.error('FAIL ' + name + ': ' + error.message); }
      finally {
        if (process.env.UX_EVIDENCE_DIR && pages.length) {
          fs.mkdirSync(process.env.UX_EVIDENCE_DIR, { recursive: true });
          await pages.at(-1).screenshot({ path: path.join(process.env.UX_EVIDENCE_DIR, name.split(':')[0] + '.png'), fullPage: true }).catch(() => {});
        }
        for (const page of pages.splice(0)) if (!page.isClosed()) await page.close({ runBeforeUnload: false });
        await worker.evaluate(() => { __ux.hold = false; __ux.failText = ''; __ux.pending.splice(0).forEach(release => release()); });
      }
    }
    async function options() {
      const page = await context.newPage(); pages.push(page);
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(`chrome-extension://${extensionId}/options.html`);
      await page.waitForFunction(() => document.querySelector('#provider-model')?.value);
      return page;
    }
    async function message(page, action, payload) {
      const response = await page.evaluate(({ action, payload }) => chrome.runtime.sendMessage({ action, payload }), { action, payload });
      assert(response?.ok, response?.error || 'message failed');
      return response.data;
    }

    await test('reply: canonical links and confirmation revalidation', async () => {
      const page = await open(article('7101', A) + `<div role="dialog" id="dialog"><a id="reply-source" href="/alpha/status/7101?s=20">Original post</a><div id="editor" data-testid="tweetTextarea_0" contenteditable="true" role="textbox">Existing draft.</div><button id="publish">Post</button></div>`, 'ux-reply');
      await page.locator('#p7101 .bx-entry-reply').click(); await ready(page);
      await page.locator('#bx-draft').fill('User reply.');
      await page.locator('#bx-insert').click();
      assert.equal(await page.locator('#bx-insert-confirm').count(), 1, 'same post author/query link must allow confirmation');
      await page.locator('#reply-source').evaluate(el => { el.href = '/beta/status/7102'; });
      await page.locator('#bx-insert-confirm').click();
      assert.equal(await page.locator('#editor').innerText(), 'Existing draft.', 'changed target must reject insertion');
      await page.locator('#reply-source').evaluate(el => { el.href = 'https://twitter.com/alpha/status/7101?lang=en'; });
      await page.locator('#bx-insert').click(); await page.locator('#bx-insert-confirm').click();
      assert((await page.locator('#editor').innerText()).includes('Existing draft.\nUser reply.'));
      await page.locator('#dialog').evaluate(el => { el.removeAttribute('role'); });
      await page.locator('#bx-insert').click();
      assert.equal(await page.locator('#bx-insert-confirm').count(), 0, 'unbound global editor stays blocked');
    });

    await test('selection: new gesture wins over stored sentence', async () => {
      await seed([{ key: 'post:7201', data: { selected: 'OLD SELECTED SENTENCE', draft: 'Saved reply for this post.' } }]);
      const page = await open(article('7201', A), 'ux-selection');
      await page.locator('#p7201 .bx-inline-button').waitFor();
      const selected = 'A new sentence selected by the user.';
      await select(page, '7201', selected.length);
      await page.locator('#bx-read-scope').waitFor(); await ready(page);
      assert.equal(await page.locator('#bx-read-scope').inputValue(), 'selection');
      assert.equal(await page.locator('.bx-pair-src').first().innerText(), selected, 'restored selection must not overwrite new gesture');
      await page.locator('[data-bx-mode="write"]').click();
      assert.equal(await page.locator('#bx-draft').inputValue(), 'Saved reply for this post.', 'untouched saved fields still restore');
    });

    await test('manual: unsubmitted material survives switch and reload', async () => {
      const page = await open(article('7301', A) + article('7302', B, 'beta'), 'ux-manual');
      await page.locator('#p7301 .bx-inline-button').click(); await ready(page);
      await page.locator('#bx-read-scope').selectOption('manual');
      await page.locator('#bx-read-source-language').selectOption('英语');
      await page.locator('#bx-read-target-language').selectOption('日语');
      await page.locator('#bx-read-manual').fill('An unsent original with a final marker: UNSENT_7301.');
      await saved(page);
      await page.locator('#p7302 .bx-inline-button').click(); await ready(page);
      assert.equal(await page.locator('#bx-read-scope').inputValue(), 'full', 'new post defaults to full');
      await page.locator('#p7301 .bx-inline-button').click(); await ready(page);
      assert.equal(await page.locator('#bx-read-scope').inputValue(), 'manual', 'returning from B to A restores manual scope');
      assert((await page.locator('#bx-read-manual').inputValue()).endsWith('UNSENT_7301.'));
      await page.reload(); await page.locator('#p7301 .bx-inline-button').click(); await ready(page);
      assert.equal(await page.locator('#bx-read-scope').inputValue(), 'manual', 'reloading A restores manual scope');
      assert((await page.locator('#bx-read-manual').inputValue()).endsWith('UNSENT_7301.'));
      assert.equal(await page.locator('#bx-read-target-language').inputValue(), '日语');
      assert.equal(await page.locator('#bx-read-source-language').inputValue(), '英语');
      assert.equal(await worker.evaluate(() => __ux.calls.filter(x => x.input.includes('UNSENT_7301')).length), 0);
    });

    await test('navigation: leaving a post detaches its draft session', async () => {
      const page = await open(article('7311', A), 'alpha/status/7311');
      await page.locator('#p7311 .bx-entry-reply').click(); await ready(page);
      await page.locator('#bx-draft').fill('PRIVATE_DRAFT_7311');
      await saved(page);
      await page.evaluate(() => history.pushState({}, '', '/home'));
      await page.waitForFunction(() => !document.querySelector('#bx-draft')?.value?.includes('PRIVATE_DRAFT_7311'));
      await page.evaluate(() => history.pushState({}, '', '/alpha/status/7311'));
      await page.waitForFunction(() => document.querySelector('#bx-draft')?.value === 'PRIVATE_DRAFT_7311');
    });

    await test('rapid-selection: latest A-B-A intent survives slow storage', async () => {
      await seed([{ key: 'post:7351', data: { selected: 'OLD A SELECTION' } }, { key: 'post:7352', data: { selected: 'OLD B SELECTION' } }]);
      // Delay delivery of readonly IDB results, keeping actual requests and records.
      await worker.evaluate(() => {
        const descriptor = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess');
        globalThis.__uxIDBSuccess = descriptor;
        Object.defineProperty(IDBRequest.prototype, 'onsuccess', { ...descriptor, set(callback) {
          descriptor.set.call(this, function(event) {
            if (this.source?.name === 'sessions' && this.transaction?.mode === 'readonly') setTimeout(() => callback.call(this, event), 250);
            else callback.call(this, event);
          });
        } });
      });
      try {
        const page = await open(article('7351', A) + article('7352', B, 'beta'), 'ux-rapid');
        await page.locator('#p7351 .bx-inline-button').click();
        await select(page, '7352', 45);
        await delay(20);
        await select(page, '7351', 35);
        await page.waitForFunction(text => document.querySelector('#bx-read-scope')?.value === 'selection'
          && document.querySelector('.bx-pair-src')?.textContent === text && !document.querySelector('#bx-body')?.inert, A.slice(0, 35));
        await saved(page);
        await page.locator('#p7352 .bx-inline-button').click(); await ready(page);
        assert(!(await page.locator('#bx-body').innerText()).includes('A new sentence selected by the user.'), 'B must not inherit A selection');
      } finally { await worker.evaluate(() => Object.defineProperty(IDBRequest.prototype, 'onsuccess', globalThis.__uxIDBSuccess)); }
    });

    await test('translation: retry failed paragraphs and stop queued work', async () => {
      const page = await open(article('7401', A), 'ux-translation');
      await page.locator('#p7401 .bx-inline-button').click(); await ready(page);
      await page.locator('#bx-read-scope').selectOption('manual');
      await page.locator('#bx-read-manual').fill('FIRST_UX_PARAGRAPH content.\n\nFAILED_UX_PARAGRAPH content.');
      await worker.evaluate(() => { __ux.failText = 'FAILED_UX_PARAGRAPH'; });
      await page.locator('#bx-translate-now').click();
      await page.locator('.bx-pair-dst.bx-fail').waitFor();
      assert.equal(await page.locator('.bx-pair-dst.bx-done').count(), 1);
      const firstCount = await worker.evaluate(() => __ux.calls.filter(x => x.input.includes('FIRST_UX_PARAGRAPH')).length);
      await worker.evaluate(() => { __ux.failText = ''; });
      await page.getByRole('button', { name: '重试失败段落', exact: true }).click();
      await page.waitForFunction(() => document.querySelectorAll('.bx-pair-dst.bx-done').length === 2);
      assert.equal(await worker.evaluate(() => __ux.calls.filter(x => x.input.includes('FIRST_UX_PARAGRAPH')).length), firstCount);
      await page.locator('#bx-read-manual').fill('STOP_UX_FIRST paragraph.\n\nSTOP_UX_SECOND paragraph.');
      await worker.evaluate(() => { __ux.hold = true; });
      await page.locator('#bx-translate-now').click();
      for (let i = 0; i < 50 && !(await worker.evaluate(() => __ux.pending.length)); i++) await delay(50);
      assert.equal(await worker.evaluate(() => __ux.pending.length), 1);
      await page.locator('#bx-stop-translation').click();
      await worker.evaluate(() => { __ux.hold = false; __ux.pending.splice(0).forEach(release => release()); });
      await delay(350);
      assert.equal(await worker.evaluate(() => __ux.calls.filter(x => x.input.includes('STOP_UX_SECOND')).length), 0);
      assert.equal(await page.locator('.bx-pair-dst.bx-done').count(), 0, 'stopped response cannot write back');
    });

    await test('settings: unsaved form and late connection response', async () => {
      const page = await options();
      const active = await page.locator('#active-config').innerText();
      await page.locator('#provider-label').fill('UNSAVED CONFIG');
      assert((await page.locator('#settings-dirty-status').innerText()).includes('未保存'));
      assert.equal(await page.locator('#active-config').innerText(), active);
      await page.locator('#model-provider').selectOption('deepseek');
      await page.locator('#model-provider').selectOption('openai');
      assert.equal(await page.locator('#provider-label').inputValue(), 'UNSAVED CONFIG');
      await worker.evaluate(() => { __ux.hold = true; });
      await page.locator('#test-model').click();
      for (let i = 0; i < 50 && !(await worker.evaluate(() => __ux.pending.length)); i++) await delay(50);
      assert.equal(await worker.evaluate(() => __ux.pending.length), 1);
      await page.locator('#model-provider').selectOption('deepseek');
      await worker.evaluate(() => { __ux.hold = false; __ux.pending.splice(0).forEach(release => release()); });
      await delay(200);
      assert(!(await page.locator('#test-result').innerText()).includes('连接正常'), 'old success cannot label the new configuration');
      assert.equal(await page.locator('#active-config').innerText(), active);
      await page.locator('#model-provider').selectOption('openai');
      assert(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; }));
      await page.locator('#provider-label').fill('SAVED CONFIG');
      await page.locator('#save-main').click();
      await page.waitForFunction(() => document.querySelector('#active-config')?.textContent.includes('SAVED CONFIG'));
      assert(!(await page.evaluate(() => { const event = new Event('beforeunload', { cancelable: true }); window.dispatchEvent(event); return event.defaultPrevented; })), 'clean page must not warn');
    });

    await test('save-failure: real settings service preserves active configuration', async () => {
      const page = await options();
      const active = await page.locator('#active-config').innerText();
      await page.locator('#provider-label').fill('RETRY CONFIG');
      await worker.evaluate(() => {
        globalThis.__uxOriginalSet = chrome.storage.local.set.bind(chrome.storage.local);
        chrome.storage.local.set = async () => { throw new Error('UX_QUOTA_FAILURE'); };
      });
      try {
        await page.locator('#save-main').click();
        await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('UX_QUOTA_FAILURE'));
        assert.equal(await page.locator('#provider-label').inputValue(), 'RETRY CONFIG');
        assert.equal(await page.locator('#active-config').innerText(), active);
        assert(!(await page.locator('#save-main').isDisabled()), 'failure allows retry');
      } finally { await worker.evaluate(() => { chrome.storage.local.set = globalThis.__uxOriginalSet; }); }
      await page.locator('#save-main').click();
      await page.waitForFunction(() => document.querySelector('#active-config')?.textContent.includes('RETRY CONFIG'));
    });

    await test('history: search pagination copy and conflict visibility', async () => {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await seed(Array.from({ length: 25 }, (_, index) => ({ key: 'post:' + (7500 + index), data: { draft: 'History draft ' + index, selected: 'History source ' + index } }))
        .concat([{ key: 'conflict:ux-history', sourceKey: 'post:7500', data: { draft: 'CONFLICT_ONLY_DRAFT', selected: 'A preserved alternate draft' } }]));
      const page = await options();
      await page.locator('[data-tab="data"]').click();
      await page.locator('#session-search').waitFor();
      await page.waitForFunction(() => document.querySelectorAll('#session-list .session-item').length === 20);
      await page.getByRole('button', { name: '显示更多', exact: true }).click();
      assert((await page.locator('#session-list .session-item').count()) > 20);
      await page.locator('#session-search').fill('CONFLICT_ONLY_DRAFT');
      await page.waitForFunction(() => document.querySelectorAll('#session-list .session-item').length === 1);
      const card = page.locator('#session-list .session-item').first();
      assert((await card.innerText()).includes('冲突副本'));
      await card.getByRole('button', { name: '复制草稿', exact: true }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), 'CONFLICT_ONLY_DRAFT');
      assert.equal(await card.locator('details[open]').count(), 0, 'technical JSON stays collapsed');
      await page.locator('#session-search').fill('History draft 24');
      await page.waitForFunction(() => document.querySelectorAll('#session-list .session-item').length === 1);
      assert((await page.locator('#session-list a').first().getAttribute('href')).includes('/status/7524'));
    });

    await test('backup: visible conflicts and partial storage failure', async () => {
      await worker.evaluate(() => chrome.storage.local.set({ glossary: { shared: 'LOCAL' }, initPrompt: 'LOCAL PROMPT', cards: [{ id: 'ux-same', text: 'LOCAL CARD' }] }));
      const page = await options();
      await page.locator('[data-tab="data"]').click();
      const archive = { format: 'babel-tower-backup', version: 1, storage: {
        glossary: { shared: 'INCOMING', added: 'NEW' }, initPrompt: 'INCOMING PROMPT',
        cards: [{ id: 'ux-same', text: 'INCOMING CARD' }]
      }, sessions: [] };
      await page.locator('#import-backup').setInputFiles({ name: 'ux-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(archive)) });
      await page.locator('#confirm-import').waitFor({ state: 'visible' });
      const preview = await page.locator('#backup-preview').innerText();
      assert(/跳过\s*2/.test(preview), 'preview reports two retained local conflicts: ' + preview);
      await page.locator('#confirm-import').click();
      await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('数据已合并'));
      assert(/跳过\s*2/.test(await page.locator('#status').innerText()));
      const exported = await message(page, 'BACKUP', { op: 'export' });
      assert.deepEqual(exported.storage.glossary, { shared: 'LOCAL', added: 'NEW' });
      assert.equal(exported.storage.initPrompt, 'LOCAL PROMPT');
      assert.equal(exported.storage.cards.length, 2);
      assert(!JSON.stringify(exported).includes('ux-test-placeholder'));
      const partial = { ...archive, storage: { glossary: { uncommitted: 'MUST NOT APPEAR' } }, sessions: [{ key: 'post:7601', data: { draft: 'PARTIAL_IMPORT_SESSION' } }] };
      await page.locator('#import-backup').setInputFiles({ name: 'ux-partial.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(partial)) });
      await page.locator('#confirm-import').waitFor({ state: 'visible' });
      await worker.evaluate(() => {
        globalThis.__uxOriginalSet = chrome.storage.local.set.bind(chrome.storage.local);
        chrome.storage.local.set = async () => { throw new Error('UX_BACKUP_QUOTA'); };
      });
      try {
        await page.locator('#confirm-import').click();
        await page.waitForFunction(() => document.querySelector('#status')?.textContent.includes('帖子会话已导入'));
        assert.equal((await message(page, 'SESSION', { op: 'get', key: 'post:7601' })).data.draft, 'PARTIAL_IMPORT_SESSION');
        assert.equal((await worker.evaluate(() => chrome.storage.local.get('glossary'))).glossary.uncommitted, undefined);
      } finally { await worker.evaluate(() => { chrome.storage.local.set = globalThis.__uxOriginalSet; }); }
    });

    if (process.env.UX_EVIDENCE_DIR) {
      fs.mkdirSync(process.env.UX_EVIDENCE_DIR, { recursive: true });
      fs.writeFileSync(path.join(process.env.UX_EVIDENCE_DIR, 'ux-results.json'), JSON.stringify({ extensionId, root, results }, null, 2));
    }
    console.log(`UX_BROWSER ${results.filter(x => x.pass).length}/${results.length}`);
    if (results.some(x => !x.pass)) process.exitCode = 1;
  } finally {
    if (context) await context.close();
    // Only the profile created by this invocation can be removed.
    if (path.dirname(profile) === os.tmpdir() && path.basename(profile).startsWith('bx-ux-')) fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
