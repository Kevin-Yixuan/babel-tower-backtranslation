// 侧栏骨架（integration 独占）：页签容器、模块注册表、共享状态、请求序号与 IME、事件总线。
// 页面结构与入口（帖子上的「翻译／回复」按钮、扫描、设置广播）在 content.js；
// 各功能以 BX.register() 挂载在 modules/ 下，协议见 SIDEBAR-PROTOCOL.md。
(() => {
  if (window.__bxSidebarLoaded) return;
  window.__bxSidebarLoaded = true;

  // ---- 共享状态（字段归属见协议 §2；新字段必须带模块前缀） ----
  const state = {
    mode: 'read', post: null, selected: '', editor: null, busy: false, error: '', notice: '',
    dictionary: null, explanation: '', practice: null, practiceAnswer: '', practiceFeedback: null,
    revision: '', revisionFeedback: null, idea: '', draft: '', draftNote: '', replyFeedback: null,
    target: '英语', tone: '自然', cards: [], settings: null, insertConfirm: false,
    binding: null, reqSeq: 0, draftCandidate: null, draftPostUrl: '', composing: false, pendingRender: false
  };

  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  const send = (action, payload = {}) => new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ action, ...payload }, response => {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response?.ok) { const error = new Error(response?.error || '插件暂时无法完成此操作。'); error.code = response?.code || ''; reject(error); }
      resolve(response.data);
    });
  });
  // 审计 W06：送模型的原始材料不得静默截断；超限由 ensureMaterialLimit / background 明确报错。
  const getTweetText = article => (article?.querySelector('[data-testid="tweetText"]')?.innerText || article?.innerText || '').trim();
  const postFrom = article => {
    if (!article) return { text: '', author: '', url: location.href };
    const permalink = [...article.querySelectorAll('a[href*="/status/"]')].find(a => /\/status\/\d+/.test(a.getAttribute('href') || ''));
    return {
      text: getTweetText(article),
      author: (article.querySelector('[data-testid="User-Name"]')?.innerText || '').split('\n')[0].slice(0, 80),
      url: permalink ? new URL(permalink.getAttribute('href'), location.origin).href : location.href
    };
  };
  const longArticleOnPage = () => {
    const node = document.querySelector('[data-testid="longformRichTextComponent"], [data-testid="articleBody"], [data-testid="article-content"]');
    const text = node?.innerText?.trim() || '';
    return text ? { text, author: document.querySelector('main h1')?.innerText?.slice(0, 80) || 'X 文章', url: location.href } : null;
  };
  const isEditor = node => node?.matches?.('[contenteditable="true"][role="textbox"], [data-testid="tweetTextarea_0"]');
  const EDITOR_SELECTOR = '[data-testid="tweetTextarea_0"][contenteditable="true"], [contenteditable="true"][role="textbox"]';
  const MAX_MATERIAL = 20000;
  const visibleInPage = el => Boolean(el?.isConnected && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));
  const visibleEditors = () => [...document.querySelectorAll(EDITOR_SELECTOR)].filter(visibleInPage);
  function ensureMaterialLimit(value, label) {
    const text = String(value ?? '');
    if (text.length > MAX_MATERIAL) throw new Error(`${label}共 ${text.length} 字符，超过上限 ${MAX_MATERIAL} 字符。当前没有自动分段，请选择较短的段落或拆分后再试；插件不会静默截断。`);
    return text;
  }

  // ---- 侧栏 DOM ----
  const sidebar = document.createElement('aside');
  sidebar.id = 'bx-sidebar';
  sidebar.setAttribute('aria-label', '巴别塔（回译）工作台');
  sidebar.innerHTML = `<div class="bx-head"><div class="bx-brand"><span class="bx-mark">回</span><span>巴别塔（回译）<small>在这里读懂，也在这里表达</small></span></div><button id="bx-close" aria-label="关闭侧栏">×</button></div><div class="bx-tabs"></div><div id="bx-body"></div><div class="bx-foot">打开翻译页会自动调用所选模型，可能消耗额度；插件不会自动发布。</div>`;
  document.documentElement.appendChild(sidebar);
  const body = sidebar.querySelector('#bx-body');
  const tabsEl = sidebar.querySelector('.bx-tabs');
  sidebar.querySelector('#bx-close').onclick = () => close();
  body.addEventListener('click', event => { if (event.target?.id === 'bx-cancel-request') cancel(); });
  sidebar.addEventListener('compositionstart', event => { if (event.target?.matches?.('textarea, input')) { state.composing = true; state.pendingRender = false; } });
  sidebar.addEventListener('compositionend', event => { if (event.target?.matches?.('textarea, input')) { state.composing = false; if (state.pendingRender) { state.pendingRender = false; refresh(); } } });
  tabsEl.addEventListener('click', event => {
    const button = event.target?.closest?.('[data-bx-mode]');
    if (!button) return;
    activeId = button.dataset.bxMode;
    state.mode = activeId; // 协议 §2：state.mode 由骨架管理 = 当前页签 id
    refresh();
  });

  const handle = document.createElement('button');
  handle.id = 'bx-sidebar-handle';
  handle.type = 'button';
  handle.textContent = '巴别塔';
  handle.title = '打开巴别塔（回译）侧栏';
  handle.onclick = () => open();
  document.documentElement.appendChild(handle);

  // ---- 模块注册表 ----
  const registry = [];
  const listeners = Object.create(null);
  let activeId = 'read';
  let isOpen = false;

  function register(mod) {
    if (!mod?.id || typeof mod.render !== 'function') throw new Error('模块接口无效：需要 id 与 render(container)。');
    if (registry.some(m => m.id === mod.id)) throw new Error(`模块重复注册：${mod.id}`);
    registry.push(mod);
    registry.sort((a, b) => (a.order || 0) - (b.order || 0));
    renderTabs();
  }
  function renderTabs() {
    tabsEl.innerHTML = registry.map(mod => `<button type="button" data-bx-mode="${esc(mod.id)}" class="${mod.id === activeId ? 'bx-active' : ''}">${esc(mod.label || mod.id)}</button>`).join('');
  }
  const activeModule = () => registry.find(mod => mod.id === activeId) || registry[0];

  function open(tabId) {
    if (tabId) activeId = tabId;
    if (!registry.some(mod => mod.id === activeId)) activeId = registry[0]?.id || '';
    state.mode = activeId; // 协议 §2：state.mode 由骨架管理
    isOpen = true;
    sidebar.classList.add('bx-open');
    document.documentElement.classList.add('bx-sidebar-on');
    refresh();
  }
  function close() {
    isOpen = false;
    sidebar.classList.remove('bx-open');
    document.documentElement.classList.remove('bx-sidebar-on');
  }
  function refresh() {
    // IME 组合输入期间不重建正在输入的编辑框（审计验收），推迟到 compositionend。
    if (state.composing) { state.pendingRender = true; return; }
    const mod = activeModule();
    if (!mod) return;
    if (!mod.__inited) { mod.__inited = true; try { mod.init?.(); } catch (error) { console.error('[bx] init', mod.id, error); } }
    renderTabs();
    const focusId = document.activeElement?.id && sidebar.contains(document.activeElement) ? document.activeElement.id : '';
    const caret = focusId && document.activeElement.selectionStart != null ? document.activeElement.selectionStart : null;
    try { mod.render(body); } catch (error) {
      body.innerHTML = `<section class="bx-section"><div class="bx-status bx-error" role="alert">${esc(error.message || '模块渲染失败。')}</div></section>`;
    }
    if (focusId) {
      const el = body.querySelector(`#${focusId}`);
      if (el && typeof el.focus === 'function') {
        el.focus();
        if (caret != null && el.setSelectionRange) { try { el.setSelectionRange(caret, caret); } catch { /* type without selection */ } }
      }
    }
  }

  // ---- 请求序号：取消/切帖后旧序号的结果一律丢弃，绝不覆盖新输入 ----
  async function busy(work) {
    if (state.busy) return;
    const seq = ++state.reqSeq;
    state.busy = true; state.error = ''; state.notice = ''; state.insertConfirm = false; refresh();
    try { await work(seq); } catch (error) { if (seq === state.reqSeq) state.error = error.message || '请求失败，请重试。'; }
    if (seq === state.reqSeq) { state.busy = false; refresh(); }
  }
  function cancel() {
    state.reqSeq++;
    state.busy = false;
    state.notice = '已取消等待；晚到的结果会被忽略，不会覆盖你的输入。';
    refresh();
  }
  function statusHTML() {
    if (state.busy) return `<div class="bx-status bx-loading"><span class="bx-spinner"></span>正在处理……原草稿会保留，等待期间可继续编辑。<button type="button" id="bx-cancel-request">取消等待</button></div>`;
    if (state.error) return `<div class="bx-status bx-error" role="alert">${esc(state.error)}</div>`;
    if (state.notice) return `<div class="bx-status bx-ok" role="status">${esc(state.notice)}</div>`;
    return '';
  }

  // 分层反馈：意思 / 语法 / 润色 三个独立区块，不合并成一段。
  function feedbackHTML(data) {
    const points = Array.isArray(data.points) ? data.points.slice(0, 3) : [];
    const meaningNote = data.meaningNote || data.summary || '';
    const grammarNote = data.grammarNote || (data.grammarOk ? '' : '');
    return `<div class="bx-feedback">
      <div class="bx-layer bx-layer-meaning"><div class="bx-layer-title"><span class="bx-layer-index">1</span>意思是否传达</div><p>${data.meaningOk ? '✅ 意思已传达' : '⚠️ 意思需要核对'}${meaningNote ? `：${esc(meaningNote)}` : ''}</p></div>
      <div class="bx-layer bx-layer-grammar"><div class="bx-layer-title"><span class="bx-layer-index">2</span>语法问题</div><p>${data.grammarOk ? '✅ 语法成立' : '⚠️ 语法需要修改'}${grammarNote ? `：${esc(grammarNote)}` : ''}</p></div>
      <div class="bx-layer bx-layer-polish"><div class="bx-layer-title"><span class="bx-layer-index">3</span>表达润色</div>${points.length ? points.map(item => `<div class="bx-feedback-item"><span class="bx-kind bx-${esc(item.kind)}">${item.kind === 'fix' ? '需要修正' : item.kind === 'polish' ? '可以优化' : '值得保留'}</span><b>${esc(item.span)}</b><p>${esc(item.reason)}</p><small>${esc(item.direction)}</small></div>`).join('') : '<p class="bx-subtle">没有需要润色的点。</p>'}</div>
      ${data.summary ? `<p class="bx-feedback-summary">总评：${esc(data.summary)}</p>` : ''}
    </div>`;
  }

  async function saveCard(text, kind, { author = '', url = '', note = '' } = {}) {
    const card = await send('SAVE_CARD', { payload: { text, kind, note, author, url } });
    emit('cards-changed', {});
    return card;
  }

  // ---- 回复对象（切帖语义） ----
  function openForPost(article, tabId) {
    const next = postFrom(article);
    const prev = state.post;
    const changed = state.post?.url !== next.url || state.post?.text !== next.text;
    if (changed) {
      // 切换帖子：作废在途请求与插入绑定，旧结果/旧稿不得落到新对象上（与旧 openArticle 语义一致）。
      state.reqSeq++;
      state.busy = false;
      state.post = next;
      for (const mod of registry) { try { mod.onPost?.(next, prev); } catch (error) { console.error('[bx] onPost', mod.id, error); } }
      emit('post-change', { post: next });
    } else {
      state.post = next;
    }
    state.error = '';
    open(tabId);
  }
  function setPost(post, { reset = false, force = false } = {}) {
    const prev = state.post;
    const changed = force || prev?.url !== post?.url || prev?.text !== post?.text;
    state.post = post;
    if (changed && reset) {
      state.reqSeq++;
      state.busy = false;
      state.editor = null;
      for (const mod of registry) { try { mod.onPost?.(post, prev); } catch (error) { console.error('[bx] onPost', mod.id, error); } }
      emit('post-change', { post });
    }
  }

  // ---- content.js 回调 ----
  function notifyArticle(article, meta) {
    for (const mod of registry) { try { mod.onArticle?.(article, meta); } catch (error) { console.error('[bx] onArticle', mod.id, error); } }
  }
  function notifyEditor(editor) {
    state.editor = editor;
    for (const mod of registry) { try { mod.onEditor?.(editor); } catch (error) { console.error('[bx] onEditor', mod.id, error); } }
  }
  function applySettings(settings) {
    state.settings = settings;
    if (settings.targetLanguage) state.target = settings.targetLanguage;
    for (const mod of registry) { try { mod.onSettings?.(settings); } catch (error) { console.error('[bx] onSettings', mod.id, error); } }
    emit('settings', settings);
  }

  // ---- 事件总线 ----
  function on(event, fn) {
    (listeners[event] || (listeners[event] = [])).push(fn);
    return () => { const list = listeners[event] || []; const i = list.indexOf(fn); if (i >= 0) list.splice(i, 1); };
  }
  function emit(event, payload) {
    for (const fn of listeners[event] || []) { try { fn(payload); } catch (error) { console.error('[bx] listener', event, error); } }
  }

  window.BX = Object.freeze({
    state, esc, send, element: sidebar,
    util: { esc, send, getTweetText, postFrom, longArticleOnPage, isEditor, visibleInPage, visibleEditors, ensureMaterialLimit },
    register, refresh, open, close, openForPost, setPost,
    busy, cancel, statusHTML, feedbackHTML, saveCard,
    notifyArticle, notifyEditor, applySettings, on, emit
  });
})();
