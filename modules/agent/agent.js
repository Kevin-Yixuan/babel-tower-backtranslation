// Pi Agent 侧栏页签：本机 Pi 桥接对话。回复插入仍由 reply.js 负责，Agent 结果只能由用户采纳。
(() => {
  const BX = window.BX;
  const { state, esc, send } = BX;
  let sessionId = '', messages = [], prompt = '', selected = {}, loading = 0, pending = '';
  let runtime = { checking: false, ready: false, label: '', detail: '', checkedAt: 0 };
  const key = () => 'x:' + (window.BXContext.key(state.post?.url || '') || 'scratch');
  const CONTEXTS = [['post', '当前帖子', () => state.post?.text || ''], ['selection', '划选文字', () => state.selected || ''], ['draft', '回复草稿', () => state.draft || '']];
  const QUICK = [
    { label: '讲讲这条帖子', context: 'post', text: '用中文解释这条帖子在说什么、语气如何，以及有哪些值得注意的文化或语言细节。' },
    { label: '帮我想回复', context: 'post', text: '给我 3 个回复这条帖子的不同角度，每个角度附一句目标语言示例。不要替我编造经历。' },
    { label: '润色我的草稿', context: 'draft', text: '润色我的回复草稿，让它更地道自然，保留原意；先给改后的完整文本，再用中文简要说明改了什么。' },
    { label: '学几个表达', context: 'post', text: '从这条帖子里挑 3 个值得学习的地道表达，解释含义并各给一个新例句。' }
  ];

  async function checkRuntime(force = false) {
    if (runtime.checking || (!force && Date.now() - runtime.checkedAt < 30000)) return;
    runtime = { ...runtime, checking: true };
    if (state.mode === 'agent') BX.refresh();
    try {
      const result = await send('AGENT_STATUS');
      runtime = { checking: false, ready: Boolean(result?.ready), label: result?.label || '', detail: result?.detail || '', checkedAt: Date.now() };
    } catch (error) {
      runtime = { checking: false, ready: false, label: 'Pi 未连接', detail: error.message, checkedAt: Date.now() };
    }
    if (state.mode === 'agent') BX.refresh();
  }

  async function restore() {
    const seq = ++loading;
    const next = key();
    // 切帖才清空输入；首次打开保留「交给 Pi」预填的指令与材料。
    if (sessionId && next !== sessionId) { prompt = ''; selected = {}; pending = ''; }
    sessionId = next; messages = [];
    try {
      const rows = await send('LIST_AGENT_SESSIONS');
      if (seq !== loading) return;
      messages = rows.find(x => x.id === sessionId)?.messages || [];
      if (state.mode === 'agent') BX.refresh();
    } catch (error) { if (seq === loading) { state.error = error.message; BX.refresh(); } }
  }

  // 回复页「交给 Pi」：带上草稿并预填指令，用户确认后才发送。
  BX.on('agent-prefill', ({ text = '', context = [] } = {}) => {
    prompt = text;
    for (const id of context) selected[id] = true;
    BX.open('agent');
  });

  const runtimeHTML = () => {
    const status = runtime.checking ? 'checking' : runtime.ready ? 'ready' : 'offline';
    const label = runtime.checking ? '正在寻找 Pi…' : runtime.label || 'Pi 未连接';
    const detail = runtime.checking ? '检测本机桥接服务' : runtime.detail || '';
    return `<div class="bx-agent-runtime bx-agent-${status}" role="status"><span class="bx-agent-dot" aria-hidden="true"></span><span class="bx-agent-runtime-text"><b>${esc(label)}</b>${detail ? `<small>${esc(detail)}</small>` : ''}</span><button type="button" id="bx-agent-refresh" ${runtime.checking ? 'disabled' : ''} aria-label="重新检测 Pi">重新检测</button></div>`;
  };
  const setupHTML = () => runtime.ready || runtime.checking || !runtime.checkedAt ? '' : `<div class="bx-agent-setup"><b>三步连接 Pi</b><ol><li>在本机安装并配置 <a href="https://pi.dev/docs/latest/cli" target="_blank" rel="noopener">Pi</a></li><li>在插件目录运行 <code>node pi-bridge/server.mjs</code></li><li>把窗口里的令牌填进设置，点「授权并检测」</li></ol><button type="button" class="bx-primary" id="bx-agent-settings">去设置连接</button></div>`;
  const bubble = (m, index, last) => {
    const mine = m.role !== 'assistant';
    const labels = mine && Array.isArray(m.contextLabels) && m.contextLabels.length ? `<span class="bx-agent-tags">${m.contextLabels.map(label => `<i>${esc(label)}</i>`).join('')}</span>` : '';
    const actions = mine ? '' : last
      ? `<div class="bx-agent-msg-actions"><button type="button" id="bx-agent-use">用作回复草稿</button><button type="button" id="bx-agent-document">存为文稿</button><button type="button" data-agent-copy="${index}">复制</button></div>`
      : `<div class="bx-agent-msg-actions"><button type="button" data-agent-copy="${index}">复制</button></div>`;
    return `<div class="bx-agent-row ${mine ? 'bx-agent-mine' : 'bx-agent-pi'}">${mine ? '' : '<span class="bx-pi-avatar" aria-hidden="true">π</span>'}<article class="bx-agent-bubble" aria-label="${mine ? '你' : 'Pi'}">${labels}<div class="bx-agent-text">${esc(m.content)}</div>${actions}</article></div>`;
  };

  function render(body) {
    if (!runtime.checkedAt && !runtime.checking) queueMicrotask(() => checkRuntime());
    const shown = messages.slice(-10);
    const offset = messages.length - shown.length;
    const lastAssistant = messages.map(m => m.role).lastIndexOf('assistant');
    const thinking = state.busy && pending;
    const thread = shown.length || thinking
      ? shown.map((m, i) => bubble(m, offset + i, offset + i === lastAssistant && !thinking)).join('')
        + (thinking ? `${bubble({ role: 'user', content: pending }, -1, false)}<div class="bx-agent-row bx-agent-pi"><span class="bx-pi-avatar" aria-hidden="true">π</span><div class="bx-agent-bubble bx-agent-typing" aria-label="Pi 正在思考"><span></span><span></span><span></span></div></div>` : '')
      : `<div class="bx-agent-empty"><span class="bx-pi-avatar bx-pi-big" aria-hidden="true">π</span><b>嗨，我是 Pi！</b><span>勾选要给我看的材料，再选一个任务或直接告诉我你想做什么。</span></div>`;
    body.innerHTML = `<section class="bx-section bx-agent">
      <div class="bx-agent-hero"><span class="bx-pi-avatar bx-pi-big" aria-hidden="true">π</span><div><div class="bx-kicker">Pi Agent · 本机运行</div><h2>和 Pi 一起想清楚</h2><p class="bx-subtle">只发送你勾选的材料和本会话历史。结果由你采纳，不会自动发布。</p></div></div>
      ${runtimeHTML()}${setupHTML()}
      <div class="bx-agent-chips" role="group" aria-label="发送给 Pi 的材料">${CONTEXTS.map(([id, label, value]) => `<label class="bx-chip ${selected[id] ? 'bx-chip-on' : ''}"><input type="checkbox" data-agent-context="${id}" ${selected[id] ? 'checked' : ''}><span>${label}</span>${value() ? '' : '<small>空</small>'}</label>`).join('')}</div>
      <div class="bx-agent-thread" aria-live="polite">${thread}</div>
      <div class="bx-agent-quick" role="group" aria-label="快捷任务">${QUICK.map((q, i) => `<button type="button" data-agent-quick="${i}" ${state.busy ? 'disabled' : ''}>${q.label}</button>`).join('')}</div>
      <div class="bx-agent-composer"><textarea id="bx-agent-prompt" placeholder="告诉 Pi 你想做什么…（Ctrl+Enter 发送）">${esc(prompt)}</textarea><button type="button" class="bx-primary" id="bx-agent-send" ${state.busy || !prompt.trim() ? 'disabled' : ''}>发送</button></div>
      ${BX.statusHTML()}
      <div class="bx-agent-foot"><button type="button" id="bx-agent-desk">全屏写作台 ↗</button><button type="button" id="bx-agent-reset" ${state.busy || !messages.length ? 'disabled' : ''}>新会话</button><button type="button" id="bx-agent-open-settings">Pi 设置</button></div>
    </section>`;
    const threadEl = body.querySelector('.bx-agent-thread');
    threadEl.scrollTop = threadEl.scrollHeight;
    const promptEl = body.querySelector('#bx-agent-prompt');
    const sendEl = body.querySelector('#bx-agent-send');
    promptEl.oninput = e => { prompt = e.target.value; sendEl.disabled = state.busy || !prompt.trim(); };
    promptEl.onkeydown = e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.isComposing && !sendEl.disabled) { e.preventDefault(); submit(); } };
    body.querySelectorAll('[data-agent-context]').forEach(el => el.onchange = () => { selected[el.dataset.agentContext] = el.checked; el.closest('.bx-chip')?.classList.toggle('bx-chip-on', el.checked); });
    body.querySelectorAll('[data-agent-quick]').forEach(el => el.onclick = () => {
      const quick = QUICK[Number(el.dataset.agentQuick)];
      prompt = quick.text; selected[quick.context] = true; BX.refresh();
      body.querySelector('#bx-agent-prompt')?.focus();
    });
    body.querySelectorAll('[data-agent-copy]').forEach(el => el.onclick = async () => {
      try { await navigator.clipboard.writeText(messages[Number(el.dataset.agentCopy)]?.content || ''); state.notice = '已复制 Pi 的回复。'; state.error = ''; }
      catch { state.error = '复制失败，请手动选中文字复制。'; }
      BX.refresh();
    });
    body.querySelector('#bx-agent-refresh').onclick = () => checkRuntime(true);
    body.querySelector('#bx-agent-settings')?.addEventListener('click', () => send('OPEN_SETTINGS'));
    body.querySelector('#bx-agent-open-settings').onclick = () => send('OPEN_SETTINGS');
    body.querySelector('#bx-agent-desk').onclick = () => send('OPEN_WRITE_DESK');
    sendEl.onclick = submit;
    body.querySelector('#bx-agent-reset').onclick = () => BX.busy(async seq => {
      if (!confirm('清除本会话记录？回复草稿保持不变。')) return;
      await send('RESET_AGENT_SESSION', { sessionId });
      if (seq === state.reqSeq) { messages = []; prompt = ''; }
    });
    const answer = messages[lastAssistant]?.content || '';
    body.querySelector('#bx-agent-use')?.addEventListener('click', () => {
      if (state.draft && !confirm('用 Pi 的结果替换当前回复草稿？')) return;
      state.draft = answer; state.reply = { ...(state.reply || {}), origin: 'ai', result: null }; state.draftPostUrl = state.post?.url || ''; BX.open('write');
    });
    body.querySelector('#bx-agent-document')?.addEventListener('click', () => BX.busy(async () => {
      const doc = await send('SAVE_DOCUMENT', { payload: { title: '来自 X 的 Pi 文稿', content: answer } });
      await send('OPEN_WRITE_DESK', { id: doc.id });
    }));
  }

  function submit() {
    if (state.busy || !prompt.trim()) return;
    BX.busy(async seq => {
      const context = CONTEXTS.filter(([id, , value]) => selected[id] && value()).map(([, label, value]) => ({ label, content: value() }));
      const instruction = prompt, id = sessionId;
      pending = instruction; BX.refresh();
      try {
        const result = await send('AGENT_CHAT', { payload: { sessionId: id, message: instruction, context } });
        if (seq !== state.reqSeq || id !== sessionId) return;
        messages = result.session.messages;
        if (prompt === instruction) prompt = '';
        runtime = { ...runtime, ready: true, checkedAt: Date.now() };
      } finally { if (pending === instruction) pending = ''; }
    });
  }

  BX.register({ id: 'agent', label: 'Pi', order: 25, init: restore, onPost: restore, render });
})();
