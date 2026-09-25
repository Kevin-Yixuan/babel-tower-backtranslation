// 发现讨论模块（discovery Agent；id=discovery，页签「发现」）。
// 第一部分：按规则折叠噪声 —— 由 content.js 的 Jev 块原样迁移，行为与既有断言一字不改
//   （折叠条、可展开、有界重试、每日硬上限、竞态四元组、错误不吞）。
// 第二部分：任务书 4 —— 按兴趣高亮「适合参与」的帖子（send('JEV',{payload,kind:'interest'})，
//   规则存 STORE 键 discoveryPrefs：{enabled, interestThreshold, interestRules:[{id,text,enabled}]}，
//   与折叠规则分开存、共用每日请求上限与 jevStats 诊断）、发现页诊断面板（BX.send('JEV_STATUS')）、
//   X 原生兴趣/「不感兴趣」指引（静态文案，插件绝不代操作 X 的任何原生控件）。
// 公共文件（manifest/background/content/sidebar）由 integration 接线，本模块一律不改。
(() => {
  const BX = window.BX;
  const { state, esc, send, register, refresh: bxRefresh, statusHTML } = BX;
  const { postFrom } = BX.util;

  // ------------------------------------------------------------------
  // 第一部分：按规则折叠（迁移自 content.js，勿改行为）
  // ------------------------------------------------------------------
  let jevHalted = false; // stop new requests this session on config/limit errors
  // 每次判断都携带身份/正文/规则/开关四元组；epoch 或规则签名一变（改设置、关筛选），晚到结果一律作废。
  let jevEpoch = 0;
  let jevRuleSig = '';
  const JEV_MAX_ATTEMPTS = 2;
  const JEV_RETRY_DELAY_MS = 3000;
  const visiblePosts = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting) { inspectPost(entry.target); inspectInterest(entry.target); }
  }, { rootMargin: '350px' });

  function computeRuleSig() {
    const s = state.settings;
    return JSON.stringify([Boolean(s?.filterEnabled), s?.filterThreshold ?? '', (s?.filterRules || []).map(r => [Boolean(r.enabled), r.text])]);
  }

  function resetFilterState(article) {
    article.classList.remove('bx-collapsed');
    article.querySelector('.bx-collapse-bar')?.remove();
    delete article.dataset.bxFiltered;
    delete article.dataset.bxAttempts;
    delete article.dataset.bxLastError;
    delete article.dataset.bxPendingId;
    delete article.dataset.bxSkipReason;
    delete article.dataset.bxLabel;
  }

  // 响应到达 / 重试定时器触发时的复核：节点还在、仍是原帖、正文没变、规则与开关没变
  function judgmentStillCurrent(article, token) {
    if (!article.isConnected) return false;
    if (token.epoch !== jevEpoch || token.ruleSig !== jevRuleSig) return false;
    if (!state.settings?.filterEnabled || !state.settings?.hasJev) return false;
    if (article.dataset.bxPostKey !== token.key || postKey(article) !== token.key) return false;
    if (postFrom(article).text !== token.text) return false;
    return true;
  }
  function postKey(article) {
    const permalink = [...article.querySelectorAll('a[href*="/status/"]')].find(a => /\/status\/\d+/.test(a.getAttribute('href') || ''));
    if (permalink) return permalink.getAttribute('href');
    return (article.querySelector('[data-testid="tweetText"]')?.textContent || '').trim().slice(0, 120);
  }

  function scheduleRetry(article, token, delay) {
    setTimeout(() => {
      // 定时器触发时同样复核：帖子复用、正文变化、设置变化都会让这次重试作废
      if (article.dataset.bxFiltered === 'retry' && article.dataset.bxPendingId === token.id && judgmentStillCurrent(article, token)) {
        delete article.dataset.bxFiltered;
        delete article.dataset.bxPendingId;
        inspectPost(article);
      }
    }, delay);
  }

  // 命中只折叠，并且永远带一个「展开原帖」按钮；bar 被 X 重渲染冲掉时由 onArticle 补回
  function collapsePost(article, label) {
    article.dataset.bxLabel = String(label || '');
    addCollapseBar(article, label);
    article.classList.add('bx-collapsed');
  }

  function addCollapseBar(article, label) {
    if (article.querySelector('.bx-collapse-bar')) return;
    const bar = document.createElement('div'); bar.className = 'bx-collapse-bar';
    const labelEl = document.createElement('span'); labelEl.textContent = `Jev 折叠 · ${label || ''}`;
    const reveal = document.createElement('button'); reveal.type = 'button'; reveal.textContent = '展开原帖';
    reveal.onclick = () => { article.classList.remove('bx-collapsed'); bar.remove(); };
    bar.append(labelEl, reveal); article.prepend(bar);
  }

  async function inspectPost(article) {
    if (!state.settings?.filterEnabled || !state.settings.hasJev || jevHalted) return;
    const flag = article.dataset.bxFiltered;
    if (flag === 'pending' || flag === 'done' || flag === 'limited' || flag === 'halted' || flag === 'retry' || flag === 'skipped') return; // 'retry' is re-entered only by its timer
    const attempts = Number(article.dataset.bxAttempts || 0);
    if (flag === 'failed' && attempts >= JEV_MAX_ATTEMPTS) return;
    const post = postFrom(article);
    if (post.text.length < 40) {
      article.dataset.bxFiltered = 'skipped';
      article.dataset.bxSkipReason = 'short'; // 短帖跳过；正文补长后由 onArticle 检测变化重新检查
      return;
    }
    if (/\bpromoted\b|推广|广告/i.test(article.innerText.slice(0, 80))) {
      article.dataset.bxFiltered = 'skipped';
      article.dataset.bxSkipReason = 'ad';
      return;
    }
    const token = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, key: postKey(article), text: post.text, epoch: jevEpoch, ruleSig: jevRuleSig };
    article.dataset.bxFiltered = 'pending';
    article.dataset.bxPendingId = token.id;
    try {
      const result = await send('JEV', { payload: post });
      // 成功也要复核——旧帖结果不能折叠复用后的新帖，关筛选后的晚到结果不得折叠
      if (article.dataset.bxPendingId !== token.id || !judgmentStillCurrent(article, token)) {
        if (article.isConnected && article.dataset.bxPendingId === token.id) {
          delete article.dataset.bxFiltered; // 同节点但正文变了 → 交回下次扫描重新判断
          delete article.dataset.bxPendingId;
        }
        return;
      }
      article.dataset.bxFiltered = 'done';
      delete article.dataset.bxPendingId;
      delete article.dataset.bxLastError;
      if (!result.collapse) return;
      collapsePost(article, result.label);
    } catch (error) {
      if (article.dataset.bxPendingId !== token.id || !judgmentStillCurrent(article, token)) return; // 过期响应：不改状态、不记错误
      const message = error.message || 'Jev 判断失败。';
      delete article.dataset.bxPendingId;
      article.dataset.bxLastError = message; // never swallow the error
      if (error.code === 'skip') {
        article.dataset.bxFiltered = 'skipped';
        article.dataset.bxSkipReason = 'short';
        return;
      }
      if (error.code === 'limit') {
        article.dataset.bxFiltered = 'limited';
        jevHalted = true;
        return;
      }
      if (error.code === 'disabled' || error.code === 'config' || error.code === 'auth' || error.code === 'no_key') {
        article.dataset.bxFiltered = 'halted';
        jevHalted = true;
        return;
      }
      // transient failure → bounded retry with delay, then mark failed
      const next = attempts + 1;
      article.dataset.bxAttempts = String(next);
      if (next < JEV_MAX_ATTEMPTS) {
        article.dataset.bxFiltered = 'retry';
        article.dataset.bxPendingId = token.id;
        scheduleRetry(article, token, JEV_RETRY_DELAY_MS * next);
      } else {
        article.dataset.bxFiltered = 'failed';
      }
    }
  }

  function refreshFilter() {
    jevHalted = false;
    jevEpoch += 1; // 旧 epoch 的在途响应与重试定时器全部作废
    jevRuleSig = computeRuleSig();
    document.querySelectorAll('article[data-bx-ready]').forEach(article => {
      resetFilterState(article);
      article.dataset.bxPostKey = postKey(article);
      article.dataset.bxTextSig = `${(article.querySelector('[data-testid="tweetText"]')?.innerText || '').trim().length}:${(article.querySelector('[data-testid="tweetText"]')?.innerText || '').trim().slice(0, 60)}`;
      inspectPost(article); // 内部自行判断筛选是否开启
    });
  }

  // ------------------------------------------------------------------
  // 第二部分：兴趣高亮（协议 §3.3）+ 发现页诊断 + X 原生兴趣指引
  // ------------------------------------------------------------------

  // 兴趣规则存 STORE 键 discoveryPrefs（协议 §3.2 RW 键），与 popup 里的折叠规则完全分开。
  const defaultPrefs = () => ({ enabled: false, interestThreshold: null, interestRules: [] });
  state.discovery = { prefs: null, prefsReady: false, prefsError: '', status: null, statusError: '' };

  function normalizePrefs(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const seen = new Set();
    const interestRules = (Array.isArray(src.interestRules) ? src.interestRules : [])
      .filter(rule => rule && typeof rule === 'object')
      .slice(0, 20)
      .map((rule, index) => {
        let id = String(rule.id || '').trim().slice(0, 40) || `int-${index}-${Math.random().toString(36).slice(2, 7)}`;
        while (seen.has(id)) id = `${id}-${index}`;
        seen.add(id);
        return {
          id,
          text: String(rule.text || '').trim().slice(0, 180), // 空规则保留在列表里（草稿可见），后台会过滤空文本
          enabled: rule.enabled === undefined ? true : Boolean(rule.enabled)
        };
      });
    const thresholdNum = Number(src.interestThreshold);
    const interestThreshold = src.interestThreshold === null || src.interestThreshold === undefined || src.interestThreshold === ''
      || !Number.isFinite(thresholdNum) || thresholdNum <= 0
      ? null
      : Math.max(0.5, Math.min(0.98, thresholdNum));
    return { enabled: Boolean(src.enabled), interestThreshold, interestRules };
  }

  const prefsNow = () => state.discovery.prefs || defaultPrefs();
  const activeInterestRules = () => prefsNow().interestRules.filter(rule => rule.enabled && rule.text);

  // 保存走串行链：快速连续编辑不会互相覆盖，也不会在后台读到旧值后才落盘。
  // 注意消息形状：background 的 STORE 走 storeOp(message.payload)，而 BX.send 是把参数平铺进消息，
  // 所以必须显式带 payload 键（与 JEV/AI/SAVE_CARD 一致）；协议 §3.2 里的平铺写法与后台实现不一致，
  // 已写进交接说明由 integration 统一（本模块按后台现状调用，两种归一方式下都兼容）。
  let persistChain = Promise.resolve();
  function persistPrefs() {
    const value = JSON.parse(JSON.stringify(prefsNow()));
    persistChain = persistChain
      .then(() => send('STORE', { payload: { op: 'set', key: 'discoveryPrefs', value } }))
      .then(() => { state.discovery.prefsError = ''; prefsMsg('已保存到本机。', 'ok'); })
      .catch(error => {
        state.discovery.prefsError = error.message || '保存兴趣规则失败。';
        prefsMsg(`保存失败：${state.discovery.prefsError}`, 'error');
      });
    return persistChain;
  }

  function prefsMsg(text, kind) {
    const el = document.querySelector('#bx-int-msg');
    if (!el) return;
    el.textContent = text || '';
    el.className = `bx-status ${kind === 'error' ? 'bx-error' : 'bx-ok'}`;
    el.hidden = !text;
  }

  // 读取偏好：不依赖页签打开（兴趣高亮要在未打开侧栏时也工作）。
  // 读取失败按「默认关闭」处理 —— 绝不因此发出任何请求；下次进入页签再试一次。
  let prefsLoad = null;
  function loadPrefs() {
    if (prefsLoad) return prefsLoad;
    prefsLoad = send('STORE', { payload: { op: 'get', key: 'discoveryPrefs' } })
      .then(raw => {
        state.discovery.prefs = normalizePrefs(raw);
        state.discovery.prefsReady = true;
        state.discovery.prefsError = '';
        refreshInterest();
        if (document.querySelector('#bx-int-rules')) bxRefresh();
      })
      .catch(error => {
        prefsLoad = null;
        state.discovery.prefs = defaultPrefs();
        state.discovery.prefsReady = true;
        state.discovery.prefsError = error.message || '读取兴趣规则失败。';
        console.error('[bx] discovery prefs', error);
      });
    return prefsLoad;
  }

  // 提交偏好：先落 STORE、再重扫（后台 classifyInterest 读的是存储里的 enabled，
  // 不先保存就重扫会拿到「未开启」把自己刚发的请求判死）。
  async function commitPrefs(next, { rescan = true } = {}) {
    state.discovery.prefs = normalizePrefs(next);
    await persistPrefs();
    if (rescan) refreshInterest();
    refreshStatus();
  }

  // 兴趣侧的竞态四元组：epoch（开关/规则变化）+ 规则签名 + 节点身份 + 正文
  let intHalted = false;
  let intEpoch = 0;
  let intRuleSig = '';
  function computeIntSig() {
    const p = prefsNow();
    return JSON.stringify([Boolean(p.enabled), p.interestThreshold ?? '', p.interestRules.map(r => [Boolean(r.enabled), r.text])]);
  }

  function resetInterestState(article) {
    article.classList.remove('bx-interest-hit');
    article.querySelector('.bx-interest-mark')?.remove();
    delete article.dataset.bxInt;
    delete article.dataset.bxIntPendingId;
    delete article.dataset.bxIntAttempts;
    delete article.dataset.bxIntLastError;
    delete article.dataset.bxIntSkipReason;
    delete article.dataset.bxIntLabel;
    delete article.dataset.bxIntHit;
  }

  function interestStillCurrent(article, token) {
    if (!article.isConnected) return false;
    if (token.epoch !== intEpoch || token.ruleSig !== intRuleSig) return false;
    if (!prefsNow().enabled || !state.settings?.hasJev) return false; // 关兴趣开关后的晚到结果一律作废
    if (article.dataset.bxPostKey !== token.key || postKey(article) !== token.key) return false; // 旧帖不得高亮复用后的节点
    if (postFrom(article).text !== token.text) return false;
    return true;
  }

  function interestGate() {
    if (!state.discovery.prefsReady || intHalted) return false;
    if (!prefsNow().enabled || !state.settings?.hasJev) return false;
    return activeInterestRules().length > 0;
  }

  function scheduleInterestRetry(article, token, delay) {
    setTimeout(() => {
      if (article.dataset.bxInt === 'retry' && article.dataset.bxIntPendingId === token.id && interestStillCurrent(article, token)) {
        delete article.dataset.bxInt;
        delete article.dataset.bxIntPendingId;
        inspectInterest(article);
      }
    }, delay);
  }

  // 轻量高亮：描边 + 顶部角标（在文档流里，不遮挡帖子内容），随时可清除。
  function applyHighlight(article, label) {
    article.dataset.bxInt = 'done';
    article.dataset.bxIntHit = '1';
    article.dataset.bxIntLabel = String(label || '');
    article.classList.add('bx-interest-hit');
    addInterestMark(article, label);
  }

  function addInterestMark(article, label) {
    if (article.querySelector('.bx-interest-mark')) return;
    const mark = document.createElement('div');
    mark.className = 'bx-interest-mark';
    const text = document.createElement('span');
    text.textContent = `适合参与 · ${label || '命中兴趣规则'}`;
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.textContent = '清除标记';
    clear.setAttribute('aria-label', '清除兴趣高亮标记');
    clear.onclick = event => { event.preventDefault(); event.stopPropagation(); clearHighlight(article); };
    mark.append(text, clear);
    article.prepend(mark);
  }

  function clearHighlight(article) {
    article.classList.remove('bx-interest-hit');
    article.querySelector('.bx-interest-mark')?.remove();
    article.dataset.bxInt = 'cleared'; // 用户主动清除：同一节点不再重复高亮，规则/复用变化后重新判断
    delete article.dataset.bxIntHit;
  }

  async function inspectInterest(article) {
    if (!interestGate()) return;
    const flag = article.dataset.bxInt;
    if (flag === 'pending' || flag === 'done' || flag === 'limited' || flag === 'halted' || flag === 'retry' || flag === 'skipped' || flag === 'cleared') return;
    const attempts = Number(article.dataset.bxIntAttempts || 0);
    if (flag === 'failed' && attempts >= JEV_MAX_ATTEMPTS) return;
    const post = postFrom(article);
    if (post.text.length < 40) {
      article.dataset.bxInt = 'skipped';
      article.dataset.bxIntSkipReason = 'short'; // 短帖跳过；正文补长后由 onArticle 检测变化重新判断
      return;
    }
    if (/\bpromoted\b|推广|广告/i.test(article.innerText.slice(0, 80))) {
      article.dataset.bxInt = 'skipped';
      article.dataset.bxIntSkipReason = 'ad';
      return;
    }
    const token = { id: `${Date.now()}-${Math.random().toString(36).slice(2)}`, key: postKey(article), text: post.text, epoch: intEpoch, ruleSig: intRuleSig };
    article.dataset.bxInt = 'pending';
    article.dataset.bxIntPendingId = token.id;
    try {
      const result = await send('JEV', { payload: post, kind: 'interest' });
      if (article.dataset.bxIntPendingId !== token.id || !interestStillCurrent(article, token)) {
        if (article.isConnected && article.dataset.bxIntPendingId === token.id) {
          delete article.dataset.bxInt; // 同节点但正文变了 → 交回下次扫描重新判断
          delete article.dataset.bxIntPendingId;
        }
        return;
      }
      article.dataset.bxInt = 'done';
      delete article.dataset.bxIntPendingId;
      delete article.dataset.bxIntLastError;
      if (result.highlight) applyHighlight(article, result.label);
      refreshStatus();
    } catch (error) {
      if (article.dataset.bxIntPendingId !== token.id || !interestStillCurrent(article, token)) return; // 过期响应：不改状态、不记错误
      delete article.dataset.bxIntPendingId;
      article.dataset.bxIntLastError = error.message || '兴趣判断失败。'; // 错误不吞
      if (error.code === 'skip') {
        article.dataset.bxInt = 'skipped';
        article.dataset.bxIntSkipReason = 'short';
        return;
      }
      if (error.code === 'limit') {
        article.dataset.bxInt = 'limited';
        intHalted = true;
        refreshStatus();
        return;
      }
      if (error.code === 'disabled' || error.code === 'config' || error.code === 'auth' || error.code === 'no_key') {
        article.dataset.bxInt = 'halted';
        intHalted = true;
        refreshStatus();
        return;
      }
      const next = attempts + 1;
      article.dataset.bxIntAttempts = String(next);
      if (next < JEV_MAX_ATTEMPTS) {
        article.dataset.bxInt = 'retry';
        article.dataset.bxIntPendingId = token.id;
        scheduleInterestRetry(article, token, JEV_RETRY_DELAY_MS * next);
      } else {
        article.dataset.bxInt = 'failed';
      }
    }
  }

  // 调用方包装：observer / onArticle 都不 await，异常必须落 console 而不是未处理拒绝
  function inspectInterestSafe(article) {
    try {
      const pending = inspectInterest(article);
      if (pending && typeof pending.catch === 'function') pending.catch(error => console.error('[bx] discovery interest', error));
    } catch (error) {
      console.error('[bx] discovery interest', error);
    }
  }

  // 规则/开关/阈值变化：epoch 与规则签名一起换掉，晚到结果全部作废，再重扫全部帖子
  function refreshInterest() {
    intEpoch += 1;
    intRuleSig = computeIntSig();
    intHalted = false;
    document.querySelectorAll('article[data-bx-ready]').forEach(article => {
      resetInterestState(article);
      inspectInterestSafe(article);
    });
  }

  // 规则文本/阈值连续输入：持久化立即做，重扫去抖（避免每个字符重判一遍时间线）
  let rescanTimer = 0;
  function scheduleInterestRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => { rescanTimer = 0; refreshInterest(); }, 900);
  }
  function flushInterestRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = 0;
    refreshInterest();
  }

  // ---------- 诊断面板（协议 §3.3：JEV_STATUS 已对 X 页面开放） ----------
  const STATE_TEXT = { disabled: '未开启', no_key: '缺密钥', ok: '已开启', limited: '已达上限' };
  let statusSeq = 0;
  let statusTimer = 0;

  function intStateOf(status) {
    const prefs = prefsNow();
    if (!prefs.enabled) return 'disabled';
    if (!status.hasJev) return 'no_key';
    return status.used >= status.dailyLimit ? 'limited' : 'ok';
  }

  function paintSetup(status, intState) {
    const box = document.querySelector('#bx-disc-setup');
    if (!box) return;
    const lines = [];
    if (!status.hasJev) lines.push('缺密钥：还没有 Jev API Key。请打开插件设置 →「筛选」填写 Jev API Key 并保存——在配好密钥之前不会发出任何请求。');
    if (status.state === 'disabled') lines.push('未开启：Jev 折叠筛选默认关闭。需要折叠噪声时，在插件设置 →「筛选」中开启自然语言筛选。');
    if (!prefsNow().enabled) lines.push('未开启：兴趣高亮默认关闭。想标记「适合参与」的帖子时，打开本页上方的「兴趣高亮」开关。');
    if (prefsNow().enabled && !activeInterestRules().length) lines.push('还没有可用规则：先在下面添加一条兴趣规则并保持勾选，兴趣判断才会开始。');
    if (status.state === 'limited' || intState === 'limited') lines.push('已达上限：今日 Jev 请求已用完，明天会自动恢复；也可以在插件设置中调高每日上限。');
    box.innerHTML = lines.map(line => `<p>${esc(line)}</p>`).join('');
    box.hidden = !lines.length;
  }

  function paintStatus(status) {
    const host = document.querySelector('#bx-disc-status');
    if (!host) return;
    state.discovery.status = status;
    state.discovery.statusError = '';
    const stats = status.stats || {};
    const intState = intStateOf(status);
    const rulesOn = activeInterestRules().length;
    host.dataset.state = String(status.state || '');
    host.dataset.intState = intState;
    host.dataset.interestEnabled = String(Boolean(prefsNow().enabled));
    host.dataset.ruleCount = String(status.interestRuleCount ?? rulesOn);
    host.dataset.used = String(status.used ?? 0);
    host.dataset.dailyLimit = String(status.dailyLimit ?? '');
    host.dataset.highlighted = String(stats.highlighted || 0);
    host.dataset.collapsed = String(stats.collapsed || 0);
    host.dataset.cached = String(stats.cached || 0);
    host.dataset.failed = String(stats.failed || 0);
    host.dataset.limited = String(stats.limited || 0);
    host.dataset.lastError = String(stats.lastError || '');
    host.innerHTML = [
      `<div class="bx-disc-row" data-role="fold-state">Jev 折叠：${esc(STATE_TEXT[status.state] || status.state || '—')}</div>`,
      `<div class="bx-disc-row" data-role="int-state">兴趣高亮：${esc(STATE_TEXT[intState] || intState)}${prefsNow().enabled ? ` · ${rulesOn} 条启用规则` : ''}</div>`,
      `<div class="bx-disc-row" data-role="used">今日请求数：${Number(status.used ?? 0)} / ${Number(status.dailyLimit ?? 0)}</div>`,
      `<div class="bx-disc-row" data-role="highlighted">命中高亮数：${stats.highlighted || 0}</div>`,
      `<div class="bx-disc-row" data-role="collapsed">折叠数：${stats.collapsed || 0}</div>`,
      `<div class="bx-disc-row" data-role="cached">缓存：${stats.cached || 0}</div>`,
      `<div class="bx-disc-row" data-role="failed">失败：${stats.failed || 0}（触发上限 ${stats.limited || 0}）</div>`,
      `<div class="bx-disc-row" data-role="last-error">最近错误：${esc(stats.lastError || '无')}</div>`
    ].join('');
    paintSetup(status, intState);
  }

  async function refreshStatus() {
    const host = document.querySelector('#bx-disc-status');
    if (!host) return; // 面板没开就不发状态查询
    const seq = ++statusSeq;
    try {
      const status = await send('JEV_STATUS');
      if (seq !== statusSeq) return;
      paintStatus(status);
    } catch (error) {
      if (seq !== statusSeq) return;
      state.discovery.statusError = error.message || '读取 Jev 状态失败。';
      const holder = document.querySelector('#bx-disc-status');
      if (holder && !holder.dataset.used) holder.innerHTML = `<div class="bx-disc-row bx-error">${esc(state.discovery.statusError)}</div>`;
    }
  }

  function scheduleStatusPolling() {
    if (statusTimer) clearInterval(statusTimer);
    statusTimer = setInterval(() => {
      if (!document.querySelector('#bx-disc-status')) { clearInterval(statusTimer); statusTimer = 0; return; }
      refreshStatus();
    }, 4000);
  }

  // ---------- X 原生兴趣指引（静态文案；插件只读不代操作） ----------
  const GUIDE_HTML = `<div class="bx-label">用 X 原生功能自己训练时间线</div>
    <div class="bx-disc-guide" id="bx-native-guide">
      <ol>
        <li><b>更多 → 不感兴趣</b>：在帖子右上角点「…（更多）」→「不感兴趣」，告诉 X 你不想看这类内容；随后可按提示选择「减少类似的帖子」。</li>
        <li><b>更多 → 展现你感兴趣的</b>：对愿意多看的内容，用「…（更多）」里的「展现你感兴趣的」表态，时间线会更多出现类似帖子。</li>
        <li><b>关注兴趣话题</b>：在搜索页的「话题」标签里关注感兴趣的 Topics 与账号，时间线会优先出现它们的讨论。</li>
        <li><b>管理不感兴趣记录</b>：在设置的「更多兴趣 / 内容偏好」里查看已标记的内容——可以删除误判，也可以关闭不感兴趣内容的进一步收敛。</li>
      </ol>
      <p class="bx-disc-boundary">边界说明：插件只在页面里做只读的高亮与折叠，<b>绝不替你自动点击 X 的任何原生控件</b>——不模拟、不代操作「不感兴趣」「展现你感兴趣的」「关注」「点赞」「回复」「发布」等按钮。上面这些操作请由你亲手完成，插件只负责给你看的标记。</p>
    </div>`;

  function ruleRowHTML(rule, index) {
    return `<div class="bx-disc-rule" data-rule-index="${index}">
      <input class="bx-disc-rule-text" id="bx-int-rule-${index}" data-rule-index="${index}" type="text" maxlength="180" autocomplete="off" placeholder="例如：语言学习方法的讨论" value="${esc(rule.text)}">
      <div class="bx-disc-rule-meta">
        <label class="bx-disc-rule-on"><input type="checkbox" class="bx-disc-rule-toggle" data-rule-index="${index}" ${rule.enabled ? 'checked' : ''}> 启用</label>
        <button type="button" class="bx-disc-rule-del" data-rule-index="${index}" aria-label="删除第 ${index + 1} 条兴趣规则">删除</button>
      </div>
    </div>`;
  }

  function renderDiscovery(container) {
    const prefs = prefsNow();
    const rulesHTML = prefs.interestRules.length
      ? prefs.interestRules.map(ruleRowHTML).join('')
      : '<div class="bx-empty">还没有兴趣规则。写一条你愿意参与的话题，例如「语言学习方法的讨论」。</div>';
    // 监听器挂在本次渲染新建的根节点上：#bx-body 是复用元素，挂它身上会随每次渲染叠加。
    container.innerHTML = `<div class="bx-disc-root"><section class="bx-section">
      <div class="bx-kicker">发现值得参与的讨论</div>
      <h2>Jev 发现</h2>
      <p class="bx-subtle">Jev 默认关闭。开启后按你的规则折叠噪声、标记「适合参与」的帖子；折叠与兴趣共用同一每日请求上限与同一套诊断。</p>
      <div class="bx-label">状态与诊断</div>
      <div id="bx-disc-status" class="bx-disc-status"><p class="bx-subtle">正在读取 Jev 状态……</p></div>
      <div id="bx-disc-setup" class="bx-disc-setup" hidden></div>
      <div class="bx-actions"><button type="button" id="bx-disc-refresh">刷新状态</button></div>
      <div class="bx-label">兴趣高亮（适合参与）</div>
      <label class="bx-disc-toggle" for="bx-int-enabled"><input type="checkbox" id="bx-int-enabled" ${prefs.enabled ? 'checked' : ''}> 开启兴趣高亮：命中你的兴趣规则时，给帖子加轻量标记</label>
      <div class="bx-field"><label for="bx-int-threshold">命中阈值（0.50–0.98，留空则用全局筛选阈值）</label><input id="bx-int-threshold" type="number" min="0.5" max="0.98" step="0.01" placeholder="默认" value="${prefs.interestThreshold ?? ''}"></div>
      <div class="bx-label">兴趣规则</div>
      <div id="bx-int-rules">${rulesHTML}</div>
      <div class="bx-actions"><button type="button" id="bx-int-add" class="bx-primary">添加一条兴趣规则</button></div>
      <p class="bx-subtle">规则只保存在本机（本地存储键 discoveryPrefs），不上传、不同步；与插件设置里的折叠规则分开保存。</p>
      <div id="bx-int-msg" class="bx-status" hidden></div>
      ${GUIDE_HTML}
      ${statusHTML()}
    </section></div>`;
    const root = container.querySelector('.bx-disc-root');

    root.querySelector('#bx-disc-refresh').onclick = () => refreshStatus();
    root.querySelector('#bx-int-enabled').onchange = event => {
      commitPrefs({ ...prefsNow(), enabled: event.target.checked }); // 先保存再重扫（后台读存储里的开关）
    };
    root.querySelector('#bx-int-threshold').oninput = event => {
      const raw = event.target.value;
      commitPrefs({ ...prefsNow(), interestThreshold: raw === '' ? null : raw }, { rescan: false });
      scheduleInterestRescan();
    };
    root.querySelector('#bx-int-add').onclick = () => {
      const next = { ...prefsNow(), interestRules: [...prefsNow().interestRules, { id: `int-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`, text: '', enabled: true }] };
      commitPrefs(next).then(() => {
        bxRefresh();
        const input = document.querySelector(`#bx-int-rule-${next.interestRules.length - 1}`);
        if (input) input.focus();
      });
    };
    root.addEventListener('input', event => {
      const input = event.target.closest?.('.bx-disc-rule-text');
      if (!input || event.isComposing) return; // IME 组合中的中间态不落盘
      const index = Number(input.dataset.ruleIndex);
      const rules = prefsNow().interestRules.slice();
      if (!rules[index]) return;
      rules[index] = { ...rules[index], text: input.value.slice(0, 180) };
      commitPrefs({ ...prefsNow(), interestRules: rules }, { rescan: false });
      scheduleInterestRescan();
    });
    root.addEventListener('change', event => {
      if (event.target.closest?.('.bx-disc-rule-text') || event.target.id === 'bx-int-threshold') flushInterestRescan();
      const toggle = event.target.closest?.('.bx-disc-rule-toggle');
      if (!toggle) return;
      const index = Number(toggle.dataset.ruleIndex);
      const rules = prefsNow().interestRules.slice();
      if (!rules[index]) return;
      rules[index] = { ...rules[index], enabled: toggle.checked };
      commitPrefs({ ...prefsNow(), interestRules: rules });
    });
    root.addEventListener('click', event => {
      const del = event.target.closest?.('.bx-disc-rule-del');
      if (!del) return;
      const index = Number(del.dataset.ruleIndex);
      const rules = prefsNow().interestRules.filter((_, i) => i !== index);
      commitPrefs({ ...prefsNow(), interestRules: rules }).then(() => {
        bxRefresh();
        document.querySelector('#bx-int-add')?.focus();
      });
    });

    if (!state.discovery.prefsReady || state.discovery.prefsError) loadPrefs();
    refreshStatus();
    scheduleStatusPolling();
  }

  // 轻量高亮样式：描边（outline，不占布局）+ 文档流内的角标条（不遮挡内容）。
  function injectStyle() {
    if (document.getElementById('bx-discovery-style')) return;
    const style = document.createElement('style');
    style.id = 'bx-discovery-style';
    style.textContent = `article.bx-interest-hit{box-shadow:inset 3px 0 0 #c59e69!important;outline:1.5px solid #e4cf9f!important;outline-offset:-1px}
.bx-interest-mark{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:8px 14px;background:#fdf8ee;border-bottom:1px solid #ecdfc4;color:#7a5c24;font-size:12px}
.bx-interest-mark span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bx-interest-mark button{border:1px solid #dcc79c;background:#fff;color:#7a5c24;border-radius:6px;padding:2px 8px;font:inherit;font-size:11px;cursor:pointer;white-space:nowrap}
.bx-interest-mark button:hover{background:#f7eedd}
#bx-sidebar .bx-disc-status{border:1px solid #dce3d9;border-radius:10px;background:#fff;padding:12px 14px;margin:0 0 6px}
#bx-sidebar .bx-disc-row{font-size:12px;color:#3f5a4c;padding:3px 0}
#bx-sidebar .bx-disc-setup{border:1px solid #e3d3ad;background:#fdf8ee;border-radius:9px;padding:10px 13px;margin:8px 0}
#bx-sidebar .bx-disc-setup p{font-size:12px;color:#7a5c24;margin:5px 0}
#bx-sidebar .bx-disc-toggle{display:flex;gap:8px;align-items:flex-start;font-size:13px;color:#2c4a3c;margin:6px 0 12px}
#bx-sidebar .bx-disc-toggle input{width:auto;margin-top:3px}
#bx-sidebar .bx-disc-rule{border:1px solid #dce3d9;border-radius:9px;background:#fff;padding:10px 12px;margin:8px 0}
#bx-sidebar .bx-disc-rule-meta{display:flex;justify-content:space-between;align-items:center;margin-top:8px}
#bx-sidebar .bx-disc-rule-on{display:flex;gap:6px;align-items:center;font-size:12px;color:#526d5d;font-weight:400}
#bx-sidebar .bx-disc-rule-on input{width:auto}
#bx-sidebar .bx-disc-rule-del{border:1px solid #d3b7ae;background:#fff;color:#9b4e39;border-radius:6px;padding:4px 10px;font-size:11px}
#bx-sidebar .bx-disc-guide{border:1px solid #dce3d9;border-radius:10px;background:#f6f7f2;padding:12px 14px;margin-top:6px}
#bx-sidebar .bx-disc-guide ol{margin:0;padding-left:18px}
#bx-sidebar .bx-disc-guide li{font-size:12px;color:#3f5a4c;margin:8px 0}
#bx-sidebar .bx-disc-boundary{border-top:1px solid #e2e6df;margin:12px 0 0;padding-top:10px;font-size:12px;color:#7a5c24}`;
    document.documentElement.appendChild(style);
  }

  injectStyle();
  loadPrefs(); // 立即读偏好：不打开侧栏也要能高亮

  register({
    id: 'discovery',
    label: '发现',
    order: 50,
    init() {
      if (!state.discovery.prefsReady || state.discovery.prefsError) loadPrefs();
    },
    render(container) { renderDiscovery(container); },
    onPost() {
      // 本模块没有「对象相关状态」：高亮/折叠挂在时间线节点上，不随当前回复对象清空。
    },
    onSettings() {
      refreshFilter();   // 折叠路径（原样；规则来自 settings，applySettings 已更新）
      // 跨标签页同步：其他标签页改动 discoveryPrefs 会广播 BX_SETTINGS_CHANGED，
      // 这里使缓存失效并重读（loadPrefs 成功后自行 refreshInterest 并重绘规则表）。
      prefsLoad = null;
      loadPrefs();
    },
    onArticle(article, meta) {
      if (meta.first) {
        visiblePosts.observe(article);
        return;
      }
      if (meta.reused) {
        // X 复用节点换了帖子/正文 → 旧判断作废，重新观察与判断（竞态四元组在这里重置）
        resetFilterState(article);
        resetInterestState(article);
        visiblePosts.observe(article);
        inspectPost(article);
        inspectInterestSafe(article);
        return;
      }
      // 无变化的周期通知：只补回被 X 重渲染冲掉的折叠条 / 高亮角标，不改判断结果
      if (article.classList.contains('bx-collapsed') && article.dataset.bxFiltered === 'done') {
        addCollapseBar(article, article.dataset.bxLabel || '');
      }
      if (article.dataset.bxIntHit === '1' && article.dataset.bxInt === 'done') {
        addInterestMark(article, article.dataset.bxIntLabel || '');
      }
    }
  });
})();
