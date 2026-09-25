// 回复与提示词模块（任务书 2）浏览器验收：本地双帖仿真页（page.route 拦 x.com）+
// service worker 内受控模型 mock（__hold/__fail 逐个放行）——只证明消息链路与 UI 行为，
// 不宣称真实模型验证通过；不打开真实已登录 x.com，绝不点击发布按钮。
// 覆盖：①中文想法→生成（请求形状含 init prompt 注入与 schema）②无想法→回应角度→点选填入
// ③统一回复结果五要素渲染顺序且草稿区可编辑 ④生成失败不清空 ⑤等待中改稿→候选区不覆盖
// ⑥切帖晚到丢弃+「已切换回复对象」⑦回复对象核对（跨编辑框拒绝、追加不覆盖）
// ⑧init prompt 编辑生效/恢复默认/STORE 往返 ⑨origin 规则与 user-draft 载荷
// ⑩20,001 字符明确报错不发请求。
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const POST_A_TEXT = 'A post for writing a reply. This text is longer than forty characters so it can be filtered and selected.';
const POST_B_TEXT = 'B post about a completely different subject. This text is also over forty characters long.';
const PRESET_PROMPT = 'PRESET_INIT_PROMPT_FOR_STORE_ROUNDTRIP';
const CUSTOM_PROMPT = 'CUSTOM_REPLY_INIT_PROMPT_XYZ';

const fixtureHtml = `<!doctype html><html><body><main>
<article data-testid="tweet" id="a"><div data-testid="User-Name">Author A</div><div data-testid="tweetText">${POST_A_TEXT}</div><a href="/a/status/111">link</a><div role="group"><button>Reply A</button></div><div id="edA" data-testid="tweetTextarea_0" contenteditable="true" role="textbox">A existing</div></article>
<article data-testid="tweet" id="b"><div data-testid="User-Name">Author B</div><div data-testid="tweetText">${POST_B_TEXT}</div><a href="/b/status/222">link</a><div role="group"><button>Reply B</button></div><div id="edB" data-testid="tweetTextarea_0" contenteditable="true" role="textbox">B existing</div></article>
</main></body></html>`;

// 统一回复结果（任务书 2 第 4 条五要素）的受控 mock 载荷。
const UNIFIED_GENERATE = {
  draft: 'MODEL_DRAFT_DEFAULT',
  backtranslation: '模型完整回复的中文回译。',
  meaningRisk: '无明显风险：观点均来自用户想法。',
  suggestions: [
    { point: '第一句', problem: '略显生硬', fix: '换更自然的连接词' },
    { point: '结尾', problem: '缺少收束', fix: '补一句致谢' }
  ],
  followUp: ['对方回应后可以补充一个具体例子。'],
  note: '措辞示例：用 I agree 开头。'
};
const UNIFIED_CHECK = {
  draft: 'CHECKED_COMPLETE_REPLY',
  backtranslation: '检查后完整回复的中文回译。',
  meaningRisk: '无明显风险：意思已传达。',
  suggestions: [{ point: '你写的句子', problem: '可更简洁', fix: '删去重复信息' }],
  followUp: ['可以顺势提问延续话题。'],
  note: '保留用户口吻。'
};
const ANGLES = {
  angles: [
    { angle: '认同并补充相关经验', seed: '我也有过类似体会，想补充一个细节……' },
    { angle: '提一个好奇的问题', seed: '我想先问一句：这一点在实践中怎么落地？' },
    { angle: '温和地给出不同视角', seed: '我理解你的意思，不过我在想另一种可能……' }
  ]
};

