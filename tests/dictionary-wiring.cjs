// Dictionary wiring E2E: popup panel + standalone import page + background local-first LOOKUP,
// all inside the REAL MV3 extension (isolated Edge profile). Uses a tiny fixture MDX built by
// tests/mdx-fixture.mjs — never the real 193 MB file, never real network (online fallback is
// mocked inside the service worker and counted).
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 启动时清理 30 分钟前的本测试遗留 profile，防止临时盘写满。
(() => { try { for (const d of fs.readdirSync(os.tmpdir())) { if (/^(bx-dictwire-)/.test(d)) { const p = path.join(os.tmpdir(), d); if (Date.now() - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } } } catch {} })();

const log = [];
const say = line => { log.push(line); console.log(line); };

(async () => {
  const root = path.resolve(__dirname, '..');
  const { buildMdx, entryHtml } = await import('./mdx-fixture.mjs');
  const fixturePath = path.join(os.tmpdir(), `bx-dictwire-fixture-${Date.now()}.mdx`);
  fs.writeFileSync(fixturePath, buildMdx([
    { word: 'solitary', html: entryHtml('solitary', { pos: 'adj.', defZh: '单独的', defEn: 'alone', examples: [] }) },
    { word: 'wiringtest', html: entryHtml('wiringtest', { pos: 'n.', defZh: '接线测试词条', defEn: 'a wiring test entry', examples: ['This is a wiring test.'] }) },
    { word: 'wiringtwo', html: entryHtml('wiringtwo', { pos: 'v.', defZh: '第二个词条', defEn: 'second entry', examples: [] }) }
  ], { title: 'Fixture Dictionary' }));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-dictwire-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const errors = [];
  const consoleErrors = [];
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
  const extensionId = new URL(worker.url()).host;

  // 预置：普通词表 + 默认设置；mock 在线词典接口并计数（绝不发真实网络请求）
  await worker.evaluate(async () => {
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      glossary: { greeting: '问候语（本地词表）' },
      settings: { modelProvider: 'openai', providers: { openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' } }, targetLanguage: '英语', filterEnabled: false, filterRules: [], filterThreshold: 0.82, filterDailyLimit: 80 }
    });
    globalThis.__net = { dictionary: 0, translation: 0 };
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      const u = String(url);
      if (u.includes('api.dictionaryapi.dev')) {
        globalThis.__net.dictionary++;
        return new Response(JSON.stringify([{ word: 'unknown', phonetic: 'ˈʌnˌnoʊn', meanings: [{ partOfSpeech: 'noun', definitions: [{ definition: 'mock online definition' }] }] }]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('mymemory.translated.net')) {
        globalThis.__net.translation++;
        return new Response(JSON.stringify({ responseData: { translatedText: '模拟在线释义' } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('api.typesafe.ai') || u.includes('api.openai.com')) throw new Error('network blocked in this test');
      return original(url, options);
    };
  });
  const net = () => worker.evaluate(() => ({ ...globalThis.__net }));

  // ---------- 1) popup: dictionary tab wiring (panel + import button, no CSP errors) ----------
  const popup = await context.newPage();
  popup.on('pageerror', error => errors.push('popup:' + error.message));
  popup.on('console', message => { if (message.type() === 'error') consoleErrors.push('popup:' + message.text()); });
  await popup.setViewportSize({ width: 372, height: 720 });
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await popup.locator('[data-tab="dictionary"]').click();
  await popup.locator('#open-mdx-import').waitFor({ timeout: 5000 });
  await popup.locator('#mdx-root .mdx-file').waitFor({ timeout: 5000 });
  await popup.locator('#mdx-root .mdx-primary').first().waitFor({ timeout: 5000 });
  say('PASS 弹窗词典页挂载：MDX 面板 + 独立导入页按钮');

  const lookup = word => popup.evaluate(w => chrome.runtime.sendMessage({ action: 'LOOKUP', word: w }), word);

  // ---------- 2) local glossary first ----------
  const glossaryHit = await lookup('greeting');
  assert.equal(glossaryHit.ok, true, JSON.stringify(glossaryHit));
  assert.match(glossaryHit.data.source, /本地词表/);
  assert((await net()).dictionary === 0, 'glossary hit must not touch the network');
  say('PASS 查词顺序①：本地词表命中，零网络请求');

  // ---------- 3) before import: MDX absent → online fallback (mocked, counted) ----------
  const before = await net();
  const preImport = await lookup('wiringtest');
  assert.equal(preImport.ok, true, JSON.stringify(preImport));
  assert.match(preImport.data.source, /MyMemory/);
  const after = await net();
  assert(after.dictionary - before.dictionary === 1, 'online fallback should call the dictionary API once');
  assert(after.translation - before.translation === 1, 'online fallback should call the translation API once');
  say('PASS 查词顺序②：未导入 MDX 时走在线兜底（mock 计数 dictionary+1 / translation+1）');

  // ---------- 4) standalone import page opens in the extension origin (CSP fix) ----------
  const [importPage] = await Promise.all([
    context.waitForEvent('page'),
    popup.locator('#open-mdx-import').click()
  ]);
  importPage.on('pageerror', error => errors.push('import:' + error.message));
  importPage.on('console', message => { if (message.type() === 'error') consoleErrors.push('import:' + message.text()); });
  await importPage.waitForLoadState('domcontentloaded');
  assert(importPage.url().startsWith(`chrome-extension://${extensionId}/mdx/import.html`), 'import page url: ' + importPage.url());
  await importPage.locator('#root > *').first().waitFor({ timeout: 5000 });
  await importPage.locator('.mdx-file').waitFor({ timeout: 5000 });
  assert(!consoleErrors.some(text => /Content Security Policy|Refused to/i.test(text)), 'import page must have no CSP errors: ' + consoleErrors.join(' | '));
  say('PASS 独立导入页在扩展 origin 打开（#root 已挂载，0 CSP 错误）');

  // ---------- 5) import the fixture MDX from the import page ----------
  await importPage.locator('.mdx-file').setInputFiles(fixturePath);
  await importPage.locator('.mdx-primary').first().click();
  await importPage.getByText(/已导入《Fixture Dictionary》/).waitFor({ timeout: 30000 });
  say('PASS 夹具 MDX 导入完成（状态行含《Fixture Dictionary》）');

  // ---------- 6) background LOOKUP is local-first after import (no network) ----------
  await popup.reload();
  await popup.locator('[data-tab="dictionary"]').click();
  await popup.locator('#mdx-root .mdx-file').waitFor({ timeout: 5000 });
  const onlineBefore = await net();
  const mdxHit = await lookup('wiringtest');
  assert.equal(mdxHit.ok, true, JSON.stringify(mdxHit));
  assert.match(mdxHit.data.source, /本地词典《Fixture Dictionary》/, 'source: ' + mdxHit.data.source);
  assert.equal(mdxHit.data.offline, true);
  assert.match(mdxHit.data.meanings[0].definition, /a wiring test entry/);
  assert.match(mdxHit.data.meanings[0].partOfSpeech, /noun|n\./);
  const onlineAfter = await net();
  assert(onlineAfter.dictionary === onlineBefore.dictionary && onlineAfter.translation === onlineBefore.translation, 'MDX hit must not touch the network');
  say('PASS 查词顺序③：MDX 命中完全离线（来源=本地词典，0 网络请求）');

  // ---------- 7) suggest + neighbours messages are wired ----------
  const suggested = await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'MDX_SUGGEST', prefix: 'wir', limit: 10 }));
  assert.equal(suggested.ok, true, JSON.stringify(suggested));
  assert(suggested.data.some(item => item.word === 'wiringtest'), JSON.stringify(suggested.data));
  const neighbours = await popup.evaluate(() => chrome.runtime.sendMessage({ action: 'MDX_NEIGHBOURS', word: 'wiringtest', span: 1 }));
  assert.equal(neighbours.ok, true, JSON.stringify(neighbours));
  say('PASS MDX_SUGGEST / MDX_NEIGHBOURS 消息已接线');

  // ---------- 8) unknown word falls back online; glossary still wins ----------
  const miss = await lookup('zzzznotaword');
  assert.equal(miss.ok, true, JSON.stringify(miss));
  assert.match(miss.data.source, /MyMemory/);
  const glossaryAgain = await lookup('greeting');
  assert.match(glossaryAgain.data.source, /本地词表/);
  say('PASS 未命中 MDX 的词走在线兜底；本地词表优先级不变');

  assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
  assert.deepEqual(consoleErrors.filter(text => !/favicon|Download the React/.test(text)), [], 'console errors: ' + consoleErrors.join(' | '));
  say('PASS 页面无 JS 错误、无 CSP 错误');
  say('dictionary-wiring.cjs 全部完成');

  fs.writeFileSync(path.join(__dirname, 'evidence-dictionary-wiring.txt'), log.join('\n'), 'utf8');
  try { fs.rmSync(fixturePath, { force: true }); } catch {}
  await context.close();
  process.exit(0);
})().catch(error => {
  console.error(error);
  try { fs.writeFileSync(path.join(__dirname, 'evidence-dictionary-wiring.txt'), log.join('\n') + '\nFAILED: ' + error.stack, 'utf8'); } catch {}
  process.exit(1);
});
