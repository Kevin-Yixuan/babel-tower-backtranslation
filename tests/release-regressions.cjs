// Community release regressions: isolated Edge profile and synthetic X pages only.
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-release-regressions-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: true, viewport: { width: 1280, height: 850 },
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    const bodyFor = url => url.endsWith('/lazy')
      ? '<main id="main"></main>'
      : url.endsWith('/mixed')
        ? '<main><div data-testid="longformRichTextComponent"><p>FIRST_P paragraph.</p><div>SECOND_DIV paragraph.</div></div></main>'
        : url.endsWith('/insert')
          ? '<main><article data-testid="tweet" id="a"><div data-testid="User-Name">Author A</div><div data-testid="tweetText">POST_A original content for a reply.</div><a href="/a/status/111">link</a><div role="group"></div></article><div id="global-composer" data-testid="tweetTextarea_0" role="textbox" contenteditable="true"></div></main>'
          : '<main id="main"><article data-testid="tweet" id="a"><div data-testid="User-Name">Author A</div><div data-testid="tweetText">POST_A original content for navigation.</div><a href="/a/status/111">link</a><div role="group"></div></article></main>';
    await context.route(/^https:\/\/x\.com\/release-audit(?:[\/-].*)?$/, route => route.fulfill({
      status: 200, contentType: 'text/html; charset=utf-8',
      body: `<!doctype html><html><body>${bodyFor(route.request().url())}</body></html>`
    }));
    const page = await context.newPage();

    await page.goto('https://x.com/release-audit');
    await page.locator('#a .bx-inline-button').click();
    await page.locator('.bx-pair-src').waitFor();
    await page.evaluate(() => {
      history.pushState({}, '', '/release-audit-article');
      document.querySelector('#main').innerHTML = '<div data-testid="longformRichTextComponent"><p>NEW_ARTICLE from a different route.</p></div>';
    });
    await page.waitForFunction(() => [...document.querySelectorAll('.bx-pair-src')]
      .some(p => p.textContent.includes('NEW_ARTICLE')) && !document.querySelector('#bx-body')?.textContent.includes('POST_A original'));
    console.log('PASS route change discards old post and reads new article');

    await page.goto('https://x.com/release-audit/lazy');
    await page.locator('#bx-sidebar-handle').click();
    await page.evaluate(() => { document.querySelector('#main').innerHTML = '<div data-testid="longformRichTextComponent"><p>LATE_ARTICLE mounted after opening.</p></div>'; });
    await page.waitForFunction(() => [...document.querySelectorAll('.bx-pair-src')].some(p => p.textContent.includes('LATE_ARTICLE')));
    console.log('PASS first article root mounts late');

    await page.goto('https://x.com/release-audit/mixed');
    await page.locator('#bx-sidebar-handle').click();
    await page.waitForFunction(() => document.querySelectorAll('.bx-pair-src').length === 2);
    const parts = await page.locator('.bx-pair-src').allInnerTexts();
    assert(parts.some(x => x.includes('FIRST_P')) && parts.some(x => x.includes('SECOND_DIV')));
    console.log('PASS mixed p/div article includes both paragraphs');

    await page.goto('https://x.com/release-audit/insert');
    await page.locator('#a .bx-entry-reply').click();
    await page.locator('#bx-draft').fill('A_REPLY_DRAFT');
    await page.locator('#bx-insert').click();
    await page.locator('.bx-insert-blocked').waitFor();
    assert.equal(await page.locator('#bx-insert-confirm').count(), 0);
    assert.equal(await page.locator('#global-composer').innerText(), '');
    console.log('PASS unbound standalone composer is refused');
    await page.locator('#bx-insert-cancel').click();

    await page.evaluate(() => {
      const b = document.createElement('article'); b.id = 'b'; b.dataset.testid = 'tweet';
      b.innerHTML = '<div data-testid="User-Name">Author B</div><div data-testid="tweetText">POST_B unrelated content.</div><a href="/b/status/222">link</a><div role="group"></div>';
      document.querySelector('main').appendChild(b);
    });
    await page.locator('#b .bx-entry-reply').click();
    assert.equal(await page.locator('#bx-draft').inputValue(), '');
    assert.equal(await page.locator('#bx-check-reply').isEnabled(), false);
    await page.locator('#a .bx-entry-reply').click();
    assert.equal(await page.locator('#bx-draft').inputValue(), 'A_REPLY_DRAFT');
    console.log('PASS replies stay in their own post sessions');

    await page.evaluate(() => {
      const first = document.querySelector('#a [data-testid="tweetText"]').firstChild;
      const end = document.querySelector('#global-composer');
      end.textContent = 'PRIVATE_EDITOR_CONTENT';
      const range = document.createRange(); range.setStart(first, 0); range.setEnd(end.firstChild, end.firstChild.data.length);
      const selection = document.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      first.parentElement.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await page.waitForTimeout(100);
    assert.equal(await page.locator('.bx-tabs .bx-active').getAttribute('data-bx-mode'), 'write');
    assert.equal(await page.locator('#bx-selection-bar.bx-show').count(), 0);
    console.log('PASS selection crossing editor and controls is ignored');

    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 10000 });
    await worker.evaluate(async () => chrome.storage.local.set({ savedPhrases: Array.from({ length: 500 }, (_, i) => ({
      id: `phrase-${i}`, text: `Sentence ${i}`, source: '', translation: '', note: '', createdAt: i
    })) }));
    await page.goto('https://x.com/release-audit/phrases');
    await page.locator('#bx-sidebar-handle').click();
    await page.locator('[data-bx-mode="growth"]').click();
    await page.waitForFunction(() => document.querySelectorAll('.bx-growth-phrase').length === 500);
    await page.locator('#bx-growth-phrase-text').fill('NEW_PHRASE_501');
    await page.locator('#bx-growth-phrase-save').click();
    await page.waitForFunction(() => document.querySelector('#bx-body')?.textContent?.includes('500 条上限'));
    const phrases = await worker.evaluate(async () => (await chrome.storage.local.get('savedPhrases')).savedPhrases);
    assert.equal(phrases.length, 500);
    assert(phrases.some(p => p.id === 'phrase-499'));
    assert(!phrases.some(p => p.text === 'NEW_PHRASE_501'));
    console.log('PASS phrase cap preserves all existing entries');
  } finally {
    if (context) await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