// 启动时清理 30 分钟前的本测试遗留 profile，防止临时盘写满。
(() => { try { for (const d of fs.readdirSync(os.tmpdir())) { if (/^bx-reply-/.test(d)) { const p = path.join(os.tmpdir(), d); if (Date.now() - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } } } catch {} })();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'tests');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-reply-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const worker = await (async () => { for (let i = 0; i < 60; i++) { const w = context.serviceWorkers()[0]; if (w) return w; try { return await context.waitForEvent('serviceworker', { timeout: 500 }); } catch { /* retry */ } } throw new Error('service worker 未在 30s 内启动'); })();

  // 受控 mock：记录请求形状（instructions 含 init prompt、schema 含统一五要素）；
  // __hold 挂起逐个放行，__fail 模拟模型失败。占位密钥，非真实密钥。
  await worker.evaluate(async args => {
    await chrome.storage.local.set({
      openaiKey: 'test-placeholder-key',
      settings: { model: 'gpt-6-luna', targetLanguage: '英语', filterEnabled: false, filterRules: [], filterThreshold: 0.82, filterDailyLimit: 80 },
      initPrompt: args.preset // 预置值：验证 STORE get 从后台到界面的往返
    });
    globalThis.__hold = false;
    globalThis.__fail = false;
    globalThis.__pending = [];
    globalThis.__requests = [];
    globalThis.__gen = args.gen;
    globalThis.__check = args.check;
    globalThis.__angles = args.angles;
    globalThis.__wrap = text => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    globalThis.__answer = request => {
      const name = request.text?.format?.name;
      if (name === 'generate_reply') return JSON.stringify(globalThis.__gen);
      if (name === 'check_reply') return JSON.stringify(globalThis.__check);
      if (name === 'suggest_angles') return JSON.stringify(globalThis.__angles);
      return JSON.stringify({ ok: true });
    };
    globalThis.fetch = async (url, options) => {
      if (!String(url).includes('api.openai.com/v1/responses')) return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
      const request = JSON.parse(options.body);
      const name = request.text?.format?.name || 'plain';
      globalThis.__requests.push({ name, input: String(request.input || ''), instructions: String(request.instructions || ''), schema: request.text?.format?.schema || null });
      if (globalThis.__fail) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      if (globalThis.__hold) return new Promise(resolve => globalThis.__pending.push({ resolve, request }));
      return globalThis.__wrap(globalThis.__answer(request));
    };
  }, { preset: PRESET_PROMPT, gen: UNIFIED_GENERATE, check: UNIFIED_CHECK, angles: ANGLES });

  const setHold = value => worker.evaluate(v => { globalThis.__hold = v; }, value);
  const setFail = value => worker.evaluate(v => { globalThis.__fail = v; }, value);
  const requestsNamed = name => worker.evaluate(n => globalThis.__requests.filter(r => r.name === n), name);
  const pendingCount = () => worker.evaluate(() => globalThis.__pending.length);
  const waitPending = async (expected = 1) => {
    for (let i = 0; i < 80; i++) { if ((await pendingCount()) >= expected) return; await sleep(100); }
    throw new Error(`等待挂起请求超时（期望 ≥${expected}）`);
  };
  const release = async draftText => {
    const released = await worker.evaluate(d => {
      const queue = globalThis.__pending;
      if (!queue.length) return false;
      const { resolve, request } = queue.shift();
      const name = request.text?.format?.name;
      const payload = name === 'generate_reply' ? { ...globalThis.__gen, draft: d }
        : name === 'check_reply' ? { ...globalThis.__check, draft: d || globalThis.__check.draft }
          : name === 'suggest_angles' ? globalThis.__angles : { ok: true };
      resolve(globalThis.__wrap(JSON.stringify(payload)));
      return true;
    }, draftText);
    assert(released, `应有挂起请求可放行（draftText=${draftText}）`);
  };

  const pageErrors = [];
  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('https://x.com/reply-fixture', route => route.fulfill({ status: 200, contentType: 'text/html', body: fixtureHtml }));
  await page.goto('https://x.com/reply-fixture');
  await page.locator('.bx-inline-button').first().waitFor({ timeout: 15000 });
  // user-draft 事件镜像观察点（页面世界看不到 BX，模块把事件镜像成 DOM CustomEvent）。
  await page.evaluate(() => {
    window.__drafts = [];
    document.addEventListener('bx-user-draft', event => {
      try { window.__drafts.push(JSON.parse(event.detail)); } catch (error) { window.__drafts.push({ parseError: String(error) }); }
    });
  });
  await page.locator('#a .bx-entry-reply').click();
  await page.locator('#bx-sidebar.bx-open').waitFor();
  await page.locator('#bx-idea').waitFor();

  // ─── ⑧前半：STORE get 往返（后台预置值出现在界面） ───
  await page.locator('#bx-init-prompt summary').click();
  await page.waitForFunction(preset => document.querySelector('#bx-init-prompt-text')?.value === preset, PRESET_PROMPT, { timeout: 8000 });
  assert((await page.locator('#bx-init-prompt').innerText()).includes('临时默认值 · 发布前将替换为正式版本'), 'UI 必须标注临时默认值与发布前替换');
  console.log('STORE_GET_ROUNDTRIP_OK');

  // ─── ① 中文想法 → 生成：请求形状含 init prompt 注入与统一 schema ───
  await page.locator('#bx-idea').fill('我想认同这个观点并补充自己的经验。');
  assert(!(await page.locator('#bx-generate').isDisabled()), '有想法时生成按钮可用');
  await page.locator('#bx-generate').click();
  await page.waitForFunction(d => document.querySelector('#bx-draft')?.value === d, UNIFIED_GENERATE.draft, { timeout: 8000 });
  const genReqs = await requestsNamed('generate_reply');
  assert(genReqs.length >= 1, '应发出 generate_reply 请求');
  const genReq = genReqs.at(-1);
  assert.equal(genReq.name, 'generate_reply', '任务名');
  assert(genReq.instructions.includes(PRESET_PROMPT), 'init prompt 注入 instructions');
  assert(genReq.instructions.includes('必需输出 JSON 字段'), '固定输出格式段在场');
  assert(genReq.input.includes('我想认同这个观点'), '中文想法进入 input');
  assert(genReq.schema && typeof genReq.schema === 'object', '请求带 schema');
  for (const key of ['draft', 'backtranslation', 'meaningRisk', 'suggestions', 'followUp']) {
    assert((genReq.schema.required || []).includes(key), `schema.required 含 ${key}`);
  }
  console.log('GENERATE_REQUEST_SHAPE_OK');

  // ─── ③ 统一回复结果五要素渲染顺序 + 草稿区可编辑 ───
  const order = await page.evaluate(() => {
    const ids = ['bx-draft', 'bx-backtranslation', 'bx-meaning-risk', 'bx-suggestions', 'bx-followup'];
    const els = ids.map(id => document.getElementById(id));
    const missing = ids.filter((id, i) => !els[i]);
    if (missing.length) return { ok: false, missing };
    for (let i = 0; i < els.length; i++) {
      for (let j = i + 1; j < els.length; j++) {
        if (!(els[i].compareDocumentPosition(els[j]) & Node.DOCUMENT_POSITION_FOLLOWING)) return { ok: false, outOfOrder: [ids[i], ids[j]] };
      }
    }
    return { ok: true };
  });
  assert(order.ok, `五要素渲染顺序（完整回复→回译→风险→逐项建议→后续交流）有误：${JSON.stringify(order)}`);
  const resultText = await page.locator('#bx-reply-result').innerText();
  assert(resultText.includes('中文回译') && resultText.includes('意思风险') && resultText.includes('逐项修改建议') && resultText.includes('后续交流建议'), '四段标题齐全');
  assert(resultText.includes('模型完整回复的中文回译。'), '回译内容渲染');
  assert(resultText.includes('略显生硬') && resultText.includes('补一句致谢'), '逐项修改建议渲染');
  assert(resultText.includes('具体例子'), '后续交流建议渲染');
  assert.equal(await page.locator('#bx-backtranslation p').innerText(), UNIFIED_GENERATE.backtranslation);
  await page.screenshot({ path: path.join(out, 'reply-unified-result.png'), fullPage: true });
  const draftBox = page.locator('#bx-draft');
  assert(!(await draftBox.getAttribute('readonly')), '草稿区只读即失败');
  await draftBox.fill('EDITABLE_DRAFT_OK');
  assert.equal(await draftBox.inputValue(), 'EDITABLE_DRAFT_OK', '草稿区可编辑');
  console.log('UNIFIED_RESULT_ORDER_AND_EDITABLE_OK');

  // ─── ④ 生成失败不清空 ───
  await page.locator('#bx-idea').fill('失败场景：想法必须保留');
  await draftBox.fill('DRAFT_KEEP_ON_FAILURE');
  await setFail(true);
  await page.locator('#bx-generate').click();
  await page.waitForFunction(() => (document.querySelector('#bx-body')?.innerText || '').includes('500'), null, { timeout: 8000 });
  assert.equal(await page.locator('#bx-idea').inputValue(), '失败场景：想法必须保留', '生成失败不清空想法');
  assert.equal(await draftBox.inputValue(), 'DRAFT_KEEP_ON_FAILURE', '生成失败不清空草稿');
  await setFail(false);
  console.log('GENERATE_FAILURE_KEEPS_INPUT_OK');

  // ─── ⑤ 等待中改稿 → 候选区不覆盖 ───
  await setHold(true);
  await page.locator('#bx-generate').click();
  await waitPending(1);
  await draftBox.fill('EDITED_WHILE_WAITING');
  await release('STALE_MODEL_DRAFT');
  await page.locator('.bx-candidate').waitFor({ timeout: 8000 });
  assert((await page.locator('.bx-candidate').innerText()).includes('STALE_MODEL_DRAFT'), '旧结果进入候选区');
  assert.equal(await draftBox.inputValue(), 'EDITED_WHILE_WAITING', '候选不覆盖当前输入');
  await page.locator('#bx-dismiss-candidate').click();
  assert.equal(await draftBox.inputValue(), 'EDITED_WHILE_WAITING', '忽略候选后输入不变');
  await setHold(false);
  console.log('WAIT_EDIT_CANDIDATE_NO_OVERWRITE_OK');

  // 采用晚到候选时必须一并恢复回译、风险、改法和后续建议。
  await setHold(true);
  await page.locator('#bx-generate').click();
  await waitPending(1);
  await draftBox.fill('KEEP_UNTIL_ADOPT');
  await release('ADOPTED_MODEL_DRAFT');
  await page.locator('#bx-adopt-candidate').click();
  assert.equal(await draftBox.inputValue(), 'ADOPTED_MODEL_DRAFT');
  assert.equal(await page.locator('#bx-backtranslation p').innerText(), UNIFIED_GENERATE.backtranslation);
  assert((await page.locator('#bx-meaning-risk').innerText()).includes('无明显风险'));
  assert((await page.locator('#bx-suggestions').innerText()).includes('换更自然的连接词'));
  assert((await page.locator('#bx-followup').innerText()).includes('具体例子'));
  await draftBox.fill('EDITED_WHILE_WAITING');
  await setHold(false);
  console.log('ADOPT_CANDIDATE_RESTORES_ALL_FEEDBACK_OK');

  // ─── ⑥ 切帖晚到丢弃 + 「已切换回复对象」 ───
  await setHold(true);
  await page.locator('#bx-generate').click();
  await waitPending(1);
  await page.locator('#b .bx-entry-reply').click();
  await release('SWITCHED_RESULT');
  await page.waitForFunction(() => (document.querySelector('#bx-body')?.innerText || '').includes('已切换回复对象'), null, { timeout: 8000 });
  assert.equal(await draftBox.inputValue(), '', '切到 B 后不得带入 A 的草稿');
  assert(!(await page.locator('#bx-body').innerText()).includes('SWITCHED_RESULT'), '被丢弃结果不进正文不进候选');
  await page.locator('#a .bx-entry-reply').click();
  assert.equal(await draftBox.inputValue(), 'EDITED_WHILE_WAITING', '回到 A 时原稿仍在');
  await page.locator('#b .bx-entry-reply').click();
  await setHold(false);
  console.log('POST_SWITCH_DISCARD_OK');

  // ─── ② 无想法 → 回应角度 → 点选填入 ───
  await page.locator('#bx-idea').fill('');
  assert(await page.locator('#bx-suggest-angles').isEnabled(), '没想法时可请求回应角度');
  await page.locator('#bx-suggest-angles').click();
  await page.locator('#bx-angle-0').waitFor({ timeout: 8000 });
  const angleReqs = await requestsNamed('suggest_angles');
  assert(angleReqs.length >= 1, '应发出 suggest_angles 请求');
  assert(angleReqs.at(-1).input.includes('B post about a completely different'), '角度请求带当前帖文上下文');
  assert.equal(await page.locator('.bx-angle').count(), ANGLES.angles.length, '角度条数');
  const seed0 = await page.locator('#bx-angle-0').getAttribute('data-seed');
  assert.equal(seed0, ANGLES.angles[0].seed);
  await page.locator('#bx-angle-0').click();
  assert.equal(await page.locator('#bx-idea').inputValue(), seed0, '点选角度填入「我想表达」');
  assert(!(await page.locator('#bx-generate').isDisabled()), '填入后可生成');
  await page.screenshot({ path: path.join(out, 'reply-angles.png'), fullPage: true });
  console.log('SUGGEST_ANGLES_FILL_OK');

  // ─── ⑦ 回复对象核对：跨编辑框拒绝（仅复制）+ 追加不覆盖 ───
  await draftBox.fill('Reply for B only');
  await page.locator('#edA').focus();
  await page.locator('#bx-insert').click();
  const blocked = page.locator('.bx-insert-blocked');
  await blocked.waitFor();
  const blockedText = await blocked.innerText();
  assert(blockedText.includes('Author B'), `拒绝框需显示回复对象：${blockedText}`);
  assert(blockedText.includes('复制'), '拒绝时必须提供复制');
  assert.equal(await blocked.locator('#bx-insert-confirm').count(), 0, '拒绝时不得有确认写入按钮');
  await blocked.locator('#bx-copy-inline').click();
  await page.waitForTimeout(300);
  assert.equal(await page.locator('#edA').innerText(), 'A existing', 'A 编辑框未被触碰');
  assert.equal(await page.locator('#edB').innerText(), 'B existing', 'B 编辑框未被触碰');
  await page.locator('#edB').focus();
  await page.locator('#bx-insert').click();
  const confirmBox = page.locator('.bx-insert-confirm:not(.bx-insert-blocked)');
  await confirmBox.waitFor();
  const preview = await confirmBox.innerText();
  assert(preview.includes('将插入到：'), '插入预览标题');
  assert(preview.includes('Author B'), `预览必须是 B：${preview}`);
  assert(preview.includes(POST_B_TEXT.slice(0, 40)), '预览含帖子前 40 字');
  await confirmBox.locator('#bx-insert-confirm').click();
  const edBText = await page.locator('#edB').innerText();
  assert(edBText.includes('B existing') && edBText.includes('Reply for B only'), `原文字保留并追加：${edBText}`);
  assert(edBText.indexOf('B existing') < edBText.indexOf('Reply for B only'), '原文在前、草稿在后（追加不覆盖）');
  await page.screenshot({ path: path.join(out, 'reply-insert-confirm.png'), fullPage: true });
  console.log('INSERT_REFUSE_AND_APPEND_OK');

  // ─── ⑧ 后半：init prompt 编辑生效 → STORE 往返 → 恢复默认 ───
  await page.locator('#bx-init-prompt-text').fill(CUSTOM_PROMPT);
  await page.locator('#bx-init-prompt-save').click();
  let stored = null;
  for (let i = 0; i < 40; i++) {
    stored = await worker.evaluate(async () => (await chrome.storage.local.get('initPrompt')).initPrompt ?? null);
    if (stored === CUSTOM_PROMPT) break;
    await sleep(100);
  }
  assert.equal(stored, CUSTOM_PROMPT, 'STORE set 往返：界面保存写入本地存储');
  await page.screenshot({ path: path.join(out, 'reply-init-prompt.png'), fullPage: true });
  await setHold(true);
  await page.locator('#bx-generate').click();
  await waitPending(1);
  let req = (await requestsNamed('generate_reply')).at(-1);
  assert(req.instructions.includes(CUSTOM_PROMPT), '编辑后的 init prompt 出现在请求中');
  assert((req.schema.required || []).includes('backtranslation'), 'init prompt 不破坏固定输出 schema');
  assert(req.instructions.includes('必需输出 JSON 字段'), '固定格式段仍在');
  await release('CUSTOM_PROMPT_DRAFT');
  await setHold(false);
  await page.locator('#bx-init-prompt-reset').click();
  await page.waitForFunction(marker => (document.querySelector('#bx-init-prompt-text')?.value || '').includes(marker), '临时默认值 · 发布前将替换为正式版本', { timeout: 8000 });
  const storedAfterReset = await worker.evaluate(async () => (await chrome.storage.local.get('initPrompt')).initPrompt ?? null);
  assert.equal(storedAfterReset, null, '恢复默认应移除 STORE 键 initPrompt');
  const defaultInBox = await page.locator('#bx-init-prompt-text').inputValue();
  assert(defaultInBox.includes('临时默认值 · 发布前将替换为正式版本'), '界面默认值带临时标注');
  await setHold(true);
  await page.locator('#bx-generate').click();
  await waitPending(1);
  req = (await requestsNamed('generate_reply')).at(-1);
  assert(req.instructions.includes(defaultInBox), '界面默认提示词与任务侧默认逐字一致（包含于 instructions）');
  assert(!req.instructions.includes(CUSTOM_PROMPT), '恢复默认后不再注入自定义文本');
  await release('AFTER_RESET_DRAFT');
  await setHold(false);
  console.log('INIT_PROMPT_EDIT_RESET_STORE_OK');

  // ─── ⑨ origin 规则与 user-draft 载荷 ───
  // 场景 A：生成后未手改 → ai（检查完成时如实上报）
  await setHold(false);
  await page.locator('#bx-check-reply').click();
  await page.waitForFunction(() => (window.__drafts || []).length >= 1, null, { timeout: 8000 });
  const draftsA = await page.evaluate(() => window.__drafts);
  assert.equal(draftsA[0].text, 'AFTER_RESET_DRAFT', '上报的是被检查的稿件');
  assert.equal(draftsA[0].origin, 'ai', '生成后未手改 = ai（不得当作掌握证据）');
  assert.equal(draftsA[0].context, 'reply');
  assert(String(draftsA[0].url).includes('/b/status/222'), `url 为回复对象：${draftsA[0].url}`);
  assert(typeof draftsA[0].at === 'number' && draftsA[0].at > 0, 'at 时间戳');
  await page.waitForFunction(d => document.querySelector('#bx-draft')?.value === d, UNIFIED_CHECK.draft, { timeout: 8000 });
  assert.equal(await draftBox.inputValue(), UNIFIED_CHECK.draft, '检查结果：①完整回复进入草稿区');
  // 场景 B：亲手键入 → user
  await draftBox.fill('USER_TYPED_DRAFT_XYZ');
  await page.locator('#bx-check-reply').click();
  await page.waitForFunction(() => (window.__drafts || []).length >= 2, null, { timeout: 8000 });
  const draftsB = await page.evaluate(() => window.__drafts);
  assert.equal(draftsB[1].text, 'USER_TYPED_DRAFT_XYZ', '上报手写稿件原文');
  assert.equal(draftsB[1].origin, 'user', '亲手键入 = user');
  assert.equal(draftsB[1].context, 'reply');
  // 交叉修复（integration 合并轮）：检查成功把①写入草稿区后，用户提交的原文保留在结果区对照
  const originalBox = page.locator('#bx-original');
  await originalBox.waitFor({ timeout: 8000 });
  await originalBox.locator('summary').click(); // 默认折叠，点开验证可交互与内容
  assert((await originalBox.innerText()).includes('USER_TYPED_DRAFT_XYZ'), '结果区保留被检查的用户原文');
  await page.waitForFunction(d => document.querySelector('#bx-draft')?.value === d, UNIFIED_CHECK.draft, { timeout: 8000 });
  console.log('ORIGINAL_TEXT_PRESERVED_AFTER_CHECK_OK');
  console.log('ORIGIN_AND_USER_DRAFT_OK');

  // ─── ⑩ 20,001 字符明确报错不发请求 ───
  const genCountBefore = (await requestsNamed('generate_reply')).length;
  const over = '啊'.repeat(20001);
  await page.locator('#bx-idea').fill(over);
  assert(!(await page.locator('#bx-generate').isDisabled()), '超限靠点击报错，不靠禁用按钮静默挡下');
  await page.locator('#bx-generate').click();
  await page.waitForFunction(() => (document.querySelector('#bx-body')?.innerText || '').includes('20001'), null, { timeout: 8000 });
  const overText = await page.locator('#bx-body').innerText();
  assert(overText.includes('20000'), '超限提示含上限');
  assert(overText.includes('没有自动分段'), '超限提示说明没有自动分段');
  assert.equal((await requestsNamed('generate_reply')).length, genCountBefore, '超限不得发出请求');
  assert.equal((await page.locator('#bx-idea').inputValue()).length, 20001, '输入不被截断');
  await page.screenshot({ path: path.join(out, 'reply-over-limit.png'), fullPage: true });
  console.log('OVER_LIMIT_CLEAR_ERROR_NO_REQUEST_OK');

  assert.deepEqual(pageErrors, [], `页面错误：${pageErrors.join(' | ')}`);
  console.log('REPLY_SMOKE_PASS');
  await context.close();
})().catch(error => { console.error(error); process.exit(1); });
