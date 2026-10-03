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
    const special = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'SAVE_DOCUMENT', payload: { id: '__proto__', title: '特殊导入记录', content: '真实存储中的文稿' } }));
    assert.equal(special.ok, true);
    assert.equal(special.data.id, '__proto__');
    const specialRead = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'GET_DOCUMENT', id: '__proto__' }));
    assert.equal(specialRead.data.content, '真实存储中的文稿');
    await page.evaluate(() => chrome.runtime.sendMessage({ action: 'DELETE_DOCUMENT', id: '__proto__' }));
    await worker.evaluate(() => chrome.storage.local.set({ writingDrafts: [{ id: 'dedup-a', text: '本地稿' }] }));
    const duplicateArchive = { format: 'babel-tower-backup', version: 1, sessions: [], storage: {
      writingDrafts: [{ id: 'dedup-a', text: '归档修改' }, { id: 'dedup-a', text: '归档修改' }]
    } };
    const uploadDuplicates = async () => {
      await page.locator('#import-backup').setInputFiles([]);
      await page.locator('#import-backup').setInputFiles({ name: 'duplicates.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(duplicateArchive)) });
    };
    await uploadDuplicates();
    await page.waitForFunction(() => document.querySelector('#backup-preview').textContent.includes('跳过 1 项、另存 1 项'));
    await page.locator('#confirm-import').click();
    await page.waitForFunction(() => document.querySelector('#confirm-import').hidden);
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('writingDrafts')).writingDrafts.length), 2);
    await uploadDuplicates();
    await page.waitForFunction(() => document.querySelector('#backup-preview').textContent.includes('跳过 2 项、另存 0 项'));
    await page.locator('#confirm-import').click();
    await page.waitForFunction(() => document.querySelector('#confirm-import').hidden);
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('writingDrafts')).writingDrafts.length), 2);

    const sessionArchive = { format: 'babel-tower-backup', version: 1, storage: {}, sessions: [
      { key: 'post:31313', data: { draft: '归档第一版' } },
      { key: 'post:31313', data: { draft: '归档第二版' } },
      { key: 'post:31313', data: { draft: '归档第二版' } }
    ] };
    const sessionPreview = await page.evaluate(archive => chrome.runtime.sendMessage({ action: 'BACKUP', payload: { op: 'preview', archive } }), sessionArchive);
    assert.deepEqual([sessionPreview.data.imported, sessionPreview.data.extra, sessionPreview.data.skipped], [1, 1, 1]);
    const sessionImport = await page.evaluate(archive => chrome.runtime.sendMessage({ action: 'BACKUP', payload: { op: 'import', archive } }), sessionArchive);
    assert.equal(sessionImport.ok, true);
    const sessionExport = await page.evaluate(() => chrome.runtime.sendMessage({ action: 'BACKUP', payload: { op: 'export' } }));
    assert(sessionExport.data.sessions.some(item => item.data.draft === '归档第一版'));
    assert(sessionExport.data.sessions.some(item => item.data.draft === '归档第二版'));
    const sessionRepeat = await page.evaluate(archive => chrome.runtime.sendMessage({ action: 'BACKUP', payload: { op: 'import', archive } }), sessionArchive);
    assert.deepEqual([sessionRepeat.data.imported, sessionRepeat.data.extra, sessionRepeat.data.skipped], [0, 0, 3]);
    const localSettings = await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings);
    const providerArchive = { format: 'babel-tower-backup', version: 1, sessions: [], storage: {
      settings: { ...localSettings, providers: { ...localSettings.providers,
        openai: { ...localSettings.providers.openai, model: 'archive-model' } } }
    } };
    await page.evaluate(archive => chrome.runtime.sendMessage({ action: 'BACKUP', payload: { op: 'import', archive } }), providerArchive);
    const providerKeys = await worker.evaluate(async () => Object.keys((await chrome.storage.local.get('settings')).settings.providers).sort());
    const providerRepeat = await page.evaluate(archive => chrome.runtime.sendMessage({ action: 'BACKUP', payload: { op: 'import', archive } }), providerArchive);
    assert.equal(providerRepeat.ok, true);
    assert.equal(providerRepeat.data.extra, 0);
    assert.deepEqual(await worker.evaluate(async () => Object.keys((await chrome.storage.local.get('settings')).settings.providers).sort()), providerKeys);
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings.modelProvider), localSettings.modelProvider);
    const beforeInvalid = await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(['documents', 'agentSessions'])));
    const invalidArchive = { format: 'babel-tower-backup', version: 1, sessions: [], storage: {
      documents: { invalid: { id: 'invalid', title: '损坏记录', content: '正文', folder: '我的文章', revision: 'bad' } }
    } };
    await page.locator('#import-backup').setInputFiles([]);
    await page.locator('#import-backup').setInputFiles({ name: 'invalid.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(invalidArchive)) });
    await page.waitForFunction(() => document.querySelector('#status').textContent.includes('文稿数据格式不正确'));
    assert.equal(await page.locator('#confirm-import').isVisible(), false);
    assert.equal(await worker.evaluate(async () => JSON.stringify(await chrome.storage.local.get(['documents', 'agentSessions']))), beforeInvalid);

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

    await worker.evaluate(() => {
      globalThis.originalDocumentSet = chrome.storage.local.set;
      chrome.storage.local.set = async values => {
        if (values.documents) throw new Error('测试：存储空间不足');
        return globalThis.originalDocumentSet(values);
      };
    });
    await page.locator('#doc-title').fill('我的:导出?');
    await page.locator('#markdown-editor').fill('# 保存失败后保留编辑内容');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '保存失败', null, { timeout: 5000 });
    assert.equal(await page.locator('#markdown-editor').inputValue(), '# 保存失败后保留编辑内容');
    assert(await page.locator('#retry-save').isVisible());
    await page.setViewportSize({ width: 390, height: 844 });
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert(await page.locator('#retry-save').evaluate(node => node.getBoundingClientRect().right <= innerWidth));
    await page.screenshot({ path: path.join(evidence, 'writing-save-failed.png'), fullPage: true });
    assert(await page.locator('#download-markdown').isVisible());
    assert(await page.locator('#download-markdown').evaluate(node => node.getBoundingClientRect().right <= innerWidth));
    const downloadEvent = page.waitForEvent('download');
    await page.locator('#download-markdown').click();
    const download = await downloadEvent;
    assert.equal(download.suggestedFilename(), '我的_导出_.md');
    const downloadPath = path.join(evidence, 'downloaded-markdown.md');
    await download.saveAs(downloadPath);
    assert.equal(fs.readFileSync(downloadPath, 'utf8'), '# 保存失败后保留编辑内容');
    assert.equal(await worker.evaluate(async () => Object.values((await chrome.storage.local.get('documents')).documents).some(document => document.content === '# 保存失败后保留编辑内容')), false);
    await worker.evaluate(() => { chrome.storage.local.set = globalThis.originalDocumentSet; });
    await page.locator('#retry-save').click();
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存');
    assert.equal(await page.locator('#retry-save').isVisible(), false);
    assert(await worker.evaluate(async () => Object.values((await chrome.storage.local.get('documents')).documents).some(document => document.content === '# 保存失败后保留编辑内容')));
    await page.locator('#markdown-editor').fill('# 快捷键立即保存');
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存');
    assert(await worker.evaluate(async () => Object.values((await chrome.storage.local.get('documents')).documents).some(document => document.content === '# 快捷键立即保存')));
    await page.setViewportSize({ width: 1440, height: 1000 });

    const originalDocumentId = new URL(page.url()).searchParams.get('doc');
    const secondWindow = await context.newPage();
    await secondWindow.goto(page.url());
    await secondWindow.waitForFunction(() => document.querySelector('#markdown-editor').value === '# 快捷键立即保存');
    await page.locator('#markdown-editor').fill('# 窗口 A 修改');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存');
    await secondWindow.locator('#markdown-editor').fill('# 窗口 B 修改');
    await secondWindow.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存');
    const copyId = new URL(secondWindow.url()).searchParams.get('doc');
    assert.notEqual(copyId, originalDocumentId);
    const copies = await worker.evaluate(async () => (await chrome.storage.local.get('documents')).documents);
    assert.equal(copies[originalDocumentId].content, '# 窗口 A 修改');
    assert.equal(copies[copyId].content, '# 窗口 B 修改');
    assert((await secondWindow.locator('#doc-title').inputValue()).includes('冲突副本'));
    await secondWindow.locator('#markdown-editor').fill('# 窗口 B 继续修改');
    await secondWindow.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存');
    assert.equal(new URL(secondWindow.url()).searchParams.get('doc'), copyId);
    assert.equal(await worker.evaluate(async id => (await chrome.storage.local.get('documents')).documents[id].content, copyId), '# 窗口 B 继续修改');
    await secondWindow.close();

    let imageRequests = 0;
    await page.route('https://images.example.com/fixture.png', route => {
      imageRequests++;
      return route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aQ3cAAAAASUVORK5CYII=', 'base64') });
    });
    await page.locator('#markdown-editor').fill('# 图片文稿\n\n![图示](https://images.example.com/fixture.png)');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存');
    await page.locator('[data-view="preview"]').click();
    assert.equal(await page.locator('#markdown-preview img').count(), 0);
    assert.equal(imageRequests, 0);
    await page.locator('#load-images').check();
    await page.waitForFunction(() => document.querySelector('#markdown-preview img')?.naturalWidth === 1);
    assert.equal(imageRequests, 1);
    await page.locator('#load-images').uncheck();
    assert.equal(await page.locator('#markdown-preview img').count(), 0);
    await page.evaluate(() => {
      window.originalImageOpen = window.open;
      window.open = () => null;
      Object.defineProperty(navigator.clipboard, 'write', { configurable: true, value: async items => { window.imageClipboard = items; } });
    });
    await page.locator('#copy-rich-x').click();
    const copiedHtml = await page.evaluate(async () => (await window.imageClipboard[0].getType('text/html')).text());
    assert(copiedHtml.includes('<img src="https://images.example.com/fixture.png"'));
    assert.equal(imageRequests, 1, '复制排版不应自行加载外部图片');
    await page.evaluate(() => { window.open = window.originalImageOpen; delete navigator.clipboard.write; });
    await page.locator('[data-view="write"]').click();

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
    const conversationBefore = await worker.evaluate(async () => (await chrome.storage.local.get('agentSessions')).agentSessions);
    await worker.evaluate(() => { globalThis.fetch = async () => Response.json({ answer: 'x'.repeat(40001) }); });
    await page.locator('#agent-prompt').fill('分段前的长文请求');
    await page.locator('#agent-send').click();
    await page.waitForFunction(() => document.querySelector('#toast').textContent.includes('超过 40000'));
    assert.equal(await page.locator('#agent-prompt').inputValue(), '分段前的长文请求');
    assert.deepEqual(await worker.evaluate(async () => (await chrome.storage.local.get('agentSessions')).agentSessions), conversationBefore);
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
