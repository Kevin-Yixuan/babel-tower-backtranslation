// Exercise the actual packaged MV3 pages: navigation, persistence and narrow layouts.
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const root = path.resolve(process.env.EXTENSION_ROOT || path.join(__dirname, '..'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-redesign-'));
  const evidence = path.resolve(process.env.DESIGN_EVIDENCE || path.join(__dirname, '../.tmp/design-evidence'));
  fs.mkdirSync(evidence, { recursive: true });
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: true, viewport: { width: 1440, height: 1000 },
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const base = `chrome-extension://${new URL(worker.url()).host}`;
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/options.html`);
    await page.waitForFunction(() => document.querySelector('#provider-model')?.value);
    await page.locator('[data-tab="preferences"]').click();
    await page.locator('#target-language').selectOption('日语');
    await page.locator('#auto-translate').uncheck();
    await page.locator('[data-tab="agent"]').click();
    assert.equal(await page.locator('#target-language').isVisible(), false);
    await page.locator('[data-tab="home"]').click();
    await page.locator('#save-main').click();
    await page.waitForFunction(() => document.querySelector('#settings-dirty-status').textContent.includes('所有修改已保存'));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#provider-model')?.value);
    await page.locator('[data-tab="preferences"]').click();
    assert.equal(await page.locator('#target-language').inputValue(), '日语');
    assert.equal(await page.locator('#auto-translate').isChecked(), false);
    for (const tab of ['home', 'preferences', 'agent', 'dictionary', 'saved', 'data', 'filters']) {
      await page.locator(`[data-tab="${tab}"]`).click();
      assert.equal(await page.locator('main > [data-panel]:visible').count(), 1);
      assert.equal(await page.locator(`[data-tab="${tab}"]`).getAttribute('aria-current'), 'page');
    }
    await page.locator('[data-tab="home"]').click();
    await page.screenshot({ path: path.join(evidence, 'settings-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.locator('[data-tab="data"]').click();
    assert(await page.locator('#export-backup').isVisible());
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(evidence, 'settings-narrow.png'), fullPage: true });

    const localDocument = { id: 'restore-a', title: '本地稿', content: '本地正文', folder: '我的文章' };
    await worker.evaluate(document => chrome.storage.local.set({ documents: { [document.id]: document } }), localDocument);
    const backup = { format: 'babel-tower-backup', version: 1, sessions: [], storage: {
      documents: { [localDocument.id]: { ...localDocument, title: '归档稿', content: '归档修改' } }
    } };
    const uploadBackup = async () => {
      await page.locator('#import-backup').setInputFiles([]);
      await page.locator('#import-backup').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(backup)) });
    };
    await uploadBackup();
    await page.waitForFunction(() => document.querySelector('#backup-preview').textContent.includes('另存 1 项'));
    assert((await page.locator('#backup-preview').textContent()).includes('1 份文稿'));
    assert.equal(await worker.evaluate(async () => Object.keys((await chrome.storage.local.get('documents')).documents).length), 1);
    await page.locator('#confirm-import').click();
    await page.waitForFunction(() => document.querySelector('#confirm-import').hidden);
    const restored = await worker.evaluate(async () => (await chrome.storage.local.get('documents')).documents);
    assert.equal(restored['restore-a'].content, '本地正文');
    assert(Object.values(restored).some(document => document.content === '归档修改' && document.id !== 'restore-a'));
    await uploadBackup();
    await page.waitForFunction(() => document.querySelector('#backup-preview').textContent.includes('跳过 1 项、另存 0 项'));
    await page.locator('#confirm-import').click();
    await page.waitForFunction(() => document.querySelector('#confirm-import').hidden);
    assert.equal(await worker.evaluate(async () => Object.keys((await chrome.storage.local.get('documents')).documents).length), 2);

    await page.goto(`${base}/write/desk.html`);
    await page.locator('#markdown-editor').fill('# 保留我的草稿\n\n切换侧栏也不会丢失。');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存');
    await page.locator('[data-pane="library"]').click();
    assert(await page.locator('.library').isVisible());
    await page.locator('[data-pane="agent"]').click();
    assert.equal(await page.locator('.library').isVisible(), false);
    assert(await page.locator('.agent-panel').isVisible());
    assert((await page.locator('#markdown-editor').inputValue()).includes('保留我的草稿'));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('.agent-panel').isVisible(), false);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await page.locator('.topbar').evaluate(node => node.getBoundingClientRect().right <= innerWidth));
    assert(await page.locator('#new-document').isVisible());
    assert(await page.locator('#new-document').evaluate(node => node.getBoundingClientRect().right <= innerWidth));
    await page.screenshot({ path: path.join(evidence, 'writing-narrow.png'), fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.screenshot({ path: path.join(evidence, 'writing-desktop.png'), fullPage: true });

    await worker.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, agentBaseUrl: 'http://127.0.0.1:4097' }, agentKey: 'test-token' });
      globalThis.originalPiFetch = globalThis.fetch;
      globalThis.originalPiPermission = chrome.permissions.contains;
      chrome.permissions.contains = async () => true;
      globalThis.fetch = async url => {
        if (String(url).endsWith('/health')) return Response.json({ ready: true, version: 'test' });
        globalThis.piRequestStarted = true;
        await new Promise(resolve => { globalThis.releasePiReply = resolve; });
        return Response.json({ answer: '受控助手回复' });
      };
    });
    await page.locator('#agent-prompt').fill('协助修改文稿');
    await page.locator('#agent-send').click();
    await page.waitForFunction(() => document.querySelector('#agent-send').textContent === '写作中…');
    for (let i = 0; i < 50 && !(await worker.evaluate(() => Boolean(globalThis.piRequestStarted))); i++) await page.waitForTimeout(50);
    assert(await worker.evaluate(() => Boolean(globalThis.piRequestStarted)));
    await page.locator('#markdown-editor').fill('# 等待助手期间也能保存');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存', { timeout: 5000 });
    assert(await worker.evaluate(async () => Object.values((await chrome.storage.local.get('documents')).documents).some(document => document.content === '# 等待助手期间也能保存')));
    await worker.evaluate(() => globalThis.releasePiReply());
    await page.waitForFunction(() => document.querySelector('#agent-send').textContent === '发送');
    await worker.evaluate(() => {
      globalThis.fetch = globalThis.originalPiFetch;
      chrome.permissions.contains = globalThis.originalPiPermission;
    });

    await page.goto(`${base}/popup.html`);
    assert.equal(await page.locator('.launch-card').count(), 2);
    await page.screenshot({ path: path.join(evidence, 'launcher.png') });

    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.route('https://x.com/redesign-fixture', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><article data-testid="tweet"><div data-testid="tweetText">Writing helps us understand our own ideas.</div><a href="/test/status/123">Original post</a><div role="group"></div></article></body></html>' }));
    await page.goto('https://x.com/redesign-fixture');
    await page.locator('#bx-sidebar-handle').click();
    await page.locator('[data-bx-mode="read"]').focus();
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.locator('[data-bx-mode="write"]').getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.bxMode), 'write');
    await page.screenshot({ path: path.join(evidence, 'reply-sidebar.png'), fullPage: true });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#bx-sidebar').evaluate(node => node.classList.contains('bx-open')), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'bx-sidebar-handle');
    assert.deepEqual(errors, []);
    console.log('REDESIGN_PASS: settings persisted across sections and reload; drawers preserve drafts; narrow pages fit; sidebar keyboard navigation works.');
  } finally {
    if (context) await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
