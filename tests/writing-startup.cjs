const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-startup-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, { channel: 'msedge', headless: true,
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`] });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const base = `chrome-extension://${new URL(worker.url()).host}`;
    const page = await context.newPage();
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ documents: { startup: { id: 'startup', title: '已有文稿', content: '原有内容', kind: 'draft', folder: '我的文章', sourceUrl: '', revision: 1 } } });
      const get = chrome.storage.local.get.bind(chrome.storage.local);
      chrome.storage.local.get = async keys => {
        if (keys === 'documents') {
          globalThis.readStarted = true;
          await new Promise(resolve => setTimeout(resolve, 700));
        }
        return get(keys);
      };
    });
    await page.goto(`${base}/write/desk.html`);
    for (let i = 0; i < 50 && !(await worker.evaluate(() => Boolean(globalThis.readStarted))); i++) await page.waitForTimeout(10);
    assert(await worker.evaluate(() => Boolean(globalThis.readStarted)));
    await page.locator('#markdown-editor').fill('加载期间抢先编辑的内容');
    await page.waitForFunction(() => document.body.dataset.ready === '1', null, { timeout: 6000 }).catch(async error => {
      throw new Error(error.message + '; ' + JSON.stringify(await page.evaluate(() => ({ ready: document.body.dataset.ready, text: document.querySelector('#markdown-editor').value, status: document.querySelector('#save-state').textContent, error: document.querySelector('#toast').textContent }))));
    });
    assert.equal(await page.locator('#markdown-editor').inputValue(), '加载期间抢先编辑的内容');
    await page.waitForFunction(() => document.querySelector('#save-state').textContent === '已保存');
    assert.equal(await worker.evaluate(async () => (await chrome.storage.local.get('documents')).documents.startup.content), '加载期间抢先编辑的内容');
    console.log('STARTUP_PASS: slow document restore never overwrites user editing.');
  } finally {
    await context?.close();
    const resolvedProfile = path.resolve(profile);
    const tempRoot = path.resolve(os.tmpdir());
    if (!resolvedProfile.startsWith(tempRoot + path.sep) || !path.basename(resolvedProfile).startsWith('bx-startup-')) throw new Error('拒绝清理测试目录之外的路径。');
    fs.rmSync(resolvedProfile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
