(() => {
  const BX = window.BX;
  const roots = '[data-testid="tweetText"],[data-testid="longformRichTextComponent"],[data-testid="articleBody"],[data-testid="article-content"]';
  let timer, closing, last = '', token = 0;
  function stop() { clearTimeout(timer); clearTimeout(closing); last = ''; token++; }
  function wordAt(x, y, root) {
    const caret = document.caretPositionFromPoint?.(x,y);
    const range = caret ? null : document.caretRangeFromPoint?.(x,y);
    const node = caret?.offsetNode || range?.startContainer, offset = caret?.offset ?? range?.startOffset;
    if (node?.nodeType !== Node.TEXT_NODE || !root.contains(node)) return null;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode(n) {
      return n.parentElement.closest('button,input,textarea,[contenteditable="true"],#bx-sidebar,.bx-entries') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
    } });
    const nodes = []; let n, text = '', position = -1;
    while ((n = walker.nextNode())) { if (n === node) position = text.length + offset; nodes.push({ node:n, start:text.length }); text += n.data; }
    if (position < 0) return null;
    const hit = window.BXWordBoundary?.(text, position);
    if (!hit) return null;
    const { word, start, end } = hit;
    const first = nodes.find(v => start >= v.start && start < v.start + v.node.length);
    const final = nodes.find(v => end > v.start && end <= v.start + v.node.length);
    if (!first || !final) return null;
    const selected = document.createRange(); selected.setStart(first.node,start-first.start); selected.setEnd(final.node,end-final.start);
    if (![...selected.getClientRects()].some(r => x >= r.left-1 && x <= r.right+1 && y >= r.top && y <= r.bottom)) return null;
    return { word, rect:selected.getBoundingClientRect() };
  }
  document.addEventListener('pointermove', event => {
    if (event.target.closest?.('#bx-word-pop')) { clearTimeout(closing); return; }
    if (BX.state.settings?.hoverLookup === false || event.buttons || BX.state.composing || !getSelection()?.isCollapsed) { stop(); return; }
    const root = event.target.closest?.(roots);
    const excluded = event.target.closest?.('input,textarea,button,a,[contenteditable="true"],#bx-sidebar,.bx-entries');
    const hit = root && !excluded ? wordAt(event.clientX,event.clientY,root) : null;
    if (!hit) { stop(); closing = setTimeout(() => window.BXLookup?.hide(), 220); return; }
    clearTimeout(closing);
    const key = hit.word.toLowerCase();
    if (last === key) return;
    clearTimeout(timer); last = key; const current = ++token;
    timer = setTimeout(() => { if (current === token) window.BXLookup?.show(hit.word,hit.rect); },350);
  }, { passive:true });
  document.addEventListener('scroll', event => { if (event.target?.id === 'bx-word-pop') return; stop(); window.BXLookup?.hide(); }, true);
  window.addEventListener('blur', () => { stop(); window.BXLookup?.hide(); });
  BX.on('post-change', () => { stop(); window.BXLookup?.hide(); });
  BX.on('settings', () => { if (BX.state.settings?.hoverLookup === false) { stop(); window.BXLookup?.hide(); } });
})();
