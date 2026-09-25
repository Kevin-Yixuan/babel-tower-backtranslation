// 成长记忆与表达模块（growth Agent；id=growth，页签「成长」）。
// 起点：旧浮层面板「收藏」页签原样迁移（既有收藏 cards 继续只读展示，数据不丢）。
// 任务书 3：
//   1) 只从 origin==='user' 的亲写草稿归纳重复错误（EXTRACT_PATTERNS 走 AI 任务注册），
//      origin==='ai' 的模型生成稿一律不产生候选、不作为掌握证据（协议 §5 铁律）；
//   2) 「待练 → 改善中 → 已改善」只由相关的后续亲写稿件证据升级：
//      先做确定性的共同内容门槛（无关句子不发模型、不升级），再由 ASSESS_EVIDENCE 保守判定；
//   3) 记忆的查看/编辑/删除/关闭 + 记录方式三档（STORE 键 growthSettings，默认自动）；
//   4) 手动保存可复用句子（STORE 键 savedPhrases，出处/译文/备注可选、可搜索、可导出 JSON）；
//      既有收藏（cards）在同一页签分区呈现，只读、不改动。
// 数据全部存本机 chrome.storage.local（协议 §3.2：growthMemories / growthSettings / savedPhrases 可写，
// writingDrafts / cards 只读），不上传、不同步。
(() => {
  const BX = window.BX;
  const { state, esc, register, statusHTML } = BX;
  const { send } = BX.util;

  const KEY_MEM = 'growthMemories';
  const KEY_SET = 'growthSettings';
  const KEY_PHR = 'savedPhrases';
  const MODES = [
    { value: 'auto', label: '自动记录（出现候选直接入库）' },
    { value: 'confirm', label: '确认后记录（先确认再入库）' },
    { value: 'off', label: '关闭（不再记录，也不更新状态）' }
  ];
  const STATUSES = ['待练', '改善中', '已改善'];
  const MAX_MEMORIES = 200;
  const MAX_PHRASES = 500;
  const MAX_EXAMPLES = 5;
  const MAX_EVIDENCE = 12;
  const LIMITS = { pattern: 120, explanation: 2000, suggestion: 600, quote: 400, phrase: 800, source: 300, translation: 400, note: 300 };

  // ---------------------------------------------------------------- 纯函数（tests/growth-logic.cjs 直接复用）
  const STOP = new Set(('with have from were been they them your that this will would could should about into ' +
    'over some any when what which then than there their here more most very just also only after before because ' +
    'think said says make made like well back even much many such take come know want need good first last same able ' +
    'being doing having going through under again where while never always maybe might must shall other another own ' +
    'does did done just only upon such upon time long way get got much').split(' '));

  /** 保守的共同内容判定：拉丁词（≥4 字符、去功能词）+ 中文二元组；单个中文字不成证据。 */
  function tokensOf(text) {
    const out = new Set();
    const s = String(text || '').toLowerCase();
    for (const word of s.match(/[a-zà-ÿ][a-zà-ÿ']{3,}/g) || []) if (!STOP.has(word)) out.add(word);
    for (const run of s.match(/[一-鿿㐀-䶿]+/g) || []) {
      if (run.length < 2) continue;
      for (let i = 0; i + 1 < run.length; i++) out.add(run.slice(i, i + 2));
    }
    return out;
  }
  function sharedTokens(a, b) {
    const right = b instanceof Set ? b : tokensOf(b);
    const out = new Set();
    for (const token of a) if (right.has(token)) out.add(token);
    return out;
  }
  function memoryTokens(mem) {
    if (!mem || typeof mem !== 'object') return new Set();
    const parts = [mem.pattern, mem.explanation, mem.suggestion];
    for (const ex of Array.isArray(mem.examples) ? mem.examples : []) parts.push(ex?.excerpt);
    for (const ev of Array.isArray(mem.evidence) ? mem.evidence : []) parts.push(ev?.excerpt);
    return tokensOf(parts.filter(Boolean).join(' '));
  }
  const normalizePattern = value => String(value || '').toLowerCase().replace(/\s+/g, '').trim();
  const excerptOf = text => String(text || '').trim().slice(0, 400);
  const normalizeExcerpt = text => String(text || '').trim().slice(0, 400).toLowerCase().replace(/\s+/g, ' ');
  const nextStatus = status => (status === '待练' ? '改善中' : status === '改善中' ? '已改善' : null);
  const fmtTime = at => (Number.isFinite(at) ? new Date(at).toLocaleString('zh-CN') : '时间未知');
  const contextLabel = context => (context === 'practice' ? '回译练习' : context === 'workbench' ? '工作台草稿' : '回复');

  /** 升级判定：宁可不升级。证据不相关 / AI 代写 / 重复证据 / 模型不确定 → 一律不升级。 */
  function planUpgrade(memory, evidence, verdict) {
    if (!memory || typeof memory !== 'object') return { upgrade: false, reason: '记忆不存在。' };
    if (memory.active === false) return { upgrade: false, reason: '这条记忆已关闭，不参与状态更新。' };
    if (!STATUSES.includes(memory.status) || memory.status === '已改善') return { upgrade: false, reason: '已经是「已改善」，无需更新。' };
    if (!evidence || evidence.origin !== 'user') return { upgrade: false, reason: 'AI 代写或来源不明的稿件不能作为进步证据。' };
    const text = String(evidence.text || '');
    if (!text.trim()) return { upgrade: false, reason: '证据稿件为空。' };
    if (!Number.isFinite(evidence.at) || !Number.isFinite(memory.createdAt) || evidence.at <= memory.createdAt) {
      return { upgrade: false, reason: '证据必须晚于该记忆的创建时间。' };
    }
    const original = (Array.isArray(memory.examples) ? memory.examples : [])
      .some(item => item?.excerpt && String(text).includes(String(item.excerpt)));
    if (original || (memory.sourceExcerpt && normalizeExcerpt(memory.sourceExcerpt) === normalizeExcerpt(text))) {
      return { upgrade: false, reason: '创建记忆的原稿或同一错误片段不能作为改善证据。' };
    }
    const prior = (Array.isArray(memory.evidence) ? memory.evidence : []).some(item => normalizeExcerpt(item?.excerpt) === normalizeExcerpt(text));
    if (prior) return { upgrade: false, reason: '同一份稿件不能重复作为证据。' };
    if (!sharedTokens(memoryTokens(memory), text).size) {
      return { upgrade: false, reason: '证据与这条记忆没有共同内容（无关句子），保守起见不升级。' };
    }
    if (!verdict || verdict.related !== true) return { upgrade: false, reason: '判定：这份稿件与该记忆无关。' };
    if (verdict.resolved !== true) return { upgrade: false, reason: '判定：同类错误仍出现或证据不足。' };
    return { upgrade: true, reason: String(verdict.reason || '相关后续稿件中该错误未再出现。').slice(0, 300) };
  }

  function applyUpgrade(memory, evidence, reason) {
    const status = nextStatus(memory.status);
    if (!status) return memory;
    const at = Number.isFinite(evidence.at) ? evidence.at : Date.now();
    return {
      ...memory,
      status,
      updatedAt: at,
      evidence: [
        ...(Array.isArray(memory.evidence) ? memory.evidence : []),
        { at, context: evidence.context || 'reply', url: evidence.url || '', excerpt: excerptOf(evidence.text), reason: String(reason || '').slice(0, 300) }
      ].slice(-MAX_EVIDENCE)
    };
  }

  function buildMemory(item, draft, source) {
    const now = Number.isFinite(draft?.at) ? draft.at : Date.now();
    const pattern = String(item?.pattern || '').trim().slice(0, LIMITS.pattern);
    const explanation = String(item?.explanation || '').trim().slice(0, LIMITS.explanation);
    if (!pattern || !explanation) return null;
    const quote = String(item?.quote || '').trim().slice(0, LIMITS.quote);
    // A model-supplied quote is evidence only when it is literally in the
    // user's draft. Do not convert a fabricated quote into a stored memory.
    if (!quote || !String(draft?.text || '').includes(quote)) return null;
    return {
      id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `m-${now}-${Math.random().toString(36).slice(2)}`,
      pattern,
      explanation,
      suggestion: String(item?.suggestion || '').trim().slice(0, LIMITS.suggestion),
      examples: [{ excerpt: quote, at: now, context: draft?.context || 'reply', url: draft?.url || '' }],
      sourceExcerpt: excerptOf(draft?.text || ''),
      status: '待练',
      active: true,
      evidence: [],
      createdAt: now,
      updatedAt: now,
      source: source === 'workbench' ? 'workbench' : 'draft'
    };
  }

  function sanitizePatterns(result, draft, source) {
    const list = Array.isArray(result?.patterns) ? result.patterns.slice(0, 3) : [];
    const out = [];
    for (const item of list) {
      const mem = buildMemory(item, draft, source);
      if (mem) out.push(mem);
    }
    return out;
  }

  // 测试钩子（纯函数；浏览器 UI 断言走 tests/growth-smoke.cjs，这里给 node 单测用）
  window.__bxGrowthCore = { tokensOf, sharedTokens, memoryTokens, normalizePattern, planUpgrade, applyUpgrade, buildMemory, sanitizePatterns, nextStatus, STATUSES };

  // ---------------------------------------------------------------- 模块状态
  state.growth = {
    storeLoaded: false, loading: false, cardsLoaded: false,
    memories: [], phrases: [], settings: { mode: 'auto' },
    pending: [], search: '', error: '', notice: '', busy: false,
    editId: '', edit: null, confirmDel: null, form: { text: '', source: '', translation: '', note: '' },
    wired: false
  };
  const emptyForm = () => ({ text: '', source: '', translation: '', note: '' });
  let storePromise = null;
  let pipeline = Promise.resolve();

  // ---------------------------------------------------------------- 存储
  async function ensureStore() {
    if (state.growth.storeLoaded) return;
    if (storePromise) return storePromise;
    storePromise = (async () => {
      const [memories, settings, phrases] = await Promise.all([
        send('STORE', { payload: { op: 'get', key: KEY_MEM } }),
        send('STORE', { payload: { op: 'get', key: KEY_SET } }),
        send('STORE', { payload: { op: 'get', key: KEY_PHR } })
      ]);
      state.growth.memories = Array.isArray(memories) ? memories.filter(m => m && typeof m === 'object' && m.id) : [];
      const mode = settings && typeof settings === 'object' && MODES.some(m => m.value === settings.mode) ? settings.mode : 'auto';
      state.growth.settings = { ...(settings && typeof settings === 'object' ? settings : {}), mode };
      state.growth.phrases = Array.isArray(phrases) ? phrases.filter(p => p && typeof p === 'object' && p.id && p.text) : [];
      state.growth.storeLoaded = true;
    })().catch(error => { state.growth.error = error.message || '成长数据读取失败。'; throw error; })
      .finally(() => { storePromise = null; });
    return storePromise;
  }

  // 先写库、成功才更新内存：写失败（如超上限）保留原数据并显示中文错误，绝不清数据。
  async function saveMemories(next) {
    const value = (Array.isArray(next) ? next : []).filter(m => m && typeof m === 'object' && m.id);
    if (value.length > MAX_MEMORIES) throw new Error(`学习记忆已达 ${MAX_MEMORIES} 条上限，未保存新项；请先导出并清理，旧记录不会被删除。`);
    await send('STORE', { payload: { op: 'set', key: KEY_MEM, value } });
    state.growth.memories = value;
    return value;
  }
  async function savePhrases(next) {
    const value = (Array.isArray(next) ? next : []).filter(p => p && typeof p === 'object' && p.id && p.text);
    if (value.length > MAX_PHRASES) throw new Error(`句子已达 ${MAX_PHRASES} 条上限，未保存新项；请先导出并清理，旧句子不会被删除。`);
    await send('STORE', { payload: { op: 'set', key: KEY_PHR, value } });
    state.growth.phrases = value;
    return value;
  }
  async function saveSettingsMode(mode) {
    const value = { ...state.growth.settings, mode };
    await send('STORE', { payload: { op: 'set', key: KEY_SET, value } });
    state.growth.settings = value;
  }

  function patternSet() {
    return new Set(state.growth.memories.map(m => normalizePattern(m.pattern)));
  }
  function existingSummary() {
    return state.growth.memories.slice(0, 40).map(m => `${m.pattern}：${String(m.explanation || '').slice(0, 120)}`).join('；').slice(0, 3400);
  }
  function memoryContext(mem) {
    const examples = (Array.isArray(mem.examples) ? mem.examples : []).map(ex => ex.excerpt).join(' / ');
    return `pattern=${mem.pattern}\nexplanation=${mem.explanation}\nsuggestion=${mem.suggestion || ''}\n出现过的稿件片段：${examples}`.slice(0, 3400);
  }
  // 骨架的 state.mode 不随页签切换更新（sidebar 只维护内部 activeId，协议与实现有出入、公共文件不由本模块改），
  // 这里直接读页签按钮的 active 类判断「成长」是否为当前页签，避免在别的页签输入时被打断重绘。
  function growthActive() {
    try {
      const root = BX.element || document;
      return root.querySelector('.bx-tabs button.bx-active')?.dataset.bxMode === 'growth';
    } catch { return false; }
  }
  function maybeRefresh() { if (growthActive()) BX.refresh(); }
  function setError(error) { state.growth.error = String(error?.message || error || '操作失败，请重试。'); }
  function clearMessages() { state.growth.error = ''; state.growth.notice = ''; }

  // ---------------------------------------------------------------- 归纳与升级
  async function runExtraction(text, source, mode, draft) {
    const result = await send('AI', { task: 'EXTRACT_PATTERNS', payload: { text, context: existingSummary(), target: state.target } });
    const created = sanitizePatterns(result, draft, source).filter(m => !patternSet().has(normalizePattern(m.pattern)));
    if (!created.length) return { added: 0, queued: 0 };
    if (mode === 'confirm') {
      for (const mem of created) {
        state.growth.pending.push({
          pid: `p-${mem.id}`, kind: 'memory', pattern: mem.pattern, explanation: mem.explanation,
          suggestion: mem.suggestion, excerpt: mem.examples[0]?.excerpt || excerptOf(text), at: mem.createdAt,
          context: draft?.context || 'reply', url: draft?.url || '', memory: mem
        });
      }
      state.growth.notice = `有 ${created.length} 条记忆候选待确认。`;
      return { added: 0, queued: created.length };
    }
    await saveMemories([...created, ...state.growth.memories]);
    state.growth.notice = `已归纳 ${created.length} 条新记忆（待练）。`;
    return { added: created.length, queued: 0 };
  }

  async function runAssessment(draft, mode) {
    const targets = state.growth.memories.filter(m => m.active !== false && (m.status === '待练' || m.status === '改善中'));
    for (const mem of targets) {
      if (state.growth.pending.some(p => p.kind === 'upgrade' && p.memoryId === mem.id)) continue;
      // 确定性门槛：证据与记忆毫无共同内容 → 不发模型、不升级（宁可不升级）。
      if (!sharedTokens(memoryTokens(mem), draft.text).size) continue;
      let verdict;
      try {
        verdict = await send('AI', { task: 'ASSESS_EVIDENCE', payload: { text: draft.text, context: memoryContext(mem), target: state.target } });
      } catch (error) { setError(error); break; }
      const plan = planUpgrade(mem, draft, verdict);
      if (!plan.upgrade) continue;
      if (mode === 'confirm') {
        state.growth.pending.push({
          pid: `u-${mem.id}-${state.growth.pending.length}`, kind: 'upgrade', memoryId: mem.id,
          pattern: mem.pattern, explanation: plan.reason, excerpt: excerptOf(draft.text), at: draft.at,
          context: draft.context || 'reply', url: draft.url || '', evidence: draft, reason: plan.reason,
          nextStatus: nextStatus(mem.status) || ''
        });
        state.growth.notice = '有状态升级待确认。';
        continue;
      }
      const upgraded = applyUpgrade(mem, draft, plan.reason);
      await saveMemories(state.growth.memories.map(m => (m.id === mem.id ? upgraded : m)));
      state.growth.notice = `「${mem.pattern}」已有相关证据，升级为「${upgraded.status}」。`;
    }
  }

  async function handleDraft(draft) {
    await ensureStore();
    const mode = state.growth.settings.mode;
    if (mode === 'off') return; // 关闭档：不记录、不升级
    clearMessages();
    await runAssessment(draft, mode);
    await runExtraction(draft.text, 'draft', mode, draft);
  }

  function enqueue(work) {
    pipeline = pipeline.then(work).catch(error => { setError(error); }).then(() => maybeRefresh());
    return pipeline;
  }

  // 协议 §5：订阅在模块加载时就挂上（init 要等首次进页签才跑，会漏掉早前的稿件）。
  BX.on('user-draft', payload => {
    if (!payload || typeof payload.text !== 'string' || !payload.text.trim()) return;
    if (payload.origin !== 'user') return; // 铁律：AI 代写稿不产生候选、也不触发升级
    enqueue(() => handleDraft({ ...payload, at: Number.isFinite(payload.at) ? payload.at : Date.now() }));
  });
  BX.on('cards-changed', () => { if (state.growth.cardsLoaded) loadCards(); });

  // ---------------------------------------------------------------- 手动句子 / 导出 / 工作台
  async function savePhrase() {
    clearMessages();
    const form = state.growth.form;
    const text = String(form.text || '').trim();
    if (!text) { state.growth.error = '请先填写要保存的句子。'; maybeRefresh(); return; }
    const source = String(form.source || '').trim();
    const translation = String(form.translation || '').trim();
    const note = String(form.note || '').trim();
    if (text.length > LIMITS.phrase) { state.growth.error = `句子共 ${text.length} 字符，超过上限 ${LIMITS.phrase} 字符。`; maybeRefresh(); return; }
    if (source.length > LIMITS.source || translation.length > LIMITS.translation || note.length > LIMITS.note) {
      state.growth.error = `出处上限 ${LIMITS.source} 字、译文上限 ${LIMITS.translation} 字、备注上限 ${LIMITS.note} 字。`; maybeRefresh(); return;
    }
    const phrase = { id: crypto.randomUUID(), text, source, translation, note, createdAt: Date.now() };
    try {
      await ensureStore();
      await savePhrases([phrase, ...state.growth.phrases]);
      state.growth.form = emptyForm();
      state.growth.notice = '已保存句子（仅存本机）。';
    } catch (error) { setError(error); }
    maybeRefresh();
  }

  async function deletePhrase(id) {
    clearMessages();
    try {
      await savePhrases(state.growth.phrases.filter(p => p.id !== id));
      state.growth.notice = '已删除该句子。';
    } catch (error) { setError(error); }
    state.growth.confirmDel = null;
    maybeRefresh();
  }

  async function exportAll() {
    clearMessages();
    try {
      await ensureStore();
      const payload = {
        app: '巴别塔（回译）· 成长记忆与表达', type: 'growth-export', version: 1,
        exportedAt: new Date().toISOString(),
        mode: state.growth.settings.mode,
        memories: state.growth.memories,
        phrases: state.growth.phrases,
        cards: state.cards || []
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `growth-export-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      state.growth.notice = '已导出 JSON 文件（记忆 + 句子 + 既有收藏）。';
    } catch (error) { setError(error); }
    maybeRefresh();
  }

  async function scanWorkbench() {
    if (state.growth.busy) return;
    state.growth.busy = true;
    clearMessages();
    maybeRefresh();
    try {
      await ensureStore();
      const mode = state.growth.settings.mode;
      if (mode === 'off') { state.growth.notice = '记录方式为「关闭」，未归纳工作台草稿。'; return; }
      const drafts = await send('STORE', { payload: { op: 'get', key: 'writingDrafts' } }); // 只读键
      const list = (Array.isArray(drafts) ? drafts : []).filter(d => d && d.authoredByUser === true && typeof d.body === 'string' && d.body.trim()).slice(0, 5);
      if (!list.length) { state.growth.notice = '没有已确认亲写的工作台草稿。请在工作台正文下方确认来源后再归纳；旧草稿不会被自动认定为亲写。'; return; }
      let added = 0, queued = 0;
      for (const draft of list) {
        const at = Date.parse(draft.updatedAt) || Date.now();
        const out = await runExtraction(draft.body, 'workbench', mode, { at, context: 'workbench', url: '', text: draft.body });
        added += out.added; queued += out.queued;
      }
      if (added) state.growth.notice = `已从工作台草稿归纳 ${added} 条记忆（待练）。`;
      else if (queued) state.growth.notice = `工作台草稿产生 ${queued} 条待确认候选。`;
      else state.growth.notice = '工作台草稿没有可归纳的重复错误（或已有相同记忆）。';
    } catch (error) { setError(error); }
    finally { state.growth.busy = false; maybeRefresh(); }
  }

  // ---------------------------------------------------------------- 记忆管理动作
  async function toggleMemory(id) {
    clearMessages();
    const mem = state.growth.memories.find(m => m.id === id);
    if (!mem) return;
    try {
      await saveMemories(state.growth.memories.map(m => (m.id === id ? { ...m, active: m.active === false, updatedAt: Date.now() } : m)));
      state.growth.notice = mem.active === false ? '已重新启用该记忆。' : '已关闭该记忆（不再参与状态更新）。';
    } catch (error) { setError(error); }
    maybeRefresh();
  }
  async function deleteMemory(id) {
    clearMessages();
    try {
      await saveMemories(state.growth.memories.filter(m => m.id !== id));
      state.growth.notice = '已删除该记忆。';
    } catch (error) { setError(error); }
    state.growth.confirmDel = null;
    maybeRefresh();
  }
  async function saveEdit(id) {
    clearMessages();
    const mem = state.growth.memories.find(m => m.id === id);
    const edit = state.growth.edit;
    if (!mem || !edit) return;
    const pattern = String(edit.pattern || '').trim();
    const explanation = String(edit.explanation || '').trim();
    const suggestion = String(edit.suggestion || '').trim();
    if (!pattern || !explanation) { state.growth.error = '错误名称和中文说明不能为空。'; maybeRefresh(); return; }
    if (pattern.length > LIMITS.pattern || explanation.length > LIMITS.explanation || suggestion.length > LIMITS.suggestion) {
      state.growth.error = `编辑超限：错误名称 ≤${LIMITS.pattern} 字、说明 ≤${LIMITS.explanation} 字、方向 ≤${LIMITS.suggestion} 字。`; maybeRefresh(); return;
    }
    try {
      await saveMemories(state.growth.memories.map(m => (m.id === id ? { ...m, pattern, explanation, suggestion, updatedAt: Date.now() } : m)));
      state.growth.editId = ''; state.growth.edit = null;
      state.growth.notice = '已保存修改。';
    } catch (error) { setError(error); }
    maybeRefresh();
  }
  async function acceptPending(pid) {
    clearMessages();
    if (state.growth.settings.mode !== 'confirm') {
      state.growth.error = '当前不是「确认后记录」模式，候选未写入。';
      maybeRefresh(); return;
    }
    const item = state.growth.pending.find(p => p.pid === pid);
    if (!item) return;
    try {
      if (item.kind === 'upgrade') {
        const mem = state.growth.memories.find(m => m.id === item.memoryId);
        if (!mem) throw new Error('该记忆已被删除，升级候选失效。');
        const upgraded = applyUpgrade(mem, item.evidence, item.reason);
        await saveMemories(state.growth.memories.map(m => (m.id === mem.id ? upgraded : m)));
        state.growth.notice = `已确认：「${mem.pattern}」升级为「${upgraded.status}」。`;
      } else {
        if (!patternSet().has(normalizePattern(item.pattern))) await saveMemories([item.memory, ...state.growth.memories]);
        state.growth.notice = '已记录该记忆候选。';
      }
      state.growth.pending = state.growth.pending.filter(p => p.pid !== pid);
    } catch (error) { setError(error); }
    maybeRefresh();
  }
  function dropPending(pid) {
    state.growth.pending = state.growth.pending.filter(p => p.pid !== pid);
    state.growth.notice = '已丢弃该候选（未写入本机）。';
    maybeRefresh();
  }

  async function updateMode(mode) {
    clearMessages();
    try {
      await saveSettingsMode(mode);
      if (mode !== 'confirm') state.growth.pending = [];
      state.growth.notice = `记录方式已改为「${MODES.find(m => m.value === mode)?.label || mode}」。`;
    } catch (error) { setError(error); }
    maybeRefresh();
  }

  // ---------------------------------------------------------------- 收藏（既有数据，只读展示）
  let cardsLoading = false;
  async function loadCards() {
    if (cardsLoading) return;
    cardsLoading = true;
    try {
      state.cards = await send('LIST_CARDS');
      state.growth.cardsLoaded = true;
      maybeRefresh(); // 首帧可能还没拿到旧收藏，载入后补一次渲染
    } catch (error) { setError(error); }
    finally { cardsLoading = false; }
  }
  function bootstrap() {
    if (!state.growth.storeLoaded && !state.growth.loading) {
      state.growth.loading = true;
      ensureStore().catch(() => {}).finally(() => { state.growth.loading = false; maybeRefresh(); });
    }
    if (!state.growth.cardsLoaded) loadCards();
  }

  // ---------------------------------------------------------------- 渲染
  const time = at => fmtTime(at);
  const haystack = (...parts) => parts.filter(Boolean).join(' ').toLowerCase().slice(0, 500);

  function statusLabel(mem) {
    if (mem.active === false) return '已关闭';
    return STATUSES.includes(mem.status) ? mem.status : '待练';
  }

  function memoryHTML(mem) {
    const editing = state.growth.editId === mem.id;
    const confirming = state.growth.confirmDel?.kind === 'memory' && state.growth.confirmDel.id === mem.id;
    const examples = Array.isArray(mem.examples) ? mem.examples : [];
    const evidence = Array.isArray(mem.evidence) ? mem.evidence : [];
    const search = haystack(mem.pattern, mem.explanation, mem.suggestion, statusLabel(mem), ...examples.map(e => e.excerpt));
    // 列表只展示前 600 字（长说明在编辑框里看全文），避免超长条目拖垮侧栏。
    const explanationView = String(mem.explanation || '').length > 600 ? `${String(mem.explanation).slice(0, 600)}……（全文见编辑）` : mem.explanation;
    return `<article class="bx-saved-card bx-growth-item bx-growth-memory" data-id="${esc(mem.id)}" data-search="${esc(search)}" style="${mem.active === false ? 'opacity:.62' : ''}">
      <span>${esc(statusLabel(mem))}</span><span>${mem.source === 'workbench' ? '工作台草稿' : '亲写稿件'}</span><span>创建于 ${esc(time(mem.createdAt))}</span>
      <p><b>${esc(mem.pattern)}</b></p>
      <p>${esc(explanationView)}</p>
      ${mem.suggestion ? `<p class="bx-subtle">正确方向：${esc(mem.suggestion)}</p>` : ''}
      ${examples.length ? `<details class="bx-reference"><summary>出现过的稿件（${examples.length}）</summary>${examples.map(ex => `<p>${esc(ex.excerpt)}<br><small>${esc(time(ex.at))} · ${esc(contextLabel(ex.context))}</small></p>`).join('')}</details>` : ''}
      <details class="bx-reference"><summary>升级证据（${evidence.length}）</summary>${evidence.length ? evidence.map(ev => `<p>${esc(ev.reason)}<br><small>来自 ${esc(contextLabel(ev.context))} 的亲写稿件 · ${esc(time(ev.at))} · ${esc(ev.excerpt || '')}</small></p>`).join('') : '<p class="bx-subtle">还没有相关后续证据。</p>'}</details>
      <div class="bx-actions bx-actions-tight">
        <button data-growth-act="edit" data-id="${esc(mem.id)}">编辑</button>
        <button data-growth-act="toggle" data-id="${esc(mem.id)}">${mem.active === false ? '启用' : '关闭'}</button>
        <button data-growth-act="del" data-id="${esc(mem.id)}">${confirming ? '确认删除' : '删除'}</button>
        ${confirming ? '<button data-growth-act="cancel-del">取消</button>' : ''}
      </div>
      ${editing ? `<div class="bx-insert-confirm"><label class="bx-label" for="bx-growth-edit-pattern">错误名称</label><input id="bx-growth-edit-pattern" value="${esc(state.growth.edit?.pattern || '')}"><label class="bx-label" for="bx-growth-edit-explanation">中文说明</label><textarea id="bx-growth-edit-explanation">${esc(state.growth.edit?.explanation || '')}</textarea><label class="bx-label" for="bx-growth-edit-suggestion">正确方向（可选）</label><input id="bx-growth-edit-suggestion" value="${esc(state.growth.edit?.suggestion || '')}"><div class="bx-actions bx-actions-tight"><button class="bx-primary" data-growth-act="save-edit" data-id="${esc(mem.id)}">保存修改</button><button data-growth-act="cancel-edit">取消</button></div></div>` : ''}
    </article>`;
  }

  function pendingHTML(item) {
    const isUp = item.kind === 'upgrade';
    return `<article class="bx-saved-card bx-growth-item bx-growth-pending-item" data-pending="${esc(item.pattern)}" data-search="${esc(haystack(item.pattern, item.explanation, item.reason, item.excerpt))}">
      <span>${isUp ? '状态升级候选' : '新记忆候选'}</span>${isUp ? `<span>目标：${esc(item.nextStatus || '')}</span>` : ''}
      <p><b>${esc(item.pattern)}</b></p>
      <p>${esc(item.explanation || item.reason || '')}</p>
      <small>稿件（${esc(time(item.at))} · ${esc(contextLabel(item.context))}）：${esc(item.excerpt || '')}</small>
      <div class="bx-actions bx-actions-tight">
        <button class="bx-primary" data-growth-act="accept" data-id="${esc(item.pid)}">${isUp ? '确认升级' : '确认记录'}</button>
        <button data-growth-act="drop" data-id="${esc(item.pid)}">丢弃</button>
      </div>
    </article>`;
  }

  function phraseHTML(phrase) {
    const confirming = state.growth.confirmDel?.kind === 'phrase' && state.growth.confirmDel.id === phrase.id;
    return `<article class="bx-saved-card bx-growth-item bx-growth-phrase" data-id="${esc(phrase.id)}" data-search="${esc(haystack(phrase.text, phrase.source, phrase.translation, phrase.note))}">
      <span>我的句子</span><span>${esc(time(phrase.createdAt))}</span>
      <p>${esc(phrase.text)}</p>
      ${phrase.translation ? `<p class="bx-subtle">译文：${esc(phrase.translation)}</p>` : ''}
      ${phrase.source ? `<small>出处：${esc(phrase.source)}</small>` : ''}
      ${phrase.note ? `<small>备注：${esc(phrase.note)}</small>` : ''}
      <div class="bx-actions bx-actions-tight">
        <button data-growth-act="phrase-del" data-id="${esc(phrase.id)}">${confirming ? '确认删除' : '删除'}</button>
        ${confirming ? '<button data-growth-act="cancel-del">取消</button>' : ''}
      </div>
    </article>`;
  }

  function cardHTML(card) {
    const kindLabel = card.kind === 'word' ? '词语' : card.kind === 'structure' ? '结构' : '句子';
    return `<article class="bx-saved-card bx-growth-item" data-id="${esc(card.id || '')}" data-search="${esc(haystack(card.text, card.note, kindLabel))}">
      <span>既有 · ${kindLabel}</span><p>${esc(card.text)}</p>${card.note ? `<small>${esc(card.note)}</small>` : ''}${card.url ? `<a href="${esc(card.url)}" target="_blank" rel="noopener noreferrer">回到原帖 ↗</a>` : ''}</article>`;
  }

  function renderGrowth(container) {
    bootstrap();
    const g = state.growth;
    const counts = STATUSES.map(s => `${s} ${g.memories.filter(m => m.active !== false && m.status === s).length}`).join(' · ');
    const closed = g.memories.filter(m => m.active === false).length;
    const status = g.busy
      ? '<div class="bx-status bx-loading"><span class="bx-spinner"></span>正在归纳草稿……</div>'
      : g.error ? `<div class="bx-status bx-error" role="alert">${esc(g.error)}</div>`
        : g.notice ? `<div class="bx-status bx-ok" role="status">${esc(g.notice)}</div>` : '';
    container.innerHTML = `<section class="bx-section">
      <div class="bx-kicker">成长记忆与表达</div>
      <h2>重复错误与可复用表达</h2>
      <p class="bx-subtle">只从你亲手写的稿件归纳；AI 代写不算掌握。数据只保存在本机，不上传、不同步。</p>
      <label class="bx-label" for="bx-growth-mode">记录方式</label>
      <select id="bx-growth-mode">${MODES.map(m => `<option value="${m.value}" ${g.settings.mode === m.value ? 'selected' : ''}>${m.label}</option>`).join('')}</select>
      ${status}
      ${g.pending.length ? `<div class="bx-candidate" id="bx-growth-pending-list"><div class="bx-result-title">待确认 <small>「确认后记录」下需要你确认才写入本机</small></div>${g.pending.map(pendingHTML).join('')}</div>` : ''}
      <div class="bx-result-title">学习记忆 <small>${g.memories.length} 条 · ${counts}${closed ? ` · 已关闭 ${closed}` : ''}</small></div>
      <label class="bx-label" for="bx-growth-search">关键词搜索（记忆 / 句子 / 收藏）</label>
      <input id="bx-growth-search" placeholder="例如：时态、agree、比喻" value="${esc(g.search)}">
      <div id="bx-growth-memories">${g.memories.length ? g.memories.map(memoryHTML).join('') : '<div class="bx-empty">还没有学习记忆。写一条回复或练习后点「检查」，这里会自动归纳你真实出现的重复错误。</div>'}</div>

      <div class="bx-result-title">我的句子 <small>${g.phrases.length} 条</small></div>
      <p class="bx-subtle">随手保存可复用的句子；出处、译文、备注都可不填。</p>
      <label class="bx-label" for="bx-growth-phrase-text">句子（必填）</label>
      <textarea id="bx-growth-phrase-text" placeholder="Break the ice">${esc(g.form.text)}</textarea>
      <div class="bx-two">
        <div class="bx-field"><label for="bx-growth-phrase-source">出处（可选）</label><input id="bx-growth-phrase-source" value="${esc(g.form.source)}" placeholder="帖子 / 书 / 原句链接"></div>
        <div class="bx-field"><label for="bx-growth-phrase-trans">译文（可选）</label><input id="bx-growth-phrase-trans" value="${esc(g.form.translation)}" placeholder="中文意思"></div>
      </div>
      <div class="bx-field"><label for="bx-growth-phrase-note">备注（可选）</label><input id="bx-growth-phrase-note" value="${esc(g.form.note)}" placeholder="什么时候用"></div>
      <div class="bx-actions">
        <button class="bx-primary" id="bx-growth-phrase-save" ${g.busy ? 'disabled' : ''}>保存句子</button>
        <button id="bx-growth-export">导出 JSON</button>
        <button id="bx-growth-scan" ${g.busy ? 'disabled' : ''}>归纳工作台草稿</button>
      </div>
      <div id="bx-growth-phrases">${g.phrases.length ? g.phrases.map(phraseHTML).join('') : '<div class="bx-empty">还没有保存句子。</div>'}</div>

      <div class="bx-result-title">既有收藏 <small>「存下表达」存的旧数据，保持原样只读展示</small></div>
      <div id="bx-growth-cards">${(state.cards || []).length ? (state.cards || []).map(cardHTML).join('') : '<div class="bx-empty">还没有既有收藏。</div>'}</div>
      ${statusHTML()}
    </section>`;

    const modeSelect = container.querySelector('#bx-growth-mode');
    if (modeSelect) modeSelect.onchange = event => updateMode(event.target.value);
    const search = container.querySelector('#bx-growth-search');
    if (search) search.oninput = event => { state.growth.search = event.target.value; applyFilter(container); };
    const bind = (id, field) => {
      const el = container.querySelector(id);
      // 输入只同步到 state，不在输入时截断（超限在保存时给明确中文错误）。
      if (el) el.oninput = event => { state.growth.form = { ...state.growth.form, [field]: event.target.value }; };
    };
    bind('#bx-growth-phrase-text', 'text');
    bind('#bx-growth-phrase-source', 'source');
    bind('#bx-growth-phrase-trans', 'translation');
    bind('#bx-growth-phrase-note', 'note');
    container.querySelector('#bx-growth-phrase-save')?.addEventListener('click', savePhrase);
    container.querySelector('#bx-growth-export')?.addEventListener('click', exportAll);
    container.querySelector('#bx-growth-scan')?.addEventListener('click', scanWorkbench);
    const editBind = (id, field) => {
      const el = container.querySelector(id);
      if (el) el.oninput = event => { if (state.growth.edit) state.growth.edit = { ...state.growth.edit, [field]: event.target.value }; };
    };
    editBind('#bx-growth-edit-pattern', 'pattern');
    editBind('#bx-growth-edit-explanation', 'explanation');
    editBind('#bx-growth-edit-suggestion', 'suggestion');

    if (!g.wired) {
      g.wired = true;
      container.addEventListener('click', event => {
        const button = event.target.closest?.('[data-growth-act]');
        if (!button || !container.contains(button)) return;
        const act = button.dataset.growthAct;
        const id = button.dataset.id;
        if (act === 'accept') acceptPending(id);
        else if (act === 'drop') dropPending(id);
        else if (act === 'edit') { state.growth.editId = id; state.growth.confirmDel = null; const mem = state.growth.memories.find(m => m.id === id); state.growth.edit = mem ? { pattern: mem.pattern, explanation: mem.explanation, suggestion: mem.suggestion || '' } : null; clearMessages(); BX.refresh(); }
        else if (act === 'cancel-edit') { state.growth.editId = ''; state.growth.edit = null; BX.refresh(); }
        else if (act === 'save-edit') saveEdit(id);
        else if (act === 'toggle') toggleMemory(id);
        else if (act === 'del') {
          if (state.growth.confirmDel?.kind === 'memory' && state.growth.confirmDel.id === id) deleteMemory(id);
          else { state.growth.confirmDel = { kind: 'memory', id }; BX.refresh(); }
        } else if (act === 'phrase-del') {
          if (state.growth.confirmDel?.kind === 'phrase' && state.growth.confirmDel.id === id) deletePhrase(id);
          else { state.growth.confirmDel = { kind: 'phrase', id }; BX.refresh(); }
        } else if (act === 'cancel-del') { state.growth.confirmDel = null; BX.refresh(); }
      });
    }
    applyFilter(container);
  }

  function applyFilter(container) {
    const query = String(state.growth.search || '').trim().toLowerCase();
    container.querySelectorAll('.bx-growth-item').forEach(el => {
      const hit = !query || String(el.dataset.search || '').includes(query);
      el.style.display = hit ? '' : 'none';
    });
  }

  register({
    id: 'growth',
    label: '成长',
    order: 40,
    init() { bootstrap(); },
    render(container) { renderGrowth(container); },
    onPost() { /* 成长记忆与具体帖子无关，切帖不清理 */ }
  });
})();
