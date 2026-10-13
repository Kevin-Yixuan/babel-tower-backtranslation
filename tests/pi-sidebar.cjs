// X 侧栏 Pi Agent：真实 MV3 扩展 + 隔离浏览器 + 合成 X 页面。只替换 Pi 桥接网络，不连接真实 Pi。
// 覆盖：连接状态与配置引导、勾选材料、快捷任务、等待动画、回复页「让 Pi 润色」预填、采纳为回复草稿、切帖隔离。
// SCREENSHOT_DIR 指定时保存设计截图。
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = path.resolve(process.env.EXTENSION_ROOT || path.join(__dirname, '..'));
const shots = process.env.SCREENSHOT_DIR || '';
const article = id => `<article data-testid="tweet" id="p${id}"><div data-testid="User-Name">writer${id}</div><div data-testid="tweetText">POST_${id} Learning languages in public is scary, but every reply teaches me something new.</div><a href="/writer/status/${id}"><time>Today</time></a><div role="group"></div></article>`;
const html = `<!doctype html><html><head><meta charset="utf-8"><style>body{margin:20px;font:16px sans-serif}article{padding:12px;margin:15px 0;border:1px solid #ccc}</style></head><body><main>${article(1)}${article(2)}</main></body></html>`;

(async () => {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-pi-sidebar-'));
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: 'msedge', headless: true, viewport: { width: 1280, height: 1000 },
      args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
    });
    context.setDefaultTimeout(10000);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15000 });
        await worker.evaluate(async () => {
      await chrome.storage.local.set({ agentKey: 'pi-test-token', settings: { autoTranslate: false, agentProvider: 'pi', agentBaseUrl: 'http://127.0.0.1:4097' } });
      globalThis.__pi = { ready: false, calls: [], hold: null, permissionChecks: [] };
      // 无头浏览器无法点击原生授权弹窗；记录扩展核对的来源，并视为用户已授权本机 Pi 地址。
      chrome.permissions.contains = async request => { globalThis.__pi.permissionChecks.push(request); return true; };
      globalThis.fetch = async (url, options = {}) => {
        const body = options.body ? JSON.parse(options.body) : null;
        globalThis.__pi.calls.push({ url: String(url), body });
        if (String(url).endsWith('/health')) return Response.json(globalThis.__pi.ready ? { ready: true, version: '0.9.1' } : { ready: false, error: 'pi: command not found' });
        if (String(url).endsWith('/chat')) {
          await new Promise(resolve => { globalThis.__pi.hold = resolve; });
          return Response.json({ answer: 'PI_ANSWER: Every reply teaches me something.' });
        }
        return Response.json({});
      };
    });
    const errors = [];
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.route('https://x.com/pi-fixture', route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto('https://x.com/pi-fixture');

    // 未就绪：显示状态与三步引导。
    await page.locator('#p1 .bx-entry-reply').click();
    await page.locator('[data-bx-mode="agent"]').click();
    await page.waitForFunction(() => document.querySelector('.bx-agent-runtime')?.classList.contains('bx-agent-offline'));
    assert.match(await page.locator('.bx-agent-setup').innerText(), /pi-bridge\/server\.mjs/);
    assert.match(await page.locator('.bx-agent-runtime').innerText(), /pi: command not found/);
    if (shots) await page.locator('#bx-sidebar').screenshot({ path: path.join(shots, 'pi-offline.png') });
    console.log('PASS offline status shows setup guide');

    // 就绪后重新检测，引导消失。
    await worker.evaluate(() => { globalThis.__pi.ready = true; });
    await page.locator('#bx-agent-refresh').click();
    await page.waitForFunction(() => document.querySelector('.bx-agent-runtime')?.classList.contains('bx-agent-ready'));
    assert.equal(await page.locator('.bx-agent-setup').count(), 0);
    assert.match(await page.locator('.bx-agent-runtime').innerText(), /Pi 0\.9\.1/);
    if (shots) await page.locator('#bx-sidebar').screenshot({ path: path.join(shots, 'pi-empty.png') });
    console.log('PASS refresh shows ready runtime');

    // 快捷任务：预填指令并勾选帖子材料；材料默认不勾选。
    assert.equal(await page.locator('[data-agent-context="post"]').isChecked(), false);
    await page.locator('[data-agent-quick="0"]').click();
    assert.equal(await page.locator('[data-agent-context="post"]').isChecked(), true);
    assert.match(await page.locator('#bx-agent-prompt').inputValue(), /解释这条帖子/);
    await page.locator('#bx-agent-send').click();
    await page.locator('.bx-agent-typing').waitFor();
    assert.match(await page.locator('.bx-agent-mine').last().innerText(), /解释这条帖子/);
    if (shots) await page.locator('#bx-sidebar').screenshot({ path: path.join(shots, 'pi-thinking.png') });
    await worker.evaluate(async () => { while (!globalThis.__pi.hold) await new Promise(r => setTimeout(r, 20)); const release = globalThis.__pi.hold; globalThis.__pi.hold = null; release(); });
    await page.locator('#bx-agent-use').waitFor();
    assert.equal(await page.locator('.bx-agent-typing').count(), 0);
    assert.match(await page.locator('.bx-agent-pi .bx-agent-text').last().innerText(), /PI_ANSWER/);
    const chat = (await worker.evaluate(() => globalThis.__pi.calls)).find(call => call.url.endsWith('/chat'));
    assert(chat.body.prompt.includes('POST_1'), 'post context is sent when checked');
    const checks = await worker.evaluate(() => globalThis.__pi.permissionChecks);
    assert(checks.length && checks.every(check => JSON.stringify(check) === JSON.stringify({ origins: ['http://127.0.0.1:4097/*'] })), `permission checks: ${JSON.stringify(checks)}`);
    assert(!chat.body.prompt.includes('回复草稿'), 'unchecked draft is not sent');
    if (shots) await page.locator('#bx-sidebar').screenshot({ path: path.join(shots, 'pi-answer.png') });
    console.log('PASS quick task sends checked context and shows answer');

    // 回复页「让 Pi 润色」：预填指令、勾选草稿；不自动发送。
    await page.locator('[data-bx-mode="write"]').click();
    await page.locator('#bx-draft').fill('MY_DRAFT reply text');
    if (shots) await page.locator('#bx-sidebar').screenshot({ path: path.join(shots, 'reply-tab.png') });
    await page.locator('#bx-ask-pi').click();
    await page.waitForFunction(() => document.querySelector('[data-bx-mode="agent"]')?.getAttribute('aria-selected') === 'true');
    assert.match(await page.locator('#bx-agent-prompt').inputValue(), /润色我的回复草稿/);
    assert.equal(await page.locator('[data-agent-context="draft"]').isChecked(), true);
    assert.equal((await worker.evaluate(() => globalThis.__pi.calls)).filter(call => call.url.endsWith('/chat')).length, 1, 'prefill must not send');
    await page.locator('#bx-agent-send').click();
    await page.waitForFunction(() => document.querySelector('.bx-agent-typing'));
    await worker.evaluate(async () => { while (!globalThis.__pi.hold) await new Promise(r => setTimeout(r, 20)); const release = globalThis.__pi.hold; globalThis.__pi.hold = null; release(); });
    await page.waitForFunction(() => document.querySelectorAll('.bx-agent-pi .bx-agent-text').length === 2);
    const second = (await worker.evaluate(() => globalThis.__pi.calls)).filter(call => call.url.endsWith('/chat'))[1];
    assert(second.body.prompt.includes('MY_DRAFT'), 'draft context is sent');
    page.once('dialog', dialog => dialog.accept());
    await page.locator('#bx-agent-use').click();
    assert.match(await page.locator('#bx-draft').inputValue(), /PI_ANSWER/);
    console.log('PASS reply hand-off to Pi and manual adoption');

    // 切帖：另一帖的 Agent 会话为空，不能采纳上一帖结果。
    await page.locator('#p2 .bx-entry-reply').click();
    await page.locator('[data-bx-mode="agent"]').click();
    await page.locator('.bx-agent-empty').waitFor();
    assert.equal(await page.locator('#bx-agent-use').count(), 0);
    assert.equal(await page.locator('#bx-agent-prompt').inputValue(), '');
    console.log('PASS post switch isolates Pi session');
    assert.deepEqual(errors, []);
    console.log('PI_SIDEBAR_PASS (real extension; Pi bridge network fixtures, not a live Pi)');
  } finally {
    if (context) await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
