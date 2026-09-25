// 阅读模块（reading Agent；id=read，页签「翻译」）。
// 任务书 1：
//   1) 识别 X 帖子（article/[data-testid=tweetText]，经骨架 postFrom/getTweetText）与长文章正文
//      （ARTICLE_SELECTOR；观察 DOM 增长，段落动态出现时补译）；
//   2) 阅读 UI 只在 #bx-sidebar 内，与网页并排不遮挡；不引入任何遮挡网页的大面板；
//   3) 打开阅读（点帖内「翻译」入口 / 切到阅读页签）自动翻译成 state.target（设置 targetLanguage）：
//      AI 任务 TRANSLATE 注册在 modules/reading/reading-tasks.js，UI 经 send('AI', { task, payload })；
//      无密钥时错误原样展示。自动翻译延迟 AUTO_DELAY_MS 后发出且发出前复核阅读页签仍打开——
//      既有套件在 service worker 内 hold 模型请求并按序放行，离开阅读页签即放弃，避免抢占它们的请求队列；
//   4) 长文按段逐段翻译/展示，不 slice 静默截断：单段超 20,000 字符报明确中文错误（含实际长度与上限）；
//   5) 原文/译文逐段对照（.bx-pair 对）；
//   6) 划选单词（含半词）→ 自动补词界 → 松手即显示小释义浮窗（BX.send('LOOKUP')，本地词表→MDX→在线）；
//      选中句子 → state.selected + 打开阅读页签（与 #bx-selection-bar 选区条衔接）；
//      contenteditable 里划选一律忽略：不弹窗、不送侧栏、不抢焦点。
// 帖内入口按钮 .bx-inline-button / .bx-entry-reply 由 content.js 注入，本模块不新增、不改名、不复制。
(() => {
  const BX = window.BX;
  const { state, esc, send, statusHTML, util, register, refresh, open, setPost, busy: withBusy } = BX;
  const { postFrom, longArticleOnPage, ensureMaterialLimit } = util;

  const ARTICLE_SELECTOR = '[data-testid="longformRichTextComponent"], [data-testid="articleBody"], [data-testid="article-content"]';
  const TEXT_RANGE = '[data-testid="tweetText"], ' + ARTICLE_SELECTOR;
  const AUTO_DELAY_MS = 800; // 打开阅读后自动翻译的发出延迟（发出前复核页签，见 maybeStartAuto）

  // ---- 模块状态（协议：新字段一律带模块前缀）----
  let seqCounter = 0;
  const freshReading = () => ({
    kind: 'none',       // 'none' | 'post' | 'article'
    key: '',            // 当前来源指纹（含目标语言；换源/换目标 → 重建 units）
    units: [],          // [{ src, dst, status: pending|queued|done|error, error }]
    word: '',           // #bx-word 手输内容（重渲染不丢）
    seq: ++seqCounter,  // 在途翻译作废号（切帖/取消/换源 → 自增，旧结果一律丢弃）
    busy: false,        // 模块本地忙（不占用骨架全局 state.busy，避免挡住其他页签的请求）
    error: '',
    notice: ''
  });
  state.reading = freshReading();

  let readVisible = false;   // 阅读页签渲染过（观察器据此决定是否刷新）
  let autoAbandon = false;   // 本次阅读渲染后切到过其他页签 → 放弃本轮自动翻译
  let autoTimer = 0;
  const activeMode = () => BX.element.querySelector('.bx-tabs .bx-active')?.dataset?.bxMode || '';

  // ---- 模块自有样式（公共 CSS 不改；浮窗小尺寸，不遮挡大片网页）----
  const style = document.createElement('style');
  style.id = 'bx-reading-style';
  style.textContent = `
#bx-word-pop{position:fixed;z-index:2147483647;display:none;max-width:252px;max-height:180px;overflow:auto;background:#fff;border:1px solid #c7d3c9;border-radius:10px;box-shadow:0 10px 28px #0e2f2538;padding:10px 12px;font:13px/1.55 -apple-system,BlinkMacSystemFont,"Microsoft YaHei",sans-serif;color:#20392f}
#bx-word-pop.bx-show{display:block}
#bx-word-pop .bx-pop-word{font-weight:700;color:#17483a;font-size:14px;word-break:break-all}
#bx-word-pop .bx-pop-chinese{color:#224d36;font-size:15px;margin:5px 0 3px}
#bx-word-pop .bx-pop-meaning{margin:3px 0;font-size:12px;color:#33463d;word-break:break-all}
#bx-word-pop .bx-pop-src{margin:5px 0 0;font-size:11px;color:#7d887f}
#bx-word-pop .bx-pop-err{margin:5px 0 0;font-size:12px;color:#9b4e39}
#bx-sidebar .bx-trans{margin:2px 0 14px}
#bx-sidebar .bx-trans-head{display:flex;justify-content:space-between;align-items:baseline;gap:8px;font-size:12px;font-weight:700;color:#526d5d;margin:16px 0 8px}
#bx-sidebar .bx-trans-head small{font-weight:400;color:#7d8b81}
#bx-sidebar .bx-pair{border:1px solid #dce3d9;border-radius:10px;background:#fff;padding:12px 13px;margin:9px 0}
#bx-sidebar .bx-pair-label{font-size:10px;letter-spacing:1.2px;color:#7a8b80;margin:0 0 4px}
#bx-sidebar .bx-pair-src{margin:0 0 10px;padding:8px 10px;background:#f3f2e9;border-left:3px solid #c59e69;border-radius:0 6px 6px 0;white-space:pre-wrap;word-break:break-word;font-size:13px}
#bx-sidebar .bx-pair-dst{margin:0;white-space:pre-wrap;word-break:break-word;font-size:13px;color:#1c4234}
#bx-sidebar .bx-pair-dst.bx-fail{color:#9b4e39}
#bx-reading-cancel{margin-left:8px;border:1px solid #9dbbab;background:#fff;color:#1d4b38;border-radius:6px;padding:3px 9px;font-size:11px;cursor:pointer}`;
  document.documentElement.appendChild(style);

  // ---- 划选相关 DOM ----
  const selectionBar = document.createElement('div');
  selectionBar.id = 'bx-selection-bar';
  document.documentElement.appendChild(selectionBar);

  const wordPop = document.createElement('div');
  wordPop.id = 'bx-word-pop';
  wordPop.setAttribute('role', 'status');
  document.documentElement.appendChild(wordPop);
  let popToken = 0;

  function hideWordPop() {
    popToken++;
    wordPop.classList.remove('bx-show');
    wordPop.innerHTML = '';
    delete wordPop.dataset.word;
  }
  function placePop(rect) {
    const maxLeft = Math.max(8, window.innerWidth - (document.documentElement.classList.contains('bx-sidebar-on') ? 430 : 0) - 262);
    wordPop.style.left = `${Math.max(8, Math.min(maxLeft, rect.left || 8))}px`;
    wordPop.style.top = `${Math.max(8, Math.min(window.innerHeight - 70, (rect.bottom || 0) + 8))}px`;
  }
  function showWordPop(word, rect) {
    const token = ++popToken;
    wordPop.dataset.word = word;
    wordPop.innerHTML = `<div class="bx-pop-word">${esc(word)}</div><p class="bx-pop-src">查询中…</p>`;
    placePop(rect);
    wordPop.classList.add('bx-show');
    send('LOOKUP', { word }).then(data => {
      if (token !== popToken) return; // 已被新浮窗/关闭取代
      wordPop.innerHTML = `<div class="bx-pop-word">${esc(word)}</div>`
        + (data.chinese ? `<p class="bx-pop-chinese">${esc(data.chinese)}</p>` : '')
        + (data.meanings || []).slice(0, 2).map(item => `<p class="bx-pop-meaning">${item.partOfSpeech ? `<b>${esc(item.partOfSpeech)}</b> ` : ''}${esc(item.definition)}</p>`).join('')
        + `<p class="bx-pop-src">${esc(data.source || '')}</p>`;
    }).catch(error => {
      if (token !== popToken) return;
      // 错误原样展示（协议：无密钥/无结果等不改写文案）
      wordPop.innerHTML = `<div class="bx-pop-word">${esc(word)}</div><p class="bx-pop-err">${esc(error.message || '查词失败，请重试。')}</p>`;
    });
  }

  // 词界补全：选中单词的一部分（如 "writ"）时向两侧扩展到完整英文单词（如 "writing"）。
  function expandWord(selection) {
    if (selection.rangeCount !== 1) return null;
    const range = selection.getRangeAt(0);
    if (range.collapsed || range.startContainer !== range.endContainer) return null;
    const node = range.startContainer;
    if (node.nodeType !== 3) return null;
    const text = node.data;
    let s = range.startOffset;
    let e = range.endOffset;
    if (s >= e) return null;
    const slice = text.slice(s, e);
    if (/\s/.test(slice) || !/[A-Za-z]/.test(slice)) return null; // 含空白/非英文 → 按句子处理
    const isWordChar = ch => ch !== undefined && /[A-Za-z0-9'’-]/.test(ch);
    while (s > 0 && isWordChar(text[s - 1])) s--;
    while (e < text.length && isWordChar(text[e])) e++;
    const match = text.slice(s, e).match(/[A-Za-z][A-Za-z0-9'’-]*/);
    if (!match) return null;
    const word = match[0].replace(/[-']+$/, '');
    return word ? { word } : null;
  }

  function selectionRect(selection) {
    try {
      const rect = selection.getRangeAt(0).getBoundingClientRect();
      if (rect && (rect.width || rect.height)) return rect;
    } catch { /* fall through */ }
    const node = selection.anchorNode;
    const el = node?.nodeType === 3 ? node.parentElement : node;
    return el?.getBoundingClientRect?.() || { left: 24, bottom: 40 };
  }

  function showSelectionBar(rect) {
    const maxLeft = Math.max(8, window.innerWidth - (document.documentElement.classList.contains('bx-sidebar-on') ? 430 : 0) - 225);
    selectionBar.style.left = `${Math.max(8, Math.min(maxLeft, rect.left || 8))}px`;
    selectionBar.style.top = `${Math.max(8, Math.min(window.innerHeight - 60, (rect.bottom || 0) + 7))}px`;
    selectionBar.innerHTML = '<button data-select="lookup">查词</button><button data-select="explain">讲句</button><button data-select="save">收藏</button>';
    selectionBar.classList.add('bx-show');
  }

  function handleSelection() {
    const selection = document.getSelection();
    const raw = selection?.rangeCount ? selection.toString() : '';
    if (!raw.trim()) {
      hideWordPop();
      selectionBar.classList.remove('bx-show');
      return;
    }
    const anchor = selection.anchorNode;
    const el = anchor?.nodeType === 3 ? anchor.parentElement : anchor;
    const focus = selection.focusNode;
    const focusEl = focus?.nodeType === 3 ? focus.parentElement : focus;
    if (!el) return;
    // 任务书 ⑦：编辑框（含发帖框）里划选一律忽略——不弹词义浮窗、不送侧栏、不抢焦点。
    if (el.closest('[contenteditable], input, textarea, a, button, [role="link"]')
      || focusEl?.closest?.('[contenteditable], input, textarea, a, button, [role="link"]')) {
      hideWordPop();
      selectionBar.classList.remove('bx-show');
      return;
    }
    const container = el.closest(TEXT_RANGE);
    const range = selection.rangeCount === 1 ? selection.getRangeAt(0) : null;
    if (!container || !util.visibleInPage(container) || !range
      || !container.contains(range.startContainer) || !container.contains(range.endContainer)) {
      hideWordPop();
      selectionBar.classList.remove('bx-show');
      return;
    }
    const rect = selectionRect(selection);
    const expanded = expandWord(selection);
    if (expanded) {
      // 任务书 ⑥ 前半：单词（含半词）→ 补词界 → 松手即小释义浮窗。
      selectionBar.classList.remove('bx-show');
      state.selected = expanded.word;
      state.dictionary = null;
      state.explanation = '';
      showWordPop(expanded.word, rect);
      if (BX.element.classList.contains('bx-open') && activeMode() === 'read') refresh();
      return;
    }
    // 任务书 ⑥ 后半：句子 → 设置 state.selected 并打开阅读页签（与选区条行为衔接）。
    hideWordPop();
    state.selected = raw.trim();
    state.dictionary = null;
    state.explanation = '';
    if (container.matches('[data-testid="tweetText"]')) {
      const tweet = container.closest('article');
      if (tweet) setPost(postFrom(tweet));
    }
    showSelectionBar(rect);
    open('read');
  }

  document.addEventListener('mouseup', event => {
    const target = event.target;
    if (target && (BX.element.contains(target) || selectionBar.contains(target) || wordPop.contains(target))) return;
    setTimeout(() => {
      // 只有发生在帖文/文章正文里的 mouseup 才当划选手势处理：
      // 点击帖内按钮（如「翻译」）时残留选区不得被重新解读、把上下文切回旧帖。
      if (!target?.isConnected) return;
      if (!target.closest?.(TEXT_RANGE) || target.closest?.('.bx-entries')) {
        hideWordPop();
        selectionBar.classList.remove('bx-show');
        return;
      }
      handleSelection();
    }, 0);
  });
  document.addEventListener('mousedown', event => {
    if (wordPop.classList.contains('bx-show') && !wordPop.contains(event.target)) hideWordPop();
  });
  window.addEventListener('scroll', () => hideWordPop(), true);
  selectionBar.addEventListener('click', event => {
    const action = event.target?.dataset?.select;
    if (!action) return;
    selectionBar.classList.remove('bx-show');
    open('read');
    if (action === 'lookup') document.querySelector('#bx-lookup')?.click();
    if (action === 'explain') document.querySelector('#bx-explain')?.click();
    if (action === 'save') document.querySelector('#bx-save')?.click();
  });

  // 其他页签被点走 → 本轮自动翻译放弃（发出前复核，见 maybeStartAuto）。
  BX.element.querySelector('.bx-tabs').addEventListener('click', event => {
    const button = event.target?.closest?.('[data-bx-mode]');
    if (button && button.dataset.bxMode !== 'read') autoAbandon = true;
  }, true);

  // ---- 长文章正文：按段提取 + 观察 DOM 增长（延迟/分批渲染 → 补译）----
  function articleParagraphs() {
    const root = document.querySelector(ARTICLE_SELECTOR);
    if (!root) return [];
    // X mixes p, div and nested rich-text blocks. A selective tag list can silently
    // omit visible text as soon as it finds one p. Split the complete visible body.
    return root.innerText.split(/\n+/).map(line => line.trim()).filter(Boolean);
  }

  function syncArticle(paras) {
    const reading = state.reading;
    const key = `article|${state.target}`;
    const reset = () => {
      state.reading = { ...freshReading(), kind: 'article', key, units: paras.map(src => ({ src, dst: '', status: 'pending', error: '' })) };
      return 'reset';
    };
    if (reading.kind !== 'article' || reading.key !== key) return reset();
    const shared = Math.min(paras.length, reading.units.length);
    for (let i = 0; i < shared; i++) {
      if (reading.units[i].src !== paras[i]) return reset();
    }
    if (paras.length > reading.units.length) {
      for (let i = reading.units.length; i < paras.length; i++) reading.units.push({ src: paras[i], dst: '', status: 'pending', error: '' });
      return 'appended';
    }
    if (paras.length < reading.units.length) reading.units.length = paras.length;
    return 'same';
  }

  function ensureSource() {
    const reading = state.reading;
    const post = state.post;
    if (post && post.text) {
      const key = `post|${post.url}|${post.text.length}|${post.text.slice(0, 40)}|${state.target}`;
      if (reading.kind !== 'post' || reading.key !== key) {
        state.reading = { ...freshReading(), kind: 'post', key, units: [{ src: post.text, dst: '', status: 'pending', error: '' }] };
      }
      return;
    }
    const paras = articleParagraphs();
    if (!paras.length) {
      if (reading.kind !== 'none') state.reading = freshReading();
      return;
    }
    syncArticle(paras);
  }

  // ---- 自动翻译：延迟发出 + 发出前复核（离开阅读页签即放弃）----
  function scheduleAuto() {
    clearTimeout(autoTimer);
    autoTimer = setTimeout(maybeStartAuto, AUTO_DELAY_MS);
  }

  function maybeStartAuto() {
    const reading = state.reading;
    if (!reading || reading.busy) return;
    if (!BX.element.classList.contains('bx-open') || activeMode() !== 'read' || autoAbandon) return;
    const fresh = reading.units.filter(unit => unit.status === 'pending');
    if (!fresh.length) return;
    fresh.forEach(unit => { unit.status = 'queued'; });
    reading.busy = true;
    reading.error = '';
    reading.notice = '';
    refresh();
    translateWork(reading, reading.seq);
  }

  async function translateWork(reading, seq) {
    try {
      for (const unit of reading.units) {
        // 切帖/换源/取消：reading 对象或作废号对不上 → 旧结果一律丢弃，绝不落到新上下文。
        if (state.reading !== reading || reading.seq !== seq) return;
        if (unit.status !== 'queued') continue;
        const label = reading.kind === 'article' ? '文章段落' : '帖子内容';
        try {
          ensureMaterialLimit(unit.src, label); // 20,000 上限：明确中文报错（含实际长度与上限），不静默截断
          const result = await send('AI', { task: 'TRANSLATE', payload: { text: unit.src, target: state.target } });
          if (state.reading !== reading || reading.seq !== seq) return;
          unit.dst = String(result?.text || '').trim();
          if (unit.dst) {
            unit.status = 'done';
          } else {
            unit.status = 'error';
            unit.error = '模型没有返回译文，请重试。';
            reading.error = reading.error || unit.error;
          }
        } catch (error) {
          if (state.reading !== reading || reading.seq !== seq) return;
          unit.status = 'error';
          unit.error = error.message || '翻译失败，请重试。';
          reading.error = reading.error || unit.error;
        }
        if (state.reading === reading) refresh();
      }
    } catch (error) {
      if (state.reading === reading && reading.seq === seq) reading.error = error.message || '翻译失败，请重试。';
    } finally {
      if (state.reading === reading && reading.seq === seq) {
        reading.busy = false;
        refresh();
      }
    }
  }

  function cancelTranslate() {
    const reading = state.reading;
    reading.seq = ++seqCounter;
    reading.busy = false;
    reading.notice = '已取消等待；晚到的翻译结果会被忽略，不会进入对照区。';
    refresh();
  }

  // ---- 渲染（阅读页签 UI 全部在 #bx-sidebar 内）----
  function readingStatusHTML() {
    const reading = state.reading;
    if (reading.busy) {
      const total = reading.units.length;
      const settled = reading.units.filter(unit => unit.status === 'done' || unit.status === 'error').length;
      return `<div class="bx-status bx-loading"><span class="bx-spinner"></span>正在翻译 ${settled}/${total} 段……<button type="button" id="bx-reading-cancel">取消等待</button></div>`;
    }
    if (reading.error) return `<div class="bx-status bx-error" role="alert">${esc(reading.error)}</div>`;
    if (reading.notice) return `<div class="bx-status bx-ok" role="status">${esc(reading.notice)}</div>`;
    return '';
  }

  function pairsHTML(reading) {
    if (!reading.units.length) return '';
    return `<div class="bx-trans"><div class="bx-trans-head">原文 · 译文对照<small>目标语言：${esc(state.target)} · 共 ${reading.units.length} 段</small></div>${reading.units.map((unit, index) => `<div class="bx-pair" data-pair="${index}">
      <p class="bx-pair-label">第 ${index + 1} 段 · 原文</p>
      <p class="bx-pair-src">${esc(unit.src)}</p>
      <p class="bx-pair-label">译文</p>
      <p class="bx-pair-dst ${unit.status === 'done' ? 'bx-done' : unit.status === 'error' ? 'bx-fail' : ''}">${
        unit.status === 'done' ? esc(unit.dst)
          : unit.status === 'error' ? esc(unit.error || '翻译失败，请重试。')
            : unit.status === 'queued' ? '翻译中……'
              : '等待翻译……'
      }</p>
    </div>`).join('')}</div>`;
  }

  function renderRead(container) {
    readVisible = true;
    autoAbandon = false; // 本页签重新渲染 = 用户当前正在阅读
    ensureSource();
    const reading = state.reading;
    const post = state.post || { text: '', author: '', url: location.href };
    const articleMeta = !post.text ? longArticleOnPage() : null;
    const placeholder = reading.kind === 'article'
      ? '文章正文会按段出现在下方的「原文 · 译文对照」区。'
      : '选中帖子里的单词或句子，或点击帖子下方的「翻译」。';
    const headline = post.author ? esc(post.author) : (articleMeta?.author ? esc(articleMeta.author) : '当前页面');
    const empty = !post.text && !articleMeta && !reading.units.length
      ? '<p class="bx-subtle">当前页面没有可翻译的帖文或文章正文。</p>' : '';
    container.innerHTML = `<section class="bx-section">
      <div class="bx-kicker">读懂这条帖子</div>
      <h2>${headline}</h2>
      <blockquote>${esc((state.selected || post.text || placeholder).slice(0, 850))}</blockquote>
      ${!post.text && articleMeta && !reading.units.length ? '<button id="bx-read-article" class="bx-wide">读取当前 X 文章</button>' : ''}
      ${readingStatusHTML()}
      ${pairsHTML(reading)}
      ${empty}
      <div class="bx-actions">
        <button id="bx-lookup" class="bx-primary">查词</button>
        <button id="bx-explain">讲解句子</button>
        <button id="bx-save">存下表达</button>
        ${reading.units.length ? `<button id="bx-retranslate" ${reading.busy ? 'disabled' : ''}>重新翻译</button>` : ''}
      </div>
      <div class="bx-field"><label for="bx-word">取词</label><input id="bx-word" placeholder="选中单词后会自动填入" value="${esc(reading.word || (state.selected.split(/\s+/).length === 1 ? state.selected : ''))}"></div>
      ${statusHTML()}
      <div id="bx-read-result"></div>
    </section>`;
    // 词典/讲解结果（旧面板「阅读」页签原样迁移；既有 smoke 依赖 .bx-result 里的查词结果）
    const result = container.querySelector('#bx-read-result');
    if (state.dictionary) {
      const data = state.dictionary;
      result.innerHTML = `<div class="bx-result"><div class="bx-result-title">${esc(data.word)} <small>${esc(data.phonetic || '')}</small></div>${data.chinese ? `<p class="bx-chinese">${esc(data.chinese)}</p>` : ''}<p class="bx-subtle">${esc(data.source)}</p>${(data.meanings || []).map(item => `<p><b>${esc(item.partOfSpeech)}</b> ${esc(item.definition)}</p>${(item.examples || []).slice(0, 3).map(ex => `<p class="bx-subtle">· ${esc(ex)}</p>`).join('')}`).join('')}${data.notice ? `<p class="bx-subtle">${esc(data.notice)}</p>` : ''}<a target="_blank" rel="noopener noreferrer" href="https://dict.eudic.net/dicts/en/${encodeURIComponent(data.word)}">欧路词典继续查 ↗</a></div>`;
    } else if (state.explanation) {
      result.innerHTML = `<div class="bx-result"><div class="bx-result-title">句子结构</div><p class="bx-explanation">${esc(state.explanation)}</p><button id="bx-save-structure">收藏这个结构</button></div>`;
    }
    wire(container);
    scheduleAuto();
  }

  function wire(container) {
    const wordInput = container.querySelector('#bx-word');
    wordInput.oninput = () => { state.reading.word = wordInput.value; };
    container.querySelector('#bx-lookup').onclick = () => {
      const word = wordInput.value.trim() || state.selected;
      withBusy(async () => { state.dictionary = await send('LOOKUP', { word }); state.explanation = ''; });
    };
    container.querySelector('#bx-explain').onclick = () => withBusy(async seq => {
      const post = state.post || { text: '', author: '', url: location.href };
      const text = state.selected || post.text;
      if (!text) throw new Error('先选中一个句子或打开一条帖子。');
      ensureMaterialLimit(text, '选段');
      ensureMaterialLimit(post.text, '帖子内容');
      const answer = await send('AI', { task: 'EXPLAIN', payload: { text, context: post.text } });
      if (seq !== state.reqSeq) return;
      state.explanation = answer.text;
      state.dictionary = null;
    });
    container.querySelector('#bx-save').onclick = () => saveCurrent(state.selected || state.post?.text || '', 'sentence');
    container.querySelector('#bx-save-structure')?.addEventListener('click', () => saveCurrent(state.selected || state.post?.text || '', 'structure'));
    container.querySelector('#bx-read-article')?.addEventListener('click', () => {
      const article = longArticleOnPage();
      if (!article) return;
      state.post = article;
      state.selected = '';
      state.reading = freshReading();
      refresh();
      maybeStartAuto(); // 手动按钮：立即翻译
    });
    container.querySelector('#bx-retranslate')?.addEventListener('click', () => {
      const reading = state.reading;
      if (reading.busy) return;
      reading.units.forEach(unit => { unit.status = 'pending'; unit.dst = ''; unit.error = ''; });
      reading.error = '';
      reading.notice = '';
      maybeStartAuto();
    });
    container.querySelector('#bx-reading-cancel')?.addEventListener('click', cancelTranslate);
  }

  async function saveCurrent(text, kind) {
    const note = window.prompt('给这条表达写个简短备注（可留空）：', '');
    if (note === null) return;
    await withBusy(async () => {
      await BX.saveCard(text, kind, { note, author: state.post?.author || '', url: state.post?.url || location.href });
      state.error = '已保存。打开「成长」可再次查看。';
    });
  }

  // ---- 长文章正文增长观察（延迟/分批渲染 → 补译）----
  let growthTimer = 0;
  const growthObserver = new MutationObserver(() => {
    clearTimeout(growthTimer);
    growthTimer = setTimeout(() => {
      if (state.post?.text) return;
      const paras = articleParagraphs();
      if (state.reading.kind === 'none' && paras.length) {
        // The entire article root may mount after the sidebar was opened.
        if (BX.element.classList.contains('bx-open') && activeMode() === 'read') refresh();
        return;
      }
      if (state.reading.kind !== 'article') return;
      const status = syncArticle(paras);
      if (status !== 'same' && readVisible && BX.element.classList.contains('bx-open') && activeMode() === 'read') refresh();
    }, 280);
  });

  register({
    id: 'read',
    label: '翻译',
    order: 10,
    init() {
      if (document.body) growthObserver.observe(document.body, { childList: true, subtree: true });
    },
    render(container) { renderRead(container); },
    onPost() {
      // 切帖：在途翻译由对象/作废号双重校验作废；词典、讲解、选区、词义浮窗都不跨帖。
      state.reading = freshReading();
      state.dictionary = null;
      state.explanation = '';
      state.selected = '';
      hideWordPop();
      selectionBar.classList.remove('bx-show');
    },
    onSettings() {
      // 目标语言可能变化（key 含 target → 下次渲染重译）；阅读页签打开时立即重绘。
      if (readVisible && BX.element.classList.contains('bx-open') && activeMode() === 'read') refresh();
    },
    onArticle(article, meta) {
      if (meta.repeat) return;
      const post = state.post;
      if (!post?.url || !meta.key?.startsWith?.('/')) return;
      if (!post.url.endsWith(meta.key)) return; // 不是当前帖子
      const next = postFrom(article);
      if (next.text === post.text) return;
      // 当前帖子正文变化（占位→全文等）：旧翻译作废，按新文重译。
      state.post = next;
      state.selected = '';
      state.reading = freshReading();
      if (readVisible && BX.element.classList.contains('bx-open') && activeMode() === 'read') refresh();
    },
    onEditor() {
      hideWordPop();
    }
  });
})();
