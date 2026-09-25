// 成长模块纯逻辑验收（node 直跑：node tests/growth-logic.cjs）。
// 与 tests/growth-smoke.cjs（浏览器端到端）互补：这里用受控 stub BX + 假 STORE/AI，
// 快速、确定性地证明误判边界——AI 代写不产生记忆、无关句子不升级、相关证据逐步升级、
// 确认后记录不确认不落库、自动档落库、关闭档不记录。
// 模型全部为受控 stub，不宣称真实模型验证。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const listeners = Object.create(null);
const store = { growthMemories: null, growthSettings: null, savedPhrases: null, writingDrafts: null };
const aiCalls = [];

// EXTRACT_PATTERNS：稿件含 MAKE_ERR 才归纳出一条记忆；ASSESS_EVIDENCE：含 MARK_OK 才判「相关且已解决」。
const aiHandler = (task, payload) => {
  const input = String(payload.text || '') + '\n' + String(payload.context || '');
  if (task === 'EXTRACT_PATTERNS') {
    const patterns = [];
    if (/MAKE_ERR2/.test(input)) {
      patterns.push({ pattern: '三单数漏加 -s', explanation: '稿件里出现 “He go to school”，第三人称单数动词要加 -s。', quote: 'He go to school', suggestion: '应说 He goes to school' });
    }
    if (/MAKE_ERR/.test(input)) {
      patterns.push({ pattern: 'agree 前误用 be 动词', explanation: '稿件里出现 “I am agree …”，agree 是动词，前面不能再用 be 动词。', quote: 'I am agree', suggestion: '应说 I agree with…' });
    }
    return { patterns };
  }
  if (task === 'ASSESS_EVIDENCE') {
    return /MARK_OK/.test(input)
      ? { related: true, resolved: true, reason: '相关知识点已在后续稿件中正确运用。' }
      : { related: false, resolved: false, reason: '证据不足。' };
  }
  throw new Error(`unexpected AI task ${task}`);
};

const BX = {
  state: { mode: 'growth', cards: [], target: '英语', reqSeq: 0 },
  esc: value => String(value ?? ''),
  register: mod => { BX.__registered = mod; },
  statusHTML: () => '',
  refresh: () => { BX.refreshCount = (BX.refreshCount || 0) + 1; },
  util: {
    send: async (action, payload) => {
      if (action === 'STORE') {
        const op = payload.payload;
        if (op.op === 'get') return store[op.key] ?? null;
        if (op.op === 'set') { store[op.key] = op.value; return { ok: true, bytes: JSON.stringify(op.value ?? null).length }; }
        if (op.op === 'remove') { store[op.key] = null; return { ok: true }; }
      }
      if (action === 'AI') { aiCalls.push({ task: payload.task, text: String(payload.payload.text || '') }); return aiHandler(payload.task, payload.payload); }
      if (action === 'LIST_CARDS') return [];
      throw new Error(`unexpected action ${action}`);
    }
  },
  on: (event, fn) => { (listeners[event] || (listeners[event] = [])).push(fn); },
  emit: (event, payload) => { for (const fn of listeners[event] || []) fn(payload); }
};

globalThis.window = { BX };
const source = fs.readFileSync(path.join(__dirname, '..', 'modules', 'growth', 'growth.js'), 'utf8');
// 直接执行内容脚本（同 realm，断言可用 deepStrictEqual）
require('node:vm').runInThisContext(source, { filename: 'modules/growth/growth.js' });
const core = window.__bxGrowthCore;
const growth = BX.state.growth;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 2000) {
  const start = Date.now();
  for (;;) {
    let value;
    try { value = fn(); } catch { value = false; }
    if (value) return value;
    if (Date.now() - start > timeout) throw new Error(`等待超时：${label}`);
    await sleep(15);
  }
}
const callsOf = task => aiCalls.filter(call => call.task === task);
const draft = (text, origin = 'user') => BX.emit('user-draft', { text, origin, context: 'reply', url: 'https://x.com/a/status/1', at: Date.now() });

