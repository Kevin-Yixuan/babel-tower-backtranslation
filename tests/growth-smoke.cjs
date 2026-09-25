// 成长记忆与表达模块 · 浏览器端到端验收（任务书 3 误判边界）。
// 独立 Edge profile（前缀 bx-growth-）加载扩展 + 本地仿真 X 页；模型 fetch 在 service worker 内
// 受控 mock——只证明消息链路、记忆状态机与 UI 行为，不宣称真实模型验证。
// 不访问真实 x.com，不点击发布。
//
// 覆盖（①~⑨ 见 HANDOFF-GROWTH.md 逐条结果）：
//   ① origin='ai' 稿件不产生记忆候选、不触发升级
//   ② 无关句子不触发「已改善」（且不发升级评估请求）
//   ③ 相关后续证据逐步升级：待练 → 改善中 → 已改善（各一步、留证据）
//   ④ 确认后记录：不确认不落库；自动档直接落库
//   ⑤ 编辑 / 删除 / 关闭生效且刷新后仍在
//   ⑥ 超过 500KB 存储上限 → 明确中文错误、数据不清
//   ⑦ 导出 JSON 内容正确
//   ⑧ 关键词搜索过滤正确
//   ⑨ 旧收藏（cards）在改造后仍完整可见、数据不变
const { chromium } = require('./load-playwright.cjs').loadPlaywright();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 启动时清理 30 分钟前的本测试遗留 profile，防止临时盘写满。
(() => { try { for (const d of fs.readdirSync(os.tmpdir())) { if (/^bx-growth-/.test(d)) { const p = path.join(os.tmpdir(), d); if (Date.now() - fs.statSync(p).mtimeMs > 30 * 60 * 1000) fs.rmSync(p, { recursive: true, force: true }); } } } catch { /* ignore */ } })();

const FIXTURE = `<!doctype html><html><body><main>
<article data-testid="tweet" id="a"><div data-testid="User-Name">Growth Author</div>
<div data-testid="tweetText">Writing is thinking made visible. This simulation post gives the reply module a stable context for the growth smoke checks.</div>
<a href="/growth/status/901">link</a><div role="group"><button>Reply</button></div></article>
</main></body></html>`;

