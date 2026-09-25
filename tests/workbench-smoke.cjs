// 工作台数据与边界验收：真实加载扩展、独立 profile。
// 模型 fetch 在 service worker mock——只证明消息与 UI，不宣称真实模型成功。
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');


// 启动时清理 30 分钟前的本测试遗留 profile，防止临时盘写满。
(() => { try { for (const d of fs.readdirSync(os.tmpdir())) { if (/^(backwrite-x-smoke-|backwrite-x-writing-|bx-adversarial-|bx-workbench-|bx-debug)/.test(d)) { const p = path.join(os.tmpdir(), d); if (Date.now() - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } } } catch {} })();

(async () => {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'tests');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-workbench-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const worker = await (async () => { for (let i = 0; i < 60; i++) { const w = context.serviceWorkers()[0]; if (w) return w; try { return await context.waitForEvent('serviceworker', { timeout: 500 }); } catch { /* retry */ } } throw new Error('service worker 未在 30s 内启动'); })();
  const extensionId = new URL(worker.url()).host;
  const pageErrors = [];

  await worker.evaluate(async () => {
    await chrome.storage.local.set({ openaiKey: 'test-placeholder-key', settings: { model: 'gpt-6-luna', targetLanguage: '英语', filterEnabled: false, filterRules: [], filterThreshold: 0.82, filterDailyLimit: 80 } });
    globalThis.__pending = [];
    globalThis.__hold = true;
    const wrap = payload => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: payload }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    globalThis.__wrap = wrap;
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('api.openai.com/v1/responses')) {
        const request = JSON.parse(options.body);
        if (globalThis.__hold) return new Promise(resolve => globalThis.__pending.push({ resolve, request }));
        const name = request.text?.format?.name;
        const text = name === 'learn_expressions' ? JSON.stringify({ expressions: [{ text: 'a learned phrase', kind: 'sentence', note: '笔记' }] })
          : JSON.stringify({ meaningOk: true, meaningNote: 'm', grammarOk: true, grammarNote: '无语法问题', summary: 's', points: [] });
        return wrap(text);
      }
      return new Response('{}', { status: 200 });
    };
  });
  const releaseHold = async () => {
    const released = await worker.evaluate(() => {
      const queue = globalThis.__pending;
      if (!queue.length) return false;
      const { resolve, request } = queue.shift();
      const name = request.text?.format?.name;
      const text = name === 'learn_expressions' ? JSON.stringify({ expressions: [{ text: 'a learned phrase', kind: 'sentence', note: '笔记' }] })
        : JSON.stringify({ meaningOk: true, meaningNote: 'm', grammarOk: true, grammarNote: '无语法问题', summary: 's', points: [] });
      resolve(globalThis.__wrap(text));
      return true;
    });
    assert(released, '应有挂起请求可放行');
  };
  const waitPending = async () => {
    for (let i = 0; i < 60; i++) {
      if (await worker.evaluate(() => globalThis.__pending.length)) return;
      await new Promise(r => setTimeout(r, 100));
    }
    throw new Error('等待挂起请求超时');
  };

  const openWorkbench = async () => {
    const page = await context.newPage();
    page.on('pageerror', e => pageErrors.push(e.message));
    await page.goto(`chrome-extension://${extensionId}/writing.html`);
    await page.locator('#w-body').waitFor();
    return page;
  };

  // ─── 1. 20 篇带唯一正文 → 第 21 篇被阻止 → 刷新后每篇可找回 ───
  let page = await openWorkbench();
  for (let i = 0; i < 19; i++) {
    await page.locator('#w-body').fill(`UNIQUE_BODY_${i}`);
    await page.locator('#w-new').click();
  }
  await page.locator('#w-body').fill('UNIQUE_BODY_19'); // 第 20 篇
  await page.waitForTimeout(900); // 防抖保存
  assert.equal(await page.locator('#w-draft-list li').count(), 20, '共 20 篇');
  await page.locator('#w-new').click(); // 第 21 次
  const capStatus = await page.locator('#w-status').innerText();
  assert(capStatus.includes('20 篇上限') || capStatus.includes('上限'), `满额必须提示：${capStatus}`);
  assert.equal(await page.locator('#w-draft-list li').count(), 20, '第 21 次不得新增');
  // 刷新后逐篇找回
  await page.reload();
  await page.locator('#w-draft-list li').first().waitFor();
  assert.equal(await page.locator('#w-draft-list li').count(), 20, '刷新后仍是 20 篇（无静默裁剪）');
  const stored = await worker.evaluate(() => chrome.storage.local.get('writingDrafts'));
  const bodies = new Set((stored.writingDrafts || []).map(d => d.body));
  for (let i = 0; i < 20; i++) assert(bodies.has(`UNIQUE_BODY_${i}`), `第 ${i} 篇正文必须仍存在`);
  console.log('CAP20_BLOCKED_AND_ALL_RECOVERABLE');
  await page.screenshot({ path: path.join(out, 'wb-cap20.png'), fullPage: true });

  // 保存失败提示
  await page.evaluate(() => {
    chrome.storage.local.set = () => Promise.reject(new Error('模拟磁盘配额不足'));
  });
  await page.locator('#w-body').fill('SAVE_FAILURE_TEST');
  await page.waitForTimeout(1100);
  assert((await page.locator('#w-save-state').innerText()).includes('保存失败'), '保存失败需显示在保存状态');
  const failStatus = await page.locator('#w-status').innerText();
  assert(failStatus.includes('保存失败'), `保存失败需有状态提示：${failStatus}`);
  await page.screenshot({ path: path.join(out, 'wb-save-failed.png'), fullPage: true });
  await page.evaluate(() => { delete chrome.storage.local.set; }).catch(() => {});
  // 若 delete 无法恢复原生方法，重开页面即可（storage 由浏览器原生提供，页面级覆盖随导航消失）
  await page.close();
  page = await openWorkbench();

  // ─── 2. 跨稿隔离：A 稿在途学习/反馈，切到 B 后返回 → 只挂 A，B 不受影响；学习结果落盘 ───
  // 当前草稿是第 20 篇（UNIQUE_BODY_19 被覆盖成 SAVE_FAILURE_TEST…重新组织：直接新建 A/B 两稿）
  // 先确保干净：删除全部再开始（用存储直接写，避免逐个删除）
  await worker.evaluate(() => chrome.storage.local.set({ writingDrafts: [] }));
  await page.reload();
  await page.locator('#w-body').waitFor();
  // 初始自动有一篇空稿
  await page.locator('#w-body').fill('BODY_A_VERSION_1');
  await page.locator('#w-reference').fill('Reference article A version one for learning.');
  await page.waitForTimeout(900);
  await page.locator('#w-new').click();
  await page.locator('#w-body').fill('BODY_B');
  await page.waitForTimeout(900);
  // 切回 A 并发起学习（挂起）
  const draftButtons = page.locator('[data-draft]');
  // 列表按 updatedAt 倒序：B 在最前，A 在第二
  await draftButtons.nth(1).click();
  assert.equal(await page.locator('#w-body').inputValue(), 'BODY_A_VERSION_1');
  await page.locator('#w-learn').click();
  await waitPending();
  // 请求在途时切到 B
  await draftButtons.nth(0).click();
  assert.equal(await page.locator('#w-body').inputValue(), 'BODY_B');
  await releaseHold();
  await page.waitForTimeout(600);
  // B 不得出现学习结果
  assert(await page.locator('#w-learn-results').isHidden(), 'B 稿不得显示 A 的学习结果');
  // 切回 A：结果已归属 A 并落盘（不在此处改写 B 的表单，避免污染版本）
  await page.reload(); // 用刷新验证落盘（W05）
  await page.locator('#w-draft-list li').first().waitFor();
  // 找到 A 稿（按正文标记）
  const listItems = page.locator('#w-draft-list [data-draft]');
  let foundA = false;
  for (let i = 0; i < await listItems.count(); i++) {
    await listItems.nth(i).click();
    if ((await page.locator('#w-body').inputValue()) === 'BODY_A_VERSION_1') { foundA = true; break; }
  }
  assert(foundA, '刷新后能找回 A 稿');
  assert(!(await page.locator('#w-learn-results').isHidden()), 'W05：A 稿学习结果刷新后仍在');
  assert((await page.locator('#w-learn-results').innerText()).includes('a learned phrase'));
  // B 稿仍无反馈/学习
  for (let i = 0; i < await listItems.count(); i++) {
    await listItems.nth(i).click();
    if ((await page.locator('#w-body').inputValue()) === 'BODY_B') {
      assert(await page.locator('#w-learn-results').isHidden(), 'B 稿无错挂的学习结果');
      break;
    }
  }
  console.log('CROSS_DRAFT_ISOLATION_AND_LEARNED_PERSISTED');

  // 反馈跨稿：A 挂起反馈 → 切 B → 返回 → 不挂 B；A 内容版本变了则忽略
  await page.locator('#w-body').fill('BODY_A_VERSION_1');
  await page.waitForTimeout(900);
  await page.locator('#w-check').click();
  await waitPending();
  // 在途时直接修改 A 正文（版本变化）
  await page.locator('#w-body').fill('BODY_A_CHANGED');
  await releaseHold();
  await page.waitForTimeout(600);
  assert.equal(await page.locator('#w-feedback-block').isHidden(), true, '版本变化后反馈不渲染');
  assert((await page.locator('#w-status').innerText()).includes('已忽略'), '版本变化有明确提示');
  console.log('VERSION_CHANGE_DROPS_FEEDBACK');

  // ─── 3. 关闭重开保留正文与参考文 ───
  await page.locator('#w-body').fill('KEEP_BODY_TEXT');
  await page.locator('#w-reference').fill('KEEP_REFERENCE_TEXT');
  await page.waitForTimeout(900);
  await page.close();
  page = await openWorkbench();
  assert.equal(await page.locator('#w-body').inputValue(), 'KEEP_BODY_TEXT', '重开保留正文');
  assert.equal(await page.locator('#w-reference').inputValue(), 'KEEP_REFERENCE_TEXT', '重开保留参考文');
  console.log('REOPEN_KEEPS_BODY_AND_REFERENCE');

  // ─── 4. 20,000 正好可提交；20,001 报错且完整保留输入 ───
  await worker.evaluate(() => { globalThis.__hold = false; });
  const body20k = 'a'.repeat(20000);
  await page.locator('#w-body').fill(body20k);
  await page.waitForTimeout(300);
  await page.locator('#w-check').click();
  await page.waitForTimeout(1500);
  assert(!(await page.locator('#w-status').innerText()).includes('超过上限'), '20000 字符不报超限');
  assert.equal(await page.locator('#w-feedback-block').isVisible(), true, '20,000 正好可提交并返回反馈（mock）');
  const body20001 = 'a'.repeat(20001);
  await page.locator('#w-body').fill(body20001);
  await page.waitForTimeout(300);
  const overStatus = await page.locator('#w-status').innerText();
  assert(overStatus.includes('20001'), `超限提示含实际长度：${overStatus}`);
  assert(overStatus.includes('20000'), '超限提示含上限');
  await page.locator('#w-check').click();
  await page.waitForTimeout(500);
  const clickStatus = await page.locator('#w-status').innerText();
  assert(clickStatus.includes('20001') || clickStatus.includes('超过'), `点击后仍有明确错误：${clickStatus}`);
  assert.equal((await page.locator('#w-body').inputValue()).length, 20001, '20,001 输入完整保留，不被截断');
  console.log('BOUNDARY_20K_OK_20001_ERROR_PRESERVED');
  await page.screenshot({ path: path.join(out, 'wb-boundary.png'), fullPage: true });

  assert.deepEqual(pageErrors, [], `页面错误：${pageErrors.join(' | ')}`);
  console.log('WORKBENCH_SMOKE_PASS');
  await context.close();
})().catch(error => { console.error(error); process.exit(1); });
