// Local-only adversarial browser test for the Jev P1 fixes (audit 2026-09-25):
//  1) a late HIT from an old post must NOT collapse a node reused by a new post;
//     the current post's own HIT still collapses and is expandable
//  2) a late HIT after the filter is switched off must NOT collapse
//  3) a placeholder short post that grows at the same URL is re-judged
//  4) failed HTTP attempts count against the daily budget (hard cap, no bypass)
//  5) HTTP 200 with malformed body is a failure, not a cached non-match
// Loads the real extension into an isolated Edge profile; all network is mocked.
// Note: background serializes JEV calls through jevQueue, so a parked request
// blocks the ones behind it — scenarios resolve the queue strictly in order.
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 启动时清理 30 分钟前的本测试遗留 profile，防止临时盘写满。
(() => { try { for (const d of fs.readdirSync(os.tmpdir())) { if (/^(bx-jev-adv-)/.test(d)) { const p = path.join(os.tmpdir(), d); if (Date.now() - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } } } catch {} })();

const log = [];
const say = line => { log.push(line); console.log(line); };

const fixture = `<!doctype html><html><body><main>
<article data-testid="tweet" id="p1"><div data-testid="User-Name">Old</div><div data-testid="tweetText">Old flame bait post that should only be judged while it is the current content of this node.</div><a href="/old/status/1">link</a><div role="group"><button>Reply</button></div></article>
<article data-testid="tweet" id="p2"><div data-testid="User-Name">Calma</div><div data-testid="tweetText">Calm post about reading books and writing language notes, used for the filter-disabled scenario here.</div><a href="/calm/status/2">link</a><div role="group"><button>Reply</button></div></article>
<article data-testid="tweet" id="p3"><div data-testid="User-Name">Grow</div><div data-testid="tweetText">placeholder</div><a href="/grow/status/3">link</a><div role="group"><button>Reply</button></div></article>
<article data-testid="tweet" id="p4"><div data-testid="User-Name">Fail</div><div data-testid="tweetText">always failing post content for the daily budget hard cap scenario in this test run ok.</div><a href="/fail/status/4">link</a><div role="group"><button>Reply</button></div></article>
<article data-testid="tweet" id="p5"><div data-testid="User-Name">Weird</div><div data-testid="tweetText">malformed json 200 response post used to verify the extension treats it as failure not as miss.</div><a href="/weird/status/5">link</a><div role="group"><button>Reply</button></div></article>
</main></body></html>`;

const HIT = { model: 'jev-latest', answers: { rule_0: { type: 'noul', noul: 0.99 } } };

(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-jev-adv-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://x.com/jev-adv-fixture', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });

  const baseSettings = {
    modelProvider: 'openai',
    providers: {
      openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' },
      deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
      mimo: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash' },
      glm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' }
    },
    targetLanguage: '英语',
    filterEnabled: true,
    filterRules: [{ id: 'r1', text: 'flame bait', enabled: true }],
    filterThreshold: 0.82,
    filterDailyLimit: 80
  };

  // Mock TypeSafe inside the service worker:
  //   hold[]: substrings of the request JSON whose fetches are parked until resolveHeld()
  //   failAll / malformedAll: every non-parked request returns 500 / 200 {}
  //   default: auto MISS; texts[] records every post text that reached the API
  await worker.evaluate(() => {
    globalThis.__jev = { pending: [], hold: [], failAll: false, malformedAll: false, http: 0, texts: [] };
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('api.typesafe.ai/v1/systemone')) {
        const jev = globalThis.__jev;
        const raw = options.body || '{}';
        const post = JSON.parse(raw).state?.post || '';
        jev.http++;
        jev.texts.push(post.slice(0, 80));
        if (jev.hold.some(marker => raw.includes(marker))) {
          return new Promise(resolve => jev.pending.push({ resolve, match: raw }));
        }
        if (jev.failAll) return new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } });
        if (jev.malformedAll) return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
        return new Response(JSON.stringify({ model: 'jev-latest', answers: { rule_0: { type: 'noul', noul: 0.2 } } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return original(url, options);
    };
  });
  const jevEval = expr => worker.evaluate(`(() => { const j = globalThis.__jev; return (${expr}); })()`);
  async function resolveHeld(matcher, payload) {
    const ok = await worker.evaluate(({ matcher, payload }) => {
      const j = globalThis.__jev;
      const index = j.pending.findIndex(item => item.match.includes(matcher));
      if (index < 0) return false;
      const [item] = j.pending.splice(index, 1);
      item.resolve(new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      return true;
    }, { matcher, payload });
    assert(ok, `no parked request matching ${matcher}`);
  }

  async function setSettings(settings, extra = {}) {
    await worker.evaluate(({ settings, extra }) => {
      const day = new Date().toISOString().slice(0, 10);
      return chrome.storage.local.set({ settings, jevDaily: Object.assign({ day, used: 0 }, extra.jevDaily || {}) });
    }, { settings, extra });
  }
  async function freshStart(settings, storageExtra = {}, mockExtra = {}) {
    await worker.evaluate(({ settings, storageExtra, mockExtra }) => {
      const day = new Date().toISOString().slice(0, 10);
      Object.assign(globalThis.__jev, { pending: [], hold: [], failAll: false, malformedAll: false, http: 0, texts: [] }, mockExtra);
      return chrome.storage.local.clear().then(() => chrome.storage.local.set(Object.assign({
        settings, jevKey: 'test-jev-key', jevDaily: { day, used: 0 }
      }, storageExtra)));
    }, { settings, storageExtra, mockExtra });
  }
  const settle = (ms = 500) => page.waitForTimeout(ms);

  // ---------- 1) node reuse: old HIT must not collapse the new post ----------
  await freshStart(baseSettings, {}, { hold: ['Old flame bait'] });
  await page.goto('https://x.com/jev-adv-fixture');
  await page.locator('#p1 .bx-inline-button').waitFor({ timeout: 15000 });
  for (let i = 0; i < 70 && await jevEval('j.pending.length') < 1; i++) await settle(100);
  assert(await jevEval('j.pending.length') >= 1, 'old post request should be parked');
  say('PASS 旧帖请求挂起（场景 1 准备）');

  // X recycles the node for a brand-new post; its judgment queues behind the parked one
  await worker.evaluate(() => { globalThis.__jev.hold = ['Old flame bait', 'A calm new post']; });
  await page.locator('#p1').evaluate(el => {
    el.innerHTML = '<div data-testid="User-Name">New</div><div data-testid="tweetText">A calm new post about reading books and sharing language notes for independent study.</div><a href="/new/status/9">link</a><div role="group"><button>Reply</button></div>';
  });
  await settle(700); // scan debounce (350ms) + reuse detection
  await resolveHeld('Old flame bait', HIT);
  await settle(600);
  const p1State = await page.locator('#p1').evaluate(el => ({ cls: el.className, filtered: el.dataset.bxFiltered || '', key: el.dataset.bxPostKey || '' }));
  assert(!p1State.cls.includes('bx-collapsed'), 'old hit must NOT collapse reused node: ' + JSON.stringify(p1State));
  assert(p1State.key.includes('/new/status/9'), 'node should carry the new post identity: ' + JSON.stringify(p1State));
  say('PASS 旧帖晚到命中不折叠复用后的新帖');

  // the queued request for the NEW post parks itself; its own HIT must collapse
  for (let i = 0; i < 70 && await jevEval('j.pending.length') < 1; i++) await settle(100);
  assert(await jevEval('j.pending.length') >= 1, 'new post request should be parked');
  await resolveHeld('A calm new post', HIT);
  await page.locator('#p1.bx-collapsed').waitFor({ timeout: 8000 });
  await page.locator('#p1 .bx-collapse-bar button').click();
  assert(!(await page.locator('#p1').evaluate(el => el.classList.contains('bx-collapsed'))), 'must expand');
  say('PASS 当前帖命中正常折叠且可展开');

  // drain the auto-miss queue behind the parked requests (p4, p5 …)
  await worker.evaluate(() => { globalThis.__jev.hold = []; });
  await settle(1200);

  // ---------- 2) filter disabled while a request is in flight ----------
  // bump the threshold to force a fresh judgment wave, with p2's request parked
  await worker.evaluate(() => { globalThis.__jev.hold = ['Calm post about reading books']; });
  await setSettings({ ...baseSettings, filterThreshold: 0.83 });
  for (let i = 0; i < 70 && await jevEval('j.pending.length') < 1; i++) await settle(100);
  assert(await jevEval('j.pending.length') >= 1, 'p2 request should be parked');
  // switch the filter off while p2 is still in flight
  await setSettings({ ...baseSettings, filterEnabled: false });
  await settle(600); // content.js receives PUBLIC_SETTINGS and bumps the epoch
  await resolveHeld('Calm post about reading books', HIT);
  await settle(500);
  const p2State = await page.locator('#p2').evaluate(el => ({ cls: el.className, filtered: el.dataset.bxFiltered || '' }));
  assert(!p2State.cls.includes('bx-collapsed'), 'late result must not collapse after filter disabled: ' + JSON.stringify(p2State));
  say('PASS 关闭筛选后晚到结果不折叠');
  await worker.evaluate(() => { globalThis.__jev.hold = []; });
  await settle(800);

  // ---------- 3) placeholder growth at the same URL is re-judged ----------
  await setSettings(baseSettings); // re-enable → wave re-judges every post, p3 stays skipped
  await settle(1500);
  const shortSent = await jevEval('j.texts.filter(t => t.includes("placeholder")).length');
  const p3State = await page.locator('#p3').evaluate(el => el.dataset.bxFiltered || '');
  assert.equal(p3State, 'skipped', 'short placeholder must be marked skipped, got: ' + p3State);
  assert.equal(shortSent, 0, 'short placeholder must never reach the API, got: ' + shortSent);
  await page.locator('#p3 [data-testid="tweetText"]').evaluate(el => {
    el.innerText = 'This placeholder grew into a full length post about sharing reading notes and language learning.';
  });
  for (let i = 0; i < 70 && (await jevEval('j.texts.filter(t => t.includes("grew into a full length")).length')) < 1; i++) await settle(100);
  assert((await jevEval('j.texts.filter(t => t.includes("grew into a full length")).length')) >= 1, 'grown post must be judged');
  say('PASS 同 URL 占位短文补长后重新检查（短文 0 请求 → 补长后发起请求）');

  // ---------- 4) failed attempts consume the daily budget (hard cap) ----------
  const limitedSettings = { ...baseSettings, filterDailyLimit: 10 };
  await freshStart(limitedSettings, { jevDaily: { day: new Date().toISOString().slice(0, 10), used: 9 } }, { failAll: true });
  await page.reload();
  await page.locator('#p1 .bx-inline-button').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => [...document.querySelectorAll('article')].some(a => a.dataset.bxFiltered === 'limited'), null, { timeout: 25000 });
  await settle(3500); // long enough for any retry timer to fire and prove the cap holds
  const budget = await worker.evaluate(async () => {
    const day = new Date().toISOString().slice(0, 10);
    const { jevDaily = {}, jevStats = {} } = await chrome.storage.local.get(['jevDaily', 'jevStats']);
    return { used: jevDaily.used, day: jevDaily.day, stats: jevStats, http: globalThis.__jev.http };
  });
  assert.equal(budget.used, 10, 'budget must stop at the limit, used=' + budget.used);
  assert(budget.http <= 1, `used 9/10 + failing post must allow at most 1 HTTP attempt, got ${budget.http}`);
  assert((budget.stats.limited || 0) >= 1, 'limit must be recorded in stats: ' + JSON.stringify(budget.stats));
  say(`PASS 失败请求被每日上限硬封顶（used=${budget.used}/10，HTTP=${budget.http}，limited=${budget.stats.limited}）`);

  // ---------- 5) HTTP 200 {} is a failure, not a cached non-match ----------
  await freshStart(baseSettings, {}, { malformedAll: true });
  await page.reload();
  await page.locator('#p1 .bx-inline-button').waitFor({ timeout: 15000 });
  await page.waitForFunction(() => [...document.querySelectorAll('article')].some(a => a.dataset.bxFiltered === 'failed'), null, { timeout: 25000 });
  await settle(1000);
  const malformed = await worker.evaluate(async () => {
    const { jevStats = {}, jevCache = {} } = await chrome.storage.local.get(['jevStats', 'jevCache']);
    return { stats: jevStats, cacheCount: Object.keys(jevCache).length };
  });
  assert.equal(malformed.cacheCount, 0, 'malformed response must not be cached: ' + JSON.stringify(malformed));
  assert((malformed.stats.failed || 0) >= 1, 'malformed response must count as failure: ' + JSON.stringify(malformed.stats));
  assert.equal(malformed.stats.judged || 0, 0, 'malformed response must not count as a judgment: ' + JSON.stringify(malformed.stats));
  const failedPost = await page.evaluate(() => {
    const node = [...document.querySelectorAll('article')].find(a => a.dataset.bxFiltered === 'failed');
    return node ? { error: node.dataset.bxLastError || '', key: node.dataset.bxPostKey } : null;
  });
  assert(failedPost, 'a post must end as failed');
  assert.match(failedPost.error, /格式异常/, 'error must surface the malformed-response reason: ' + failedPost.error);
  say(`PASS 200 畸形响应记为失败且不缓存（failed=${malformed.stats.failed}, cache=${malformed.cacheCount}, error=${failedPost.error}）`);

  assert.deepEqual(errors, []);
  say('PASS 页面无 JS 错误');
  say('jev-adversarial.cjs 全部完成');
  fs.writeFileSync(path.join(__dirname, 'evidence-jev-adversarial.txt'), log.join('\n'), 'utf8');
  await context.close();
  process.exit(0);
})().catch(error => {
  console.error(error);
  try { fs.writeFileSync(path.join(__dirname, 'evidence-jev-adversarial.txt'), log.join('\n') + '\nFAILED: ' + error.stack, 'utf8'); } catch {}
  process.exit(1);
});