(async () => {
  // ── 0. 模块已注册到 growth 页签，且订阅在加载时就挂上（不依赖首次打开页签）──
  assert.equal(BX.__registered.id, 'growth');
  assert.equal(BX.__registered.label, '成长');
  assert((listeners['user-draft'] || []).length >= 1, 'user-draft 订阅必须在模块加载时挂上');
  assert.equal(growth.settings.mode, 'auto', '默认记录方式＝自动');

  // ── ① origin==='ai' 稿件：不产生记忆候选、不发归纳模型、不落库 ──
  draft('AI 代写稿 MAKE_ERR I am agree with the machine text.', 'ai');
  await sleep(150);
  assert.equal(callsOf('EXTRACT_PATTERNS').length, 0, 'AI 稿不得触发归纳');
  assert.equal(callsOf('ASSESS_EVIDENCE').length, 0, 'AI 稿不得触发升级评估');
  assert.equal(store.growthMemories, null, 'AI 稿不得落库');
  assert.equal(growth.memories.length, 0);
  assert.equal(growth.pending.length, 0);

  // ── ③ 自动档：origin==='user' 且含真实错误 → 归纳入库，状态「待练」 ──
  draft('I am agree with you about MAKE_ERR daily review.');
  const mem1 = await waitFor(() => (store.growthMemories || [])[0], '自动档落库');
  assert.equal(store.growthMemories.length, 1, '自动档应直接落库');
  assert.equal(mem1.status, '待练');
  assert.equal(mem1.examples[0].context, 'reply');
  assert.equal(callsOf('EXTRACT_PATTERNS').length, 1);

  // 重复归纳同一模式不应产生第二条（模块按 pattern 去重）
  draft('Second draft with MAKE_ERR again, I am agree.');
  await waitFor(() => callsOf('EXTRACT_PATTERNS').length === 2, '第二次归纳请求');
  await sleep(80);
  assert.equal(store.growthMemories.length, 1, '相同 pattern 不重复入库');

  // ── ② 无关句子：不发升级评估、不升级（确定性门槛先于模型） ──
  const beforeAssess = callsOf('ASSESS_EVIDENCE').length;
  draft('The weather forecast shows sunny skies and birds are singing in the garden today.');
  await waitFor(() => callsOf('EXTRACT_PATTERNS').length === 3, '无关稿件也被归纳（返回空）');
  await sleep(80);
  assert.equal(callsOf('ASSESS_EVIDENCE').length, beforeAssess, '无关句子不得触发升级评估请求');
  assert.equal(store.growthMemories[0].status, '待练', '无关句子不得触发升级');
  assert.equal(store.growthMemories.length, 1, '无关稿件不产生新记忆');

  // 有共同内容但模型说「错误仍出现」→ 不升级
  draft('EVID_STILL I am agree with the habit of daily review.');
  await waitFor(() => callsOf('ASSESS_EVIDENCE').some(c => c.text.includes('EVID_STILL')), '模型评估请求');
  await sleep(60);
  assert.equal(store.growthMemories[0].status, '待练', '模型判定错误仍出现时不得升级');

  // ── ③ 相关后续证据逐步升级：待练 → 改善中 → 已改善 ──
  draft('MARK_OK In my notes I agree that careful review matters.');
  await waitFor(() => store.growthMemories[0].status === '改善中', '待练→改善中');
  assert.equal(store.growthMemories[0].evidence.length, 1, '升级要留证据');
  assert.ok(store.growthMemories[0].evidence[0].at > 0);
  assert.ok(store.growthMemories[0].evidence[0].reason.includes('正确运用'), '证据含中文理由');

  // 同一份稿件不能重复当证据
  const planDup = core.planUpgrade(store.growthMemories[0], { text: 'MARK_OK In my notes I agree that careful review matters.', origin: 'user', at: Date.now() }, { related: true, resolved: true, reason: 'x' });
  assert.equal(planDup.upgrade, false, '重复证据不升级');

  draft('MARK_OK After revising, I agree the second draft reads clearer than the first.');
  await waitFor(() => store.growthMemories[0].status === '已改善', '改善中→已改善');
  assert.equal(store.growthMemories[0].evidence.length, 2, '两次相关证据各一步');
  draft('MARK_OK One more agreeing note after reaching the final status.');
  await sleep(120);
  assert.equal(store.growthMemories[0].status, '已改善', '已改善后不再变化');
  assert.equal(store.growthMemories[0].evidence.length, 2, '已改善后不再追加证据');

  // ── ④ 确认后记录：不确认不落库 ──
  growth.settings.mode = 'confirm';
  draft('He go to school MAKE_ERR2 and this one waits for confirmation.');
  await waitFor(() => growth.pending.length === 1, '确认档出现候选');
  assert.equal(store.growthMemories.length, 1, '确认档：不确认不落库');
  assert.equal(growth.pending[0].kind, 'memory');
  assert.equal(growth.pending[0].pattern, '三单数漏加 -s');
  growth.settings.mode = 'auto';

  // ── 关闭档：既不归纳也不评估 ──
  growth.settings.mode = 'off';
  const aiBefore = aiCalls.length;
  draft('He go to school MAKE_ERR2 while recording is off.');
  await sleep(150);
  assert.equal(aiCalls.length, aiBefore, '关闭档不发任何模型请求');
  assert.equal(store.growthMemories.length, 1, '关闭档不落库');
  assert.equal(growth.pending.length, 1, '关闭档不产生候选');
  growth.settings.mode = 'auto';

  // ── 纯函数边界：AI 代写证据即使模型吹得天花乱坠也不升级 ──
  const aiEvidencePlan = core.planUpgrade(
    { ...mem1, status: '待练', active: true, evidence: [], createdAt: Date.now() - 1000 },
    { text: 'I am agree with everything MARK_OK', origin: 'ai', at: Date.now() },
    { related: true, resolved: true, reason: '模型认为已掌握' }
  );
  assert.equal(aiEvidencePlan.upgrade, false, 'origin=ai 的证据一律不升级');
  assert.match(aiEvidencePlan.reason, /AI 代写/);

  // 无关证据 + 模型误判为「已解决」→ 仍被确定性门槛拦下
  const unrelatedPlan = core.planUpgrade(
    { ...mem1, status: '待练', active: true, evidence: [], createdAt: Date.now() - 1000 },
    { text: 'The weather forecast shows sunny skies.', origin: 'user', at: Date.now() },
    { related: true, resolved: true, reason: '模型误判' }
  );
  assert.equal(unrelatedPlan.upgrade, false, '无关句子即使模型误判也不升级');
  assert.match(unrelatedPlan.reason, /无关句子/);

  // 关闭的记忆不参与升级
  const closedPlan = core.planUpgrade(
    { ...mem1, status: '待练', active: false, evidence: [], createdAt: Date.now() - 1000 },
    { text: 'I am agree MARK_OK', origin: 'user', at: Date.now() },
    { related: true, resolved: true, reason: 'x' }
  );
  assert.equal(closedPlan.upgrade, false, '已关闭记忆不升级');

  // 证据早于记忆创建 → 不算后续证据
  const earlyPlan = core.planUpgrade(
    { ...mem1, status: '待练', active: true, evidence: [], createdAt: Date.now() },
    { text: 'I am agree MARK_OK', origin: 'user', at: Date.now() - 60000 },
    { related: true, resolved: true, reason: 'x' }
  );
  assert.equal(earlyPlan.upgrade, false, '早于创建时间的证据不算');

  // sanitizePatterns：空结果 / 缺字段不入库
  assert.deepEqual(core.sanitizePatterns({ patterns: [] }, { text: 'x', at: 1 }, 'draft'), []);
  assert.deepEqual(core.sanitizePatterns(null, { text: 'x', at: 1 }, 'draft'), []);
  assert.equal(core.sanitizePatterns({ patterns: [{ pattern: '', explanation: '', quote: '', suggestion: '' }] }, { text: 'x', at: 1 }, 'draft').length, 0, '空 pattern 不入库');
  assert.equal(core.sanitizePatterns({ patterns: [{ pattern: 'p', explanation: 'e', quote: 'x', suggestion: 's' }] }, { text: 'x', at: 1 }, 'draft')[0].status, '待练');
  assert.equal(core.sanitizePatterns({ patterns: [{ pattern: 'p', explanation: 'e', quote: 'invented', suggestion: 's' }] }, { text: 'x', at: 1 }, 'draft').length, 0, '模型编造的引文不得入库');
  const sameSource = core.buildMemory({ pattern: 'p', explanation: 'e', quote: 'I am agree', suggestion: 's' }, { text: 'I am agree with you.', at: 10 }, 'draft');
  assert.equal(core.planUpgrade(sameSource, { text: 'I am agree with you.', origin: 'user', at: 11 }, { related: true, resolved: true }).upgrade, false, '原稿重复提交不得作为改善证据');

  // applyUpgrade 是纯函数（不改原对象）并按序推进状态
  const base = { id: 'm', pattern: 'p', explanation: 'e', status: '待练', active: true, evidence: [], createdAt: 1 };
  const step1 = core.applyUpgrade(base, { text: 'ev1 I am agree', origin: 'user', at: 100, context: 'reply', url: '' }, 'r');
  const step2 = core.applyUpgrade(step1, { text: 'ev2 I am agree', origin: 'user', at: 200, context: 'reply', url: '' }, 'r');
  assert.equal(base.status, '待练', 'applyUpgrade 不改原对象');
  assert.equal(step1.status, '改善中');
  assert.equal(step2.status, '已改善');
  assert.equal(core.applyUpgrade(step2, { text: 'ev3', origin: 'user', at: 300 }, 'r').status, '已改善', '已改善不再推进');

  // tokensOf：功能词不参与重合判定
  assert(!core.tokensOf('I agree with that idea').has('with'));
  assert(core.tokensOf('I agree with that idea').has('agree'));

  console.log('GROWTH_LOGIC_PASS 记忆边界与状态机全部通过');
})().catch(error => { console.error(error); process.exit(1); });
