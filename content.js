// 页面宿主（integration 独占）：文章扫描与节点复用检测、帖内「翻译／回复」入口、
// 编辑框聚焦跟踪、设置加载与广播。功能 UI 全部在 modules/*（经 BX.register 挂载），
// 侧栏骨架在 sidebar/sidebar.js（window.BX）。协议见 SIDEBAR-PROTOCOL.md。
(() => {
  if (window.__bxHostLoaded) return;
  window.__bxHostLoaded = true;
  if (!window.BX) { console.error('[bx] 侧栏骨架未加载（manifest 脚本顺序？）'); return; }
  const { util, notifyArticle, notifyEditor, applySettings, openForPost } = window.BX;
  const { isEditor } = util;

  // stable identity for a post, used to detect X's DOM-node reuse (virtualized timeline)
  function postKey(article) {
    const permalink = [...article.querySelectorAll('a[href*="/status/"]')].find(a => /\/status\/\d+/.test(a.getAttribute('href') || ''));
    if (permalink) return permalink.getAttribute('href');
    return (article.querySelector('[data-testid="tweetText"]')?.textContent || '').trim().slice(0, 120);
  }
  function postTextSignature(article) {
    const text = (article.querySelector('[data-testid="tweetText"]')?.innerText || '').trim();
    return `${text.length}:${text.slice(0, 60)}`;
  }

  // 每帖两个入口：翻译（保留 .bx-inline-button，旧测试与外部依赖都认它）与回复。
  function ensureEntries(article, textNode) {
    if (article.querySelector('.bx-entries')) return;
    const wrap = document.createElement('div');
    wrap.className = 'bx-entries';
    const translate = document.createElement('button');
    translate.type = 'button';
    translate.className = 'bx-inline-button bx-entry';
    translate.dataset.bxEntry = 'read';
    translate.textContent = '翻译';
    translate.onclick = event => { event.preventDefault(); event.stopPropagation(); window.BX.emit('translate-full', {}); openForPost(article, 'read'); };
    const reply = document.createElement('button');
    reply.type = 'button';
    reply.className = 'bx-entry bx-entry-reply';
    reply.dataset.bxEntry = 'write';
    reply.textContent = '回复';
    reply.onclick = event => { event.preventDefault(); event.stopPropagation(); openForPost(article, 'write'); };
    wrap.append(translate, reply);
    const actionBar = article.querySelector('[role="group"]') || textNode;
    actionBar.appendChild(wrap);
  }

  let scanTimer;
  let observedHref = location.href;
  function reconcileLocation() {
    if (location.href === observedHref) return;
    observedHref = location.href;
    // X navigates without reloading content scripts. The prior post, selection, editor,
    // and in-flight answers must not be reused on the next route.
    window.BX.setPost(null, { reset: true, force: true });
    if (window.BX.element.classList.contains('bx-open')) window.BX.refresh();
  }
  function scan() {
    reconcileLocation();
    document.querySelectorAll('article[data-testid="tweet"], article').forEach(article => {
      const textNode = article.querySelector('[data-testid="tweetText"]');
      if (!textNode) return;
      const key = postKey(article);
      const sig = postTextSignature(article);
      if (article.dataset.bxReady) {
        // X recycles article nodes across tweets — detect reuse, and detect the same URL
        // growing from placeholder to full text; either way module judgments must redone.
        const keyChanged = article.dataset.bxPostKey && article.dataset.bxPostKey !== key;
        const textChanged = article.dataset.bxTextSig && article.dataset.bxTextSig !== sig;
        if (keyChanged || textChanged) {
          article.dataset.bxPostKey = key;
          article.dataset.bxTextSig = sig;
          ensureEntries(article, textNode); // innerHTML replacement wipes our entries
          notifyArticle(article, { key, sig, first: false, reused: true, repeat: false });
          return;
        }
        // 节点重复渲染：入口被冲掉时按既有状态补回，不改各模块判断结果
        ensureEntries(article, textNode);
        notifyArticle(article, { key, sig, first: false, reused: false, repeat: true });
        return;
      }
      article.dataset.bxReady = '1';
      article.dataset.bxPostKey = key;
      article.dataset.bxTextSig = sig;
      ensureEntries(article, textNode);
      notifyArticle(article, { key, sig, first: true, reused: false, repeat: false });
    });
  }
  const observer = new MutationObserver(() => { clearTimeout(scanTimer); scanTimer = setTimeout(scan, 350); });
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('popstate', reconcileLocation);
  // pushState does not fire popstate; keep this inexpensive route check as a fallback
  // when X changes the URL before it mounts the next article.
  setInterval(reconcileLocation, 500);
  scan();

  document.addEventListener('focusin', event => { if (isEditor(event.target)) notifyEditor(event.target); });

  // MV3 内容脚本收不到 chrome.storage.onChanged（实测 Edge 153 从未触发），
  // 设置变化由 background.js 收到 storage 事件后广播 BX_SETTINGS_CHANGED 过来。
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.action === 'BX_SETTINGS_CHANGED') {
      window.BX.send('PUBLIC_SETTINGS').then(applySettings).catch(() => {});
      respond({ ok: true });
    }
    return false;
  });
  window.BX.send('PUBLIC_SETTINGS').then(applySettings).catch(() => {});
})();