const SEED_CARDS = [
  { id: 'card-seed-1', text: '旧收藏句子 Alpha：写作让思考可见。', kind: 'sentence', note: '来自旧面板的收藏', author: 'Author A', url: 'https://x.com/a/status/1', createdAt: '2026-01-01T00:00:00.000Z' },
  { id: 'card-seed-2', text: 'legacy favorite beta phrase', kind: 'word', note: '', author: '', url: '', createdAt: '2026-01-02T00:00:00.000Z' }
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// chrome.storage 往返会重排对象键顺序：比较内容时用递归排序键的规范 JSON
const canonical = value => JSON.stringify(value, (_key, v) => (
  v && typeof v === 'object' && !Array.isArray(v)
    ? Object.keys(v).sort().reduce((acc, key) => { acc[key] = v[key]; return acc; }, {})
    : v
));

(async () => {
  const root = path.resolve(__dirname, '..');
  const out = path.join(root, 'tests');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'bx-growth-'));
  const context = await chromium.launchPersistentContext(profile, {
    channel: 'msedge', headless: true, acceptDownloads: true,
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`]
  });
  const pageErrors = [];
  const worker = await (async () => { for (let i = 0; i < 60; i++) { const w = context.serviceWorkers()[0]; if (w) return w; try { return await context.waitForEvent('serviceworker', { timeout: 500 }); } catch { /* retry */ } } throw new Error('service worker 未在 30s 内启动'); })();

  // ── 受控 mock：本机数据种子 + 模型 fetch 拦截（模型响应由测试标记驱动） ──
  const seededWritingDrafts = [{ id: 'w-seed', title: '工作台草稿', body: '工作台里的练习笔记 I am agree with this PAT_I note on Monday morning routine.', authoredByUser: true, reference: '', feedback: null, learned: null, updatedAt: '2026-01-03T08:00:00.000Z' }];
  await worker.evaluate(async ({ cards, drafts }) => {
    await chrome.storage.local.set({
      openaiKey: 'test-growth-placeholder-key',
      settings: { model: 'gpt-6-luna', targetLanguage: '英语', filterEnabled: false, filterRules: [], filterThreshold: 0.82, filterDailyLimit: 80 },
      cards, writingDrafts: drafts
    });
    globalThis.__requests = [];
    globalThis.__wrap = payload => new Response(JSON.stringify({ status: 'completed', output: [{ content: [{ type: 'output_text', text: payload }] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('api.openai.com/v1/responses')) {
        const request = JSON.parse(options.body);
        const name = request.text?.format?.name || 'plain';
        const input = String(request.input || '');
        globalThis.__requests.push({ name, input, at: Date.now() });
        let payload;
        if (name === 'extract_patterns') {
          const patterns = [];
          if (/PAT_S/.test(input)) patterns.push({ pattern: '三单数漏加 -s', explanation: '“He go to school” 第三人称单数动词漏加 -s，属于真实出现的重复错误。', quote: 'He go to school', suggestion: '应说 He goes to school' });
          if (/PAT_I/.test(input)) patterns.push({ pattern: '介词 in/on 混用', explanation: '“on Monday morning” 一类时间介词混用：时间点用 on，时段用 in。', quote: 'on Monday', suggestion: '时间点用 on，时段用 in' });
          if (/PAT_A/.test(input)) patterns.push({ pattern: 'agree 前误用 be 动词', explanation: '“I am agree …” 中 agree 是动词，前面不能再用 be 动词。', quote: 'I am agree', suggestion: '应说 I agree with…' });
          if (/PAT_D/.test(input)) patterns.push({ pattern: "代词 its/it's 混用", explanation: "its 是物主代词，it's 是 it is 的缩写，稿件里混用。", quote: input.includes("It's") ? "It's" : 'its own choice', suggestion: "按语义区分 its 与 it's" });
          payload = { patterns };
        } else if (name === 'assess_evidence') {
          // 受控判定：EVID_STILL = 同类错误仍出现；其余标记为「相关且已正确运用」
          payload = /EVID_STILL/.test(input)
            ? { related: true, resolved: false, reason: '同一类错误在这份稿件里仍出现。' }
            : { related: true, resolved: true, reason: '相关知识点已在后续稿件中正确运用。' };
        } else if (name === 'generate_reply') {
          // reply 合入后 GENERATE_REPLY 走统一五要素 schema（draft 保持与断言逐字一致）
          payload = {
            draft: 'AI 生成的草稿 PAT_A I am agree with this thinking idea.',
            backtranslation: 'AI 生成草稿的中文回译。', meaningRisk: '无明显风险。',
            suggestions: [], followUp: [], note: '受控 mock 生成'
          };
        } else {
          // check_reply（本测试中 else 仅会命中它）同样要求统一五要素，否则结构校验失败、
          // reply 不会 emit user-draft，growth 管线收不到稿件。
          payload = {
            draft: 'Checked complete reply with PAT_A correction applied.',
            backtranslation: '检查后的完整回复中文回译。', meaningRisk: '无明显风险。',
            suggestions: [{ point: 'agree 用法', problem: 'am agree 重复', fix: '直接用 I agree' }],
            followUp: [], note: '受控 mock 检查'
          };
        }
        return globalThis.__wrap(JSON.stringify(payload));
      }
      return new Response('{}', { status: 200 });
    };
  }, { cards: SEED_CARDS, drafts: seededWritingDrafts });

  const cardsJSON = canonical(SEED_CARDS);
  const writingJSON = canonical(seededWritingDrafts);
  const getStore = key => worker.evaluate(async k => (await chrome.storage.local.get(k))[k], key);
  const reqs = name => worker.evaluate(n => (globalThis.__requests || []).filter(r => r.name === n), name);
  const reqCount = async name => (await reqs(name)).length;

  const page = await context.newPage();
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.route('https://x.com/growth-fixture', route => route.fulfill({ status: 200, contentType: 'text/html', body: FIXTURE }));
  await page.goto('https://x.com/growth-fixture');
  await page.locator('.bx-inline-button').waitFor({ timeout: 15000 });
  await page.locator('.bx-inline-button').click();
  await page.locator('#bx-sidebar.bx-open').waitFor();

  async function waitFor(fn, label, timeout = 20000) {
    const start = Date.now();
    for (;;) {
      let value;
      try { value = await fn(); } catch { value = false; }
      if (value) return value;
      if (Date.now() - start > timeout) {
        const body = await page.locator('#bx-body').innerText().catch(() => '(侧栏不可读)');
        throw new Error(`等待超时：${label}\n--- 侧栏文本 ---\n${body.slice(0, 1600)}`);
      }
      await sleep(120);
    }
  }
  const openTab = async id => { await page.locator(`[data-bx-mode="${id}"]`).click(); };
  const bodyText = () => page.locator('#bx-body').innerText();
  // 侧栏内部滚动（fullPage 截图拍不到 fixed 侧栏的滚动区），截图前手动定位
  const scrollTo = async top => page.locator('#bx-body').evaluate((el, value) => { el.scrollTop = value; }, top);
  const memoryCount = async () => (await getStore('growthMemories') || []).length;
  const statuses = async () => (await getStore('growthMemories') || []).map(m => `${m.pattern}=${m.status}${m.active === false ? '(关)' : ''}`);

  // 走真实回复页签路径产生 user-draft（origin 语义由 reply 模块如实标注）
  async function checkReply(text) {
    await openTab('write');
    await page.locator('#bx-draft').fill(text);
    const before = await reqCount('check_reply');
    await page.locator('#bx-check-reply').click();
    await waitFor(async () => (await reqCount('check_reply')) > before, `检查请求完成：${text.slice(0, 24)}`);
    await sleep(250); // 等 emit 落进 growth 管线
  }

  // ─── 0. 打开「成长」页签：默认自动档、空状态、旧收藏完整可见（⑨ 前半） ───
  await openTab('growth');
  await page.locator('#bx-growth-mode').waitFor();
  assert.equal(await page.locator('#bx-growth-mode').inputValue(), 'auto', '默认记录方式＝自动记录');
  const initialBody = await bodyText();
  assert(initialBody.includes('还没有学习记忆'), `空状态提示：${initialBody.slice(0, 300)}`);
  await waitFor(async () => (await bodyText()).includes('旧收藏句子 Alpha'), '旧收藏 1 必须可见');
  assert((await bodyText()).includes('legacy favorite beta phrase'), '旧收藏 2 必须可见');
  assert.equal((await getStore('growthMemories') || []).length, 0, '初始无记忆');
  console.log('[evidence] 成长页签初始：默认自动档 + 旧收藏完整可见');
  await page.screenshot({ path: path.join(out, 'growth-tab-initial.png'), fullPage: true });
  await scrollTo(99999);
  await sleep(150);
  await page.screenshot({ path: path.join(out, 'growth-cards-kept.png'), fullPage: true }); // ⑨ 旧收藏分区展示
  await scrollTo(0);

  // ─── ① origin='ai'：生成稿未手改 → 不产生候选、不发归纳请求、不落库 ───
  await openTab('write');
  await page.locator('#bx-idea').fill('我同意，写作能帮助我澄清想法。');
  await page.locator('#bx-generate').click();
  await waitFor(async () => (await page.locator('#bx-draft').inputValue()).includes('PAT_A'), '生成草稿到达');
  assert.equal(await page.locator('#bx-draft').inputValue(), 'AI 生成的草稿 PAT_A I am agree with this thinking idea.', '生成后草稿未被手改');
  const extractBeforeAI = await reqCount('extract_patterns');
  const before = await reqCount('check_reply');
  await page.locator('#bx-check-reply').click();
  await waitFor(async () => (await reqCount('check_reply')) > before, 'AI 稿检查完成');
  await sleep(600);
  assert.equal(await reqCount('extract_patterns'), extractBeforeAI, '① origin=ai 稿件不得触发 EXTRACT_PATTERNS');
  assert.equal(await memoryCount(), 0, '① origin=ai 稿件不得产生记忆');
  await openTab('growth');
  assert((await bodyText()).includes('还没有学习记忆'), '① AI 稿后仍是空记忆列表');
  console.log('[evidence] ① origin=ai 不产生记忆候选（无 EXTRACT 请求、存储为空）');

  // ─── ④ 自动档：origin='user' 亲写稿件 → 归纳入库（待练） ───
  await checkReply('I am agree with you about PAT_A daily review of my writing.');
  await waitFor(async () => (await memoryCount()) === 1, '自动档记忆落库');
  let memories = await getStore('growthMemories');
  assert.equal(memories[0].status, '待练', '新记忆状态＝待练');
  assert.equal(memories[0].pattern, 'agree 前误用 be 动词');
  assert.equal(memories[0].examples[0].context, 'reply', '证据来源＝回复');
  assert.ok(memories[0].examples[0].at > 0, '记录了稿件时间');
  await openTab('growth');
  const todoBody = await bodyText();
  assert(todoBody.includes('agree 前误用'), '记忆名称可见');
  assert(todoBody.includes('待练'), '状态可见');
  assert(todoBody.includes('出现过的稿件'), '首次出现的稿件可见');
  console.log('[evidence] ④ 自动档：亲写稿件 → 记忆落库（待练）');
  await page.screenshot({ path: path.join(out, 'growth-memory-todo.png'), fullPage: true });

  // ─── ② 无关句子：不发升级评估、不升级、不产生新记忆 ───
  const assessBefore = await reqCount('assess_evidence');
  await checkReply('The weather forecast shows sunny skies and birds are singing in the garden today.');
  await waitFor(async () => (await reqs('extract_patterns')).some(r => r.input.includes('weather')), '无关稿件完成归纳');
  await sleep(300);
  assert.equal(await memoryCount(), 1, '② 无关句子不产生新记忆');
  assert.deepEqual(await statuses(), ['agree 前误用 be 动词=待练'], '② 无关句子不触发升级');
  const assessInputs = (await reqs('assess_evidence')).map(r => r.input).join('\n');
  assert.equal(await reqCount('assess_evidence'), assessBefore, '② 无关句子不得触发 ASSESS_EVIDENCE 请求');
  assert(!assessInputs.includes('weather'), '② 升级评估请求里不得出现无关稿件');
  console.log('[evidence] ② 无关句子：不发评估请求、状态保持待练');

  // 有共同内容但模型说「错误仍出现」→ 也不升级
  await checkReply('EVID_STILL I am agree with the habit of daily review.');
  await waitFor(async () => (await reqs('assess_evidence')).some(r => r.input.includes('EVID_STILL')), '模型评估请求到达');
  assert.deepEqual(await statuses(), ['agree 前误用 be 动词=待练'], '模型判定错误仍出现时不得升级');
  console.log('[evidence] ②b 同类错误仍出现：不升级');

  // ─── ③ 相关后续证据：待练 → 改善中（证据 1） ───
  await checkReply('MARK_OK In my notes I agree that careful review matters every day.');
  await waitFor(async () => (await statuses())[0] === 'agree 前误用 be 动词=改善中', '待练→改善中');
  memories = await getStore('growthMemories');
  assert.equal(memories[0].evidence.length, 1, '第一步升级留 1 条证据');
  assert.equal(memories[0].evidence[0].context, 'reply');
  assert.ok(memories[0].evidence[0].reason.includes('正确运用'), '证据含中文理由');

  // ─── ③ 相关后续证据：改善中 → 已改善（证据 2，各一步） ───
  await checkReply('MARK_OK After revising, I agree the second draft reads clearer than the first.');
  await waitFor(async () => (await statuses())[0] === 'agree 前误用 be 动词=已改善', '改善中→已改善');
  memories = await getStore('growthMemories');
  assert.equal(memories[0].evidence.length, 2, '两次相关证据，各升一级');
  assert.notEqual(memories[0].evidence[0].at, memories[0].evidence[1].at, '两次证据时间不同');
  await openTab('growth');
  const improvedText = await page.locator('.bx-growth-memory').first().textContent();
  assert(improvedText.includes('已改善'), '状态已改善可见');
  assert(improvedText.includes('升级证据（2）'), '证据条数可见');
  assert(improvedText.includes('相关知识点已在后续稿件中正确运用'), '证据理由可见');
  console.log('[evidence] ③ 相关证据两步升级：待练→改善中→已改善');
  await scrollTo(0);
  const firstMemory = page.locator('.bx-growth-memory').first();
  for (const detail of await firstMemory.locator('details').all()) await detail.evaluate(el => { el.open = true; });
  await sleep(150);
  await page.screenshot({ path: path.join(out, 'growth-memory-improved.png'), fullPage: true });

  // 已提取过的 pattern 不重复入库
  const dedupeBefore = await memoryCount();
  await checkReply('I am agree PAT_A once more in a later draft about writing.');
  await waitFor(async () => (await reqs('extract_patterns')).some(r => r.input.includes('PAT_A once more')), '去重归纳请求完成');
  await sleep(300);
  assert.equal(await memoryCount(), dedupeBefore, '相同 pattern 不重复入库');
  console.log('[evidence] 相同错误模式去重：不再新增记忆');

  // ─── 工作台草稿（STORE 只读键 writingDrafts）作为归纳证据来源 ───
  await openTab('growth');
  await page.locator('#bx-growth-scan').click();
  await waitFor(async () => (await memoryCount()) === 2, '工作台草稿归纳落库');
  const scanBody = await bodyText();
  assert(scanBody.includes('介词 in/on 混用'), '工作台归纳出的记忆可见');
  assert(scanBody.includes('工作台草稿'), '来源标注为工作台草稿');
  assert.equal(canonical(await getStore('writingDrafts')), writingJSON, 'writingDrafts 只读不被改动');
  console.log('[evidence] writingDrafts（只读键）参与归纳，且未被改动');

  // ─── ④ 确认后记录：不确认不落库 → 确认才入库；丢弃不入库 ───
  await page.locator('#bx-growth-mode').selectOption('confirm');
  await waitFor(async () => (await getStore('growthSettings'))?.mode === 'confirm', '记录方式＝确认后记录');
  await checkReply('He go to school PAT_S and I keep practicing every single day.');
  await waitFor(async () => (await reqs('extract_patterns')).some(r => r.input.includes('PAT_S')), '候选归纳请求完成');
  await openTab('growth');
  await waitFor(async () => (await bodyText()).includes('待确认'), '确认档出现待确认区');
  assert.equal(await memoryCount(), 2, '④ 确认后记录：不确认不落库');
  // 第二个候选：丢弃路径
  await checkReply("It's its own PAT_D choice whether we agree on the wording later.");
  await openTab('growth');
  await waitFor(async () => (await page.locator('.bx-growth-pending-item').count()) === 2, '两个待确认候选');
  assert.equal(await memoryCount(), 2, '④ 未确认前存储不变');
  await scrollTo(0);
  await sleep(150);
  await page.screenshot({ path: path.join(out, 'growth-confirm-pending.png'), fullPage: true });
  await page.locator('.bx-growth-pending-item[data-pending*="代词"]').locator('[data-growth-act="drop"]').click();
  await waitFor(async () => (await page.locator('.bx-growth-pending-item').count()) === 1, '丢弃后剩一个候选');
  assert.equal(await memoryCount(), 2, '④ 丢弃不落库');
  await page.locator('.bx-growth-pending-item[data-pending*="三单数"]').locator('[data-growth-act="accept"]').click();
  await waitFor(async () => (await memoryCount()) === 3, '确认后落库');
  memories = await getStore('growthMemories');
  assert.equal(memories.find(m => m.pattern.includes('三单数')).status, '待练', '确认入库的状态＝待练');
  assert.equal((await getStore('growthSettings')).mode, 'confirm', '确认动作不改记录方式');
  console.log('[evidence] ④ 确认后记录：不确认不落库 / 丢弃不落库 / 确认才入库');
  await page.locator('#bx-growth-mode').selectOption('auto');
  await waitFor(async () => (await getStore('growthSettings'))?.mode === 'auto', '恢复自动档');

  // ─── ⑤ 编辑 / 关闭 / 删除 + 刷新持久 ───
  await page.locator('.bx-growth-memory[data-search*="agree"]').locator('[data-growth-act="edit"]').click();
  await page.locator('#bx-growth-edit-explanation').fill('（人工修订）agree 前不能再用 be 动词，已确认。');
  await page.locator('[data-growth-act="save-edit"]').click();
  await waitFor(async () => String((await getStore('growthMemories') || []).find(m => m.pattern.includes('agree'))?.explanation || '').includes('（人工修订）'), '编辑保存落库');
  await page.locator('.bx-growth-memory[data-search*="介词"]').locator('[data-growth-act="toggle"]').click();
  await waitFor(async () => (await getStore('growthMemories')).find(m => m.pattern.includes('介词'))?.active === false, '关闭记忆落库');
  await waitFor(async () => (await bodyText()).includes('已关闭'), '关闭状态可见');
  await page.locator('.bx-growth-memory[data-search*="三单数"]').locator('[data-growth-act="del"]').click(); // 第一次＝请求确认
  await page.locator('.bx-growth-memory[data-search*="三单数"]').locator('[data-growth-act="del"]').click(); // 第二次＝确认删除
  await waitFor(async () => (await memoryCount()) === 2, '删除落库');
  await waitFor(async () => !(await bodyText()).includes('三单数'), '删除后列表不再显示');
  console.log('[evidence] ⑤ 编辑/关闭/删除均落库');

  // 刷新（内容脚本与侧栏全部重建）后仍保持
  await page.reload();
  await page.locator('.bx-inline-button').waitFor({ timeout: 15000 });
  await page.locator('.bx-inline-button').click();
  await page.locator('#bx-sidebar.bx-open').waitFor();
  await openTab('growth');
  await page.locator('#bx-growth-mode').waitFor();
  assert.equal(await page.locator('#bx-growth-mode').inputValue(), 'auto', '⑤ 刷新后记录方式仍在');
  await waitFor(async () => (await bodyText()).includes('（人工修订）'), '⑤ 编辑刷新后仍在');
  const afterReload = await bodyText();
  assert(afterReload.includes('已关闭'), '⑤ 关闭刷新后仍在');
  assert(!afterReload.includes('三单数'), '⑤ 删除刷新后仍不在');
  await waitFor(async () => (await bodyText()).includes('旧收藏句子 Alpha'), '⑨ 刷新后旧收藏仍完整可见');
  assert((await bodyText()).includes('legacy favorite beta phrase'), '⑨ 刷新后旧收藏 2 可见');
  console.log('[evidence] ⑤ 刷新后：编辑/关闭保持，删除保持，旧收藏仍在');
  await page.screenshot({ path: path.join(out, 'growth-after-reload.png'), fullPage: true });

  // ─── 手动保存句子（出处/译文/备注可选） ───
  await page.locator('#bx-growth-phrase-text').fill('It rains cats and dogs.');
  await page.locator('#bx-growth-phrase-source').fill('英语老话');
  await page.locator('#bx-growth-phrase-trans').fill('倾盆大雨');
  await page.locator('#bx-growth-phrase-note').fill('idiom-smoke');
  await page.locator('#bx-growth-phrase-save').click();
  await waitFor(async () => (await getStore('savedPhrases') || []).length === 1, '句子保存落库');
  await page.locator('#bx-growth-phrase-text').fill('Break the ice at the meeting.');
  await page.locator('#bx-growth-phrase-save').click();
  await waitFor(async () => (await getStore('savedPhrases') || []).length === 2, '第二条句子落库');
  let phrases = await getStore('savedPhrases');
  assert.equal(phrases.find(p => p.text.includes('cats')).translation, '倾盆大雨', '译文可选字段保存');
  assert.equal(phrases.find(p => p.text.includes('Break the ice')).source, '', '出处可留空');

  // ─── ⑧ 关键词搜索过滤 ───
  await page.locator('#bx-growth-search').fill('cats');
  await sleep(150);
  assert(await page.locator('.bx-growth-phrase[data-search*="cats"]').isVisible(), '⑧ 命中句子可见');
  assert(!(await page.locator('.bx-growth-phrase[data-search*="break the ice"]').isVisible()), '⑧ 未命中句子隐藏');
  assert(!(await page.locator('.bx-growth-memory[data-search*="agree"]').isVisible()), '⑧ 未命中记忆隐藏');
  assert(!(await page.locator('#bx-growth-cards .bx-growth-item[data-search*="旧收藏句子"]').isVisible()), '⑧ 未命中旧收藏隐藏');
  console.log('[evidence] ⑧ 搜索过滤：命中可见、未命中隐藏');
  await page.screenshot({ path: path.join(out, 'growth-search.png'), fullPage: true });
  await page.locator('#bx-growth-search').fill('');
  await sleep(150);
  assert(await page.locator('.bx-growth-phrase[data-search*="break the ice"]').isVisible(), '⑧ 清空搜索恢复全部');
  assert(await page.locator('#bx-growth-cards .bx-growth-item[data-search*="旧收藏句子"]').isVisible(), '⑨ 清空后旧收藏可见');

  // ─── ⑦ 导出 JSON ───
  const downloadPromise = page.waitForEvent('download', { timeout: 15000 });
  await page.locator('#bx-growth-export').click();
  const download = await downloadPromise;
  const exportPath = await download.path();
  const exported = JSON.parse(fs.readFileSync(exportPath, 'utf8'));
  assert.equal(exported.type, 'growth-export');
  assert.equal(exported.version, 1);
  assert.equal(exported.mode, 'auto');
  assert(Array.isArray(exported.memories) && exported.memories.length === 2, `⑦ 导出含 2 条记忆（实际 ${exported.memories?.length}）`);
  assert(exported.memories.some(m => m.pattern.includes('agree')), '⑦ 导出含 agree 记忆（含编辑后说明）');
  assert(exported.memories.some(m => m.pattern.includes('介词')), '⑦ 导出含介词记忆');
  assert(exported.memories.find(m => m.pattern.includes('agree')).explanation.includes('（人工修订）'), '⑦ 导出内容＝当前库内容');
  assert.equal(exported.phrases.length, 2, '⑦ 导出含 2 条句子');
  assert(exported.phrases.some(p => p.text === 'It rains cats and dogs.' && p.translation === '倾盆大雨'), '⑦ 导出句子字段完整');
  assert(exported.cards.some(c => c.text === '旧收藏句子 Alpha：写作让思考可见。'), '⑦ 导出含旧收藏');
  console.log('[evidence] ⑦ 导出 JSON：记忆/句子/旧收藏字段正确');
  await sleep(300);

  // ─── ⑥ 超过 500KB 单键上限：明确中文错误、不清数据 ───
  const snapshot = JSON.parse(JSON.stringify(await getStore('growthMemories')));
  const prefill = [{
    id: 'huge-1', pattern: '超大记忆（上限测试）', explanation: '', suggestion: '',
    examples: [{ excerpt: 'huge excerpt for storage limit test', at: Date.now(), context: 'reply', url: '' }],
    status: '待练', active: true, evidence: [], createdAt: Date.now(), updatedAt: Date.now(), source: 'draft'
  }];
  for (let i = 0; i < 6; i++) {
    const len = JSON.stringify(prefill).length;
    const delta = 499850 - len;
    if (Math.abs(delta) < 300) break;
    prefill[0].explanation += 'x'.repeat(delta);
  }
  const prefillJSON = canonical(prefill);
  assert(prefillJSON.length < 500000, `预置数据必须低于上限（${prefillJSON.length}）`);
  assert(prefillJSON.length > 499500, `预置数据必须贴近上限（${prefillJSON.length}）`);
  await worker.evaluate(async value => { await chrome.storage.local.set({ growthMemories: value }); }, prefill);
  await page.reload();
  await page.locator('.bx-inline-button').waitFor({ timeout: 15000 });
  await page.locator('.bx-inline-button').click();
  await page.locator('#bx-sidebar.bx-open').waitFor();
  await openTab('growth');
  await page.locator('#bx-growth-mode').waitFor();
  await waitFor(async () => (await bodyText()).includes('超大记忆'), '超限预置记忆可见');
  // 触发一次会超限的写入（自动档归纳入库 → STORE set 超 500KB）
  await checkReply("PAT_D It is its own choice whether we write every day and agree later.");
  await waitFor(async () => (await reqs('extract_patterns')).some(r => r.input.includes('its own choice')), '超限用归纳请求完成');
  await openTab('growth');
  await waitFor(async () => (await bodyText()).includes('超过单键上限'), '⑥ 超限中文错误显示');
  const limitText = await bodyText();
  assert(limitText.includes('500000'), '⑥ 错误含上限数值');
  assert.equal(canonical(await getStore('growthMemories')), prefillJSON, '⑥ 超限失败不清数据（存储＝原值）');
  assert.equal(await memoryCount(), 1, '⑥ 失败写入不落库');
  console.log('[evidence] ⑥ 超过 500KB 上限：中文错误 + 数据未被清空');
  await scrollTo(0);
  await sleep(150);
  await page.screenshot({ path: path.join(out, 'growth-store-limit.png'), fullPage: true });
  // 恢复现场
  await worker.evaluate(async value => { await chrome.storage.local.set({ growthMemories: value }); }, snapshot);
  await page.reload();
  await page.locator('.bx-inline-button').waitFor({ timeout: 15000 });
  await page.locator('.bx-inline-button').click();
  await openTab('growth');
  await page.locator('#bx-growth-mode').waitFor();
  assert.equal(await memoryCount(), 2, '恢复后仍是 2 条记忆');
  await waitFor(async () => (await bodyText()).includes('（人工修订）'), '恢复后编辑内容仍在');
  console.log('[evidence] 上限测试后恢复：数据完整');

  // ─── ⑨ 数据完整性：旧收藏与工作台草稿全程未被改动 ───
  assert.equal(canonical(await getStore('cards')), cardsJSON, '⑨ cards 旧收藏数据全程不变');
  assert.equal(canonical(await getStore('writingDrafts')), writingJSON, 'writingDrafts 全程不变');
  await waitFor(async () => (await bodyText()).includes('旧收藏句子 Alpha'), '⑨ 最终旧收藏可见');
  const finalBody = await bodyText();
  assert(finalBody.includes('legacy favorite beta phrase'), '⑨ 最终旧收藏 2 可见');
  assert.equal((await statuses()).length, 2);
  assert.deepEqual(pageErrors, [], `页面错误：${pageErrors.join(' | ')}`);
  console.log('[evidence] ⑨ 旧收藏数据与展示全程完整（cards JSON 未变）');
  await page.screenshot({ path: path.join(out, 'growth-final.png'), fullPage: true });

  console.log('GROWTH_SMOKE_PASS');
  await context.close();
})().catch(error => { console.error(error); process.exit(1); });
