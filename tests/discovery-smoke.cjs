// Discovery module browser test (local simulation only; Jev mock inside the service worker).
// Covers task brief 4:
//   ① default off ⇒ zero requests + explicit setup guidance (not opened / no key)
//   ② interest rule CRUD lands in STORE (discoveryPrefs) and survives reload
//   ③ kind='interest' request shape (questions come from interestRules) + highlight marker UI
//   ④ highlight races: late old-post result must not highlight a reused node; turning the
//      interest switch off voids in-flight results (and queued requests stop hitting HTTP);
//      a placeholder that grows at the same URL is re-judged
//   ⑤ fold regression: hit ⇒ collapse only, expandable, interest stays quiet
//   ⑥ fold and interest share ONE daily counter (interest is rate-limited after fold used it up)
//   ⑦ diagnostics panel fields (four states / used / highlighted / collapsed / cached / failed / last error)
//   ⑧ X-native guidance copy exists and declares the plugin never operates X for the user
// Never opens a real x.com session; all network to the Jev API is mocked and counted.
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 启动时清理 30 分钟前的本测试遗留 profile，防止临时盘写满。
(() => { try { for (const d of fs.readdirSync(os.tmpdir())) { if (/^(bx-discovery-)/.test(d)) { const p = path.join(os.tmpdir(), d); if (Date.now() - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } } } catch {} })();

const log = [];
const say = line => { log.push(line); console.log(line); };

const tweet = (id, user, text, href) =>
  `<article data-testid="tweet" id="${id}"><div data-testid="User-Name">${user}</div><div data-testid="tweetText">${text}</div><a href="${href}">link</a><div role="group"><button>Reply</button></div></article>`;

const fixture = `<!doctype html><html><body><main>
${tweet('p1', 'Old', 'Old interest target post about sharing language learning notes for the community discussion.', '/old/status/1')}
${tweet('p2', 'Calma', 'A calm post about reading books and writing language notes for independent study every day.', '/calm/status/2')}
${tweet('p3', 'Grow', 'placeholder', '/grow/status/3')}
${tweet('p4', 'Flame', 'Flame bait content that only exists to argue about language learning methods online today.', '/flame/status/4')}
${tweet('p5', 'More', 'Another long post about travel photography and city walks shared with friends this weekend.', '/more/status/5')}
</main></body></html>`;

const emptyFixture = '<!doctype html><html><body><main></main></body></html>';

const baseSettings = (overrides = {}) => ({
  modelProvider: 'openai',
  providers: {
    openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-6-luna' },
    deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-flash' },
    mimo: { baseUrl: 'https://api.xiaomimimo.com/v1', model: 'mimo-v2.6-flash' },
    glm: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus' }
  },
  targetLanguage: '英语',
  filterEnabled: false,
  filterRules: [],
  filterThreshold: 0.82,
  filterDailyLimit: 80,
  ...overrides
});

const FOLD_RULES = [{ id: 'r1', text: 'flame bait', enabled: true }];
const INT_PREFS = { enabled: false, interestRules: [{ id: 'i1', text: 'language learning', enabled: true }] };

(async () => {
  const root = path.resolve(__dirname, '..');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-discovery-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const page = await context.newPage();
  await page.setViewportSize({ width: 1180, height: 900 });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('https://x.com/discovery-fixture', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: fixture }));
  await page.route('https://x.com/discovery-empty', route => route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: emptyFixture }));

  const worker = await (async () => {
    for (let i = 0; i < 60; i++) {
      const w = context.serviceWorkers()[0];
      if (w) return w;
      try { return await context.waitForEvent('serviceworker', { timeout: 500 }); } catch { /* retry */ }
    }
    throw new Error('service worker 未在 30s 内启动');
  })();

  // ---- Jev mock inside the service worker (proves the pipeline only; no real model) ----
  //   hold[]: park fetches whose body contains the marker until resolveHeld()
  //   hits[]: answer 0.97 (match) when the body contains a marker, else 0.2 (miss)
  //   bodies[] / texts[]: record every request that reached the API (shape + shape assertions)
  async function installMock() {
    await worker.evaluate(() => {
      if (globalThis.__bxJevMock) return;
      globalThis.__bxJevMock = true;
      globalThis.__jev = { pending: [], hold: [], hits: [], failAll: false, http: 0, bodies: [], texts: [] };
      const original = globalThis.fetch;
      globalThis.fetch = async (url, options) => {
        if (String(url).includes('api.typesafe.ai/v1/systemone')) {
          const jev = globalThis.__jev;
          const raw = options.body || '{}';
          let parsed = {};
          try { parsed = JSON.parse(raw); } catch { /* keep empty */ }
          const post = parsed.state?.post || '';
          const count = Object.keys(parsed.questions || {}).length;
          jev.http++;
          jev.bodies.push(raw);
          jev.texts.push(post.slice(0, 80));
          if (jev.hold.some(marker => raw.includes(marker))) {
            return new Promise(resolve => jev.pending.push({ resolve, match: raw, count }));
          }
          if (jev.failAll) return new Response('boom', { status: 500, headers: { 'Content-Type': 'text/plain' } });
          const noul = jev.hits.some(marker => raw.includes(marker)) ? 0.97 : 0.2;
          const answers = Object.fromEntries(Array.from({ length: count }, (_, i) => [`rule_${i}`, { type: 'noul', noul }]));
          return new Response(JSON.stringify({ model: 'jev-latest', answers }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }
        return original(url, options);
      };
    });
  }
  const jevEval = expr => worker.evaluate(`(() => { const j = globalThis.__jev; return (${expr}); })()`);
  async function resetMock(patch = {}) {
    await installMock(); // SW may have restarted between scenarios
    await worker.evaluate(patch => Object.assign(globalThis.__jev, {
      pending: [], hold: [], hits: [], failAll: false, http: 0, bodies: [], texts: []
    }, patch), patch);
  }
  const setMock = patch => worker.evaluate(patch => Object.assign(globalThis.__jev, patch), patch);
  async function resolveHeld(matcher, noul) {
    const ok = await worker.evaluate(({ matcher, noul }) => {
      const j = globalThis.__jev;
      const index = j.pending.findIndex(item => item.match.includes(matcher));
      if (index < 0) return false;
      const [item] = j.pending.splice(index, 1);
      const answers = Object.fromEntries(Array.from({ length: item.count }, (_, i) => [`rule_${i}`, { type: 'noul', noul }]));
      item.resolve(new Response(JSON.stringify({ model: 'jev-latest', answers }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      return true;
    }, { matcher, noul });
    assert(ok, `no parked request matching ${matcher}`);
  }
  async function seedStorage(extra = {}) {
    // 先撤走时间线页：写 settings 会广播 BX_SETTINGS_CHANGED，旧页若还在会按新设置
    // 整表重判（污染 used / 缓存 / 挂起队列）。空时间线页收到广播也不会发请求。
    if (!page.url().includes('discovery-empty')) await page.goto('https://x.com/discovery-empty');
    await worker.evaluate(async extra => {
      await chrome.storage.local.clear();
      const day = new Date().toISOString().slice(0, 10);
      await chrome.storage.local.set({ jevDaily: { day, used: 0 }, ...extra });
    }, extra);
  }
  const readPrefs = () => worker.evaluate(async () => (await chrome.storage.local.get('discoveryPrefs')).discoveryPrefs || null);
  const readBudget = () => worker.evaluate(async () => {
    const { jevDaily = {}, jevStats = {} } = await chrome.storage.local.get(['jevDaily', 'jevStats']);
    return { used: jevDaily.used || 0, stats: jevStats };
  });

  const settle = ms => page.waitForTimeout(ms);
  async function waitForJev(expr, tries = 90, step = 100) {
    for (let i = 0; i < tries; i++) { if (await jevEval(expr)) return true; await settle(step); }
    return false;
  }
  async function openDiscovery() {
    if (!(await page.locator('#bx-sidebar.bx-open').count())) {
      await page.locator('#bx-sidebar-handle').click({ timeout: 8000 });
      await page.locator('#bx-sidebar.bx-open').waitFor({ timeout: 8000 });
    }
    await page.locator('[data-bx-mode="discovery"]').click();
    await page.locator('#bx-disc-status[data-used]').waitFor({ timeout: 12000 });
  }

  await installMock();
  await page.goto('https://x.com/discovery-fixture');
  await page.locator('.bx-inline-button').first().waitFor({ timeout: 15000 });

  // ---------- ① default off: zero requests + guidance (not opened / no key) ----------
  await seedStorage({ settings: baseSettings() }); // no jevKey, no discoveryPrefs, fold off
  await resetMock();
  await page.goto('https://x.com/discovery-fixture');
  await page.locator('.bx-inline-button').first().waitFor({ timeout: 15000 });
  await settle(2500); // long enough for any wrongly-fired request to show up
  assert.equal(await jevEval('j.http'), 0, 'default off must send zero Jev requests');
  assert.equal(await jevEval('j.texts.length'), 0, 'default off must send zero posts');
  assert.equal(await page.locator('article.bx-collapsed').count(), 0, 'nothing collapsed by default');
  assert.equal(await page.locator('article.bx-interest-hit').count(), 0, 'nothing highlighted by default');
  await openDiscovery();
  assert.equal(await page.locator('[data-bx-mode="discovery"]').count(), 1, 'discovery tab must be registered');
  assert.equal(await page.locator('#bx-disc-status').getAttribute('data-state'), 'disabled');
  assert.equal(await page.locator('#bx-disc-status').getAttribute('data-int-state'), 'disabled');
  const setup = await page.locator('#bx-disc-setup').innerText();
  assert(setup.includes('未开启'), 'setup guidance must explain "not enabled": ' + setup);
  assert(setup.includes('密钥'), 'setup guidance must explain the missing key: ' + setup);
  await page.locator('#bx-sidebar').screenshot({ path: path.join(root, 'tests', 'discovery-setup.png') });
  say('PASS ①a 默认关闭：零请求 + 未开启/缺密钥引导');

  // no key while fold is switched on ⇒ still zero requests, state = 缺密钥
  await seedStorage({ settings: baseSettings({ filterEnabled: true, filterRules: FOLD_RULES }) });
  await resetMock();
  await page.goto('https://x.com/discovery-fixture');
  await page.locator('.bx-inline-button').first().waitFor({ timeout: 15000 });
  await settle(2000);
  assert.equal(await jevEval('j.http'), 0, 'missing key must send zero requests');
  await openDiscovery();
  assert.equal(await page.locator('#bx-disc-status').getAttribute('data-state'), 'no_key');
  assert((await page.locator('#bx-disc-setup').innerText()).includes('密钥'), 'no-key guidance must be shown');
  say('PASS ①b 缺密钥：状态=缺密钥、引导给出配置路径、零请求');

  // ---------- ⑧ X-native guidance copy (checked while the panel is open) ----------
  const guide = await page.locator('#bx-native-guide').innerText();
  assert.match(guide, /更多 → 不感兴趣/, 'guide must teach "more → not interested"');
  assert.match(guide, /展现你感兴趣的/, 'guide must teach "show me more of this"');
  assert.match(guide, /话题/, 'guide must teach following interest topics');
  assert.match(guide, /关闭不感兴趣内容/, 'guide must teach turning off "not interested" fallout');
  assert.match(guide, /绝不替你自动点击 X 的任何原生控件/, 'guide must declare the no-auto-click boundary');
  assert.match(guide, /不模拟、不代操作/, 'guide must declare no simulation / no proxy actions');
  say('PASS ⑧ 指引文案存在：原生兴趣操作 + 明确声明不代操作 X');

  // ---------- ② interest rule CRUD lands in STORE and survives reload ----------
  await seedStorage({ settings: baseSettings(), jevKey: 'test-jev-key' });
  await resetMock();
  await page.goto('https://x.com/discovery-fixture');
  await page.locator('.bx-inline-button').first().waitFor({ timeout: 15000 });
  await openDiscovery();
  await page.locator('#bx-int-add').click();
  await page.locator('#bx-int-rule-0').fill('language learning methods');
  await settle(400);
  let prefs = await readPrefs();
  assert.equal(prefs.interestRules.length, 1, JSON.stringify(prefs));
  assert.equal(prefs.interestRules[0].text, 'language learning methods');
  assert.equal(prefs.interestRules[0].enabled, true);
  assert.equal(prefs.enabled, false, 'CRUD must not silently turn the switch on');

  await page.locator('#bx-int-add').click();
  await page.locator('#bx-int-rule-1').fill('city walk photography');
  await settle(400);
  await page.locator('.bx-disc-rule-toggle[data-rule-index="0"]').click();
  await settle(400);
  prefs = await readPrefs();
  assert.equal(prefs.interestRules[0].enabled, false, 'rule toggle must persist');
  assert.equal(prefs.interestRules[1].text, 'city walk photography');

  await page.locator('.bx-disc-rule-del[data-rule-index="0"]').click();
  await settle(400);
  prefs = await readPrefs();
  assert.equal(prefs.interestRules.length, 1, 'delete must persist: ' + JSON.stringify(prefs));
  assert.equal(prefs.interestRules[0].text, 'city walk photography');

  await page.locator('#bx-int-threshold').fill('0.75');
  await settle(500);
  prefs = await readPrefs();
  assert.equal(prefs.interestThreshold, 0.75, 'threshold must persist: ' + JSON.stringify(prefs));
  assert.equal(await jevEval('j.http'), 0, 'CRUD with the switch off must send zero requests');

  await page.goto('https://x.com/discovery-fixture');
  await page.locator('.bx-inline-button').first().waitFor({ timeout: 15000 });
  await openDiscovery();
  assert.equal(await page.locator('#bx-int-rule-0').inputValue(), 'city walk photography', 'rule text must survive reload');
  assert.equal(await page.locator('#bx-int-threshold').inputValue(), '0.75', 'threshold must survive reload');
  assert.equal(await page.locator('.bx-disc-rule-toggle[data-rule-index="0"]').isChecked(), true);
  prefs = await readPrefs();
  assert.equal(prefs.interestRules.length, 1);
  assert.equal(prefs.interestThreshold, 0.75);
  await page.locator('#bx-sidebar').screenshot({ path: path.join(root, 'tests', 'discovery-panel.png') });
  await page.locator('#bx-body').evaluate(el => { el.scrollTop = el.scrollHeight; }); // 规则列表 + 原生兴趣指引
  await settle(250);
  await page.locator('#bx-sidebar').screenshot({ path: path.join(root, 'tests', 'discovery-guide.png') });
  say('PASS ② 兴趣规则 CRUD 落 STORE（discoveryPrefs），刷新后仍在');

  // ---------- ③ kind='interest' request shape + highlight marker ----------
  await seedStorage({
    settings: baseSettings(),
    jevKey: 'test-jev-key',
    discoveryPrefs: { enabled: true, interestRules: [{ id: 'i1', text: 'language learning', enabled: true }] }
  });
  await resetMock({ hits: ['reader-defined interest'] });
  await page.goto('https://x.com/discovery-fixture');
  await page.locator('.bx-inline-button').first().waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('article.bx-interest-hit').length >= 1, null, { timeout: 20000 });
  const bodies = await jevEval('j.bodies');
  const interestBodies = bodies.filter(body => body.includes('reader-defined interest'));
  assert(interestBodies.length >= 1, 'interest request must exist: ' + JSON.stringify(bodies.map(b => b.slice(0, 60))));
  assert(bodies.every(body => !body.includes('reader-defined rule')), 'fold must stay quiet while fold is off');
  const parsed = JSON.parse(interestBodies[0]);
  assert.equal(parsed.model, 'jev-latest');
  assert.deepEqual(Object.keys(parsed.questions), ['rule_0'], 'questions keys must be rule_N built from interestRules');
  assert.match(parsed.questions.rule_0.instructions, /language learning/, 'questions must carry the interest rule text');
  assert.match(parsed.questions.rule_0.instructions, /interest/, 'interest requests must be distinguishable from fold requests');
  await page.locator('#p1 .bx-interest-mark').waitFor({ timeout: 10000 });
  assert.match(await page.locator('#p1 .bx-interest-mark').innerText(), /适合参与 · /, 'marker must carry the label');
  say('PASS ③ kind=interest 请求形状（questions 来自 interestRules）+ 高亮角标出现');

  await openDiscovery();
  assert.equal(await page.locator('#bx-disc-status').getAttribute('data-interest-enabled'), 'true');
  assert.equal(await page.locator('#bx-disc-status').getAttribute('data-int-state'), 'ok');
  assert(Number(await page.locator('#bx-disc-status').getAttribute('data-highlighted')) >= 1, 'diagnostics must count highlighted posts');
  say('PASS ③/⑦ 诊断面板：兴趣已开启 + 命中高亮数 ≥ 1');

  // highlight is lightweight and clearable
  await page.locator('#bx-close').click();
  await settle(400);
  await page.screenshot({ path: path.join(root, 'tests', 'discovery-highlight.png') });
  await page.locator('#p1 .bx-interest-mark button').click();
  assert(!(await page.locator('#p1').evaluate(el => el.classList.contains('bx-interest-hit'))), 'clear must remove the highlight');
  assert.equal(await page.locator('#p1 .bx-interest-mark').count(), 0, 'clear must remove the marker');
  say('PASS 高亮标记可清除（描边 + 角标均移除）');

  // ---------- ④ highlight races ----------
  await seedStorage({
    settings: baseSettings(),
    jevKey: 'test-jev-key',
    discoveryPrefs: { enabled: true, interestRules: [{ id: 'i1', text: 'language learning', enabled: true }] }
  });
  await resetMock({ hold: ['Old interest target post'] });
  await page.goto('https://x.com/discovery-fixture');
  await page.locator('.bx-inline-button').first().waitFor({ timeout: 15000 });
  assert(await waitForJev('j.pending.length >= 1'), 'old post interest request should park');
  say('PASS ④ 准备：旧帖兴趣请求挂起');

  // (a) X recycles the node for a brand-new post while the old judgment is in flight
  await setMock({ hold: ['Old interest target post', 'A calm new post about sharing'] });
  await page.locator('#p1').evaluate(el => {
    el.innerHTML = '<div data-testid="User-Name">New</div><div data-testid="tweetText">A calm new post about sharing language learning notes for the reuse race check.</div><a href="/new/status/9">link</a><div role="group"><button>Reply</button></div>';
  });
  await settle(800); // scan debounce (350ms) + reuse detection
  await resolveHeld('Old interest target post', 0.97);
  await settle(800);
  const p1State = await page.locator('#p1').evaluate(el => ({
    hit: el.classList.contains('bx-interest-hit'),
    mark: Boolean(el.querySelector('.bx-interest-mark')),
    key: el.dataset.bxPostKey || ''
  }));
  assert(!p1State.hit && !p1State.mark, 'old late hit must NOT highlight the reused node: ' + JSON.stringify(p1State));
  assert(p1State.key.includes('/new/status/9'), 'node must carry the new post identity: ' + JSON.stringify(p1State));
  assert(await waitForJev('j.pending.length >= 1'), 'new post interest request should park');
  await resolveHeld('A calm new post about sharing', 0.97);
  await page.locator('#p1.bx-interest-hit').waitFor({ timeout: 12000 });
  say('PASS ④a 旧帖晚到不高亮复用后的节点；当前帖自己的命中正常高亮');

  // (b) turn the interest switch off while a request is in flight
  // clear the background cache first: p2 was already judged (and cached) while the
  // S4a queue drained, so a fresh wave is the only way to get a real fetch here.
  await worker.evaluate(() => chrome.storage.local.remove('jevCache'));
  await setMock({ hold: ['A calm post about reading books'], hits: [] });
  await openDiscovery();
  await page.locator('#bx-int-enabled').uncheck();
  await settle(500); // persist then epoch bump
  await page.locator('#bx-int-enabled').check();
  assert(await waitForJev('j.pending.length >= 1'), 'p2 interest request should park');
  await page.locator('#bx-int-enabled').uncheck(); // switch off while p2 is still in flight
  await settle(700);
  const httpBefore = await jevEval('j.http');
  await resolveHeld('A calm post about reading books', 0.97);
  await settle(1600);
  assert.equal(await page.locator('article.bx-interest-hit').count(), 0, 'late hit must not highlight after the switch is off');
  const p2State = await page.locator('#p2').evaluate(el => ({ hit: el.classList.contains('bx-interest-hit'), int: el.dataset.bxInt || '' }));
  assert(!p2State.hit, 'p2 must not be highlighted: ' + JSON.stringify(p2State));
  assert.equal(await jevEval('j.http'), httpBefore, 'queued requests must stop hitting HTTP after the switch is off');
  say('PASS ④b 关兴趣开关后晚到不高亮，排队请求不再发 HTTP');

  // (c) placeholder that grows at the same URL is re-judged
  await setMock({ hold: [], hits: ['grew into a full length'] });
  await page.locator('#bx-int-enabled').check();
  await settle(1500); // re-judgment wave settles (p1/p2 cache hits, p4/p5 misses, p3 skipped)
  const p3Before = await page.locator('#p3').evaluate(el => ({ int: el.dataset.bxInt || '', key: el.dataset.bxPostKey || '' }));
  assert.equal(p3Before.int, 'skipped', 'short placeholder must be skipped: ' + JSON.stringify(p3Before));
  assert.equal(await jevEval('j.texts.filter(t => t.includes("placeholder")).length'), 0, 'placeholder must never reach the API');
  await page.locator('#p3 [data-testid="tweetText"]').evaluate(el => {
    el.innerText = 'This placeholder grew into a full length post about sharing reading notes and language learning.';
  });
  assert(await waitForJev('j.texts.some(t => t.includes("grew into a full length"))'), 'grown post must be re-judged');
  await page.locator('#p3.bx-interest-hit').waitFor({ timeout: 12000 });
  const p3After = await page.locator('#p3').evaluate(el => ({ key: el.dataset.bxPostKey || '' }));
  assert(p3After.key.includes('/grow/status/3'), 'same-URL identity must be kept: ' + JSON.stringify(p3After));
  say('PASS ④c 同 URL 占位补长后重新判断（短文 0 请求 → 补长后发起请求并高亮）');

  // ---------- ⑤ fold regression (behaviour of the migrated path must not change) ----------
  await seedStorage({
    settings: baseSettings({ filterEnabled: true, filterRules: FOLD_RULES }),
    jevKey: 'test-jev-key'
    // no discoveryPrefs ⇒ interest stays off
  });
  await resetMock({ hits: ['reader-defined rule'] });
  await page.goto('https://x.com/discovery-fixture');
  await page.locator('.bx-inline-button').first().waitFor({ state: 'attached', timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('article.bx-collapsed').length >= 1, null, { timeout: 20000 });
  const foldBar = page.locator('#p1 .bx-collapse-bar');
  await foldBar.waitFor({ timeout: 10000 });
  assert.match(await foldBar.innerText(), /Jev 折叠/, 'collapse bar label must stay as before');
  await foldBar.locator('button').click();
  assert(!(await page.locator('#p1').evaluate(el => el.classList.contains('bx-collapsed'))), 'expanded post must not stay collapsed');
  assert(await page.locator('#p1 [data-testid="tweetText"]').isVisible(), 'expand must reveal the post');
  const foldBodies = await jevEval('j.bodies');
  assert(foldBodies.some(body => body.includes('reader-defined rule')), 'fold request must exist');
  assert(foldBodies.every(body => !body.includes('reader-defined interest')), 'interest must stay quiet when folded off');
  assert.equal(await page.locator('article.bx-interest-hit').count(), 0, 'no highlight while interest is off');
  say('PASS ⑤ 折叠回归：命中只折叠、可展开，兴趣路径保持安静');

  // ---------- ⑥ shared daily cap ----------
  await seedStorage({
    settings: baseSettings({ filterEnabled: true, filterRules: FOLD_RULES, filterDailyLimit: 2 }),
    jevKey: 'test-jev-key',
    discoveryPrefs: INT_PREFS // rule present but switch off; fold consumes the shared budget first
  });
  await resetMock({ hits: [], hold: [] });
  await page.goto('https://x.com/discovery-fixture');
  await page.locator('.bx-inline-button').first().waitFor({ state: 'attached', timeout: 15000 });
  await page.waitForFunction(() => [...document.querySelectorAll('article')].some(a => a.dataset.bxFiltered === 'limited'), null, { timeout: 25000 });
  await settle(800);
  let budget = await readBudget();
  assert.equal(budget.used, 2, 'fold must stop exactly at the daily limit, used=' + budget.used);
  assert.equal(await jevEval('j.http'), 2, 'HTTP attempts must stop at the limit, got ' + (await jevEval('j.http')));
  assert((budget.stats.limited || 0) >= 1, 'limit must be recorded in stats: ' + JSON.stringify(budget.stats));
  say(`PASS ⑥ 折叠把每日上限用尽（used=${budget.used}/2，HTTP=2）`);

  await openDiscovery();
  assert.equal(await page.locator('#bx-disc-status').getAttribute('data-state'), 'limited', 'fold state must read 已达上限');
  assert.equal(await page.locator('#bx-disc-status').getAttribute('data-used'), '2');
  await page.locator('#bx-int-enabled').check(); // interest joins the SAME counter
  await page.waitForFunction(() => [...document.querySelectorAll('article')].some(a => a.dataset.bxInt === 'limited'), null, { timeout: 25000 });
  await settle(800);
  budget = await readBudget();
  assert.equal(budget.used, 2, 'interest must share the same used counter, used=' + budget.used);
  assert.equal(await jevEval('j.http'), 2, 'interest at the cap must not fire HTTP, got ' + (await jevEval('j.http')));
  await page.locator('#bx-disc-refresh').click();
  await page.locator('#bx-disc-status[data-int-state="limited"]').waitFor({ timeout: 8000 });
  assert.match(await page.locator('#bx-disc-status').innerText(), /已达上限/, 'diagnostics must show 已达上限');
  await page.locator('#bx-sidebar').screenshot({ path: path.join(root, 'tests', 'discovery-limited.png') });
  say('PASS ⑥ 兴趣与折叠共用同一 used 计数：达上限后 interest 也被限流（0 额外 HTTP），诊断=已达上限');

  // ---------- ⑦ diagnostics panel fields ----------
  const day = new Date().toISOString().slice(0, 10);
  await seedStorage({
    settings: baseSettings({ filterEnabled: true, filterRules: FOLD_RULES }),
    jevKey: 'test-jev-key',
    discoveryPrefs: { enabled: true, interestRules: [{ id: 'i1', text: 'language learning', enabled: true }] },
    jevDaily: { day, used: 7 },
    jevStats: { day, judged: 5, collapsed: 2, cached: 1, failed: 1, limited: 0, skipped: 0, highlighted: 3, lastError: '模拟的最近错误（mock）', lastAt: Date.now() }
  });
  await resetMock();
  await page.goto('https://x.com/discovery-empty'); // empty timeline ⇒ seeded stats stay untouched
  await page.locator('#bx-sidebar-handle').waitFor({ timeout: 15000 });
  await openDiscovery();
  const host = page.locator('#bx-disc-status');
  assert.equal(await host.getAttribute('data-state'), 'ok');
  assert.equal(await host.getAttribute('data-int-state'), 'ok');
  assert.equal(await host.getAttribute('data-used'), '7');
  assert.equal(await host.getAttribute('data-daily-limit'), '80');
  assert.equal(await host.getAttribute('data-highlighted'), '3');
  assert.equal(await host.getAttribute('data-collapsed'), '2');
  assert.equal(await host.getAttribute('data-cached'), '1');
  assert.equal(await host.getAttribute('data-failed'), '1');
  assert.equal(await host.getAttribute('data-rule-count'), '1');
  assert.match(await host.getAttribute('data-last-error'), /模拟的最近错误/);
  const diag = await host.innerText();
  assert.match(diag, /今日请求数：7 \/ 80/, diag);
  assert.match(diag, /命中高亮数：3/, diag);
  assert.match(diag, /折叠数：2/, diag);
  assert.match(diag, /缓存：1/, diag);
  assert.match(diag, /失败：1/, diag);
  assert.match(diag, /最近错误：模拟的最近错误/, diag);
  assert.match(diag, /已开启/, diag);
  assert.equal(await jevEval('j.http'), 0, 'empty timeline must not request');
  await page.locator('#bx-sidebar').screenshot({ path: path.join(root, 'tests', 'discovery-diagnostics.png') });
  say('PASS ⑦ 诊断面板字段（已开启 / 今日请求数 / 命中高亮数 / 折叠数 / 缓存 / 失败 / 最近错误）');

  assert.deepEqual(errors, [], 'page errors: ' + errors.join(' | '));
  say('PASS 页面无 JS 错误');
  say('discovery-smoke.cjs 全部完成');
  await context.close();
  process.exit(0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
